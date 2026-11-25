/**
 * The API's view of its malware scanner (clamd), refreshed in the
 * background with PING and VERSION, so request handlers can check it
 * synchronously and never wait on clamd.
 *
 * Evidence ingestion and the app's `caseSubmission` feature need a current
 * approved scanner: the privacy controls' malware scan policy must be
 * enabled and in its validity window (checked by the callers), AND
 * `isApprovedScannerReady(policy)` must hold: clamd answered recently, it is
 * the scanner the policy names (e.g. "clamav 1.5.4"), and its signatures
 * meet the policy's definition rule (services/malwareScanPolicy.ts).
 * Unconfigured (no CLAMD_HOST), never reached, or silent for longer than the
 * grace period: not ready, so ingestion fails closed.
 */
import { env } from '../../config/env.js';
import { definitionMeetsPolicy, formatClamavDefinitionVersion } from '../malwareScanPolicy.js';
import { ClamdClient, ClamdError, type ClamdErrorCode } from './clamdClient.js';

/** clamd blocks while it reloads signatures (ConcurrentDatabaseReload no); ride out a reload or two. */
export const SCANNER_HEALTH_GRACE_MS = 2 * 60 * 1000;
export const SCANNER_PROBE_INTERVAL_MS = 30 * 1000;

export type ScannerSnapshot = {
  /** e.g. "clamav 1.5.4" */
  scanner: string;
  /** e.g. "clamav-daily-28161 (2026-10-22T06:24:11Z)", or null when clamd reports no daily database. */
  definitionVersion: string | null;
  signatureDate: string | null;
  /** epoch ms of the probe */
  at: number;
};

export type ScannerStatus = {
  state: 'unconfigured' | 'unknown' | 'ready' | 'unavailable';
  /** The last successful probe (kept through short outages). */
  lastHealthy: ScannerSnapshot | null;
  lastCheckedAt: number | null;
  lastError: ClamdErrorCode | null;
};

type ScanPolicy = {
  status: 'enabled' | 'disabled';
  scanner: string | null;
  definitionVersion: string | null;
};

let status: ScannerStatus = { state: 'unknown', lastHealthy: null, lastCheckedAt: null, lastError: null };
let sharedClient: ClamdClient | null = null;

/** The configured clamd, or null when CLAMD_HOST is unset. */
export function getClamdClient(): ClamdClient | null {
  if (!env.clamdHost) return null;
  if (!sharedClient) sharedClient = new ClamdClient({ host: env.clamdHost, port: env.clamdPort });
  return sharedClient;
}

export function getScannerStatus(): ScannerStatus {
  if (!env.clamdHost) return { ...status, state: 'unconfigured' };
  return status;
}

/** PING and VERSION once and update the cached status. Never throws. */
export async function probeScanner(client: ClamdClient | null = getClamdClient(), now = () => Date.now()): Promise<ScannerStatus> {
  if (!client) {
    status = { state: 'unconfigured', lastHealthy: null, lastCheckedAt: now(), lastError: null };
    return status;
  }
  try {
    await client.ping();
    const version = await client.version();
    const at = now();
    status = {
      state: 'ready',
      lastHealthy: {
        scanner: version.scanner,
        definitionVersion: version.signatureVersion !== null && version.signatureDate
          ? formatClamavDefinitionVersion(version.signatureVersion, version.signatureDate)
          : null,
        signatureDate: version.signatureDate?.toISOString() ?? null,
        at,
      },
      lastCheckedAt: at,
      lastError: null,
    };
  } catch (error) {
    status = {
      state: 'unavailable',
      lastHealthy: status.lastHealthy,
      lastCheckedAt: now(),
      lastError: error instanceof ClamdError ? error.code : 'protocol_error',
    };
  }
  return status;
}

/**
 * True when clamd answered within the grace period as the scanner the
 * policy names, with signatures the policy accepts now. The policy's own
 * status and validity window are the caller's check.
 */
export function isApprovedScannerReady(policy: ScanPolicy, now = Date.now()): boolean {
  if (policy.status !== 'enabled' || !policy.scanner || !policy.definitionVersion) return false;
  const current = getScannerStatus();
  const healthy = current.lastHealthy;
  if (current.state === 'unconfigured' || !healthy) return false;
  if (now - healthy.at > SCANNER_HEALTH_GRACE_MS || healthy.at - now > SCANNER_HEALTH_GRACE_MS) return false;
  return healthy.scanner === policy.scanner && definitionMeetsPolicy(policy.definitionVersion, healthy.definitionVersion, now);
}

/** Probes now and then every `intervalMs` (timer unref'd). Returns a stop function. */
export function startScannerHealthMonitor(options: { intervalMs?: number } = {}): () => void {
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await probeScanner();
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), options.intervalMs ?? SCANNER_PROBE_INTERVAL_MS);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export function resetScannerStatusForTests(next?: Partial<ScannerStatus>): void {
  status = { state: 'unknown', lastHealthy: null, lastCheckedAt: null, lastError: null, ...next };
  sharedClient = null;
}
