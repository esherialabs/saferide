/**
 * The cached scanner status the request path reads: ready only while clamd
 * answered recently as the scanner the policy names, with signatures the
 * policy accepts. clamd is a stand-in object here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const envState = vi.hoisted(() => ({ clamdHost: 'clamd-scan' as string | undefined, clamdPort: 3310 }));
vi.mock('../../../config/env.js', () => ({ env: envState }));

import { ClamdError, type ClamdClient } from '../clamdClient.js';
import {
  SCANNER_HEALTH_GRACE_MS,
  getScannerStatus,
  isApprovedScannerReady,
  probeScanner,
  resetScannerStatusForTests,
} from '../scannerHealth.js';

const SIGNED = Date.parse('2026-10-22T06:24:11Z');
const NOW = SIGNED + 3 * 3600_000;
const policy = { status: 'enabled' as const, scanner: 'clamav 1.5.4', definitionVersion: 'freshclam:max-age=48h' };

function fakeClient(behaviour: 'up' | 'down' = 'up', engine = '1.5.4'): ClamdClient {
  return {
    ping: vi.fn(async () => {
      if (behaviour === 'down') throw new ClamdError('connect_failed', 'down');
    }),
    version: vi.fn(async () => ({
      raw: `ClamAV ${engine}/28161/Thu Oct 22 06:24:11 2026`,
      engine,
      scanner: `clamav ${engine}`,
      signatureVersion: 28161,
      signatureDate: new Date(SIGNED),
    })),
  } as unknown as ClamdClient;
}

describe('scanner health', () => {
  beforeEach(() => {
    envState.clamdHost = 'clamd-scan';
    resetScannerStatusForTests();
  });

  it('is not ready before the first probe', () => {
    expect(isApprovedScannerReady(policy, NOW)).toBe(false);
  });

  it('is ready after a healthy probe of the approved scanner', async () => {
    const status = await probeScanner(fakeClient(), () => NOW);
    expect(status).toMatchObject({
      state: 'ready',
      lastHealthy: { scanner: 'clamav 1.5.4', definitionVersion: 'clamav-daily-28161 (2026-10-22T06:24:11Z)' },
    });
    expect(isApprovedScannerReady(policy, NOW)).toBe(true);
  });

  it('rides out a short outage, then fails closed after the grace period', async () => {
    await probeScanner(fakeClient(), () => NOW);
    const down = await probeScanner(fakeClient('down'), () => NOW + 30_000);
    expect(down).toMatchObject({ state: 'unavailable', lastError: 'connect_failed' });
    expect(isApprovedScannerReady(policy, NOW + 30_000)).toBe(true);
    expect(isApprovedScannerReady(policy, NOW + SCANNER_HEALTH_GRACE_MS + 1)).toBe(false);
  });

  it('is not ready for another engine, stale signatures, or a disabled policy', async () => {
    await probeScanner(fakeClient('up', '1.4.6'), () => NOW);
    expect(isApprovedScannerReady(policy, NOW)).toBe(false);
    resetScannerStatusForTests();
    await probeScanner(fakeClient(), () => SIGNED + 49 * 3600_000);
    expect(isApprovedScannerReady(policy, SIGNED + 49 * 3600_000)).toBe(false);
    await probeScanner(fakeClient(), () => NOW);
    expect(isApprovedScannerReady({ ...policy, status: 'disabled' }, NOW)).toBe(false);
    expect(isApprovedScannerReady({ ...policy, scanner: null }, NOW)).toBe(false);
  });

  it('is never ready without CLAMD_HOST', async () => {
    await probeScanner(fakeClient(), () => NOW);
    envState.clamdHost = undefined;
    expect(getScannerStatus().state).toBe('unconfigured');
    expect(isApprovedScannerReady(policy, NOW)).toBe(false);
  });
});
