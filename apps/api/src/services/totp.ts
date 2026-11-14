/**
 * HOTP (RFC 4226) and TOTP (RFC 6238) on node:crypto, plus RFC 4648 base32.
 * Partner accounts use the authenticator-app defaults: SHA-1, 6 digits,
 * 30-second steps, accepting one step either side for clock drift.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type TotpAlgorithm = 'sha1' | 'sha256' | 'sha512';

export type TotpOptions = {
  algorithm?: TotpAlgorithm;
  digits?: number;
  periodSeconds?: number;
};

export const PARTNER_TOTP = { algorithm: 'sha1', digits: 6, periodSeconds: 30, window: 1, secretBytes: 20 } as const;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  const cleaned = input.replace(/=+$/, '').toUpperCase();
  if (!/^[A-Z2-7]*$/.test(cleaned)) throw new Error('Invalid base32 input');
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const character of cleaned) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function assertDigits(digits: number): void {
  if (!Number.isInteger(digits) || digits < 6 || digits > 10) throw new Error('TOTP digits must be 6-10');
}

/** RFC 4226 section 5.3: HMAC, dynamic truncation, modulo 10^digits. */
export function hotp(secret: Uint8Array, counter: bigint | number, options: TotpOptions = {}): string {
  const algorithm = options.algorithm ?? 'sha1';
  const digits = options.digits ?? 6;
  assertDigits(digits);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(algorithm, secret).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function totpStep(unixSeconds: number, periodSeconds = 30): number {
  return Math.floor(unixSeconds / periodSeconds);
}

/** RFC 6238: HOTP over T = floor((now - T0) / X) with T0 = 0. */
export function totp(secret: Uint8Array, unixSeconds: number, options: TotpOptions = {}): string {
  return hotp(secret, totpStep(unixSeconds, options.periodSeconds ?? 30), options);
}

function codesMatch(expected: string, candidate: string): boolean {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(candidate, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Returns the matched time step, or null. A step at or below `afterStep`
 * (the last one accepted for this secret) is a replay and never matches.
 */
export function verifyTotp(
  secret: Uint8Array,
  code: string,
  params: { unixSeconds: number; window?: number; afterStep?: number | null } & TotpOptions,
): number | null {
  const digits = params.digits ?? 6;
  if (!new RegExp(`^\\d{${digits}}$`).test(code)) return null;
  const window = params.window ?? 1;
  const current = totpStep(params.unixSeconds, params.periodSeconds ?? 30);
  const afterStep = params.afterStep ?? -1;
  let matched: number | null = null;
  for (let offset = -window; offset <= window; offset += 1) {
    const step = current + offset;
    if (step < 0) continue;
    // Check every candidate so timing does not reveal which step matched.
    const isMatch = codesMatch(hotp(secret, step, params), code);
    if (isMatch && step > afterStep && matched === null) matched = step;
  }
  return matched;
}

export function generateTotpSecret(): Buffer {
  return randomBytes(PARTNER_TOTP.secretBytes);
}

/** Key URI for authenticator apps; the account label is shown only to the enrolling user. */
export function totpKeyUri(params: { secret: Uint8Array; issuer: string; account: string }): string {
  const label = `${encodeURIComponent(params.issuer)}:${encodeURIComponent(params.account)}`;
  const query = new URLSearchParams({
    secret: base32Encode(params.secret),
    issuer: params.issuer,
    algorithm: PARTNER_TOTP.algorithm.toUpperCase(),
    digits: String(PARTNER_TOTP.digits),
    period: String(PARTNER_TOTP.periodSeconds),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
