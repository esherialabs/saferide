import { createECDH, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { allowedPushEndpoint, openPushSubscription, partnerPushConfig, PUSH_MESSAGE, PUSH_TEST_MESSAGE, pushEndpointHash, pushSubscriptionSchema, sealPushSubscription } from '../partnerPushProtocol.js';
import { buildPartnerPushRelay } from '../partnerPushRelay.js';

function subscription() {
  const curve = createECDH('prime256v1'); curve.generateKeys();
  return { endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/synthetic-test', keys: { p256dh: curve.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}
const relaySecret = 'ab'.repeat(32);

describe('partner push minimisation and isolation', () => {
  it('allows only the selected HTTPS browser providers, with real EC and auth key sizes', () => {
    expect(pushSubscriptionSchema.safeParse(subscription()).success).toBe(true);
    for (const endpoint of ['http://fcm.googleapis.com/send', 'https://127.0.0.1/send', 'https://fcm.googleapis.com.attacker.invalid/send', 'https://fcm.googleapis.com:8443/send', 'https://user@fcm.googleapis.com/send', 'https://web.push.apple.com/path#secret', 'https://%66cm.googleapis.com/send', 'https://fcm%2egoogleapis.com/send', 'https://fcm.\tgoogleapis.com/send', 'https://fcm.googleapis.com\\send']) expect(allowedPushEndpoint(endpoint)).toBe(false);
    const bad = subscription(); bad.keys.p256dh = Buffer.alloc(65).toString('base64url');
    expect(pushSubscriptionSchema.safeParse(bad).success).toBe(false);
  });
  it('seals browser credentials with purpose, user and endpoint binding', () => {
    const value = subscription(); const key = randomBytes(32); const hash = pushEndpointHash(value.endpoint);
    const sealed = sealPushSubscription(key, 'synthetic-user', hash, value);
    expect(sealed).not.toContain(value.endpoint);
    expect(openPushSubscription(key, 'synthetic-user', hash, sealed)).toEqual(value);
    expect(() => openPushSubscription(key, 'different-user', hash, sealed)).toThrow();
    expect(() => openPushSubscription(key, 'synthetic-user', 'different-endpoint', sealed)).toThrow();
    expect(() => openPushSubscription(randomBytes(32), 'synthetic-user', hash, sealed)).toThrow();
  });
  it('leaves push off when unconfigured and refuses a partial configuration', () => {
    expect(partnerPushConfig(null, {})).toBeNull();
    expect(() => partnerPushConfig(randomBytes(32), { PARTNER_PUSH_RELAY_SECRET: relaySecret })).toThrow('incomplete');
  });
  it('authenticates the relay and sends only its fixed generic messages', async () => {
    const send = vi.fn(async () => ({})); const app = buildPartnerPushRelay(relaySecret, send); const value = subscription();
    try {
      const headers = { authorization: `Bearer ${relaySecret}` };
      expect((await app.inject({ method: 'POST', url: '/send', payload: { subscription: value, kind: 'attention' } })).statusCode).toBe(401);
      expect(send).not.toHaveBeenCalled();
      expect((await app.inject({ method: 'POST', url: '/send', headers, payload: { subscription: value, kind: 'attention', narrative: 'never accepted' } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/send', headers, payload: { subscription: value, kind: 'attention' } })).json()).toEqual({ outcome: 'accepted' });
      expect(send).toHaveBeenLastCalledWith(value, PUSH_MESSAGE);
      await app.inject({ method: 'POST', url: '/send', headers, payload: { subscription: value, kind: 'test' } });
      expect(send).toHaveBeenLastCalledWith(value, PUSH_TEST_MESSAGE);
    } finally { await app.close(); }
  });
  it.each([[410, 'expired'], [404, 'expired'], [429, 'retry'], [503, 'retry'], [403, 'refused']])('sanitises provider status %i to %s', async (statusCode, outcome) => {
    const app = buildPartnerPushRelay(relaySecret, async () => { throw { statusCode, body: 'sensitive provider data', headers: { authorization: 'secret' } }; });
    try {
      const response = await app.inject({ method: 'POST', url: '/send', headers: { authorization: `Bearer ${relaySecret}` }, payload: { subscription: subscription(), kind: 'attention' } });
      expect(response.json()).toEqual({ outcome });
      expect(response.body).not.toContain('sensitive');
    } finally { await app.close(); }
  });
});
