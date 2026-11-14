import { describe, expect, it } from 'vitest';

import { getCaseSubmissionDecision, getCaseSubmissionMaxAgeMs } from './caseSubmissionGate';

const NOW = Date.parse('2026-10-22T10:00:00.000Z');
const MAX_AGE = 15 * 60_000;

function snapshot(overrides: Partial<{ source: 'bundled' | 'override' | 'remote'; features: Record<string, boolean>; appliedAt?: string }> = {}) {
  return {
    source: 'remote' as const,
    features: { caseSubmission: true },
    appliedAt: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  };
}

describe('case submission switch (fails closed)', () => {
  it('is on only for a fresh server answer that says exactly true', () => {
    expect(getCaseSubmissionDecision(snapshot(), NOW, MAX_AGE)).toEqual({ enabled: true, reason: 'enabled' });
  });

  it('is off while the flag is off, missing or not strictly true', () => {
    expect(getCaseSubmissionDecision(snapshot({ features: { caseSubmission: false } }), NOW, MAX_AGE).reason).toBe('flag_off');
    expect(getCaseSubmissionDecision(snapshot({ features: {} }), NOW, MAX_AGE).reason).toBe('flag_off');
    expect(getCaseSubmissionDecision(
      snapshot({ features: { caseSubmission: 'true' as unknown as boolean } }),
      NOW,
      MAX_AGE,
    ).enabled).toBe(false);
  });

  it('is off without a server config: bundled defaults, a local override, or no applied time', () => {
    expect(getCaseSubmissionDecision(snapshot({ source: 'bundled' }), NOW, MAX_AGE)).toEqual({ enabled: false, reason: 'config_missing' });
    expect(getCaseSubmissionDecision(snapshot({ source: 'override' }), NOW, MAX_AGE)).toEqual({ enabled: false, reason: 'config_missing' });
    expect(getCaseSubmissionDecision(snapshot({ appliedAt: undefined }), NOW, MAX_AGE)).toEqual({ enabled: false, reason: 'config_missing' });
  });

  it('is off once the config is stale, future-dated or unreadable', () => {
    expect(getCaseSubmissionDecision(snapshot({ appliedAt: new Date(NOW - MAX_AGE - 1).toISOString() }), NOW, MAX_AGE).reason)
      .toBe('config_stale');
    expect(getCaseSubmissionDecision(snapshot({ appliedAt: new Date(NOW + 5 * 60_000).toISOString() }), NOW, MAX_AGE).reason)
      .toBe('config_stale');
    expect(getCaseSubmissionDecision(snapshot({ appliedAt: 'not-a-date' }), NOW, MAX_AGE).reason).toBe('config_stale');
  });

  it('allows three missed refreshes, never less than five minutes', () => {
    expect(getCaseSubmissionMaxAgeMs(300)).toBe(15 * 60_000);
    expect(getCaseSubmissionMaxAgeMs(10)).toBe(5 * 60_000);
  });
});
