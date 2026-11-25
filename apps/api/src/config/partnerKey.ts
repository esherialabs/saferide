const placeholderPattern = /^(replace|change|your|todo|example|placeholder|xxx)/i;

/**
 * Decodes a 32-byte key given as 64 hex characters or (url-safe) base64.
 * Returns null for anything else, including placeholders.
 */
export function decodePartnerKey(value: string | undefined): Buffer | null {
  if (!value || placeholderPattern.test(value)) return null;
  let decoded: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    decoded = Buffer.from(value, 'hex');
  } else if (/^[A-Za-z0-9+/_-]{43}={0,1}$/.test(value)) {
    decoded = Buffer.from(value, 'base64');
  } else {
    return null;
  }
  return decoded.length === 32 ? decoded : null;
}
