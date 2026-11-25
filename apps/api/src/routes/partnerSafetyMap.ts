import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest, serviceUnavailable } from '../http/errors.js';
import { getPartnerSession, requirePartnerSession } from '../middleware/partnerSession.js';
import { listPartnerSafetyMapRecords, SAFETY_MAP_CASE_LIMIT } from '../repositories/partnerSafetyMapRepository.js';
import { recordPartnerAccess } from '../repositories/partnerRepository.js';
import { buildPartnerSafetyMap } from '../services/partnerSafetyMap.js';

/** Register inside the existing guarded /partner/v1 scope, never on the public API. */
export async function registerPartnerSafetyMapRoutes(scope: FastifyInstance): Promise<void> {
  scope.get('/safety-map', { preHandler: requirePartnerSession }, async request => {
    const session = getPartnerSession(request);
    const parsed = z.object({ days: z.coerce.number().int().refine(days => [7, 30, 90].includes(days)).default(30) }).strict().safeParse(request.query ?? {});
    async function audit(outcome: 'success' | 'denied') {
      try {
      await recordPartnerAccess({ orgId: session.orgId, actor: { type: 'partner_user', userId: session.userId },
        action: 'partner.summary.read', outcome, requestId: request.id });
      } catch { throw serviceUnavailable('The partner service is unavailable'); }
    }
    if (!parsed.success) { await audit('denied'); throw badRequest('Invalid map window'); }
    const page = await listPartnerSafetyMapRecords(session.orgId, parsed.data.days);
    await audit('success');
    return buildPartnerSafetyMap(page.records, { days: parsed.data.days, limit: SAFETY_MAP_CASE_LIMIT, truncated: page.truncated });
  });
}
