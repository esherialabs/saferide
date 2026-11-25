/**
 * Known-device cookie: after a full partner sign-in (password and TOTP, or
 * enrolment) the browser gets a signed marker that THIS USER signed in here
 * recently. Its only use is priority in the partner auth gate
 * (services/partnerAuthGate.ts), so a flood of anonymous password guesses
 * cannot starve caseworkers who have signed in before. It grants no access.
 *
 * It names the user id and that user's known_device_epoch (migration 012)
 * and carries an expiry, a random device id and an HMAC under a subkey of
 * PARTNER_TOTP_KEY. The routes honour it only when the user is the account
 * the request is for (the email in the password step's body), that user and
 * their org are active, and the epoch still matches the database. Operators
 * revoke every cookie of a user by bumping the epoch (user:disable,
 * user:reset, sessions:revoke). Each account holds at most one priority
 * place at a time, however many cookies exist for it.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { FastifyRequest } from 'fastify';

export const PARTNER_KNOWN_DEVICE_COOKIE = '__Host-saferide_partner_device';
export const PARTNER_KNOWN_DEVICE_TTL_SECONDS = 30 * 24 * 60 * 60;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const TOKEN_PATTERN = new RegExp(`^v2\\.(${UUID})\\.([0-9a-z]{1,7})\\.([0-9a-z]{1,10})\\.[A-Za-z0-9_-]{22}\\.([A-Za-z0-9_-]{43})$`);

export type KnownDevice = { userId: string; epoch: number };

function mac(key: Buffer, body: string): string {
  return createHmac('sha256', key).update(`saferide-partner-known-device:${body}`).digest('base64url');
}

export function issueKnownDeviceToken(key: Buffer, device: KnownDevice, nowSeconds: number): string {
  const expiry = (nowSeconds + PARTNER_KNOWN_DEVICE_TTL_SECONDS).toString(36);
  const body = `v2.${device.userId.toLowerCase()}.${device.epoch.toString(36)}.${expiry}.${randomBytes(16).toString('base64url')}`;
  return `${body}.${mac(key, body)}`;
}

/** The user and epoch of a valid, unexpired token, or null. The caller still checks both against the database. */
export function verifyKnownDeviceToken(key: Buffer, token: string | null, nowSeconds: number): KnownDevice | null {
  const match = token ? TOKEN_PATTERN.exec(token) : null;
  if (!match || !token) return null;
  const body = token.slice(0, token.lastIndexOf('.'));
  const given = Buffer.from(match[4], 'utf8');
  const expected = Buffer.from(mac(key, body), 'utf8');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  if (parseInt(match[3], 36) <= nowSeconds) return null;
  return { userId: match[1], epoch: parseInt(match[2], 36) };
}

/** The single known-device cookie value, or null. */
export function readKnownDeviceCookie(request: FastifyRequest): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  const prefix = `${PARTNER_KNOWN_DEVICE_COOKIE}=`;
  const values = header.split(';').map(part => part.trim()).filter(part => part.startsWith(prefix));
  return values.length === 1 ? values[0].slice(prefix.length) : null;
}

export function knownDeviceCookie(token: string): string {
  return `${PARTNER_KNOWN_DEVICE_COOKIE}=${token}; Path=/; Max-Age=${PARTNER_KNOWN_DEVICE_TTL_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}
