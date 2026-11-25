import { afterEach, describe, expect, it, vi } from 'vitest';

const redis = vi.hoisted(() => ({
  incr: vi.fn(),
  decr: vi.fn(),
  expire: vi.fn(),
  del: vi.fn(),
}));
vi.mock('../../plugins/redis.js', () => ({ redis }));

import {
  PARTNER_LIMITER_REDIS_TIMEOUT_MS,
  enforcePartnerAuthRateLimit,
  refundPartnerClientAccountAttempt,
  reservePartnerClientAccountAttempt,
} from '../partnerRateLimit.js';

const keys = { clientFingerprint: 'client', accountFingerprint: 'account' };

describe('partner limiter against a stalled Redis', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fails closed with 503 within the deadline instead of holding the gate slot', async () => {
    vi.useFakeTimers();
    redis.incr.mockImplementation(() => new Promise(() => undefined));
    redis.decr.mockImplementation(() => new Promise(() => undefined));
    expect(PARTNER_LIMITER_REDIS_TIMEOUT_MS).toBeLessThanOrEqual(2_000);
    const reserve = reservePartnerClientAccountAttempt(keys).catch((error: unknown) => error);
    const limit = enforcePartnerAuthRateLimit({ clientFingerprint: 'client' }).catch((error: unknown) => error);
    const refund = refundPartnerClientAccountAttempt(keys);
    await vi.advanceTimersByTimeAsync(PARTNER_LIMITER_REDIS_TIMEOUT_MS);
    await expect(reserve).resolves.toMatchObject({ statusCode: 503, code: 'service_unavailable' });
    await expect(limit).resolves.toMatchObject({ statusCode: 503 });
    // A refund is best effort: it gives up quietly.
    await expect(refund).resolves.toBeUndefined();
  });
});
