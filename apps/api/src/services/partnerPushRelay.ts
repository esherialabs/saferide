import Fastify from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import webpush from 'web-push';
import { z } from 'zod';
import { PUSH_MESSAGE, PUSH_TEST_MESSAGE, pushSubscriptionSchema } from './partnerPushProtocol.js';

export type PushDelivery = 'accepted' | 'expired' | 'retry' | 'refused';
export type PushSender = (subscription: webpush.PushSubscription, message: string) => Promise<unknown>;

/** No database, survivor data, request logging, redirects, or arbitrary destination URLs. */
export function buildPartnerPushRelay(secret: string, send: PushSender) {
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('Push relay authentication is not configured');
  const app = Fastify({ logger: false, bodyLimit: 4096, requestTimeout: 15_000 });
  app.get('/health', async () => ({ ok: true }));
  app.post('/send', async (request, reply) => {
    const given = Buffer.from(String(request.headers.authorization ?? ''));
    const expected = Buffer.from(`Bearer ${secret}`);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return reply.code(401).send({ outcome: 'refused' });
    const input = z.object({ subscription: pushSubscriptionSchema, kind: z.enum(['attention', 'test']) }).strict().safeParse(request.body);
    if (!input.success) return reply.code(400).send({ outcome: 'refused' });
    try {
      await send(input.data.subscription, input.data.kind === 'test' ? PUSH_TEST_MESSAGE : PUSH_MESSAGE);
      return { outcome: 'accepted' satisfies PushDelivery };
    } catch (error) {
      const status = error && typeof error === 'object' && 'statusCode' in error ? Number(error.statusCode) : 0;
      // Provider errors may contain endpoint URLs and request headers. Never return or log them.
      return { outcome: (status === 404 || status === 410 ? 'expired' : status === 400 || status === 401 || status === 403 ? 'refused' : 'retry') satisfies PushDelivery };
    }
  });
  return app;
}

export function vapidSender(input: { publicKey: string; privateKey: string; subject: string }): PushSender {
  return (subscription, message) => webpush.sendNotification(subscription, message, {
    vapidDetails: { publicKey: input.publicKey, privateKey: input.privateKey, subject: input.subject },
    TTL: 300, urgency: 'high', topic: 'saferide-attention', timeout: 10_000,
  });
}
