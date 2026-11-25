import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { partnerPushStep } from '../partnerPushWorker.js';
import { pushEndpointHash, sealPushSubscription } from '../partnerPushProtocol.js';
const repo = vi.hoisted(() => ({ claimPartnerPushJob: vi.fn(), settlePartnerPushJob: vi.fn() }));
vi.mock('../../repositories/partnerPushRepository.js', () => repo);
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
function fixture() {
  const key = randomBytes(32); const userId = randomUUID();
  const curve = createECDH('prime256v1'); curve.generateKeys();
  const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic', keys: { p256dh: curve.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
  const hash = pushEndpointHash(subscription.endpoint);
  const job = { id: randomUUID(), subscription_id: randomUUID(), user_id: userId, endpoint_hash: hash, subscription_enc: sealPushSubscription(key, userId, hash, subscription), kind: 'attention', attempts: 1, claim_token: randomUUID() };
  const config = { sealKey: key, publicKey: subscription.keys.p256dh, relaySecret: 'ab'.repeat(32), relayUrl: 'http://push-relay-internal:3335' };
  return { subscription, job, config };
}
describe('push outbox delivery step', () => {
  it('decrypts and sends only subscription + fixed kind to the isolated relay', async () => {
    const f = fixture(); repo.claimPartnerPushJob.mockResolvedValue(f.job);
    const transport = vi.fn(async () => new Response(JSON.stringify({ outcome: 'accepted' }), { status: 200 })); vi.stubGlobal('fetch', transport);
    expect(await partnerPushStep(f.config)).toBe('accepted');
    expect(transport.mock.calls[0][0]).toBe('http://push-relay-internal:3335/send');
    const request = (transport.mock.calls as unknown as Array<[string, RequestInit]>)[0][1];
    expect(JSON.parse(String(request.body))).toEqual({ subscription: f.subscription, kind: 'attention' });
    expect(request.redirect).toBe('error');
    expect(repo.settlePartnerPushJob).toHaveBeenCalledWith(f.job, 'accepted');
  });
  it('retries a failed connection without leaking its error', async () => {
    const f = fixture(); repo.claimPartnerPushJob.mockResolvedValue(f.job);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('private endpoint and credential'); }));
    expect(await partnerPushStep(f.config)).toBe('retry');
    expect(repo.settlePartnerPushJob).toHaveBeenCalledWith(f.job, 'retry');
  });
  it('does not send a tampered or cross-user subscription', async () => {
    const f = fixture(); repo.claimPartnerPushJob.mockResolvedValue({ ...f.job, user_id: randomUUID() });
    const transport = vi.fn(); vi.stubGlobal('fetch', transport);
    expect(await partnerPushStep(f.config)).toBe('refused');
    expect(transport).not.toHaveBeenCalled();
  });
});
