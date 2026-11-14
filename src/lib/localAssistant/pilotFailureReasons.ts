/**
 * Maps local AI failures to stable, content-free reason codes and short
 * user-facing categories. Classification reads only the error name, the
 * native bridge error code, and SafeRide-authored error messages; the result
 * is always an allowlisted code, never error text.
 */
import { LOCAL_AI_MIN_RAM_GB } from './pilotDeviceProfile';

export const LOCAL_AI_FAILURE_CODES = [
  'NOT_ENOUGH_MEMORY',
  'NOT_ENOUGH_STORAGE',
  'DOWNLOAD_NETWORK',
  'DOWNLOAD_INCOMPLETE',
  'DOWNLOAD_NOT_AUTHORIZED',
  'CHECKSUM_MISMATCH',
  'CHECKSUM_READ_FAILED',
  'MODEL_FILE_MISSING',
  'MODEL_NOT_DOWNLOADED',
  'MODEL_START_FAILED',
  'MODEL_LOAD_TIMEOUT',
  'MODEL_NOT_LOADED',
  'READINESS_PROBE_FAILED',
  'READINESS_PROBE_TIMEOUT',
  'GENERATION_FAILED',
  'GENERATION_TIMEOUT',
  'EMPTY_RESPONSE',
  'GENERATION_CANCELLED',
  'RUNTIME_UNAVAILABLE',
  'ARTIFACT_UNAVAILABLE',
  'CONFIG_INVALID',
  'LOCAL_AI_DISABLED',
  'UNCLASSIFIED',
] as const;

export type LocalAiFailureCode = typeof LOCAL_AI_FAILURE_CODES[number];

export const LOCAL_AI_FAILURE_CATEGORIES = [
  'memory',
  'storage',
  'download-incomplete',
  'model-start',
  'reply-failed',
  'not-ready',
  'unavailable',
  'unknown',
] as const;

export type LocalAiFailureCategory = typeof LOCAL_AI_FAILURE_CATEGORIES[number];

const NATIVE_CODE_MAP: Record<string, LocalAiFailureCode> = {
  ERR_LITERT_INVALID_CONFIG: 'CONFIG_INVALID',
  ERR_LITERT_UNSUPPORTED_MANIFEST: 'ARTIFACT_UNAVAILABLE',
  ERR_LITERT_INVALID_MODEL_PATH: 'CONFIG_INVALID',
  ERR_LITERT_MODEL_PATH_OUTSIDE_APP_STORAGE: 'CONFIG_INVALID',
  ERR_LITERT_MODEL_FILE_MISSING: 'MODEL_FILE_MISSING',
  ERR_LITERT_MODEL_SIZE_MISMATCH: 'DOWNLOAD_INCOMPLETE',
  ERR_LITERT_CHECKSUM_MISMATCH: 'CHECKSUM_MISMATCH',
  ERR_LITERT_REAL_RUNTIME_DISABLED: 'RUNTIME_UNAVAILABLE',
  ERR_LITERT_RUNTIME_UNAVAILABLE: 'RUNTIME_UNAVAILABLE',
  ERR_LITERT_LOAD_FAILED: 'MODEL_START_FAILED',
  ERR_LITERT_INIT_FAILED: 'MODEL_START_FAILED',
  ERR_LITERT_NOT_LOADED: 'MODEL_NOT_LOADED',
  ERR_LITERT_EMPTY_RESPONSE: 'EMPTY_RESPONSE',
  ERR_LITERT_GENERATE_FAILED: 'GENERATION_FAILED',
  ERR_LITERT_CANCELLED: 'GENERATION_CANCELLED',
};

const CATEGORY_BY_CODE: Record<LocalAiFailureCode, LocalAiFailureCategory> = {
  NOT_ENOUGH_MEMORY: 'memory',
  NOT_ENOUGH_STORAGE: 'storage',
  DOWNLOAD_NETWORK: 'download-incomplete',
  DOWNLOAD_INCOMPLETE: 'download-incomplete',
  DOWNLOAD_NOT_AUTHORIZED: 'not-ready',
  CHECKSUM_MISMATCH: 'download-incomplete',
  CHECKSUM_READ_FAILED: 'download-incomplete',
  MODEL_FILE_MISSING: 'download-incomplete',
  MODEL_NOT_DOWNLOADED: 'not-ready',
  MODEL_START_FAILED: 'model-start',
  MODEL_LOAD_TIMEOUT: 'model-start',
  MODEL_NOT_LOADED: 'model-start',
  READINESS_PROBE_FAILED: 'model-start',
  READINESS_PROBE_TIMEOUT: 'model-start',
  GENERATION_FAILED: 'reply-failed',
  GENERATION_TIMEOUT: 'reply-failed',
  EMPTY_RESPONSE: 'reply-failed',
  GENERATION_CANCELLED: 'reply-failed',
  RUNTIME_UNAVAILABLE: 'unavailable',
  ARTIFACT_UNAVAILABLE: 'unavailable',
  CONFIG_INVALID: 'unavailable',
  LOCAL_AI_DISABLED: 'unavailable',
  UNCLASSIFIED: 'unknown',
};

// Ordered: the first matching pattern wins. Patterns match SafeRide-authored
// messages (modelStorage, localGemmaEngine, liteRtLmBridge, localAssistantService).
const MESSAGE_PATTERNS: Array<[RegExp, LocalAiFailureCode]> = [
  [/outofmemory|out of memory|\boom\b|not enough memory|insufficient memory|failed to allocate|bad_alloc/, 'NOT_ENOUGH_MEMORY'],
  [/not enough device storage|no space left|enospc|disk full|storage full/, 'NOT_ENOUGH_STORAGE'],
  [/checksum mismatch|model check failed/, 'CHECKSUM_MISMATCH'],
  [/for checksum verification|checksum read length/, 'CHECKSUM_READ_FAILED'],
  [/model configuration timed out/, 'MODEL_LOAD_TIMEOUT'],
  [/readiness check timed out/, 'READINESS_PROBE_TIMEOUT'],
  [/readiness check/, 'READINESS_PROBE_FAILED'],
  [/reply timed out/, 'GENERATION_TIMEOUT'],
  [/empty response/, 'EMPTY_RESPONSE'],
  [/incomplete download|size mismatch|incomplete range response|empty range response|download did not finish/, 'DOWNLOAD_INCOMPLETE'],
  [/network request failed|failed to download|resumable range download|invalid range response|network error|aborterror|connection/, 'DOWNLOAD_NETWORK'],
  [/cannot be downloaded by this build|downloads are disabled|download consent|network type is unknown|metered-network download/, 'DOWNLOAD_NOT_AUTHORIZED'],
  [/disabled via configuration/, 'LOCAL_AI_DISABLED'],
  [/tuned local ai is unavailable|selected tuned model is unavailable|not approved for this build|revoked/, 'ARTIFACT_UNAVAILABLE'],
  [/native bridge is unavailable|runtime dependency is not available|not enabled in this build|supports only gemma 4/, 'RUNTIME_UNAVAILABLE'],
  [/model file is missing/, 'MODEL_FILE_MISSING'],
  [/must be loaded before generation|runtime is not loaded/, 'MODEL_NOT_LOADED'],
  [/generation failed/, 'GENERATION_FAILED'],
  [/failed to initialize|failed to load|load failed|could not start|init failed|\binit\b/, 'MODEL_START_FAILED'],
  [/invalid local model identity|is missing a manifest id|missing an exact artifact|bridge model path|invalid model path|setup is invalid/, 'CONFIG_INVALID'],
];

function errorCodeOf(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}

function errorNameOf(error: unknown): string {
  return error instanceof Error ? error.name : '';
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message.toLowerCase();
  return typeof error === 'string' ? error.toLowerCase() : '';
}

export function isLocalAiFailureCode(value: unknown): value is LocalAiFailureCode {
  return typeof value === 'string' && (LOCAL_AI_FAILURE_CODES as readonly string[]).includes(value);
}

export function classifyLocalAiFailure(error: unknown): LocalAiFailureCode {
  const name = errorNameOf(error);
  const nativeCode = errorCodeOf(error);
  const message = errorMessageOf(error);

  if (name === 'LocalModelGenerationStoppedError' || nativeCode === 'ERR_LITERT_CANCELLED') {
    return 'GENERATION_CANCELLED';
  }
  if (/outofmemory|out of memory|\boom\b/.test(`${nativeCode.toLowerCase()} ${message}`)) {
    return 'NOT_ENOUGH_MEMORY';
  }
  const nativeMatch = NATIVE_CODE_MAP[nativeCode];
  if (nativeMatch) return nativeMatch;
  if (name === 'ModelDownloadAuthorizationError') return 'DOWNLOAD_NOT_AUTHORIZED';
  if (name === 'AbortError') return 'DOWNLOAD_NETWORK';

  for (const [pattern, code] of MESSAGE_PATTERNS) {
    if (pattern.test(message)) return code;
  }
  return 'UNCLASSIFIED';
}

/**
 * Returns the user-facing category. On phones below the RAM guidance, start or
 * reply crashes are most likely memory pressure, so those surface as "memory".
 */
export function categorizeLocalAiFailure(
  code: LocalAiFailureCode,
  context: { ramClassGb?: number | null } = {},
): LocalAiFailureCategory {
  const base = CATEGORY_BY_CODE[code];
  const lowRam = typeof context.ramClassGb === 'number' && context.ramClassGb < LOCAL_AI_MIN_RAM_GB;
  if (lowRam && (base === 'model-start' || code === 'GENERATION_FAILED')) {
    return 'memory';
  }
  return base;
}
