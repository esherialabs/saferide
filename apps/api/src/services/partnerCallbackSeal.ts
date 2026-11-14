/**
 * Sealing for the optional survivor callback number (design section 11).
 * AES-256-GCM with a random 96-bit IV under an HKDF subkey of the dedicated
 * PARTNER_CALLBACK_KEY, with the referral id as associated data, so a sealed
 * number cannot be read under another referral. Stored format (enforced by
 * migration 007): v1.<iv>.<tag>.<ciphertext>, base64url.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const HKDF_INFO = 'saferide-partner/callback-seal/v1';
export const SEALED_CALLBACK_PATTERN = /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{8,}$/;
const E164 = /^\+[1-9]\d{7,14}$/;

/** Derives the callback subkey from the 32-byte PARTNER_CALLBACK_KEY. */
export function deriveCallbackSealKey(master: Buffer): Buffer {
  if (master.length !== 32) throw new Error('PARTNER_CALLBACK_KEY must be 32 bytes');
  return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), HKDF_INFO, 32));
}

/**
 * Minimises a survivor-entered number to E.164, or returns null. Kenyan
 * local forms (07xx/01xx, 2547xx) become +254; anything else must already
 * be E.164. Nothing but digits and a leading + survives.
 */
export function normalizeCallbackPhone(input: string): string | null {
  const compact = input.trim().replace(/[\s().-]/g, '');
  let candidate = compact;
  if (/^0[17]\d{8}$/.test(compact)) candidate = `+254${compact.slice(1)}`;
  else if (/^254[17]\d{8}$/.test(compact)) candidate = `+${compact}`;
  return E164.test(candidate) ? candidate : null;
}

function aad(referralId: string): Buffer {
  return Buffer.from(`saferide-partner-callback:${VERSION}:${referralId}`, 'utf8');
}

export function sealPartnerCallback(key: Buffer, referralId: string, phoneE164: string): string {
  if (!E164.test(phoneE164)) throw new Error('Callback number must be normalised to E.164 first');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(referralId));
  const ciphertext = Buffer.concat([cipher.update(phoneE164, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

/** Throws if the value was tampered with, sealed for another referral, or under another key. */
export function openPartnerCallback(key: Buffer, referralId: string, sealed: string): string {
  if (!SEALED_CALLBACK_PATTERN.test(sealed)) throw new Error('Unsupported sealed callback format');
  const [, iv, tag, ciphertext] = sealed.split('.').map(part => Buffer.from(part, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad(referralId));
  decipher.setAuthTag(tag);
  const phone = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  if (!E164.test(phone)) throw new Error('Sealed callback did not contain an E.164 number');
  return phone;
}
