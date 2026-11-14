// RFC 4226/6238 TOTP on node:crypto, matching apps/api/src/services/totp.ts
// (SHA-1, 6 digits, 30 s, ±1 step). Used by the mock API and the e2e tests.
import { createHmac, randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const PERIOD_SECONDS = 30;
export const DIGITS = 6;

export function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(text) {
  const clean = text.replace(/[\s=]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error('invalid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function newTotpKey() {
  return base32Encode(randomBytes(20));
}

export function hotp(key, counter) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', base32Decode(key)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function totpAt(key, unixSeconds = Date.now() / 1000) {
  return hotp(key, Math.floor(unixSeconds / PERIOD_SECONDS));
}

/** The matching step, or null. `afterStep` rejects replays of a used step. */
export function verifyTotp(key, code, { unixSeconds = Date.now() / 1000, window = 1, afterStep = null } = {}) {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(unixSeconds / PERIOD_SECONDS);
  for (let step = current - window; step <= current + window; step += 1) {
    if (afterStep !== null && step <= afterStep) continue;
    if (hotp(key, step) === code) return step;
  }
  return null;
}

export function keyUri({ key, issuer, account }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const query = new URLSearchParams({ secret: key, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(PERIOD_SECONDS) });
  return `otpauth://totp/${label}?${query.toString()}`;
}
