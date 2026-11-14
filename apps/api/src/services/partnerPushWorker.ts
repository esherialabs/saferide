import { claimPartnerPushJob, settlePartnerPushJob } from '../repositories/partnerPushRepository.js';
import { openPushSubscription, type PartnerPushConfig } from './partnerPushProtocol.js';
import type { PushDelivery } from './partnerPushRelay.js';

export async function partnerPushStep(config: PartnerPushConfig): Promise<'idle' | PushDelivery> {
  const job = await claimPartnerPushJob();
  if (!job) return 'idle';
  let outcome: PushDelivery = 'retry';
  let subscription;
  try { subscription = openPushSubscription(config.sealKey, job.user_id, job.endpoint_hash, job.subscription_enc); }
  catch { await settlePartnerPushJob(job, 'refused'); return 'refused'; }
  try {
    const response = await fetch(`${config.relayUrl}/send`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12_000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.relaySecret}` },
      body: JSON.stringify({ subscription, kind: job.kind }),
    });
    if (response.ok) {
      const result = await response.json() as { outcome?: unknown };
      if (['accepted', 'expired', 'refused', 'retry'].includes(String(result.outcome))) outcome = result.outcome as PushDelivery;
    }
  } catch { /* Network/provider details can carry secrets: only the bounded outcome is stored. */ }
  await settlePartnerPushJob(job, outcome);
  return outcome;
}

export function startPartnerPushWorker(config: PartnerPushConfig, log: { warn(message: string): void }) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();
  function next() {
    if (stopped) return;
    running = partnerPushStep(config).then(() => undefined).catch(() => { log.warn('Partner notification worker could not complete a delivery step'); }).finally(() => {
      if (!stopped) timer = setTimeout(next, 5_000).unref();
    });
  }
  next();
  return { async stop() { stopped = true; clearTimeout(timer); await running; } };
}
