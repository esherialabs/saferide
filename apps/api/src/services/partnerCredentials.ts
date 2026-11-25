/**
 * Partner credentials: scrypt password hashes (stronger cost than the
 * survivor realm's Node defaults) and TOTP secrets sealed with AES-256-GCM
 * under a key derived from PARTNER_TOTP_KEY, bound to the owning user id.
 *
 * Hashing always uses the asynchronous crypto.scrypt (libuv thread pool),
 * never scryptSync, so it never blocks the event loop. Callers in the API
 * process run it under the partner auth gate (services/partnerAuthGate.ts).
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  randomInt,
  scrypt,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

export const PARTNER_PASSWORD_POLICY = { minLength: 12, maxLength: 256 } as const;

type ScryptCost = { logN: number; r: number; p: number };

/**
 * New hashes: N = 2^17, r = 8, p = 1, the OWASP minimum for scrypt, which
 * needs 128 MiB per hash. Each hash records its own parameters
 * (`ln=..,r=..,p=..`), so older hashes still verify and are rewritten at
 * this cost on the next successful sign-in.
 */
export const PARTNER_SCRYPT_COST: Readonly<ScryptCost> = { logN: 17, r: 8, p: 1 };
/** Oldest cost still verified (the #287 hashes, N = 2^16); upgraded on use. */
const SCRYPT_MIN_LOG_N = 16;
/** Bounds the memory a stored hash can ask for (2^17: 128 MiB). */
const SCRYPT_MAX_LOG_N = 17;
const SCRYPT_KEY_BYTES = 64;
const SCRYPT_SALT_BYTES = 16;
/** OpenSSL refuses a hash whose working memory would exceed maxmem; allow 1 MiB over the exact need. */
const SCRYPT_MAXMEM_HEADROOM = 1024 * 1024;
const HASH_PATTERN = /^scrypt\$v1\$ln=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{86})$/;

/** Working memory scrypt needs: 128·r·(N + 2) bytes for V plus 128·r·p for B. */
export function partnerScryptMaxmem(cost: ScryptCost): number {
  return 128 * cost.r * (2 ** cost.logN + 2 + cost.p) + SCRYPT_MAXMEM_HEADROOM;
}

function deriveScrypt(password: string, salt: Buffer, cost: ScryptCost): Promise<Buffer> {
  const N = 2 ** cost.logN;
  const options: ScryptOptions = { N, r: cost.r, p: cost.p, maxmem: partnerScryptMaxmem(cost) };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, SCRYPT_KEY_BYTES, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPartnerPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const key = await deriveScrypt(password, salt, PARTNER_SCRYPT_COST);
  const { logN, r, p } = PARTNER_SCRYPT_COST;
  return `scrypt$v1$ln=${logN},r=${r},p=${p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** Parameters of a stored hash this realm will verify, or null. */
function acceptedHash(storedHash: string | null): { cost: ScryptCost; salt: Buffer; key: Buffer } | null {
  const match = storedHash ? HASH_PATTERN.exec(storedHash) : null;
  if (!match) return null;
  const cost = { logN: Number(match[1]), r: Number(match[2]), p: Number(match[3]) };
  const acceptable = cost.logN >= SCRYPT_MIN_LOG_N && cost.logN <= SCRYPT_MAX_LOG_N && cost.r === 8 && cost.p >= 1 && cost.p <= 2;
  return acceptable ? { cost, salt: Buffer.from(match[4], 'base64url'), key: Buffer.from(match[5], 'base64url') } : null;
}

const timingEqualiserSalt = randomBytes(SCRYPT_SALT_BYTES);

/** Constant-work check: an unknown user or malformed hash still costs one scrypt at the current cost. */
export async function verifyPartnerPassword(password: string, storedHash: string | null): Promise<boolean> {
  const stored = acceptedHash(storedHash);
  if (!stored) {
    await deriveScrypt(password, timingEqualiserSalt, PARTNER_SCRYPT_COST);
    return false;
  }
  const derived = await deriveScrypt(password, stored.salt, stored.cost);
  return stored.key.length === derived.length && timingSafeEqual(stored.key, derived);
}

/** True for a verifiable hash made at a lower cost than new hashes use: rehash it after the next successful sign-in. */
export function partnerPasswordHashNeedsUpgrade(storedHash: string | null): boolean {
  const stored = acceptedHash(storedHash);
  return stored !== null && stored.cost.logN < PARTNER_SCRYPT_COST.logN;
}

/**
 * Words that make up most weak passwords people choose here. They are
 * removed before counting, so "Password2026!" or "SafeRide12345" do not pass
 * on length alone. Not a dictionary: just the obvious ones.
 */
const COMMON_PASSWORD_FRAGMENTS = [
  'password', 'passw0rd', 'p@ssw0rd', 'saferide', 'esheria', 'huria', 'qwerty', 'azerty', 'asdf', 'zxcv',
  'letmein', 'welcome', 'changeme', 'iloveyou', 'admin', 'nairobi', 'mombasa', 'kenya',
];
const FRAGMENT_BREAK = '\u0000';

/** Unpredictable characters a password needs after common words, runs and repeats are discounted. */
export const PARTNER_PASSWORD_MIN_UNPREDICTABLE = 8;

/**
 * A rough count of the characters an attacker would have to guess: common
 * words are dropped, and a character continuing a run (`aaaa`, `abcd`,
 * `1234`, `4321`) counts once for the whole run. No composition rules.
 */
export function partnerPasswordUnpredictableChars(password: string): number {
  let rest = password.normalize('NFKC').toLowerCase();
  for (const fragment of COMMON_PASSWORD_FRAGMENTS) rest = rest.split(fragment).join(FRAGMENT_BREAK);
  let count = 0;
  let previous: number | null = null;
  for (const char of rest) {
    if (char === FRAGMENT_BREAK) {
      previous = null;
      continue;
    }
    const code = char.codePointAt(0) ?? 0;
    if (previous === null || Math.abs(code - previous) > 1) count += 1;
    previous = code;
  }
  return count;
}

/** Returns a reason the password is unacceptable, or null. */
export function partnerPasswordProblem(password: string, email: string): string | null {
  const length = [...password].length;
  if (length < PARTNER_PASSWORD_POLICY.minLength) return `Use at least ${PARTNER_PASSWORD_POLICY.minLength} characters`;
  if (length > PARTNER_PASSWORD_POLICY.maxLength) return `Use at most ${PARTNER_PASSWORD_POLICY.maxLength} characters`;
  const lowered = password.toLowerCase();
  const localPart = email.toLowerCase().split('@')[0] ?? '';
  if (lowered === email.toLowerCase() || (localPart.length >= 4 && lowered.includes(localPart))) {
    return 'Do not use your email address in the password';
  }
  if (new Set(password).size < 5) return 'Use a less repetitive password';
  if (partnerPasswordUnpredictableChars(password) < PARTNER_PASSWORD_MIN_UNPREDICTABLE) {
    return 'That password is too easy to guess. Avoid common words, runs like 1234 or abcd, and repeats; a few unrelated words work well';
  }
  return null;
}

/**
 * Operator-issued passwords (partnerAdmin user:set-password): five groups
 * of five characters from 31 symbols that cannot be confused when read
 * aloud or copied from paper (no 0/o, 1/l/i), joined by hyphens, e.g.
 * `k7mqa-...`. 25 random symbols carry about 124 bits.
 */
export const PARTNER_GENERATED_PASSWORD = {
  alphabet: 'abcdefghjkmnpqrstuvwxyz23456789',
  groups: 5,
  groupLength: 5,
  separator: '-',
} as const;

export function generatePartnerPassword(email: string): string {
  const { alphabet, groups, groupLength, separator } = PARTNER_GENERATED_PASSWORD;
  for (;;) {
    const parts: string[] = [];
    for (let group = 0; group < groups; group += 1) {
      let part = '';
      for (let index = 0; index < groupLength; index += 1) part += alphabet[randomInt(alphabet.length)];
      parts.push(part);
    }
    const password = parts.join(separator);
    // Practically always accepted; the loop only guards a freak draw.
    if (partnerPasswordProblem(password, email) === null) return password;
  }
}

export type PartnerKeys = {
  totpSeal: Buffer;
  clientFingerprint: Buffer;
  /** Signs known-device cookies (services/partnerKnownDevice.ts). */
  knownDevice: Buffer;
};

/** Separate subkeys per use so the master key never touches data directly. */
export function derivePartnerKeys(master: Buffer): PartnerKeys {
  if (master.length !== 32) throw new Error('Partner key must be 32 bytes');
  const derive = (info: string) => Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), info, 32));
  return {
    totpSeal: derive('saferide-partner/totp-seal/v1'),
    clientFingerprint: derive('saferide-partner/client-fingerprint/v1'),
    knownDevice: derive('saferide-partner/known-device/v1'),
  };
}

function sealAad(userId: string): Buffer {
  return Buffer.from(`saferide-partner-totp:v1:${userId}`, 'utf8');
}

export function sealTotpSecret(keys: PartnerKeys, userId: string, secret: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keys.totpSeal, iv);
  cipher.setAAD(sealAad(userId));
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), ciphertext].map(part => (typeof part === 'string' ? part : part.toString('base64url'))).join('.');
}

/** Throws if the value was tampered with, sealed for another user, or under another key. */
export function openTotpSecret(keys: PartnerKeys, userId: string, sealed: string): Buffer {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Unsupported sealed TOTP secret');
  const [, iv, tag, ciphertext] = parts.map(part => Buffer.from(part, 'base64url'));
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Malformed sealed TOTP secret');
  const decipher = createDecipheriv('aes-256-gcm', keys.totpSeal, iv);
  decipher.setAAD(sealAad(userId));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Keyed, non-reversible client fingerprint for rate limiting; raw IPs are never stored. */
export function fingerprintPartnerClient(keys: PartnerKeys, clientAddress: string): string {
  return createHmac('sha256', keys.clientFingerprint).update(clientAddress).digest('hex');
}

/**
 * Keyed fingerprint of the account an attempt targets (the submitted email,
 * or the user id at the TOTP step). Computed the same way whether or not the
 * account exists, so the limiter does not reveal which emails are real.
 */
export function fingerprintPartnerAccount(keys: PartnerKeys, account: { email: string } | { userId: string }): string {
  const subject = 'email' in account ? `email:${account.email}` : `user:${account.userId}`;
  return createHmac('sha256', keys.clientFingerprint).update(`account:${subject}`).digest('hex');
}
