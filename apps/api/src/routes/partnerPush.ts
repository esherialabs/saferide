import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPartnerSession, requirePartnerCsrf, requirePartnerSession } from '../middleware/partnerSession.js';
import { conflict, serviceUnavailable } from '../http/errors.js';
import { enqueuePartnerPushTest, partnerPushStatus, subscribePartnerPush, unsubscribePartnerPush } from '../repositories/partnerPushRepository.js';
import { pushEndpointHash, pushSubscriptionSchema, sealPushSubscription, type PartnerPushConfig } from '../services/partnerPushProtocol.js';

export async function registerPartnerPushRoutes(scope: FastifyInstance, config: PartnerPushConfig | null): Promise<void> {
  scope.get('/notifications', { preHandler: requirePartnerSession }, async request => {
    const status = await partnerPushStatus(getPartnerSession(request).sessionId);
    return { configured: config !== null, publicKey: config?.publicKey ?? null, ...status };
  });
  scope.post('/notifications/subscribe', { bodyLimit: 4096, preHandler: [requirePartnerSession, requirePartnerCsrf] }, async request => {
    if (!config) throw serviceUnavailable('Browser notifications are not configured');
    const subscription = pushSubscriptionSchema.parse(request.body);
    const session = getPartnerSession(request);
    const hash = pushEndpointHash(subscription.endpoint);
    await subscribePartnerPush(session, { hash, sealed: sealPushSubscription(config.sealKey, session.userId, hash, subscription), requestId: request.id });
    return { enabled: true };
  });
  scope.post('/notifications/unsubscribe', { preHandler: [requirePartnerSession, requirePartnerCsrf] }, async request => {
    z.object({}).strict().parse(request.body ?? {});
    await unsubscribePartnerPush(getPartnerSession(request), request.id);
    return { enabled: false };
  });
  scope.post('/notifications/test', { preHandler: [requirePartnerSession, requirePartnerCsrf] }, async (request, reply) => {
    if (!config) throw serviceUnavailable('Browser notifications are not configured');
    z.object({}).strict().parse(request.body ?? {});
    const queued = await enqueuePartnerPushTest(getPartnerSession(request), request.id);
    if (!queued) throw conflict('Enable notifications first, or wait for the pending test');
    return reply.code(202).send({ queued: true });
  });
}
