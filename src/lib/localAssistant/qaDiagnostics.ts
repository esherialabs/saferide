import type { SafeRideLiteRtLmBridgeStatus } from './liteRtLmBridge';

export const TUNED_ARTIFACT_DEVICE_CLASSES = [
  'android-2-3gb',
  'android-4gb',
  'android-6-8gb',
  'android-8gb-plus',
  'android-unknown',
] as const;

export type TunedArtifactDeviceClass = typeof TUNED_ARTIFACT_DEVICE_CLASSES[number];

export const TUNED_ARTIFACT_QA_PHASES = ['load', 'readiness-probe', 'generation'] as const;
export type TunedArtifactQaPhase = typeof TUNED_ARTIFACT_QA_PHASES[number];

export const TUNED_ARTIFACT_QA_BACKENDS = ['gpu', 'cpu', 'npu', 'mock', 'unknown'] as const;
export type TunedArtifactQaBackend = typeof TUNED_ARTIFACT_QA_BACKENDS[number];

export const TUNED_ARTIFACT_QA_RESULT_STATUSES = ['not-run', 'passed', 'failed', 'cancelled'] as const;

export type TunedArtifactQaDiagnostic = {
  schema: 'com.saferide.tuned-artifact-qa-diagnostic';
  schemaVersion: 2;
  manifestId: string;
  artifactSha256: string;
  phase: TunedArtifactQaPhase;
  runtimeState: SafeRideLiteRtLmBridgeStatus['state'];
  artifactValidated: boolean;
  realRuntimeLoaded: boolean;
  backend: TunedArtifactQaBackend | null;
  deviceClass: TunedArtifactDeviceClass;
  timings: {
    loadMs: number | null;
    /** The LiteRT-LM bridge returns whole replies, so this stays null until it streams tokens. */
    firstTokenMs: number | null;
    totalGenerationMs: number | null;
  };
  /** Estimated from reply length (about 4 characters per token); the bridge does not report token counts. */
  throughput: {
    estimatedOutputTokens: number | null;
    estimatedTokensPerSecond: number | null;
  };
  result: {
    status: typeof TUNED_ARTIFACT_QA_RESULT_STATUSES[number];
    errorCode: string | null;
  };
  capturedAt: string;
};

function safeTiming(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function safeErrorCode(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 80);
  return normalized || 'UNCLASSIFIED';
}

function safeBackend(status: SafeRideLiteRtLmBridgeStatus): TunedArtifactQaBackend | null {
  const raw = (status.activeBackend ?? status.backendLabel ?? '').toLowerCase();
  if (!raw) return null;
  return (TUNED_ARTIFACT_QA_BACKENDS as readonly string[]).includes(raw)
    ? raw as TunedArtifactQaBackend
    : 'unknown';
}

function roundedRate(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}

export function createTunedArtifactQaDiagnostic(params: {
  manifestId: string;
  artifactSha256: string;
  bridgeStatus: SafeRideLiteRtLmBridgeStatus;
  deviceClass: TunedArtifactDeviceClass;
  phase?: TunedArtifactQaPhase;
  timings?: Partial<TunedArtifactQaDiagnostic['timings']>;
  throughput?: Partial<TunedArtifactQaDiagnostic['throughput']>;
  resultStatus: TunedArtifactQaDiagnostic['result']['status'];
  errorCode?: string | null;
  capturedAt?: Date;
}): TunedArtifactQaDiagnostic {
  if (!params.manifestId.trim()) throw new Error('QA diagnostic requires a manifest ID.');
  if (!/^[a-f0-9]{64}$/i.test(params.artifactSha256)) throw new Error('QA diagnostic requires an artifact SHA-256.');
  return {
    schema: 'com.saferide.tuned-artifact-qa-diagnostic',
    schemaVersion: 2,
    manifestId: params.manifestId,
    artifactSha256: params.artifactSha256.toLowerCase(),
    phase: params.phase ?? 'generation',
    runtimeState: params.bridgeStatus.state,
    artifactValidated: params.bridgeStatus.artifactValidated === true,
    realRuntimeLoaded: params.bridgeStatus.realRuntimeLoaded === true,
    backend: safeBackend(params.bridgeStatus),
    deviceClass: params.deviceClass,
    timings: {
      loadMs: safeTiming(params.timings?.loadMs),
      firstTokenMs: safeTiming(params.timings?.firstTokenMs),
      totalGenerationMs: safeTiming(params.timings?.totalGenerationMs),
    },
    throughput: {
      estimatedOutputTokens: safeTiming(params.throughput?.estimatedOutputTokens),
      estimatedTokensPerSecond: roundedRate(safeTiming(params.throughput?.estimatedTokensPerSecond)),
    },
    result: {
      status: params.resultStatus,
      errorCode: safeErrorCode(params.errorCode ?? params.bridgeStatus.lastErrorCode),
    },
    capturedAt: (params.capturedAt ?? new Date()).toISOString(),
  };
}
