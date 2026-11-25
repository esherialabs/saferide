import { AppError } from '../http/errors.js';
import { redis } from '../plugins/redis.js';

export const PARTNER_AUTH_REQUESTS_PER_MINUTE = 30;

/** Per client x account: failures allowed before that client is blocked for that account. */
export const PARTNER_CLIENT_ACCOUNT_POLICY = {
  maxFailures: 5,
  windowMinutes: 15,
  baseBlockMinutes: 15,
  maxBlockMinutes: 24 * 60,
  strikeMemoryHours: 24,
} as const;

function unavailable(error: unknown): never {
  if (error instanceof AppError) throw error;
  throw new AppError(503, 'service_unavailable', 'Partner sign-in is unavailable');
}

/**
 * Longest wait for one limiter command. The client x account reservation
 * runs while a partner auth gate slot is held, and the shared Redis client
 * has no command timeout (it queues commands while reconnecting), so a
 * stalled Redis must fail the attempt closed within seconds instead.
 */
export const PARTNER_LIMITER_REDIS_TIMEOUT_MS = 1_500;

class LimiterTimeout extends Error {}

function withinDeadline<T>(command: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new LimiterTimeout('Partner limiter timed out')), PARTNER_LIMITER_REDIS_TIMEOUT_MS);
  });
  return Promise.race([command, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Per-client limit on unauthenticated partner auth requests, keyed by a
 * keyed fingerprint of the real client address (never the raw address).
 * Fails closed if Redis is down, like the RSI limiter.
 */
export async function enforcePartnerAuthRateLimit(params: {
  clientFingerprint: string;
  requestsPerMinute?: number;
}): Promise<void> {
  const minute = Math.floor(Date.now() / 60_000);
  const key = `saferide:partner-auth-rate:${minute}:${params.clientFingerprint}`;
  try {
    const count = await withinDeadline(redis.incr(key));
    if (count === 1) await withinDeadline(redis.expire(key, 120));
    if (count > (params.requestsPerMinute ?? PARTNER_AUTH_REQUESTS_PER_MINUTE)) {
      throw new AppError(429, 'rate_limited', 'Too many sign-in attempts; wait a minute and try again');
    }
  } catch (error) {
    unavailable(error);
  }
}

function clientAccountKeys(params: { clientFingerprint: string; accountFingerprint: string }) {
  const key = `saferide:partner-auth-ca:${params.clientFingerprint}:${params.accountFingerprint}`;
  return { key, strikes: `${key}:strikes` };
}

/**
 * Reserves one attempt for this client against this account BEFORE any
 * password or TOTP work (INCR is atomic, so concurrent requests cannot
 * overshoot). After `maxFailures` unrefunded attempts in the window the
 * client is blocked for that account for 15 min, doubling per repeat block
 * (24 h memory, capped at 24 h). Other clients, such as the real user, are
 * unaffected. Returns false when blocked. Fails closed without Redis.
 */
export async function reservePartnerClientAccountAttempt(params: {
  clientFingerprint: string;
  accountFingerprint: string;
}): Promise<boolean> {
  const policy = PARTNER_CLIENT_ACCOUNT_POLICY;
  const keys = clientAccountKeys(params);
  try {
    const count = await withinDeadline(redis.incr(keys.key));
    if (count === 1) await withinDeadline(redis.expire(keys.key, policy.windowMinutes * 60));
    if (count <= policy.maxFailures) return true;
    if (count === policy.maxFailures + 1) {
      const strikes = await withinDeadline(redis.incr(keys.strikes));
      await withinDeadline(redis.expire(keys.strikes, policy.strikeMemoryHours * 3600));
      const blockMinutes = Math.min(policy.baseBlockMinutes * 2 ** Math.min(strikes - 1, 16), policy.maxBlockMinutes);
      await withinDeadline(redis.expire(keys.key, blockMinutes * 60));
    }
    return false;
  } catch (error) {
    return unavailable(error);
  }
}

/** Gives back a reserved attempt that turned out to be correct. Best effort. */
export async function refundPartnerClientAccountAttempt(params: {
  clientFingerprint: string;
  accountFingerprint: string;
}): Promise<void> {
  const keys = clientAccountKeys(params);
  try {
    const remaining = await withinDeadline(redis.decr(keys.key));
    if (remaining <= 0) await withinDeadline(redis.del(keys.key));
  } catch {
    // A failed refund only makes the limit stricter; never fail the sign-in for it.
  }
}
