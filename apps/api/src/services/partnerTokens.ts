import { createHash, randomBytes } from 'node:crypto';

/**
 * Partner-realm opaque tokens. They are never JWTs: survivor auth rejects
 * anything with this prefix, and the partner realm accepts nothing else.
 * Only the sha256 of a token is stored.
 */
export const PARTNER_TOKEN_PREFIX = 'srp';

const KIND_PREFIX = {
  session: 'srps_',
  enrollment: 'srpe_',
} as const;

export type PartnerTokenKind = keyof typeof KIND_PREFIX;

const TOKEN_BYTES = 32;
const TOKEN_BODY = '[A-Za-z0-9_-]{43}';
const TOKEN_PATTERNS: Record<PartnerTokenKind, RegExp> = {
  session: new RegExp(`^${KIND_PREFIX.session}${TOKEN_BODY}$`),
  enrollment: new RegExp(`^${KIND_PREFIX.enrollment}${TOKEN_BODY}$`),
};

export function generatePartnerToken(kind: PartnerTokenKind): string {
  return `${KIND_PREFIX[kind]}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
}

export function isPartnerToken(kind: PartnerTokenKind, value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERNS[kind].test(value);
}

export function looksLikePartnerToken(value: string): boolean {
  return value.startsWith(PARTNER_TOKEN_PREFIX);
}

export function hashPartnerToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

// Crockford base32: no I, L, O or U, so a reference survives being read aloud.
const REFERENCE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A well-formed reference (migration 007's partner_referrals.reference check). */
export const PARTNER_REFERENCE_PATTERN = /^SR-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

/** Survivor-quotable referral reference, e.g. `SR-7K3Q-9M2D`. */
export function generatePartnerReference(): string {
  const bytes = randomBytes(8);
  const chars = Array.from(bytes, byte => REFERENCE_ALPHABET[byte & 31]);
  return `SR-${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}
