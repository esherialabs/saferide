/**
 * Malware scanner readiness, for operators (`saferide.sh status` and
 * `verify` run it in the API container):
 *
 *   node dist/jobs/scannerStatus.js
 *
 * Asks clamd for PING and VERSION over the API's own route to it (the
 * `scan` network), compares it with the privacy controls' malware scan
 * policy, and counts the scan queue. Prints versions and counts only, never
 * identifiers. Exit 0 when clamd answers, 1 when it does not (a fresh
 * install's first signature download takes a few minutes).
 */
import { loadPrivacyControls } from '../config/privacyControls.js';
import { closeDb } from '../plugins/db.js';
import { countEvidenceScanQueue } from '../repositories/evidenceScanRepository.js';
import { isApprovedScannerReady, probeScanner } from '../services/clamav/scannerHealth.js';
import { isScanPolicyCurrent } from '../services/evidenceMalwareScan.js';

const lines: string[] = [];
let exitCode = 0;
try {
  const status = await probeScanner();
  const now = Date.now();
  if (status.state === 'unconfigured') {
    lines.push('scanner: not configured (CLAMD_HOST is unset); evidence ingestion is refused');
    exitCode = 1;
  } else if (status.state !== 'ready' || !status.lastHealthy) {
    lines.push(`scanner: clamd not answering (${status.lastError ?? 'unknown'}); still loading or downloading signatures?`);
    exitCode = 1;
  } else {
    const healthy = status.lastHealthy;
    const age = healthy.signatureDate ? Math.round((now - Date.parse(healthy.signatureDate)) / 3_600_000) : null;
    lines.push(`scanner: ready ${healthy.scanner}, signatures ${healthy.definitionVersion ?? 'none loaded'}${age === null ? '' : `, ${age}h old`}`);
  }

  try {
    const policy = loadPrivacyControls().malwareScanPolicy;
    if (policy.status !== 'enabled') {
      lines.push(`policy: disabled (${policy.reason ?? 'no reason given'}); evidence stays refused until it names this scanner`);
    } else if (!isScanPolicyCurrent(policy, now)) {
      lines.push(`policy: enabled for ${policy.scanner} but outside its validity window`);
    } else if (isApprovedScannerReady(policy, now)) {
      lines.push(`policy: approves ${policy.scanner} (${policy.definitionVersion}); evidence can be scanned and released`);
    } else {
      lines.push(`policy: approves ${policy.scanner} (${policy.definitionVersion}), which clamd does not currently satisfy`);
    }
  } catch {
    lines.push('policy: privacy controls unreadable');
  }

  try {
    const queue = await countEvidenceScanQueue();
    lines.push(`queue: ${queue.pending} pending (${queue.due} due), ${queue.failed} failed`);
  } catch {
    lines.push('queue: unavailable (database)');
  }
} catch {
  lines.push('scanner: status check failed');
  exitCode = 1;
}

process.stdout.write(`${lines.join('\n')}\n`);
await closeDb().catch(() => undefined);
process.exit(exitCode);
