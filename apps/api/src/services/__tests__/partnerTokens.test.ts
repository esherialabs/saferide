import { describe, expect, it } from 'vitest';

import {
  generatePartnerReference,
  generatePartnerToken,
  hashPartnerToken,
  isPartnerToken,
  looksLikePartnerToken,
} from '../partnerTokens.js';

describe('partner tokens', () => {
  it('issues distinct opaque tokens per kind that are never JWT-shaped', () => {
    const session = generatePartnerToken('session');
    const enrollment = generatePartnerToken('enrollment');
    expect(isPartnerToken('session', session)).toBe(true);
    expect(isPartnerToken('enrollment', enrollment)).toBe(true);
    expect(isPartnerToken('session', enrollment)).toBe(false);
    expect(isPartnerToken('enrollment', session)).toBe(false);
    expect(session).not.toContain('.');
    expect(looksLikePartnerToken(session) && looksLikePartnerToken(enrollment)).toBe(true);
    expect(generatePartnerToken('session')).not.toBe(session);
  });

  it('rejects malformed token shapes', () => {
    for (const value of [undefined, '', 'srps_short', `srps_${'a'.repeat(43)}x`, `eyJ${'a'.repeat(40)}`, 42]) {
      expect(isPartnerToken('session', value)).toBe(false);
    }
  });

  it('hashes tokens to lowercase sha256 hex', () => {
    expect(hashPartnerToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('generates survivor-quotable references without ambiguous characters', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 500; index += 1) {
      const reference = generatePartnerReference();
      expect(reference).toMatch(/^SR-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
      seen.add(reference);
    }
    expect(seen.size).toBe(500);
  });
});
