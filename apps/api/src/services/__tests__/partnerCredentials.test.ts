import { randomBytes, scrypt, scryptSync } from 'node:crypto';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { decodePartnerKey } from '../../config/partnerKey.js';
import {
  derivePartnerKeys,
  fingerprintPartnerClient,
  generatePartnerPassword,
  hashPartnerPassword,
  openTotpSecret,
  PARTNER_GENERATED_PASSWORD,
  PARTNER_SCRYPT_COST,
  partnerPasswordHashNeedsUpgrade,
  partnerPasswordProblem,
  partnerPasswordUnpredictableChars,
  partnerScryptMaxmem,
  sealTotpSecret,
  verifyPartnerPassword,
} from '../partnerCredentials.js';

const syntheticPassword = 'synthetic correct horse 42';
const keys = derivePartnerKeys(randomBytes(32));
const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, length: number, options: object) => Promise<Buffer>;

/** A hash in the stored format at a chosen cost, made like the #287 code made them. */
async function hashAtCost(password: string, logN: number): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64, { N: 2 ** logN, r: 8, p: 1, maxmem: 256 * 2 ** logN * 8 });
  return `scrypt$v1$ln=${logN},r=8,p=1$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

describe('partner password hashing', () => {
  it('hashes with scrypt N=2^17, r=8, p=1 and verifies only the right password', async () => {
    expect(PARTNER_SCRYPT_COST).toEqual({ logN: 17, r: 8, p: 1 });
    const stored = await hashPartnerPassword(syntheticPassword);
    expect(stored).toMatch(/^scrypt\$v1\$ln=17,r=8,p=1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/);
    expect(stored).not.toContain(syntheticPassword);
    await expect(verifyPartnerPassword(syntheticPassword, stored)).resolves.toBe(true);
    await expect(verifyPartnerPassword(`${syntheticPassword}!`, stored)).resolves.toBe(false);
    expect(await hashPartnerPassword(syntheticPassword)).not.toBe(stored);
    expect(partnerPasswordHashNeedsUpgrade(stored)).toBe(false);
  });

  it('still verifies N=2^16 hashes from #287 and marks them for rehashing', async () => {
    const legacy = await hashAtCost(syntheticPassword, 16);
    await expect(verifyPartnerPassword(syntheticPassword, legacy)).resolves.toBe(true);
    await expect(verifyPartnerPassword(`${syntheticPassword}!`, legacy)).resolves.toBe(false);
    expect(partnerPasswordHashNeedsUpgrade(legacy)).toBe(true);
    expect(partnerPasswordHashNeedsUpgrade(null)).toBe(false);
    expect(partnerPasswordHashNeedsUpgrade('scrypt$abc$def')).toBe(false);
  });

  it('sets maxmem just above what N=2^17, r=8 needs (128 MiB) and refuses costlier stored hashes', async () => {
    const needed = 128 * 8 * 2 ** 17;
    expect(partnerScryptMaxmem(PARTNER_SCRYPT_COST)).toBeGreaterThan(needed);
    expect(partnerScryptMaxmem(PARTNER_SCRYPT_COST)).toBeLessThanOrEqual(needed + 2 * 1024 * 1024);
    // A tampered row asking for N=2^18 (256 MiB) is refused without running it.
    const costly = (await hashAtCost(syntheticPassword, 16)).replace('ln=16', 'ln=18');
    await expect(verifyPartnerPassword(syntheticPassword, costly)).resolves.toBe(false);
    expect(partnerPasswordHashNeedsUpgrade(costly)).toBe(false);
  });

  it('hashes off the event loop (async crypto.scrypt, never scryptSync)', async () => {
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 5);
    try {
      await hashPartnerPassword(syntheticPassword);
    } finally {
      clearInterval(timer);
    }
    // A synchronous hash would hold the loop for the whole ~100+ ms and allow no ticks.
    expect(ticks).toBeGreaterThan(2);
  });

  it('refuses missing, malformed and weaker-cost hashes', async () => {
    const salt = randomBytes(16);
    const weakKey = scryptSync(syntheticPassword, salt, 64, { N: 2 ** 14, r: 8, p: 1 });
    const downgraded = `scrypt$v1$ln=14,r=8,p=1$${salt.toString('base64url')}$${weakKey.toString('base64url')}`;
    await expect(verifyPartnerPassword(syntheticPassword, downgraded)).resolves.toBe(false);
    await expect(verifyPartnerPassword(syntheticPassword, null)).resolves.toBe(false);
    await expect(verifyPartnerPassword(syntheticPassword, 'scrypt$abc$def')).resolves.toBe(false);
  });

  it('enforces the partner password policy', () => {
    expect(partnerPasswordProblem('short-pass', 'case.worker@example.invalid')).toMatch(/at least 12/);
    expect(partnerPasswordProblem('x'.repeat(257), 'case.worker@example.invalid')).toMatch(/at most 256/);
    expect(partnerPasswordProblem('my case.worker pw 9', 'case.worker@example.invalid')).toMatch(/email/);
    expect(partnerPasswordProblem('aaaaaaaaaaaaaaaa', 'case.worker@example.invalid')).toMatch(/repetitive/);
    expect(partnerPasswordProblem(syntheticPassword, 'case.worker@example.invalid')).toBeNull();
  });

  it('refuses predictable passwords without composition rules', () => {
    const email = 'case.worker@example.invalid';
    for (const weak of ['Password2026!', 'SafeRide12345', 'qwertyuiop1234', '123456789012', 'abcdefghijklm', 'zyxwvu-987654','P@ssw0rd-P@ssw0rd']) {
      expect(partnerPasswordProblem(weak, email), weak).toMatch(/too easy to guess/);
    }
    // Lowercase-only sentences and digits-free words are fine: no "one capital, one symbol" theatre.
    for (const fine of ['blue kettle river stone', 'mango tractor velvet', 'k7mqa-2rx9p-hd4tz-w8nce-3vjfy']) {
      expect(partnerPasswordProblem(fine, email), fine).toBeNull();
    }
    expect(partnerPasswordUnpredictableChars('aaaa1234abcd')).toBe(3);
  });
});

describe('operator-issued partner passwords', () => {
  it('generates 25 unambiguous characters in five hyphenated groups that pass the policy', () => {
    const { alphabet } = PARTNER_GENERATED_PASSWORD;
    expect(alphabet).toHaveLength(31);
    expect(alphabet).not.toMatch(/[01ilo]/);
    const seen = new Set<string>();
    for (let index = 0; index < 500; index += 1) {
      const password = generatePartnerPassword('case.worker@example.invalid');
      expect(password).toMatch(/^[a-hj-km-np-z2-9]{5}(-[a-hj-km-np-z2-9]{5}){4}$/);
      expect(password.length).toBeGreaterThanOrEqual(20);
      expect(partnerPasswordProblem(password, 'case.worker@example.invalid')).toBeNull();
      seen.add(password);
    }
    expect(seen.size).toBe(500);
    // About 124 bits: 25 symbols from 31.
    expect(25 * Math.log2(alphabet.length)).toBeGreaterThan(120);
  });
});

describe('partner TOTP secret sealing', () => {
  it('round-trips a secret for the same user', () => {
    const secret = randomBytes(20);
    const sealed = sealTotpSecret(keys, 'user-1', secret);
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain(secret.toString('base64url'));
    expect(openTotpSecret(keys, 'user-1', sealed).equals(secret)).toBe(true);
  });

  it('cannot be opened for another user, under another key or after tampering', () => {
    const sealed = sealTotpSecret(keys, 'user-1', randomBytes(20));
    expect(() => openTotpSecret(keys, 'user-2', sealed)).toThrow();
    expect(() => openTotpSecret(derivePartnerKeys(randomBytes(32)), 'user-1', sealed)).toThrow();
    const parts = sealed.split('.');
    const flipped = Buffer.from(parts[3], 'base64url');
    flipped[0] ^= 1;
    expect(() => openTotpSecret(keys, 'user-1', [...parts.slice(0, 3), flipped.toString('base64url')].join('.'))).toThrow();
    expect(() => openTotpSecret(keys, 'user-1', 'v2.a.b.c')).toThrow();
  });

  it('derives distinct subkeys and keyed client fingerprints', () => {
    expect(keys.totpSeal.equals(keys.clientFingerprint)).toBe(false);
    const fingerprint = fingerprintPartnerClient(keys, '203.0.113.7');
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint).not.toContain('203.0.113.7');
    expect(fingerprintPartnerClient(derivePartnerKeys(randomBytes(32)), '203.0.113.7')).not.toBe(fingerprint);
  });

  it('accepts only 32-byte hex or base64 keys from the environment', () => {
    const raw = randomBytes(32);
    expect(decodePartnerKey(raw.toString('hex'))?.equals(raw)).toBe(true);
    expect(decodePartnerKey(raw.toString('base64'))?.equals(raw)).toBe(true);
    expect(decodePartnerKey(raw.toString('base64url'))?.equals(raw)).toBe(true);
    expect(decodePartnerKey(randomBytes(16).toString('hex'))).toBeNull();
    expect(decodePartnerKey('replace-with-a-real-key')).toBeNull();
    expect(decodePartnerKey(undefined)).toBeNull();
  });
});
