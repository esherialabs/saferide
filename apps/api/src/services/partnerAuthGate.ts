/**
 * Process-wide cap on partner credential work (scrypt password hashing and
 * verification, and the TOTP step) inside the API process that also serves
 * survivors. Async scrypt runs on the libuv thread pool (4 threads by
 * default, shared with file and DNS work) and each N=2^17 hash holds
 * 128 MiB, so a burst of partner sign-ins could otherwise take the pool, the
 * CPU and the memory the survivor routes need.
 *
 * At most `maxConcurrent` operations run at once; up to `maxQueued` more
 * wait, first come first served, for at most `queueTimeoutMs`. Anything
 * beyond that is refused at once with 503 and Retry-After. Routes take the
 * slot BEFORE reserving an attempt (Redis or SQL), so a refusal here never
 * counts against an account: flooding the gate can delay a caseworker's
 * sign-in but cannot lock their account. Per-client and per-account limits
 * still apply behind the gate, and the partner auth database statements and
 * limiter commands are time-bounded (plugins/db.ts, partnerRateLimit.ts), so
 * a stalled dependency cannot hold a slot for long.
 *
 * Priority lane: requests that already proved something a flood cannot
 * fake (a pre-MFA session, an enrolment link, or a signed known-device
 * cookie from an earlier full sign-in) wait in their own queue of
 * `maxQueuedPriority`, which is always served before the general queue. A
 * flood of anonymous password guesses therefore delays a known caseworker
 * by at most about one slot turnover instead of starving them; if the
 * priority queue is full the request falls back to the general queue.
 */
import { AppError } from '../http/errors.js';

export type PartnerAuthGatePolicy = {
  maxConcurrent: number;
  maxQueued: number;
  /** Waiting room for priority requests, served first. Default 0: none. */
  maxQueuedPriority?: number;
  queueTimeoutMs: number;
  retryAfterSeconds: number;
};

/**
 * One hash at a time. Load test on the real container limits (1 CPU,
 * 512 MiB; 40-worker sign-in flood plus 20 survivor req/s, 60 s): with one
 * slot survivor p95 was 41 ms and peak memory 188 MiB, against 62 ms and
 * 324 MiB with two, for the same sign-in throughput (one CPU does one
 * N=2^17 hash at a time either way), and known caseworkers waited less.
 */
export const PARTNER_AUTH_GATE_POLICY: PartnerAuthGatePolicy = {
  maxConcurrent: 1,
  maxQueued: 16,
  maxQueuedPriority: 8,
  queueTimeoutMs: 5_000,
  retryAfterSeconds: 5,
};

/** Releases a slot; calling it again does nothing. */
export type PartnerAuthGateRelease = () => void;

export type PartnerAuthGateOptions = { priority?: boolean };

type Waiter = {
  grant: (release: PartnerAuthGateRelease) => void;
  timer: NodeJS.Timeout;
};

export function partnerAuthBusy(retryAfterSeconds: number): AppError {
  const error = new AppError(503, 'partner_auth_busy', 'Partner sign-in is busy; try again in a few seconds');
  error.retryAfterSeconds = retryAfterSeconds;
  return error;
}

export class PartnerAuthGate {
  readonly policy: PartnerAuthGatePolicy;
  private active = 0;
  private readonly priority: Waiter[] = [];
  private readonly general: Waiter[] = [];

  constructor(policy: PartnerAuthGatePolicy = PARTNER_AUTH_GATE_POLICY) {
    if (policy.maxConcurrent < 1 || policy.maxQueued < 0 || (policy.maxQueuedPriority ?? 0) < 0 || policy.queueTimeoutMs < 0) {
      throw new Error('Invalid partner auth gate policy');
    }
    this.policy = policy;
  }

  get stats(): { active: number; queued: number; priorityQueued: number } {
    return { active: this.active, queued: this.general.length, priorityQueued: this.priority.length };
  }

  /** Resolves with a release function once a slot is free; rejects with 503 when saturated. */
  acquire(options: PartnerAuthGateOptions = {}): Promise<PartnerAuthGateRelease> {
    if (this.active < this.policy.maxConcurrent) {
      this.active += 1;
      return Promise.resolve(this.releaser());
    }
    if (options.priority && this.priority.length < (this.policy.maxQueuedPriority ?? 0)) return this.wait(this.priority);
    if (this.general.length < this.policy.maxQueued) return this.wait(this.general);
    return Promise.reject(partnerAuthBusy(this.policy.retryAfterSeconds));
  }

  /** Runs `work` holding one slot. */
  async run<T>(work: () => Promise<T>, options: PartnerAuthGateOptions = {}): Promise<T> {
    const release = await this.acquire(options);
    try {
      return await work();
    } finally {
      release();
    }
  }

  private wait(queue: Waiter[]): Promise<PartnerAuthGateRelease> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        grant: resolve,
        timer: setTimeout(() => {
          const index = queue.indexOf(waiter);
          if (index !== -1) queue.splice(index, 1);
          reject(partnerAuthBusy(this.policy.retryAfterSeconds));
        }, this.policy.queueTimeoutMs),
      };
      queue.push(waiter);
    });
  }

  private releaser(): PartnerAuthGateRelease {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.priority.shift() ?? this.general.shift();
      if (next) {
        // Hand the slot straight to the next waiter: `active` is unchanged.
        clearTimeout(next.timer);
        next.grant(this.releaser());
      } else {
        this.active -= 1;
      }
    };
  }
}

/** The one gate shared by every partner auth route in this process. */
export const partnerAuthGate = new PartnerAuthGate();
