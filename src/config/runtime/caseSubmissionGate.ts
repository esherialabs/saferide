import { appConfig } from '../appConfig';
import { getRuntimeConfigSnapshot, type RuntimeConfigSnapshot } from './runtimeConfigStore';

/**
 * Whether the app may send reports to SafeRide. This replaces the old
 * hard-coded BACKEND_SYNC_ENABLED const: the server decides through
 * `features.caseSubmission` in GET /api/config/runtime, which it sets only
 * when its ingestion and policy locks are all on. The app fails closed:
 * only a fresh answer from the server with exactly `true` turns it on.
 */
export const CASE_SUBMISSION_FEATURE = 'caseSubmission';

const MIN_MAX_AGE_MS = 5 * 60_000;
/** A config applied a little "in the future" means the device clock moved; treat it as stale. */
const CLOCK_SKEW_ALLOWANCE_MS = 60_000;

export type CaseSubmissionDecision = {
  enabled: boolean;
  reason: 'enabled' | 'flag_off' | 'config_missing' | 'config_stale';
};

/** Three missed refreshes, and never under five minutes. */
export function getCaseSubmissionMaxAgeMs(refreshSeconds = appConfig.remoteConfig.refreshSeconds): number {
  return Math.max(MIN_MAX_AGE_MS, 3 * Math.max(1, refreshSeconds) * 1000);
}

export function getCaseSubmissionDecision(
  snapshot: Pick<RuntimeConfigSnapshot, 'source' | 'features' | 'appliedAt'>,
  now = Date.now(),
  maxAgeMs = getCaseSubmissionMaxAgeMs(),
): CaseSubmissionDecision {
  // Bundled defaults and local overrides never switch sending on.
  if (snapshot.source !== 'remote' || !snapshot.appliedAt) return { enabled: false, reason: 'config_missing' };
  const appliedAt = Date.parse(snapshot.appliedAt);
  if (!Number.isFinite(appliedAt) || now - appliedAt > maxAgeMs || appliedAt - now > CLOCK_SKEW_ALLOWANCE_MS) {
    return { enabled: false, reason: 'config_stale' };
  }
  if (snapshot.features?.[CASE_SUBMISSION_FEATURE] !== true) return { enabled: false, reason: 'flag_off' };
  return { enabled: true, reason: 'enabled' };
}

export function isCaseSubmissionEnabled(now = Date.now()): boolean {
  return getCaseSubmissionDecision(getRuntimeConfigSnapshot(), now).enabled;
}
