import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../http/errors.js';
import { PARTNER_AUTH_GATE_POLICY, PartnerAuthGate } from '../partnerAuthGate.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('partner auth gate', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('defaults to one operation at a time, 16 waiting plus 8 priority, 5 s in the queue', () => {
    expect(PARTNER_AUTH_GATE_POLICY).toEqual({
      maxConcurrent: 1, maxQueued: 16, maxQueuedPriority: 8, queueTimeoutMs: 5_000, retryAfterSeconds: 5,
    });
  });

  it('serves priority waiters before the general queue, and lets them in when the general queue is full', async () => {
    const gate = new PartnerAuthGate({ maxConcurrent: 1, maxQueued: 2, maxQueuedPriority: 1, queueTimeoutMs: 10_000, retryAfterSeconds: 5 });
    const hold = deferred();
    const order: string[] = [];
    const job = (name: string, priority = false) => gate.run(async () => { order.push(name); }, { priority });
    const first = gate.run(() => hold.promise);
    const jobs = [job('general-1'), job('general-2'), job('known-1', true)];
    expect(gate.stats).toEqual({ active: 1, queued: 2, priorityQueued: 1 });
    // General queue full: a general request is refused, while a second priority
    // request (priority room also full) falls back to it and is refused too.
    await expect(gate.acquire()).rejects.toMatchObject({ code: 'partner_auth_busy' });
    await expect(gate.acquire({ priority: true })).rejects.toMatchObject({ code: 'partner_auth_busy' });
    hold.resolve();
    await first;
    await Promise.all(jobs);
    expect(order).toEqual(['known-1', 'general-1', 'general-2']);
    expect(gate.stats).toEqual({ active: 0, queued: 0, priorityQueued: 0 });
  });

  it('puts a priority request in the general queue when no priority room is configured', async () => {
    const gate = new PartnerAuthGate({ maxConcurrent: 1, maxQueued: 1, queueTimeoutMs: 10_000, retryAfterSeconds: 5 });
    const release = await gate.acquire();
    const waiting = gate.acquire({ priority: true });
    expect(gate.stats).toEqual({ active: 1, queued: 1, priorityQueued: 0 });
    release();
    (await waiting)();
    expect(gate.stats).toEqual({ active: 0, queued: 0, priorityQueued: 0 });
  });

  it('never runs more than maxConcurrent at once and serves waiters first come, first served', async () => {
    const gate = new PartnerAuthGate({ maxConcurrent: 2, maxQueued: 16, queueTimeoutMs: 10_000, retryAfterSeconds: 5 });
    let running = 0;
    let peak = 0;
    const started: number[] = [];
    const jobs = Array.from({ length: 10 }, (_, index) => gate.run(async () => {
      started.push(index);
      running += 1;
      peak = Math.max(peak, running);
      await new Promise(resolve => setTimeout(resolve, 5));
      running -= 1;
      return index;
    }));
    expect(gate.stats).toEqual({ active: 2, queued: 8, priorityQueued: 0 });
    await expect(Promise.all(jobs)).resolves.toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(peak).toBe(2);
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(gate.stats).toEqual({ active: 0, queued: 0, priorityQueued: 0 });
  });

  it('refuses at once with 503 and Retry-After when the queue is full', async () => {
    const gate = new PartnerAuthGate({ maxConcurrent: 1, maxQueued: 1, queueTimeoutMs: 10_000, retryAfterSeconds: 7 });
    const hold = deferred();
    const first = gate.run(() => hold.promise);
    const second = gate.run(async () => 'second');
    const refused = await gate.acquire().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AppError);
    expect(refused).toMatchObject({ statusCode: 503, code: 'partner_auth_busy', retryAfterSeconds: 7 });
    hold.resolve();
    await first;
    await expect(second).resolves.toBe('second');
  });

  it('gives up on a waiter after the queue timeout and never hands it a slot later', async () => {
    vi.useFakeTimers();
    const gate = new PartnerAuthGate({ maxConcurrent: 1, maxQueued: 4, queueTimeoutMs: 1_000, retryAfterSeconds: 5 });
    const release = await gate.acquire();
    const waiting = gate.acquire();
    const outcome = waiting.then(() => 'granted', (error: AppError) => error.code);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(outcome).resolves.toBe('partner_auth_busy');
    expect(gate.stats).toEqual({ active: 1, queued: 0, priorityQueued: 0 });
    release();
    expect(gate.stats).toEqual({ active: 0, queued: 0, priorityQueued: 0 });
  });

  it('frees the slot when the work throws, and a second release does nothing', async () => {
    const gate = new PartnerAuthGate({ maxConcurrent: 1, maxQueued: 0, queueTimeoutMs: 0, retryAfterSeconds: 5 });
    await expect(gate.run(async () => { throw new Error('synthetic failure'); })).rejects.toThrow('synthetic failure');
    expect(gate.stats).toEqual({ active: 0, queued: 0, priorityQueued: 0 });
    const release = await gate.acquire();
    release();
    release();
    expect(gate.stats).toEqual({ active: 0, queued: 0, priorityQueued: 0 });
    const again = await gate.acquire();
    expect(gate.stats).toEqual({ active: 1, queued: 0, priorityQueued: 0 });
    again();
  });
});
