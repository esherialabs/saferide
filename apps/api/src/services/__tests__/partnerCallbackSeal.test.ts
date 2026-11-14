import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { decodePartnerKey } from '../../config/partnerKey.js';
import {
  SEALED_CALLBACK_PATTERN,
  deriveCallbackSealKey,
  normalizeCallbackPhone,
  openPartnerCallback,
  sealPartnerCallback,
} from '../partnerCallbackSeal.js';

const key = deriveCallbackSealKey(randomBytes(32));
const referralId = '44444444-4444-4444-8444-444444444444';
const syntheticNumber = '+254700000001';

describe('partner callback sealing', () => {
  it('round-trips under the same referral with a fresh IV each time', () => {
    const first = sealPartnerCallback(key, referralId, syntheticNumber);
    const second = sealPartnerCallback(key, referralId, syntheticNumber);
    expect(first).toMatch(SEALED_CALLBACK_PATTERN);
    expect(first).not.toBe(second);
    expect(first).not.toContain('254700000001');
    expect(openPartnerCallback(key, referralId, first)).toBe(syntheticNumber);
  });

  it('cannot be opened under another referral, another key, or after tampering', () => {
    const sealed = sealPartnerCallback(key, referralId, syntheticNumber);
    expect(() => openPartnerCallback(key, '55555555-5555-4555-8555-555555555555', sealed)).toThrow();
    expect(() => openPartnerCallback(deriveCallbackSealKey(randomBytes(32)), referralId, sealed)).toThrow();
    const parts = sealed.split('.');
    const flipped = Buffer.from(parts[3], 'base64url');
    flipped[0] ^= 1;
    expect(() => openPartnerCallback(key, referralId, [...parts.slice(0, 3), flipped.toString('base64url')].join('.'))).toThrow();
    expect(() => openPartnerCallback(key, referralId, `v2.${parts.slice(1).join('.')}`)).toThrow();
  });

  it('derives a subkey distinct from the master key', () => {
    const master = randomBytes(32);
    expect(deriveCallbackSealKey(master).equals(master)).toBe(false);
    expect(() => deriveCallbackSealKey(randomBytes(16))).toThrow();
    expect(decodePartnerKey(master.toString('base64'))?.equals(master)).toBe(true);
  });

  it('minimises survivor input to E.164 and refuses anything else', () => {
    expect(normalizeCallbackPhone('0700 000 001')).toBe('+254700000001');
    expect(normalizeCallbackPhone('0110-000-001')).toBe('+254110000001');
    expect(normalizeCallbackPhone('254700000001')).toBe('+254700000001');
    expect(normalizeCallbackPhone('+44 20 7946 0000')).toBe('+442079460000');
    for (const bad of ['', 'call me', '12345', '+0123456789', '0700 000 001 ext 2', '07000000011']) {
      expect(normalizeCallbackPhone(bad)).toBeNull();
    }
    expect(() => sealPartnerCallback(key, referralId, '0700000001')).toThrow();
  });
});
