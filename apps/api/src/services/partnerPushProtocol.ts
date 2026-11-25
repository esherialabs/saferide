import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, ECDH } from 'node:crypto';
import { z } from 'zod';

const HOSTS = new Set(['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com']);
export function allowedPushEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    // web-push uses Node's legacy URL parser: require the browser's canonical
    // URL so encoded hosts/backslashes cannot mean a different destination.
    return url.href === value && !/[\u0000-\u0020\\]/.test(value)
      && url.protocol === 'https:' && HOSTS.has(url.hostname) && !url.port && !url.username && !url.password
      && !url.hash && url.pathname.length > 1 && !/[%\s\\]/.test(url.hostname);
  } catch { return false; }
}
function pushKey(value: string, size: number): boolean {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== size) return false;
  if (size === 65) {
    try { ECDH.convertKey(bytes, 'prime256v1'); } catch { return false; }
  }
  return true;
}
export const pushSubscriptionSchema = z.object({
  endpoint: z.string().max(2048).refine(allowedPushEndpoint, 'Unsupported browser push provider'),
  keys: z.object({ p256dh: z.string().max(100).refine(value => pushKey(value, 65)), auth: z.string().max(32).refine(value => pushKey(value, 16)) }).strict(),
}).strict();
export type PartnerPushSubscription = z.infer<typeof pushSubscriptionSchema>;
export const PUSH_MESSAGE = JSON.stringify({ kind: 'attention' });
export const PUSH_TEST_MESSAGE = JSON.stringify({ kind: 'test' });

export type PartnerPushConfig = { publicKey: string; relayUrl: string; relaySecret: string; sealKey: Buffer };
/** The API has no internet route; only the isolated relay can contact a push provider. */
export function partnerPushConfig(masterKey: Buffer | null, input = process.env): PartnerPushConfig | null {
  const publicKey = input.PARTNER_PUSH_PUBLIC_KEY?.trim();
  const relaySecret = input.PARTNER_PUSH_RELAY_SECRET?.trim();
  if (!publicKey && !relaySecret) return null;
  if (!masterKey || !publicKey || !pushKey(publicKey, 65) || !relaySecret || !/^[a-f0-9]{64}$/.test(relaySecret)) {
    throw new Error('Partner push configuration is incomplete or invalid');
  }
  return { publicKey, relaySecret, relayUrl: 'http://push-relay-internal:3335',
    sealKey: Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), 'saferide-partner/push-subscription/v1', 32)) };
}
export function pushEndpointHash(endpoint: string): string { return createHash('sha256').update(endpoint).digest('hex'); }
export function sealPushSubscription(key: Buffer, userId: string, hash: string, subscription: PartnerPushSubscription): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`partner-push:v1:${userId}:${hash}`));
  const bytes = Buffer.concat([cipher.update(JSON.stringify(subscription), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), bytes.toString('base64url')].join('.');
}
export function openPushSubscription(key: Buffer, userId: string, hash: string, sealed: string): PartnerPushSubscription {
  const [version, iv, tag, bytes] = sealed.split('.');
  if (version !== 'v1' || !iv || !tag || !bytes) throw new Error('Invalid subscription envelope');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(`partner-push:v1:${userId}:${hash}`));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return pushSubscriptionSchema.parse(JSON.parse(Buffer.concat([decipher.update(Buffer.from(bytes, 'base64url')), decipher.final()]).toString('utf8')));
}
