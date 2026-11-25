import * as FileSystem from 'expo-file-system/legacy';
import { File, FileMode } from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { LocalModelConfig, LocalModelFile } from './modelRegistry';
import {
  isSafeModelPathSegment,
  isSafeNamespacedModelId,
  isSafeRelativeModelPath,
} from './modelIdentity';
import { TUNED_ARTIFACT_CONTROLS, type TunedArtifactControls } from './tunedArtifactControls';
import { devPrivacyWarn, getPrivacySafeErrorReason } from '../../utils/privacyLog';
import {
  isAiPilotDiagnosticsEnabled,
  recordAiPilotDownloadEvent,
  recordAiPilotVerifyEvent,
  runWithAiPilotInFlight,
} from './pilotDiagnostics';
import { readLocalAiFreeStorageBucket } from './pilotDeviceProfile';

const MODEL_ROOT = `${FileSystem.documentDirectory ?? ''}models/`;
const MODEL_CHECKSUM_CHUNK_BYTES = 4 * 1024 * 1024;
const RANGE_DOWNLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
const MODEL_DOWNLOAD_MIN_FREE_BUFFER_BYTES = 256 * 1024 * 1024;
export const MODEL_DOWNLOAD_STATE_KEY_PREFIX = '@saferide_local_model_download:';
const MODEL_DOWNLOAD_STATE_SCHEMA = 'com.saferide.local-model-download-state';
const MODEL_DOWNLOAD_STATE_VERSION = 1;
export const MODEL_VERIFICATION_STATE_KEY_PREFIX = '@saferide_local_model_verification:';
const MODEL_VERIFICATION_STATE_SCHEMA = 'com.saferide.local-model-verification-state';
const MODEL_VERIFICATION_STATE_VERSION = 1;

export type ModelPreparationPhase = 'download' | 'verify' | 'load';

export type DownloadProgress = {
  totalBytes: number;
  receivedBytes: number;
  fileName: string;
  phase?: ModelPreparationPhase;
};

export type ProgressCallback = (progress: DownloadProgress) => void;

export type ModelFileAvailabilityState = 'missing' | 'partial' | 'downloaded' | 'complete' | 'invalid';

export type ModelFileAvailability = {
  fileName: string;
  path: string;
  state: ModelFileAvailabilityState;
  expectedSizeBytes?: number;
  actualSizeBytes?: number;
  resumable: boolean;
  progress?: DownloadProgress;
};

export type ModelAvailability = {
  modelId: string;
  files: ModelFileAvailability[];
  downloaded: boolean;
  complete: boolean;
  invalid: boolean;
  partial: boolean;
  resumable: boolean;
  receivedBytes: number;
  totalBytes: number;
};

type PersistedModelDownloadState = {
  schema: typeof MODEL_DOWNLOAD_STATE_SCHEMA;
  version: typeof MODEL_DOWNLOAD_STATE_VERSION;
  modelId: string;
  fileName: string;
  expectedSizeBytes?: number;
  progress?: Omit<DownloadProgress, 'fileName' | 'phase'>;
  pauseState: FileSystem.DownloadPauseState;
  savedAt: string;
};

type PersistedModelVerificationState = {
  schema: typeof MODEL_VERIFICATION_STATE_SCHEMA;
  version: typeof MODEL_VERIFICATION_STATE_VERSION;
  modelId: string;
  fileName: string;
  fileUri: string;
  expectedSizeBytes?: number;
  expectedSha256?: string;
  actualSizeBytes: number;
  modificationTime?: number;
  verifiedAt: string;
};

type ActiveModelDownload = {
  fileName: string;
  pause: () => Promise<boolean>;
  cancel: () => Promise<boolean>;
};

export type ModelDownloadNetworkType = 'wifi' | 'metered' | 'unknown';

export type LargeModelDownloadAuthorization = {
  manifestId: string;
  artifactSha256: string;
  acknowledgedSizeBytes: number;
  consentedAt: string;
  networkType: ModelDownloadNetworkType;
  meteredNetworkAccepted: boolean;
};

type ParsedContentRange = {
  start: number;
  end: number;
  totalBytes?: number;
};

export class ModelDownloadPausedError extends Error {
  constructor(fileName: string) {
    super(`Download paused for ${fileName}`);
    this.name = 'ModelDownloadPausedError';
  }
}

export class ModelDownloadCancelledError extends Error {
  constructor(fileName: string) {
    super(`Download cancelled and partial data removed for ${fileName}`);
    this.name = 'ModelDownloadCancelledError';
  }
}

export class ModelDownloadAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelDownloadAuthorizationError';
  }
}

let activeModelDownload: ActiveModelDownload | null = null;

function resolveModelDirectory(config: LocalModelConfig): string {
  if (
    !isSafeNamespacedModelId(config.id)
    || (config.manifestId !== undefined && !isSafeModelPathSegment(config.manifestId))
    || !isSafeRelativeModelPath(config.storageDir)
  ) {
    throw new Error('Local model storage identity is invalid.');
  }
  return `${MODEL_ROOT}${config.storageDir}/`;
}

function resolveFilePath(config: LocalModelConfig, file: LocalModelFile): string {
  if (!isSafeModelPathSegment(file.fileName)) {
    throw new Error('Local model file identity is invalid.');
  }
  return `${resolveModelDirectory(config)}${file.fileName}`;
}

function downloadStateKey(config: LocalModelConfig, file: LocalModelFile): string {
  return `${MODEL_DOWNLOAD_STATE_KEY_PREFIX}${config.id}:${file.fileName}`;
}

function verificationStateKey(config: LocalModelConfig, file: LocalModelFile): string {
  return `${MODEL_VERIFICATION_STATE_KEY_PREFIX}${config.id}:${file.fileName}`;
}

function downloadOptions(): FileSystem.DownloadOptions {
  return {
    sessionType: FileSystem.FileSystemSessionType.BACKGROUND,
  };
}

function createRangePauseState(file: LocalModelFile, target: string): FileSystem.DownloadPauseState {
  return {
    url: file.downloadUrl,
    fileUri: target,
    options: downloadOptions(),
  };
}

function hasNativeResumeData(state: PersistedModelDownloadState | null | undefined): boolean {
  return Boolean(state?.pauseState.resumeData);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fileModificationTime(fileInfo: FileSystem.FileInfo): number | undefined {
  if (!fileInfo.exists || !('modificationTime' in fileInfo)) return undefined;
  return typeof fileInfo.modificationTime === 'number' && Number.isFinite(fileInfo.modificationTime)
    ? fileInfo.modificationTime
    : undefined;
}

function parsePersistedDownloadState(raw: string | null): PersistedModelDownloadState | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<PersistedModelDownloadState>;
    if (
      parsed.schema === MODEL_DOWNLOAD_STATE_SCHEMA &&
      parsed.version === MODEL_DOWNLOAD_STATE_VERSION &&
      typeof parsed.modelId === 'string' &&
      typeof parsed.fileName === 'string' &&
      isRecord(parsed.pauseState) &&
      typeof parsed.pauseState.url === 'string' &&
      typeof parsed.pauseState.fileUri === 'string' &&
      (
        parsed.pauseState.resumeData === undefined ||
        typeof parsed.pauseState.resumeData === 'string'
      )
    ) {
      return parsed as PersistedModelDownloadState;
    }
  } catch {
    return null;
  }

  return null;
}

async function readPersistedDownloadState(
  config: LocalModelConfig,
  file: LocalModelFile,
  target: string,
): Promise<PersistedModelDownloadState | null> {
  const key = downloadStateKey(config, file);
  const state = parsePersistedDownloadState(await AsyncStorage.getItem(key));

  if (!state) {
    await AsyncStorage.removeItem(key);
    return null;
  }

  if (
    state.modelId !== config.id ||
    state.fileName !== file.fileName ||
    state.pauseState.url !== file.downloadUrl ||
    state.pauseState.fileUri !== target
  ) {
    await AsyncStorage.removeItem(key);
    return null;
  }

  return state;
}

async function persistDownloadState(params: {
  config: LocalModelConfig;
  file: LocalModelFile;
  pauseState: FileSystem.DownloadPauseState;
  progress?: DownloadProgress;
}): Promise<void> {
  if (!params.pauseState.resumeData && !params.progress) {
    return;
  }

  const state: PersistedModelDownloadState = {
    schema: MODEL_DOWNLOAD_STATE_SCHEMA,
    version: MODEL_DOWNLOAD_STATE_VERSION,
    modelId: params.config.id,
    fileName: params.file.fileName,
    expectedSizeBytes: params.file.sizeBytes,
    progress: params.progress
      ? {
          receivedBytes: params.progress.receivedBytes,
          totalBytes: params.progress.totalBytes,
        }
      : undefined,
    pauseState: params.pauseState,
    savedAt: new Date().toISOString(),
  };

  await AsyncStorage.setItem(downloadStateKey(params.config, params.file), JSON.stringify(state));
}

async function clearDownloadState(config: LocalModelConfig, file: LocalModelFile): Promise<void> {
  await AsyncStorage.removeItem(downloadStateKey(config, file));
}

function parsePersistedVerificationState(raw: string | null): PersistedModelVerificationState | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<PersistedModelVerificationState>;
    if (
      parsed.schema === MODEL_VERIFICATION_STATE_SCHEMA
      && parsed.version === MODEL_VERIFICATION_STATE_VERSION
      && typeof parsed.modelId === 'string'
      && typeof parsed.fileName === 'string'
      && typeof parsed.fileUri === 'string'
      && typeof parsed.actualSizeBytes === 'number'
      && Number.isSafeInteger(parsed.actualSizeBytes)
      && parsed.actualSizeBytes >= 0
      && (parsed.expectedSizeBytes === undefined || Number.isSafeInteger(parsed.expectedSizeBytes))
      && (parsed.expectedSha256 === undefined || typeof parsed.expectedSha256 === 'string')
      && (parsed.modificationTime === undefined || typeof parsed.modificationTime === 'number')
    ) {
      return parsed as PersistedModelVerificationState;
    }
  } catch {
    return null;
  }

  return null;
}

function verificationStateMatches(
  state: PersistedModelVerificationState,
  config: LocalModelConfig,
  file: LocalModelFile,
  target: string,
  fileInfo: FileSystem.FileInfo,
): boolean {
  if (!fileInfo.exists || !('size' in fileInfo)) return false;
  return state.modelId === config.id
    && state.fileName === file.fileName
    && state.fileUri === target
    && state.expectedSizeBytes === file.sizeBytes
    && (state.expectedSha256 ?? '').toLowerCase() === (file.sha256 ?? '').toLowerCase()
    && state.actualSizeBytes === fileInfo.size
    && (state.modificationTime ?? null) === (fileModificationTime(fileInfo) ?? null);
}

async function hasPersistedVerificationState(
  config: LocalModelConfig,
  file: LocalModelFile,
  target: string,
  fileInfo: FileSystem.FileInfo,
): Promise<boolean> {
  try {
    const key = verificationStateKey(config, file);
    const raw = await AsyncStorage.getItem(key);
    const state = parsePersistedVerificationState(raw);
    if (state && verificationStateMatches(state, config, file, target, fileInfo)) {
      return true;
    }
    if (raw) {
      await AsyncStorage.removeItem(key);
    }
  } catch (error) {
    devPrivacyWarn('local model verification state read failed', {
      reason: getPrivacySafeErrorReason(error),
    });
  }
  return false;
}

async function persistVerificationState(
  config: LocalModelConfig,
  file: LocalModelFile,
  target: string,
  fileInfo: FileSystem.FileInfo,
): Promise<void> {
  if (!fileInfo.exists || !('size' in fileInfo)) return;
  const state: PersistedModelVerificationState = {
    schema: MODEL_VERIFICATION_STATE_SCHEMA,
    version: MODEL_VERIFICATION_STATE_VERSION,
    modelId: config.id,
    fileName: file.fileName,
    fileUri: target,
    expectedSizeBytes: file.sizeBytes,
    expectedSha256: file.sha256,
    actualSizeBytes: fileInfo.size,
    modificationTime: fileModificationTime(fileInfo),
    verifiedAt: new Date().toISOString(),
  };
  await AsyncStorage.setItem(verificationStateKey(config, file), JSON.stringify(state));
}

async function clearVerificationState(config: LocalModelConfig, file: LocalModelFile): Promise<void> {
  await AsyncStorage.removeItem(verificationStateKey(config, file));
}

async function persistCurrentFileProgress(params: {
  config: LocalModelConfig;
  file: LocalModelFile;
  target: string;
  fallbackProgress?: DownloadProgress;
}): Promise<DownloadProgress | undefined> {
  const progress = await progressFromCurrentFile(params.file, params.target) ?? params.fallbackProgress;
  if (progress) {
    await persistDownloadState({
      config: params.config,
      file: params.file,
      pauseState: createRangePauseState(params.file, params.target),
      progress,
    });
  }
  return progress;
}

function progressFromEvent(
  file: LocalModelFile,
  progressEvent: FileSystem.DownloadProgressData,
): DownloadProgress {
  const expected = progressEvent.totalBytesExpectedToWrite > 0
    ? progressEvent.totalBytesExpectedToWrite
    : file.sizeBytes ?? 0;

  return {
    fileName: file.fileName,
    totalBytes: expected,
    receivedBytes: progressEvent.totalBytesWritten,
    phase: 'download',
  };
}

function progressFromSavedState(
  file: LocalModelFile,
  savedState: PersistedModelDownloadState,
): DownloadProgress | undefined {
  if (!savedState.progress) return undefined;

  return {
    fileName: file.fileName,
    ...savedState.progress,
    phase: 'download',
  };
}

function progressFromFileInfo(
  file: LocalModelFile,
  actualSizeBytes: number | undefined,
): DownloadProgress | undefined {
  if (!actualSizeBytes || actualSizeBytes <= 0) return undefined;

  return {
    fileName: file.fileName,
    receivedBytes: actualSizeBytes,
    totalBytes: file.sizeBytes ?? actualSizeBytes,
    phase: 'download',
  };
}

async function progressFromCurrentFile(
  file: LocalModelFile,
  target: string,
): Promise<DownloadProgress | undefined> {
  const info = await FileSystem.getInfoAsync(target);
  const actualSizeBytes = info.exists && 'size' in info ? info.size : undefined;
  return progressFromFileInfo(file, actualSizeBytes);
}

async function ensureSufficientDiskSpace(
  file: LocalModelFile,
  currentBytes: number,
): Promise<void> {
  if (!file.sizeBytes) return;

  try {
    const freeBytes = await FileSystem.getFreeDiskStorageAsync();
    const remainingBytes = Math.max(0, file.sizeBytes - currentBytes);
    if (freeBytes < remainingBytes + MODEL_DOWNLOAD_MIN_FREE_BUFFER_BYTES) {
      throw new Error(
        `Not enough device storage for ${file.fileName}. Free at least ${Math.ceil(
          (remainingBytes + MODEL_DOWNLOAD_MIN_FREE_BUFFER_BYTES) / (1024 * 1024),
        )} MB and resume.`,
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Not enough device storage')) {
      throw error;
    }
    devPrivacyWarn('local model free storage check unavailable', {
      reason: getPrivacySafeErrorReason(error),
    });
  }
}

function parseContentRange(value: string | null): ParsedContentRange | null {
  if (!value) return null;

  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value.trim());
  if (!match) return null;

  const start = Number(match[1]);
  const end = Number(match[2]);
  const totalBytes = match[3] === '*' ? undefined : Number(match[3]);

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    (totalBytes !== undefined && (!Number.isSafeInteger(totalBytes) || totalBytes <= end))
  ) {
    return null;
  }

  return { start, end, totalBytes };
}

function isSuccessfulDownloadStatus(status: number | undefined): boolean {
  return typeof status === 'number' && status >= 200 && status < 300;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function canUseDurableRangeDownload(file: LocalModelFile): boolean {
  return Boolean(file.sizeBytes && file.sizeBytes > 0);
}

export function validateLargeModelDownloadAuthorization(
  config: LocalModelConfig,
  file: LocalModelFile,
  authorization?: LargeModelDownloadAuthorization,
  controls: TunedArtifactControls = TUNED_ARTIFACT_CONTROLS,
): string[] {
  if (!file.sizeBytes || file.sizeBytes < controls.download.largeArtifactThresholdBytes) return [];
  const qaControlledDownload = Boolean(
    config.qaOnly
    && config.devOnly
    && config.lifecycleStatus === 'artifact-produced'
    && file.downloadMode === 'app-download',
  );
  if (!controls.download.enabled && !qaControlledDownload) {
    return ['Large local-model downloads are disabled by the active artifact controls.'];
  }
  if (
    !authorization
    || !config.manifestId
    || authorization.manifestId !== config.manifestId
    || !file.sha256
    || authorization.artifactSha256.toLowerCase() !== file.sha256.toLowerCase()
    || authorization.acknowledgedSizeBytes !== file.sizeBytes
    || Number.isNaN(Date.parse(authorization.consentedAt))
  ) {
    return ['Exact artifact identity, byte size, and explicit download consent are required.'];
  }
  if (authorization.networkType === 'unknown') {
    return ['Network type is unknown; connect to Wi-Fi or explicitly identify a metered network.'];
  }
  if (authorization.networkType === 'metered' && !authorization.meteredNetworkAccepted) {
    return ['Metered-network download requires separate explicit consent.'];
  }
  return [];
}

function assertLargeDownloadAuthorized(
  config: LocalModelConfig,
  file: LocalModelFile,
  authorization?: LargeModelDownloadAuthorization,
): void {
  const [error] = validateLargeModelDownloadAuthorization(config, file, authorization);
  if (error) throw new ModelDownloadAuthorizationError(error);
}

function shouldUseRangeDownload(
  file: LocalModelFile,
  persistedState: PersistedModelDownloadState | null,
  fileProgress?: DownloadProgress,
): boolean {
  if (!canUseDurableRangeDownload(file)) return false;
  if (fileProgress?.receivedBytes && fileProgress.receivedBytes > 0) return true;
  return !hasNativeResumeData(persistedState);
}

function bytesToBase64(bytes: Uint8Array): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  let index = 0;

  for (; index + 2 < bytes.length; index += 3) {
    output += chars[bytes[index] >> 2];
    output += chars[((bytes[index] & 3) << 4) | (bytes[index + 1] >> 4)];
    output += chars[((bytes[index + 1] & 15) << 2) | (bytes[index + 2] >> 6)];
    output += chars[bytes[index + 2] & 63];
  }

  if (index < bytes.length) {
    output += chars[bytes[index] >> 2];
    if (index === bytes.length - 1) {
      output += chars[(bytes[index] & 3) << 4];
      output += '==';
    } else {
      output += chars[((bytes[index] & 3) << 4) | (bytes[index + 1] >> 4)];
      output += chars[(bytes[index + 1] & 15) << 2];
      output += '=';
    }
  }

  return output;
}

export async function sha256FileInChunks(
  uri: string,
  sizeBytes: number,
  chunkBytes = MODEL_CHECKSUM_CHUNK_BYTES,
  onProgress?: (verifiedBytes: number, totalBytes: number) => void,
): Promise<string> {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || !Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
    throw new Error('Invalid model checksum bounds.');
  }

  const digest = sha256.create();
  // The legacy Android reader stores `position` as a 32-bit Int and cannot
  // address the second half of multi-gigabyte model files. FileHandle advances
  // a native 64-bit cursor, so every byte is read exactly once in sequence.
  const handle = new File(uri).open(FileMode.ReadOnly);
  let verifiedBytes = 0;
  try {
    onProgress?.(0, sizeBytes);
    while (verifiedBytes < sizeBytes) {
      const length = Math.min(chunkBytes, sizeBytes - verifiedBytes);
      const bytes = handle.readBytes(length);
      if (bytes.byteLength !== length) {
        throw new Error('Model checksum read length mismatch.');
      }
      digest.update(bytes);
      verifiedBytes += bytes.byteLength;
      onProgress?.(verifiedBytes, sizeBytes);
      if (verifiedBytes < sizeBytes) {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
    }
  } finally {
    handle.close();
  }

  return bytesToHex(digest.digest());
}

async function appendBytesToFile(target: string, bytes: Uint8Array): Promise<void> {
  await FileSystem.writeAsStringAsync(target, bytesToBase64(bytes), {
    append: true,
    encoding: FileSystem.EncodingType.Base64,
  });
}

async function ensureDirectoryExists(directory: string): Promise<void> {
  const info = await FileSystem.getInfoAsync(directory);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  }
}

async function validateChecksum(
  config: LocalModelConfig,
  file: LocalModelFile,
  uri: string,
  fileInfo?: FileSystem.FileInfo,
  onProgress?: ProgressCallback,
): Promise<boolean> {
  if (!file.sha256) return true;
  const fileSize = fileInfo?.exists && 'size' in fileInfo ? fileInfo.size : undefined;
  if (!Number.isSafeInteger(fileSize) || fileSize === undefined || fileSize < 0) return false;

  try {
    if (fileInfo && await hasPersistedVerificationState(config, file, uri, fileInfo)) {
      return true;
    }
    const verifyStartedAt = Date.now();
    const digest = await runWithAiPilotInFlight('verify', () => sha256FileInChunks(
      uri,
      fileSize,
      MODEL_CHECKSUM_CHUNK_BYTES,
      (verifiedBytes, totalBytes) => {
        onProgress?.({
          fileName: file.fileName,
          phase: 'verify',
          receivedBytes: verifiedBytes,
          totalBytes,
        });
      },
    ));
    const valid = digest.toLowerCase() === file.sha256.toLowerCase();
    recordAiPilotVerifyEvent({ outcome: valid ? 'passed' : 'failed', durationMs: Date.now() - verifyStartedAt });
    if (valid && fileInfo) {
      try {
        await persistVerificationState(config, file, uri, fileInfo);
      } catch (error) {
        devPrivacyWarn('local model verification state save failed', {
          reason: getPrivacySafeErrorReason(error),
        });
      }
    } else {
      try {
        await clearVerificationState(config, file);
      } catch (error) {
        devPrivacyWarn('local model verification state clear failed', {
          reason: getPrivacySafeErrorReason(error),
        });
      }
    }
    return valid;
  } catch (error) {
    try {
      await clearVerificationState(config, file);
    } catch {
      // The checksum result remains authoritative even if stale metadata cannot be cleared.
    }
    devPrivacyWarn('local model checksum validation failed', {
      reason: getPrivacySafeErrorReason(error),
    });
    recordAiPilotVerifyEvent({ outcome: 'read-error' });
    throw new Error(`Could not read ${file.fileName} for checksum verification.`);
  }
}

async function fileExistsWithIntegrity(
  config: LocalModelConfig,
  file: LocalModelFile,
  onProgress?: ProgressCallback,
): Promise<boolean> {
  const path = resolveFilePath(config, file);
  const info = await FileSystem.getInfoAsync(path);
  if (!info.exists || info.size === 0) {
    return false;
  }
  if (file.sizeBytes && info.size !== file.sizeBytes) {
    return false;
  }
  return validateChecksum(config, file, path, info, onProgress);
}

async function getModelFileAvailability(
  config: LocalModelConfig,
  file: LocalModelFile,
  verifyIntegrity: boolean,
  onProgress?: ProgressCallback,
): Promise<ModelFileAvailability> {
  const path = resolveFilePath(config, file);
  const savedState = await readPersistedDownloadState(config, file, path);
  const info = await FileSystem.getInfoAsync(path);
  const actualSizeBytes = info.exists && 'size' in info ? info.size : undefined;
  const savedProgress = savedState ? progressFromSavedState(file, savedState) : undefined;
  const fileProgress = progressFromFileInfo(file, actualSizeBytes);

  let state: ModelFileAvailabilityState = 'missing';

  if (info.exists && actualSizeBytes && actualSizeBytes > 0) {
    if (file.sizeBytes && actualSizeBytes < file.sizeBytes) {
      state = 'partial';
    } else if (file.sizeBytes && actualSizeBytes > file.sizeBytes) {
      state = 'invalid';
    } else {
      const cachedVerification = await hasPersistedVerificationState(config, file, path, info);
      if (cachedVerification || !file.sha256) {
        state = 'complete';
      } else if (!verifyIntegrity) {
        state = 'downloaded';
      } else {
        state = (await validateChecksum(config, file, path, info, onProgress)) ? 'complete' : 'invalid';
      }
    }
  } else if (savedProgress || hasNativeResumeData(savedState)) {
    state = 'partial';
  }

  if (state === 'complete' && savedState) {
    await clearDownloadState(config, file);
  }

  return {
    fileName: file.fileName,
    path,
    state,
    expectedSizeBytes: file.sizeBytes,
    actualSizeBytes,
    resumable: state === 'partial' && Boolean(savedState?.pauseState.resumeData || fileProgress),
    progress: savedProgress ?? fileProgress,
  };
}

async function downloadFileWithRangeResume(params: {
  config: LocalModelConfig;
  file: LocalModelFile;
  target: string;
  initialProgress: DownloadProgress;
  onProgress?: ProgressCallback;
}): Promise<void> {
  const { config, file, target, onProgress } = params;
  let offset = params.initialProgress.receivedBytes;
  let totalBytes = file.sizeBytes ?? params.initialProgress.totalBytes;
  let lastProgress: DownloadProgress = {
    fileName: file.fileName,
    receivedBytes: offset,
    totalBytes,
    phase: 'download',
  };
  let paused = false;
  let cancelled = false;
  let abortController: AbortController | null = null;

  const persistRangeProgress = async () => {
    await persistDownloadState({
      config,
      file,
      pauseState: createRangePauseState(file, target),
      progress: lastProgress,
    });
  };

  const controller: ActiveModelDownload = {
    fileName: file.fileName,
    pause: async () => {
      paused = true;
      abortController?.abort();
      try {
        const currentProgress = await progressFromCurrentFile(file, target);
        if (currentProgress) {
          lastProgress = currentProgress;
        }
        await persistRangeProgress();
      } catch (error) {
        devPrivacyWarn('local model range pause state save failed', {
          reason: getPrivacySafeErrorReason(error),
        });
      }
      return true;
    },
    cancel: async () => {
      cancelled = true;
      abortController?.abort();
      await FileSystem.deleteAsync(target, { idempotent: true });
      await clearDownloadState(config, file);
      await clearVerificationState(config, file);
      return true;
    },
  };

  activeModelDownload = controller;
  onProgress?.(lastProgress);
  await ensureSufficientDiskSpace(file, offset);

  if (offset <= 0) {
    await FileSystem.deleteAsync(target, { idempotent: true });
    await clearVerificationState(config, file);
    await persistRangeProgress();
  }

  try {
    while (!totalBytes || offset < totalBytes) {
      if (paused) {
        throw new ModelDownloadPausedError(file.fileName);
      }
      if (cancelled) {
        throw new ModelDownloadCancelledError(file.fileName);
      }

      const chunkEnd = totalBytes
        ? Math.min(offset + RANGE_DOWNLOAD_CHUNK_BYTES - 1, totalBytes - 1)
        : offset + RANGE_DOWNLOAD_CHUNK_BYTES - 1;

      abortController = new AbortController();
      const response = await fetch(file.downloadUrl, {
        headers: {
          Range: `bytes=${offset}-${chunkEnd}`,
          'Accept-Encoding': 'identity',
        },
        signal: abortController.signal,
      });
      abortController = null;

      if (response.status !== 206) {
        throw new Error(
          `Server does not support resumable range download for ${file.fileName} (status ${response.status})`,
        );
      }

      const contentRange = parseContentRange(response.headers.get('content-range'));
      if (
        !contentRange
        || contentRange.start !== offset
        || contentRange.end > chunkEnd
        || contentRange.totalBytes !== file.sizeBytes
      ) {
        throw new Error(`Invalid range response for ${file.fileName}`);
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0) {
        throw new Error(`Empty range response for ${file.fileName}`);
      }
      const expectedRangeLength = contentRange.end - contentRange.start + 1;
      if (bytes.byteLength !== expectedRangeLength) {
        throw new Error(`Incomplete range response for ${file.fileName}`);
      }

      if (paused) {
        throw new ModelDownloadPausedError(file.fileName);
      }

      await appendBytesToFile(target, bytes);
      offset += bytes.byteLength;
      lastProgress = {
        fileName: file.fileName,
        receivedBytes: offset,
        totalBytes,
        phase: 'download',
      };
      onProgress?.(lastProgress);
      await persistRangeProgress();
    }
  } catch (error) {
    if (cancelled) {
      await FileSystem.deleteAsync(target, { idempotent: true });
      await clearDownloadState(config, file);
      await clearVerificationState(config, file);
      throw new ModelDownloadCancelledError(file.fileName);
    }
    if (paused || isAbortError(error)) {
      const currentProgress = await progressFromCurrentFile(file, target);
      if (currentProgress) {
        lastProgress = currentProgress;
      }
      await persistRangeProgress();
      throw new ModelDownloadPausedError(file.fileName);
    }

    try {
      const currentProgress = await progressFromCurrentFile(file, target);
      if (currentProgress) {
        lastProgress = currentProgress;
      }
      await persistRangeProgress();
    } catch (persistError) {
      devPrivacyWarn('local model range resume state save failed', {
        reason: getPrivacySafeErrorReason(persistError),
      });
    }

    throw error;
  } finally {
    if (activeModelDownload === controller) {
      activeModelDownload = null;
    }
  }
}

async function downloadFile(
  config: LocalModelConfig,
  file: LocalModelFile,
  onProgress?: ProgressCallback,
  authorization?: LargeModelDownloadAuthorization,
): Promise<void> {
  if (file.downloadMode === 'controlled-import') {
    throw new Error(
      `${file.fileName} cannot be downloaded by this build.`,
    );
  }

  const target = resolveFilePath(config, file);
  const persistedState = await readPersistedDownloadState(config, file, target);
  const savedProgress = persistedState ? progressFromSavedState(file, persistedState) : undefined;
  let fileProgress = await progressFromCurrentFile(file, target);
  let completedWithRangeResume = false;
  if (
    file.sizeBytes &&
    fileProgress?.receivedBytes &&
    fileProgress.receivedBytes > file.sizeBytes
  ) {
    await FileSystem.deleteAsync(target, { idempotent: true });
    await clearDownloadState(config, file);
    await clearVerificationState(config, file);
    fileProgress = undefined;
  } else if (file.sizeBytes && fileProgress?.receivedBytes === file.sizeBytes) {
    const info = await FileSystem.getInfoAsync(target);
    if (await validateChecksum(config, file, target, info, onProgress)) {
      await clearDownloadState(config, file);
      return;
    }
    await FileSystem.deleteAsync(target, { idempotent: true });
    await clearDownloadState(config, file);
    await clearVerificationState(config, file);
    fileProgress = undefined;
  }

  assertLargeDownloadAuthorized(config, file, authorization);

  if (shouldUseRangeDownload(file, persistedState, fileProgress)) {
    const rangeStartProgress = fileProgress ?? (
      savedProgress?.receivedBytes === 0 ? savedProgress : undefined
    ) ?? {
      fileName: file.fileName,
      receivedBytes: 0,
      totalBytes: file.sizeBytes ?? 0,
      phase: 'download',
    };

    await downloadFileWithRangeResume({
      config,
      file,
      target,
      initialProgress: rangeStartProgress,
      onProgress,
    });
    completedWithRangeResume = true;
  }

  let lastProgress: DownloadProgress | undefined = savedProgress ?? fileProgress;

  if (completedWithRangeResume) {
    lastProgress = await progressFromCurrentFile(file, target) ?? lastProgress;
  }

  if (lastProgress && !completedWithRangeResume) {
    onProgress?.(lastProgress);
  }

  if (!completedWithRangeResume) {
    const resumable = FileSystem.createDownloadResumable(
      file.downloadUrl,
      target,
      downloadOptions(),
      progressEvent => {
        lastProgress = progressFromEvent(file, progressEvent);
        onProgress?.(lastProgress);
      },
      persistedState?.pauseState.resumeData,
    );
    let rejectActiveDownload: ((error: ModelDownloadPausedError | ModelDownloadCancelledError) => void) | null = null;
    let pauseInFlight: Promise<boolean> | null = null;
    const pausePromise = new Promise<never>((_, reject) => {
      rejectActiveDownload = reject;
    });

    const controller: ActiveModelDownload = {
      fileName: file.fileName,
      pause: async () => {
        if (pauseInFlight) return pauseInFlight;

        pauseInFlight = (async () => {
          try {
            const pauseState = await resumable.pauseAsync();
            const currentProgress = await progressFromCurrentFile(file, target);
            if (currentProgress) {
              lastProgress = currentProgress;
            }
            await persistDownloadState({ config, file, pauseState, progress: lastProgress });
            rejectActiveDownload?.(new ModelDownloadPausedError(file.fileName));
            return true;
          } catch (error) {
            devPrivacyWarn('local model download pause failed', {
              reason: getPrivacySafeErrorReason(error),
            });
            return false;
          }
        })();

        return pauseInFlight;
      },
      cancel: async () => {
        try {
          await resumable.pauseAsync();
        } catch {
          // Cleanup below is authoritative even when the platform cannot return resume data.
        }
        await FileSystem.deleteAsync(target, { idempotent: true });
        await clearDownloadState(config, file);
        await clearVerificationState(config, file);
        rejectActiveDownload?.(new ModelDownloadCancelledError(file.fileName));
        return true;
      },
    };

    try {
      activeModelDownload = controller;
      const result = await Promise.race([
        hasNativeResumeData(persistedState) ? resumable.resumeAsync() : resumable.downloadAsync(),
        pausePromise,
      ]);

      if (!result || !isSuccessfulDownloadStatus(result.status)) {
        throw new Error(`Failed to download ${file.fileName} (status ${result?.status})`);
      }
    } catch (error) {
      if (error instanceof ModelDownloadPausedError || error instanceof ModelDownloadCancelledError) {
        throw error;
      }

      try {
        const currentProgress = await progressFromCurrentFile(file, target);
        if (currentProgress) {
          lastProgress = currentProgress;
        }
        await persistDownloadState({
          config,
          file,
          pauseState: resumable.savable(),
          progress: lastProgress,
        });
      } catch (persistError) {
        devPrivacyWarn('local model download resume state save failed', {
          reason: getPrivacySafeErrorReason(persistError),
        });
      }

      console.warn(`Download failed for ${file.fileName}`, error);
      throw error;
    } finally {
      if (activeModelDownload === controller) {
        activeModelDownload = null;
      }
    }
  }

  const info = await FileSystem.getInfoAsync(target);
  if (file.sizeBytes && (!info.exists || info.size < file.sizeBytes)) {
    await persistCurrentFileProgress({
      config,
      file,
      target,
      fallbackProgress: lastProgress,
    });
    throw new Error(`Incomplete download for ${file.fileName}. Progress was saved for resume.`);
  }
  if (file.sizeBytes && info.exists && info.size > file.sizeBytes) {
    await FileSystem.deleteAsync(target, { idempotent: true });
    await clearDownloadState(config, file);
    await clearVerificationState(config, file);
    throw new Error(`Size mismatch for ${file.fileName}`);
  }
  if (file.sizeBytes && lastProgress?.receivedBytes !== file.sizeBytes) {
    onProgress?.({
      fileName: file.fileName,
      receivedBytes: file.sizeBytes,
      totalBytes: file.sizeBytes,
      phase: 'download',
    });
  }
  const isValid = await validateChecksum(config, file, target, info, onProgress);
  if (!isValid) {
    await FileSystem.deleteAsync(target, { idempotent: true });
    await clearDownloadState(config, file);
    await clearVerificationState(config, file);
    throw new Error(`Checksum mismatch for ${file.fileName}`);
  }
  await clearDownloadState(config, file);
}

export async function pauseActiveModelDownload(): Promise<boolean> {
  return activeModelDownload ? activeModelDownload.pause() : false;
}

export async function cancelActiveModelDownload(): Promise<boolean> {
  return activeModelDownload ? activeModelDownload.cancel() : false;
}

async function readDownloadStartBytes(
  config: LocalModelConfig,
  file: LocalModelFile,
): Promise<{ receivedBytes: number; nativeResume: boolean }> {
  try {
    const target = resolveFilePath(config, file);
    const persistedState = await readPersistedDownloadState(config, file, target);
    const currentProgress = await progressFromCurrentFile(file, target);
    const savedProgress = persistedState ? progressFromSavedState(file, persistedState) : undefined;
    return {
      receivedBytes: currentProgress?.receivedBytes ?? savedProgress?.receivedBytes ?? 0,
      nativeResume: hasNativeResumeData(persistedState),
    };
  } catch {
    return { receivedBytes: 0, nativeResume: false };
  }
}

/** Records content-free download start/resume/pause/finish/failure events in pilot builds. */
async function downloadFileWithPilotDiagnostics(
  config: LocalModelConfig,
  file: LocalModelFile,
  onProgress?: ProgressCallback,
  authorization?: LargeModelDownloadAuthorization,
): Promise<void> {
  if (!isAiPilotDiagnosticsEnabled()) {
    return downloadFile(config, file, onProgress, authorization);
  }

  const networkType = authorization?.networkType ?? null;
  const start = await readDownloadStartBytes(config, file);
  recordAiPilotDownloadEvent({
    outcome: start.receivedBytes > 0 || start.nativeResume ? 'resumed' : 'started',
    networkType,
    freeStorageBucket: await readLocalAiFreeStorageBucket(),
    startPercent: file.sizeBytes ? (start.receivedBytes / file.sizeBytes) * 100 : null,
  });
  const startedAt = Date.now();
  try {
    await runWithAiPilotInFlight('download', () => downloadFile(config, file, onProgress, authorization));
    recordAiPilotDownloadEvent({ outcome: 'completed', networkType, durationMs: Date.now() - startedAt });
  } catch (error) {
    recordAiPilotDownloadEvent({
      outcome: error instanceof ModelDownloadPausedError
        ? 'paused'
        : error instanceof ModelDownloadCancelledError
          ? 'cancelled'
          : 'failed',
      networkType,
      durationMs: Date.now() - startedAt,
      error,
    });
    throw error;
  }
}

export async function ensureModelAvailability(
  config: LocalModelConfig,
  onProgress?: ProgressCallback,
  authorization?: LargeModelDownloadAuthorization,
): Promise<void> {
  const directory = resolveModelDirectory(config);
  await ensureDirectoryExists(directory);

  for (const file of config.files) {
    const exists = await fileExistsWithIntegrity(config, file, onProgress);
    if (exists) {
      await clearDownloadState(config, file);
      continue;
    }
    await downloadFileWithPilotDiagnostics(config, file, onProgress, authorization);
  }
}

export async function getSavedModelDownloadProgress(
  config: LocalModelConfig,
): Promise<DownloadProgress | null> {
  for (const file of config.files) {
    const target = resolveFilePath(config, file);
    const savedState = await readPersistedDownloadState(config, file, target);
    const progress = savedState
      ? progressFromSavedState(file, savedState)
      : await progressFromCurrentFile(file, target);
    if (progress) {
      return progress;
    }
  }

  return null;
}

async function buildModelAvailability(
  config: LocalModelConfig,
  verifyIntegrity: boolean,
  onProgress?: ProgressCallback,
): Promise<ModelAvailability> {
  const files: ModelFileAvailability[] = [];

  for (const file of config.files) {
    files.push(await getModelFileAvailability(config, file, verifyIntegrity, onProgress));
  }

  const totalBytes = files.reduce((total, file) => total + (file.expectedSizeBytes ?? file.actualSizeBytes ?? 0), 0);
  const receivedBytes = files.reduce((total, file) => {
    if (file.state === 'complete' || file.state === 'downloaded') {
      return total + (file.expectedSizeBytes ?? file.actualSizeBytes ?? 0);
    }
    return total + (file.progress?.receivedBytes ?? file.actualSizeBytes ?? 0);
  }, 0);
  const downloaded = files.length > 0 && files.every(file => (
    file.state === 'complete' || file.state === 'downloaded'
  ));

  return {
    modelId: config.id,
    files,
    downloaded,
    complete: files.length > 0 && files.every(file => file.state === 'complete'),
    invalid: files.some(file => file.state === 'invalid'),
    partial: files.some(file => file.state === 'partial'),
    resumable: files.some(file => file.resumable),
    receivedBytes,
    totalBytes,
  };
}

export async function inspectModelAvailability(config: LocalModelConfig): Promise<ModelAvailability> {
  return buildModelAvailability(config, false);
}

export async function getModelAvailability(
  config: LocalModelConfig,
  onProgress?: ProgressCallback,
): Promise<ModelAvailability> {
  return buildModelAvailability(config, true, onProgress);
}

export function resolveModelFilePath(config: LocalModelConfig, fileName: string): string {
  const file = config.files.find(entry => entry.fileName === fileName);
  if (!file) {
    throw new Error(`File ${fileName} is not part of model ${config.id}`);
  }
  return resolveFilePath(config, file);
}

export function listModelFiles(config: LocalModelConfig): string[] {
  return config.files.map(file => resolveFilePath(config, file));
}

export function getModelDirectory(config: LocalModelConfig): string {
  return resolveModelDirectory(config);
}

export function isModelDownloadStateKey(key: string): boolean {
  return key.startsWith(MODEL_DOWNLOAD_STATE_KEY_PREFIX);
}

export function isModelVerificationStateKey(key: string): boolean {
  return key.startsWith(MODEL_VERIFICATION_STATE_KEY_PREFIX);
}

export async function clearSavedModelDownloadStates(): Promise<string[]> {
  const keys = (await AsyncStorage.getAllKeys()).filter(isModelDownloadStateKey);
  if (keys.length > 0) {
    await AsyncStorage.multiRemove(keys);
  }
  return keys;
}

export async function clearSavedModelVerificationStates(): Promise<string[]> {
  const keys = (await AsyncStorage.getAllKeys()).filter(isModelVerificationStateKey);
  if (keys.length > 0) {
    await AsyncStorage.multiRemove(keys);
  }
  return keys;
}

export async function removeModelArtifacts(config: LocalModelConfig): Promise<void> {
  if (activeModelDownload && config.files.some(file => file.fileName === activeModelDownload?.fileName)) {
    await activeModelDownload.cancel();
  }
  for (const file of config.files) {
    await clearDownloadState(config, file);
    await clearVerificationState(config, file);
  }
  await FileSystem.deleteAsync(resolveModelDirectory(config), { idempotent: true });
}
