/**
 * Makes metadata-stripped derivatives of released evidence, one file at a
 * time, and deletes the stored copies of derivatives whose rows are gone.
 *
 *   node dist/jobs/evidenceDerivativeJob.js [--limit=25]
 *
 * Run it as a one-shot process (cron or a timer), not inside the API server:
 * peak memory is about twice the largest evidence file (100 MiB cap) plus
 * the strip sandbox's 256 MB heap budget. Each file is stripped in a worker
 * thread with a 30 s budget, and each item has a 120 s overall timeout, so
 * one bad file cannot stall the run. It prints counts only, never
 * identifiers, keys or content.
 */
import { closeDb } from '../plugins/db.js';
import { runEvidenceDerivativeJob } from '../services/evidenceDerivatives.js';

function parseLimit(argv: string[]): number {
  const arg = argv.find(value => value.startsWith('--limit='));
  const limit = arg ? Number(arg.slice('--limit='.length)) : 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('--limit must be an integer from 1 to 1000');
  return limit;
}

try {
  const summary = await runEvidenceDerivativeJob({ limit: parseLimit(process.argv.slice(2)) });
  process.stdout.write(
    `Evidence derivatives: ${summary.ready} ready, ${summary.unsupported} unsupported, ${summary.failed} failed, ` +
      `${summary.lost} lost claims, ${summary.timedOut} timed out, ${summary.expired} expired claims, ` +
      `${summary.purged} purged, ${summary.purgeFailed} purge failures\n`,
  );
  if (summary.purgeFailed > 0 || summary.timedOut > 0) process.exitCode = 1;
} catch {
  process.stderr.write('Evidence derivative run failed closed; nothing was marked shareable by the failed step\n');
  process.exitCode = 1;
} finally {
  await closeDb().catch(() => undefined);
  // A timed-out item may still hold a socket; its claim goes stale and is retried later.
  process.exit();
}
