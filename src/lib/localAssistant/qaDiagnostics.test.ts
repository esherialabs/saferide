import { describe, expect, it } from 'vitest';

import { createTunedArtifactQaDiagnostic } from './qaDiagnostics';

describe('tuned artifact QA diagnostics', () => {
  it('keeps exact public artifact identity and content-free runtime state', () => {
    const diagnostic = createTunedArtifactQaDiagnostic({
      manifestId: 'synthetic-tuned-manifest',
      artifactSha256: 'A'.repeat(64),
      bridgeStatus: {
        state: 'loaded',
        nativeAvailable: true,
        runtimeAvailable: true,
        mockMode: false,
        artifactValidated: true,
        realRuntimeLoaded: true,
        lastErrorMessage: 'must never be copied',
      },
      deviceClass: 'android-6-8gb',
      timings: { loadMs: 1234, firstTokenMs: 200, totalGenerationMs: 800 },
      resultStatus: 'passed',
      capturedAt: new Date('2026-07-30T00:00:00.000Z'),
    });

    expect(diagnostic).toMatchObject({
      artifactSha256: 'a'.repeat(64),
      artifactValidated: true,
      realRuntimeLoaded: true,
      result: { status: 'passed', errorCode: null },
    });
    const serialized = JSON.stringify(diagnostic);
    expect(serialized).not.toMatch(/prompt|completion|path|message|narrative|location/i);
  });

  it('normalizes codes and discards invalid timing values without copying arbitrary input', () => {
    const diagnostic = createTunedArtifactQaDiagnostic({
      manifestId: 'synthetic-tuned-manifest',
      artifactSha256: 'b'.repeat(64),
      bridgeStatus: {
        state: 'error',
        nativeAvailable: true,
        runtimeAvailable: true,
        mockMode: false,
        lastErrorCode: 'checksum mismatch: /private/path',
      },
      deviceClass: 'android-unknown',
      timings: { loadMs: -1, firstTokenMs: Number.NaN },
      resultStatus: 'failed',
    });
    expect(diagnostic.timings).toEqual({ loadMs: null, firstTokenMs: null, totalGenerationMs: null });
    expect(diagnostic.result.errorCode).toBe('CHECKSUM_MISMATCH___PRIVATE_PATH');
    expect(diagnostic).not.toHaveProperty('lastErrorMessage');
  });

  it('records the pilot phase, backend, and estimated throughput without any reply content', () => {
    const diagnostic = createTunedArtifactQaDiagnostic({
      manifestId: 'synthetic-tuned-manifest',
      artifactSha256: 'd'.repeat(64),
      bridgeStatus: {
        state: 'loaded',
        nativeAvailable: true,
        runtimeAvailable: true,
        mockMode: false,
        activeBackend: 'GPU',
      },
      deviceClass: 'android-8gb-plus',
      phase: 'generation',
      timings: { totalGenerationMs: 2000 },
      throughput: { estimatedOutputTokens: 50, estimatedTokensPerSecond: 25.04 },
      resultStatus: 'passed',
    });

    expect(diagnostic).toMatchObject({
      schemaVersion: 2,
      phase: 'generation',
      backend: 'gpu',
      deviceClass: 'android-8gb-plus',
      timings: { loadMs: null, firstTokenMs: null, totalGenerationMs: 2000 },
      throughput: { estimatedOutputTokens: 50, estimatedTokensPerSecond: 25 },
    });
    expect(createTunedArtifactQaDiagnostic({
      manifestId: 'synthetic-tuned-manifest',
      artifactSha256: 'd'.repeat(64),
      bridgeStatus: { state: 'loaded', nativeAvailable: true, runtimeAvailable: true, mockMode: false, backendLabel: 'tpu?' },
      deviceClass: 'android-unknown',
      resultStatus: 'not-run',
    })).toMatchObject({ phase: 'generation', backend: 'unknown' });
  });
});
