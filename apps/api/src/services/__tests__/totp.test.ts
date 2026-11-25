import { describe, expect, it } from 'vitest';

import {
  PARTNER_TOTP,
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  totp,
  totpKeyUri,
  totpStep,
  verifyTotp,
} from '../totp.js';

// RFC 6238 Appendix B reference seeds (ASCII) for each HMAC algorithm.
const rfcSeeds = {
  sha1: Buffer.from('12345678901234567890', 'ascii'),
  sha256: Buffer.from('12345678901234567890123456789012', 'ascii'),
  sha512: Buffer.from('1234567890123456789012345678901234567890123456789012345678901234', 'ascii'),
} as const;

// RFC 6238 Appendix B, 8 digits, X = 30, T0 = 0.
const rfc6238Vectors: Array<[number, string, string, string]> = [
  [59, '94287082', '46119246', '90693936'],
  [1111111109, '07081804', '68084774', '25091201'],
  [1111111111, '14050471', '67062674', '99943326'],
  [1234567890, '89005924', '91819424', '93441116'],
  [2000000000, '69279037', '90698825', '38618901'],
  [20000000000, '65353130', '77737706', '47863826'],
];

// RFC 4226 Appendix D, 6 digits.
const rfc4226Vectors = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];

describe('RFC 6238 TOTP', () => {
  it.each(rfc6238Vectors)('matches the Appendix B vectors at T=%i', (unixSeconds, sha1, sha256, sha512) => {
    expect(totp(rfcSeeds.sha1, unixSeconds, { algorithm: 'sha1', digits: 8 })).toBe(sha1);
    expect(totp(rfcSeeds.sha256, unixSeconds, { algorithm: 'sha256', digits: 8 })).toBe(sha256);
    expect(totp(rfcSeeds.sha512, unixSeconds, { algorithm: 'sha512', digits: 8 })).toBe(sha512);
  });

  it('matches the RFC 4226 Appendix D HOTP vectors', () => {
    rfc4226Vectors.forEach((expected, counter) => {
      expect(hotp(rfcSeeds.sha1, counter)).toBe(expected);
    });
  });

  it('round-trips base32 and matches the RFC 4648 test vectors', () => {
    const vectors: Array<[string, string]> = [
      ['', ''], ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'],
      ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI'],
    ];
    for (const [plain, encoded] of vectors) {
      expect(base32Encode(Buffer.from(plain))).toBe(encoded);
      expect(base32Decode(encoded.padEnd(Math.ceil(encoded.length / 8) * 8, '=')).toString()).toBe(plain);
    }
    const secret = generateTotpSecret();
    expect(secret).toHaveLength(PARTNER_TOTP.secretBytes);
    expect(base32Decode(base32Encode(secret)).equals(secret)).toBe(true);
    expect(() => base32Decode('not-base32!')).toThrow();
  });

  it('accepts one step of drift either side and nothing further', () => {
    const now = 1_800_000_015;
    const step = totpStep(now);
    const codeAt = (offset: number) => hotp(rfcSeeds.sha1, step + offset);
    expect(verifyTotp(rfcSeeds.sha1, codeAt(0), { unixSeconds: now })).toBe(step);
    expect(verifyTotp(rfcSeeds.sha1, codeAt(-1), { unixSeconds: now })).toBe(step - 1);
    expect(verifyTotp(rfcSeeds.sha1, codeAt(1), { unixSeconds: now })).toBe(step + 1);
    expect(verifyTotp(rfcSeeds.sha1, codeAt(-2), { unixSeconds: now })).toBeNull();
    expect(verifyTotp(rfcSeeds.sha1, codeAt(2), { unixSeconds: now })).toBeNull();
  });

  it('rejects replay of the last accepted step and anything older', () => {
    const now = 1_800_000_015;
    const step = totpStep(now);
    const code = hotp(rfcSeeds.sha1, step);
    expect(verifyTotp(rfcSeeds.sha1, code, { unixSeconds: now, afterStep: step - 1 })).toBe(step);
    expect(verifyTotp(rfcSeeds.sha1, code, { unixSeconds: now, afterStep: step })).toBeNull();
    expect(verifyTotp(rfcSeeds.sha1, hotp(rfcSeeds.sha1, step - 1), { unixSeconds: now, afterStep: step })).toBeNull();
    expect(verifyTotp(rfcSeeds.sha1, hotp(rfcSeeds.sha1, step + 1), { unixSeconds: now, afterStep: step })).toBe(step + 1);
  });

  it('rejects malformed codes without comparing', () => {
    for (const code of ['', '12345', '1234567', 'abcdef', ' 123456', '12345a']) {
      expect(verifyTotp(rfcSeeds.sha1, code, { unixSeconds: 59 })).toBeNull();
    }
  });

  it('builds an authenticator key URI with the partner parameters', () => {
    const raw = totpKeyUri({ secret: rfcSeeds.sha1, issuer: 'SafeRide Partners', account: 'case.worker@example.invalid' });
    expect(raw.startsWith('otpauth://totp/SafeRide%20Partners:case.worker%40example.invalid?')).toBe(true);
    const uri = new URL(raw);
    expect(uri.searchParams.get('secret')).toBe(base32Encode(rfcSeeds.sha1));
    expect(uri.searchParams.get('issuer')).toBe('SafeRide Partners');
    expect(uri.searchParams.get('algorithm')).toBe('SHA1');
    expect(uri.searchParams.get('digits')).toBe('6');
    expect(uri.searchParams.get('period')).toBe('30');
  });
});
