import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  localModelEngine,
  inspectModelAvailability,
  LocalModelGenerationStoppedError,
  ModelDownloadCancelledError,
  ModelDownloadPausedError,
  cancelActiveModelDownload,
  pauseActiveModelDownload,
  removeModelArtifacts,
  tunedArtifactRemovalReason,
  type AssistantMessage,
  type AssistantOptions,
  type TranscriptionOptions,
  type ProgressCallback,
  type LargeModelDownloadAuthorization,
  formatApproximateModelSize,
  getLocalModelArtifactBlocker,
  getBundledTunedArtifactRemovalCandidate,
  resolveLocalModelConfig,
  resolveTunedArtifactRuntimeSelection,
  type LocalModelConfig,
} from '../lib/localAssistant';
import { localAssistantConfig } from '../config/localAssistant';
import {
  getRuntimeConfigSnapshot,
  type TunedArtifactRuntimeSnapshot,
} from '../config/runtime/runtimeConfigStore';
import {
  getAssistantLanguageCopy,
  getAssistantLanguageInstruction,
} from '../i18n/appLanguage';
import { devPrivacyError, devPrivacyWarn, getPrivacySafeErrorReason } from '../utils/privacyLog';
import { getCachedLocalAiDeviceFacts } from '../lib/localAssistant/pilotDeviceProfile';
import {
  categorizeLocalAiFailure,
  classifyLocalAiFailure,
  type LocalAiFailureCategory,
} from '../lib/localAssistant/pilotFailureReasons';
import { getLocalAiPilotCopy } from '../i18n/localAiPilotCopy';

type AssistantState =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'verifying'
  | 'downloaded'
  | 'configuring'
  | 'ready'
  | 'error';

type StatePayload = {
  state: AssistantState;
  percent?: number;
  error?: string;
  modelDownloaded?: boolean;
  resumable?: boolean;
  receivedBytes?: number;
  totalBytes?: number;
};

const listeners = new Set<(payload: StatePayload) => void>();
const LOCAL_ASSISTANT_KEEP_AWAKE_TAG = 'saferide-local-assistant-preparation';
const LOCAL_ASSISTANT_READY_STATE_KEY = '@saferide_local_assistant_ready_state';
const LOCAL_ASSISTANT_READY_STATE_SCHEMA = 'com.saferide.local-assistant-ready-state';
const LOCAL_ASSISTANT_READY_STATE_VERSION = 2;
const LOCAL_ASSISTANT_CONTEXT_MESSAGE_LIMIT = 4;
const LOCAL_ASSISTANT_CONTEXT_MESSAGE_CHAR_LIMIT = 650;

let currentState: AssistantState = 'idle';
let cachedError: string | undefined;
let lastPercent = 0;
let lastModelDownloaded = false;
let lastResumable = false;
let lastReceivedBytes: number | undefined;
let lastTotalBytes: number | undefined;
let localAssistantForegroundActive = true;
let keepAwakeActive = false;
let keepAwakeQueue = Promise.resolve();
let activePreparation: Promise<void> | null = null;
let autoPreparation: Promise<boolean> | null = null;
let nextGenerationRequestId = 0;
const activeGenerationRequests = new Set<number>();
const stoppedGenerationRequests = new Set<number>();
let lastSelectedTunedModelConfig: LocalModelConfig | null = null;
let runtimeControlQueue = Promise.resolve();

type PersistedReadyState = {
  schema: typeof LOCAL_ASSISTANT_READY_STATE_SCHEMA;
  version: typeof LOCAL_ASSISTANT_READY_STATE_VERSION;
  modelId: string;
  runtimeModelId: string;
  runtimeKind: ReturnType<typeof getActiveLocalModelConfig>['runtime']['kind'];
  manifestId?: string;
  manifestSha256?: string;
  files: Array<{
    fileName: string;
    sizeBytes?: number;
    sha256?: string;
  }>;
  verifiedAt: string;
};

function buildUnavailableTunedModelConfig(
  baseConfig: LocalModelConfig,
  reason: string,
): LocalModelConfig {
  return {
    ...baseConfig,
    devOnly: false,
    artifact: {
      state: 'runtime-pending',
      format: 'litertlm',
      manifestId: 'fail-closed-no-local-ai',
      sourceModelId: baseConfig.id,
      reason: `The selected tuned model is unavailable (${reason}).`,
      requiredAction: 'Keep local AI disabled; a different model must not be substituted.',
    },
    capabilities: {
      textGeneration: false,
      audioTranscription: false,
      offenceTagging: false,
    },
  };
}

function getActiveLocalModelConfig(): LocalModelConfig {
  const baseConfig = resolveLocalModelConfig(localAssistantConfig.modelId, localAssistantConfig.artifact);
  const selection = resolveTunedArtifactRuntimeSelection();
  if (!selection.selectionRequired) return baseConfig;
  if (selection.config) {
    lastSelectedTunedModelConfig = selection.config;
    return selection.config;
  }
  return buildUnavailableTunedModelConfig(baseConfig, selection.decision.reason);
}

function isDevApprovedLiteRtRuntime(modelConfig: ReturnType<typeof getActiveLocalModelConfig>): boolean {
  return Boolean(
    localAssistantConfig.allowRealLiteRtLmRuntime &&
    modelConfig.devOnly &&
    modelConfig.runtime.kind === 'litert-lm' &&
    (
      (
        modelConfig.rolloutDownloadMode === 'controlled-import'
        && modelConfig.lifecycleStatus === 'prototype'
      )
      || (
        modelConfig.qaOnly
        && modelConfig.rolloutDownloadMode === 'app-download'
        && modelConfig.lifecycleStatus === 'artifact-produced'
      )
    ),
  );
}

function getRuntimeArtifactBlocker(modelConfig: ReturnType<typeof getActiveLocalModelConfig>): string | null {
  const blocker = getLocalModelArtifactBlocker(modelConfig);
  if (blocker && isDevApprovedLiteRtRuntime(modelConfig)) {
    return null;
  }
  return blocker;
}

function emitArtifactBlockedState(modelConfig: ReturnType<typeof getActiveLocalModelConfig>): string | null {
  const blocker = getRuntimeArtifactBlocker(modelConfig);
  if (!blocker) return null;

  emitState({
    state: 'error',
    percent: 0,
    modelDownloaded: false,
    resumable: false,
    receivedBytes: 0,
    totalBytes: 0,
    error: blocker,
  });
  return blocker;
}

function readyStateForConfig(modelConfig: ReturnType<typeof getActiveLocalModelConfig>): PersistedReadyState {
  return {
    schema: LOCAL_ASSISTANT_READY_STATE_SCHEMA,
    version: LOCAL_ASSISTANT_READY_STATE_VERSION,
    modelId: modelConfig.id,
    runtimeModelId: modelConfig.runtime.modelId,
    runtimeKind: modelConfig.runtime.kind,
    manifestId: modelConfig.manifestId,
    manifestSha256: modelConfig.manifestSha256,
    files: modelConfig.files.map(file => ({
      fileName: file.fileName,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
    })),
    verifiedAt: new Date().toISOString(),
  };
}

function parseReadyState(raw: string | null): PersistedReadyState | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<PersistedReadyState>;
    if (
      parsed.schema === LOCAL_ASSISTANT_READY_STATE_SCHEMA &&
      parsed.version === LOCAL_ASSISTANT_READY_STATE_VERSION &&
      typeof parsed.modelId === 'string' &&
      typeof parsed.runtimeModelId === 'string' &&
      typeof parsed.runtimeKind === 'string' &&
      Array.isArray(parsed.files)
    ) {
      return parsed as PersistedReadyState;
    }
  } catch {
    return null;
  }

  return null;
}

function readyStateMatchesConfig(
  state: PersistedReadyState | null,
  modelConfig: ReturnType<typeof getActiveLocalModelConfig>,
): boolean {
  if (
    !state ||
    state.modelId !== modelConfig.id ||
    state.runtimeModelId !== modelConfig.runtime.modelId ||
    state.runtimeKind !== modelConfig.runtime.kind ||
    (state.manifestId ?? null) !== (modelConfig.manifestId ?? null) ||
    (state.manifestSha256 ?? null) !== (modelConfig.manifestSha256 ?? null)
  ) {
    return false;
  }
  if (state.files.length !== modelConfig.files.length) {
    return false;
  }
  return modelConfig.files.every(file => (
    state.files.some(savedFile => (
      savedFile.fileName === file.fileName &&
      savedFile.sizeBytes === file.sizeBytes &&
      savedFile.sha256 === file.sha256
    ))
  ));
}

async function hasPersistedReadyState(modelConfig: ReturnType<typeof getActiveLocalModelConfig>): Promise<boolean> {
  const raw = await AsyncStorage.getItem(LOCAL_ASSISTANT_READY_STATE_KEY);
  const state = parseReadyState(raw);
  if (readyStateMatchesConfig(state, modelConfig)) {
    return true;
  }

  if (raw) {
    await AsyncStorage.removeItem(LOCAL_ASSISTANT_READY_STATE_KEY);
  }
  return false;
}

async function persistReadyState(modelConfig: ReturnType<typeof getActiveLocalModelConfig>): Promise<void> {
  try {
    await AsyncStorage.setItem(LOCAL_ASSISTANT_READY_STATE_KEY, JSON.stringify(readyStateForConfig(modelConfig)));
  } catch (error) {
    devPrivacyWarn('local assistant readiness state save failed', {
      reason: getPrivacySafeErrorReason(error),
    });
  }
}

async function clearReadyState(): Promise<void> {
  try {
    await AsyncStorage.removeItem(LOCAL_ASSISTANT_READY_STATE_KEY);
  } catch (error) {
    devPrivacyWarn('local assistant readiness state clear failed', {
      reason: getPrivacySafeErrorReason(error),
    });
  }
}

async function enforceTunedArtifactRuntimeControl(
  modelConfig: ReturnType<typeof getActiveLocalModelConfig>,
): Promise<string | null> {
  const runtime = getRuntimeConfigSnapshot().localAi;
  const candidate = lastSelectedTunedModelConfig
    ?? (
      modelConfig.lifecycleStatus === 'release-ready' || modelConfig.qaOnly
        ? modelConfig
        : null
    )
    ?? getBundledTunedArtifactRemovalCandidate();
  if (!candidate) return null;
  const reason = tunedArtifactRemovalReason(candidate, runtime);
  if (!reason) return null;

  return removeTunedArtifactForRuntimeControl(candidate, reason);
}

async function removeTunedArtifactForRuntimeControl(
  modelConfig: LocalModelConfig,
  reason: string,
): Promise<string> {
  await unloadLocalAssistantRuntime('tuned local assistant runtime unload failed');
  try {
    await removeModelArtifacts(modelConfig);
  } catch (error) {
    devPrivacyWarn('tuned local assistant artifact cleanup failed', {
      reason: getPrivacySafeErrorReason(error),
    });
  }
  await clearReadyState();
  if (lastSelectedTunedModelConfig?.manifestId === modelConfig.manifestId) {
    lastSelectedTunedModelConfig = null;
  }
  const message = `Tuned local AI is unavailable (${reason}). SafeRide remains available without local AI.`;
  emitState({
    state: 'error',
    percent: 0,
    modelDownloaded: false,
    resumable: false,
    receivedBytes: 0,
    totalBytes: modelConfig.runtime.approximateSizeBytes,
    error: message,
  });
  return message;
}

export function handleLocalAssistantRuntimeConfigUpdate(
  runtime: TunedArtifactRuntimeSnapshot,
): Promise<void> {
  const operation = runtimeControlQueue.catch(() => undefined).then(async () => {
    const selection = resolveTunedArtifactRuntimeSelection({ runtime });
    if (selection.config) {
      lastSelectedTunedModelConfig = selection.config;
    }
    const candidate = lastSelectedTunedModelConfig ?? getBundledTunedArtifactRemovalCandidate();
    if (!candidate) return;
    const reason = tunedArtifactRemovalReason(candidate, runtime);
    if (reason) await removeTunedArtifactForRuntimeControl(candidate, reason);
  });
  runtimeControlQueue = operation.catch(() => undefined);
  return operation;
}

async function unloadLocalAssistantRuntime(logLabel: string): Promise<void> {
  try {
    await localModelEngine.unload();
  } catch (error) {
    devPrivacyWarn(logLabel, {
      reason: getPrivacySafeErrorReason(error),
    });
  }
}

function localAssistantFailureCategory(error: unknown): LocalAiFailureCategory {
  return categorizeLocalAiFailure(classifyLocalAiFailure(error), {
    ramClassGb: getCachedLocalAiDeviceFacts()?.ramClassGb ?? null,
  });
}

/** A short reason category for the status panel; unclassified errors keep the generic guidance. */
function describeLocalAssistantFailure(error: unknown, modelSaved: boolean, genericMessage: string): string {
  const category = localAssistantFailureCategory(error);
  return category === 'unknown'
    ? genericMessage
    : getLocalAiPilotCopy().failure.statusMessage(category, modelSaved);
}

function emitState(payload: StatePayload) {
  currentState = payload.state;
  lastPercent = payload.percent ?? lastPercent;
  cachedError = payload.error;
  lastModelDownloaded = payload.modelDownloaded ?? lastModelDownloaded;
  lastResumable = payload.resumable ?? lastResumable;
  lastReceivedBytes = payload.receivedBytes ?? lastReceivedBytes;
  lastTotalBytes = payload.totalBytes ?? lastTotalBytes;
  const nextPayload: StatePayload = {
    state: currentState,
    percent: lastPercent,
    error: cachedError,
    modelDownloaded: lastModelDownloaded,
    resumable: lastResumable,
    receivedBytes: lastReceivedBytes,
    totalBytes: lastTotalBytes,
  };
  listeners.forEach(listener => {
    try {
      listener(nextPayload);
    } catch (error) {
      devPrivacyWarn('local assistant listener failed', { reason: getPrivacySafeErrorReason(error) });
    }
  });
}

function progressToPercent(receivedBytes: number, totalBytes: number): number {
  if (!totalBytes || totalBytes <= 0) {
    return Math.min(100, Math.max(0, Math.round(receivedBytes / 1024)));
  }
  return Math.min(100, Math.round((receivedBytes / totalBytes) * 100));
}

function isActivePreparationState(state: AssistantState = currentState): boolean {
  return state === 'checking'
    || state === 'downloading'
    || state === 'verifying'
    || state === 'configuring';
}

function enqueueKeepAwakeOperation(operation: () => Promise<void>): Promise<void> {
  const nextOperation = keepAwakeQueue.catch(() => undefined).then(operation);
  keepAwakeQueue = nextOperation.catch(() => undefined);
  return nextOperation;
}

async function activatePreparationKeepAwake(): Promise<void> {
  if (!localAssistantForegroundActive || keepAwakeActive) return;

  keepAwakeActive = true;
  try {
    await enqueueKeepAwakeOperation(() => activateKeepAwakeAsync(LOCAL_ASSISTANT_KEEP_AWAKE_TAG));
  } catch (error) {
    keepAwakeActive = false;
    devPrivacyWarn('local assistant keep-awake activation failed', {
      reason: getPrivacySafeErrorReason(error),
    });
  }
}

async function releasePreparationKeepAwake(): Promise<void> {
  if (!keepAwakeActive) return;

  keepAwakeActive = false;
  try {
    await enqueueKeepAwakeOperation(() => deactivateKeepAwake(LOCAL_ASSISTANT_KEEP_AWAKE_TAG));
  } catch (error) {
    devPrivacyWarn('local assistant keep-awake release failed', {
      reason: getPrivacySafeErrorReason(error),
    });
  }
}

export async function setLocalAssistantForegroundActive(isForegroundActive: boolean): Promise<void> {
  localAssistantForegroundActive = isForegroundActive;

  if (!localAssistantForegroundActive) {
    await releasePreparationKeepAwake();
    return;
  }

  if (isActivePreparationState()) {
    await activatePreparationKeepAwake();
  }
}

function adaptProgress(callback?: (percent: number) => void): ProgressCallback | undefined {
  return progress => {
    const percent = progressToPercent(progress.receivedBytes, progress.totalBytes);
    callback?.(percent);
    const state: AssistantState = progress.phase === 'load'
      ? 'configuring'
      : progress.phase === 'verify'
        ? 'verifying'
        : 'downloading';
    emitState({
      state,
      percent,
      modelDownloaded: progress.phase !== 'download',
      resumable: progress.phase === 'download' ? lastResumable : false,
      receivedBytes: progress.receivedBytes,
      totalBytes: progress.totalBytes,
    });
  };
}

export function subscribeToAssistantState(listener: (payload: StatePayload) => void): () => void {
  listeners.add(listener);
  listener({
    state: currentState,
    percent: lastPercent,
    error: cachedError,
    modelDownloaded: lastModelDownloaded,
    resumable: lastResumable,
    receivedBytes: lastReceivedBytes,
    totalBytes: lastTotalBytes,
  });
  return () => listeners.delete(listener);
}

export async function hydrateLocalAssistantPreparationState(): Promise<void> {
  if (
    !localAssistantConfig.enabled ||
    currentState === 'ready' ||
    currentState === 'checking' ||
    currentState === 'downloading' ||
    currentState === 'verifying' ||
    currentState === 'downloaded' ||
    currentState === 'configuring'
  ) {
    return;
  }

  const modelConfig = getActiveLocalModelConfig();
  if (await enforceTunedArtifactRuntimeControl(modelConfig)) {
    return;
  }
  if (emitArtifactBlockedState(modelConfig)) {
    return;
  }

  if (localModelEngine.isReady(modelConfig)) {
    emitState({ state: 'ready', percent: 100, modelDownloaded: true, resumable: false });
    return;
  }

  emitState({
    state: 'checking',
    percent: 0,
    modelDownloaded: lastModelDownloaded,
    resumable: false,
    receivedBytes: 0,
    totalBytes: modelConfig.runtime.approximateSizeBytes,
  });

  const availability = await inspectModelAvailability(modelConfig);
  if (availability.downloaded) {
    emitState({
      state: 'downloaded',
      percent: 100,
      modelDownloaded: true,
      resumable: false,
      receivedBytes: availability.receivedBytes,
      totalBytes: availability.totalBytes,
    });
    return;
  }

  if (availability.invalid) {
    emitState({
      state: 'error',
      percent: progressToPercent(availability.receivedBytes, availability.totalBytes),
      modelDownloaded: false,
      resumable: false,
      receivedBytes: availability.receivedBytes,
      totalBytes: availability.totalBytes,
      error: 'The saved model file is invalid. Download it again.',
    });
    return;
  }

  if (availability.partial || availability.receivedBytes > 0) {
    emitState({
      state: 'idle',
      percent: progressToPercent(availability.receivedBytes, availability.totalBytes),
      modelDownloaded: false,
      resumable: availability.resumable,
      receivedBytes: availability.receivedBytes,
      totalBytes: availability.totalBytes,
    });
    return;
  }

  emitState({
    state: 'idle',
    percent: 0,
    modelDownloaded: false,
    resumable: false,
    receivedBytes: 0,
    totalBytes: availability.totalBytes || modelConfig.runtime.approximateSizeBytes,
  });
}

function assertAssistantEnabled() {
  if (!localAssistantConfig.enabled) {
    throw new Error('Local assistant is disabled via configuration.');
  }
}

export async function prepareLocalAssistant(
  onProgress?: (percent: number) => void,
  downloadAuthorization?: LargeModelDownloadAuthorization,
): Promise<void> {
  assertAssistantEnabled();
  if (currentState === 'ready') return;
  if (activePreparation) {
    return activePreparation;
  }

  activePreparation = performLocalAssistantPreparation(onProgress, downloadAuthorization).finally(() => {
    activePreparation = null;
  });

  return activePreparation;
}

function compactLocalAssistantContent(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= LOCAL_ASSISTANT_CONTEXT_MESSAGE_CHAR_LIMIT) {
    return trimmed;
  }

  const edgeLength = Math.floor((LOCAL_ASSISTANT_CONTEXT_MESSAGE_CHAR_LIMIT - 24) / 2);
  return `${trimmed.slice(0, edgeLength)}\n[...]\n${trimmed.slice(-edgeLength)}`;
}

function compactLocalAssistantConversation(conversation: AssistantMessage[]): AssistantMessage[] {
  return conversation
    .filter(message => message.content.trim().length > 0)
    .slice(-LOCAL_ASSISTANT_CONTEXT_MESSAGE_LIMIT)
    .map(message => ({
      role: message.role,
      content: compactLocalAssistantContent(message.content),
    }));
}

async function performLocalAssistantPreparation(
  onProgress?: (percent: number) => void,
  downloadAuthorization?: LargeModelDownloadAuthorization,
): Promise<void> {
  const modelConfig = getActiveLocalModelConfig();
  const runtimeBlocker = await enforceTunedArtifactRuntimeControl(modelConfig);
  if (runtimeBlocker) throw new Error(runtimeBlocker);
  const blocker = emitArtifactBlockedState(modelConfig);
  if (blocker) {
    throw new Error(blocker);
  }

  const availability = await inspectModelAvailability(modelConfig);
  const hadPersistedReadyState = await hasPersistedReadyState(modelConfig);

  if (localModelEngine.isReady(modelConfig)) {
    await persistReadyState(modelConfig);
    emitState({
      state: 'ready',
      percent: 100,
      modelDownloaded: true,
      resumable: false,
      receivedBytes: availability.receivedBytes,
      totalBytes: availability.totalBytes,
    });
    return;
  }

  emitState({
    state: availability.downloaded ? 'checking' : 'downloading',
    percent: availability.downloaded ? 0 : progressToPercent(availability.receivedBytes, availability.totalBytes),
    modelDownloaded: availability.downloaded,
    resumable: availability.resumable,
    receivedBytes: availability.receivedBytes,
    totalBytes: availability.totalBytes,
  });
  try {
    await activatePreparationKeepAwake();
    await localModelEngine.ensureReady(modelConfig, adaptProgress(onProgress), {
      allowRealLiteRtLmRuntime: localAssistantConfig.allowRealLiteRtLmRuntime,
      downloadAuthorization,
    });
    await persistReadyState(modelConfig);
    emitState({ state: 'ready', percent: 100, modelDownloaded: true, resumable: false });
  } catch (error) {
    if (error instanceof ModelDownloadPausedError) {
      emitState({ state: 'idle', percent: lastPercent, modelDownloaded: false, resumable: true });
      throw error;
    }
    if (error instanceof ModelDownloadCancelledError) {
      await clearReadyState();
      emitState({
        state: 'idle',
        percent: 0,
        modelDownloaded: false,
        resumable: false,
        receivedBytes: 0,
        totalBytes: modelConfig.runtime.approximateSizeBytes,
      });
      throw error;
    }

    devPrivacyError('local assistant preparation failed', { reason: getPrivacySafeErrorReason(error) });
    await unloadLocalAssistantRuntime('local assistant runtime unload after preparation failure failed');
    let modelDownloaded = lastModelDownloaded;
    let resumable = lastResumable;
    let percent = lastPercent;
    try {
      const nextAvailability = await inspectModelAvailability(modelConfig);
      modelDownloaded = nextAvailability.downloaded;
      resumable = nextAvailability.resumable;
      percent = modelDownloaded
        ? 100
        : progressToPercent(nextAvailability.receivedBytes, nextAvailability.totalBytes);
      lastReceivedBytes = nextAvailability.receivedBytes;
      lastTotalBytes = nextAvailability.totalBytes;
    } catch (availabilityError) {
      devPrivacyWarn('local assistant availability check failed after preparation error', {
        reason: getPrivacySafeErrorReason(availabilityError),
      });
    }
    if (!modelDownloaded || !hadPersistedReadyState) {
      await clearReadyState();
    }
    emitState({
      state: 'error',
      percent,
      modelDownloaded,
      resumable,
      receivedBytes: lastReceivedBytes,
      totalBytes: lastTotalBytes,
      error: describeLocalAssistantFailure(
        error,
        modelDownloaded,
        modelDownloaded
          ? 'The model is saved, but SafeRide could not start it. Try again.'
          : 'Model setup failed. Check connection and storage, then try again.',
      ),
    });
    throw error;
  } finally {
    await releasePreparationKeepAwake();
  }
}

export async function pauseLocalAssistantPreparation(): Promise<boolean> {
  const paused = await pauseActiveModelDownload();
  if (paused) {
    emitState({ state: 'idle', percent: lastPercent, modelDownloaded: false, resumable: true });
    await releasePreparationKeepAwake();
  }
  return paused;
}

export async function cancelLocalAssistantPreparation(): Promise<boolean> {
  const modelConfig = getActiveLocalModelConfig();
  const availability = await inspectModelAvailability(modelConfig);
  const cancelledActiveDownload = await cancelActiveModelDownload();
  if (!cancelledActiveDownload && !availability.partial && !availability.resumable) {
    return false;
  }
  await removeModelArtifacts(modelConfig);
  await clearReadyState();
  emitState({
    state: 'idle',
    percent: 0,
    modelDownloaded: false,
    resumable: false,
    receivedBytes: 0,
    totalBytes: modelConfig.runtime.approximateSizeBytes,
  });
  await releasePreparationKeepAwake();
  return true;
}

export function isLocalAssistantPreparationPausedError(error: unknown): boolean {
  return error instanceof ModelDownloadPausedError;
}

export function isLocalAssistantPreparationCancelledError(error: unknown): boolean {
  return error instanceof ModelDownloadCancelledError;
}

export function isLocalAssistantReplyStoppedError(error: unknown): boolean {
  return error instanceof LocalModelGenerationStoppedError ||
    (error instanceof Error && error.name === 'LocalModelGenerationStoppedError');
}

function throwIfLocalAssistantReplyStopped(requestId: number): void {
  if (stoppedGenerationRequests.has(requestId)) {
    throw new LocalModelGenerationStoppedError();
  }
}

export function cancelActiveLocalAssistantReply(): boolean {
  let hadActiveRequest = false;
  activeGenerationRequests.forEach(requestId => {
    hadActiveRequest = true;
    stoppedGenerationRequests.add(requestId);
  });

  const stoppedNativeGeneration = localModelEngine.cancelActiveGeneration();
  return hadActiveRequest || stoppedNativeGeneration;
}

export async function resumeVerifiedLocalAssistantPreparation(onProgress?: (percent: number) => void): Promise<boolean> {
  assertAssistantEnabled();
  if (!localAssistantForegroundActive || currentState === 'ready' || isActivePreparationState()) {
    return false;
  }
  if (autoPreparation) {
    return autoPreparation;
  }

  const modelConfig = getActiveLocalModelConfig();
  if (emitArtifactBlockedState(modelConfig)) {
    return false;
  }

  const availability = await inspectModelAvailability(modelConfig);
  if (!availability.downloaded || !(await hasPersistedReadyState(modelConfig))) {
    return false;
  }

  autoPreparation = prepareLocalAssistant(onProgress)
    .then(() => true)
    .catch(error => {
      devPrivacyError('local assistant automatic preparation failed', {
        reason: getPrivacySafeErrorReason(error),
      });
      return false;
    })
    .finally(() => {
      autoPreparation = null;
    });

  return autoPreparation;
}

export async function startAutomaticLocalAssistantPreparation(onProgress?: (percent: number) => void): Promise<boolean> {
  assertAssistantEnabled();
  if (!localAssistantForegroundActive || currentState === 'ready' || isActivePreparationState()) {
    return false;
  }
  if (autoPreparation) {
    return autoPreparation;
  }

  const modelConfig = getActiveLocalModelConfig();
  if (emitArtifactBlockedState(modelConfig)) {
    return false;
  }

  const availability = await inspectModelAvailability(modelConfig);
  if (!availability.downloaded) {
    return false;
  }

  autoPreparation = prepareLocalAssistant(onProgress)
    .then(() => true)
    .catch(error => {
      if (!isLocalAssistantPreparationPausedError(error)) {
        devPrivacyError('local assistant automatic preparation failed', {
          reason: getPrivacySafeErrorReason(error),
        });
      }
      return false;
    })
    .finally(() => {
      autoPreparation = null;
    });

  return autoPreparation;
}

export type LocalAssistantResponse = {
  content: string;
  sourceLabel?: string;
};

const LOCAL_ASSISTANT_FAST_GREETING_SOURCE = 'SafeRide local quick reply';

function toUserFacingAssistantText(content: string, languageCode?: string | null): string {
  const copy = getAssistantLanguageCopy(languageCode);
  const withoutCodeBlocks = content.replace(/```[\s\S]*?```/g, ' ');
  const withoutInlineCode = withoutCodeBlocks.replace(/`([^`]+)`/g, '$1');
  const withoutMarkdownLinks = withoutInlineCode.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  const cleaned = withoutMarkdownLinks
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return cleaned || copy.fallbackReply;
}

function getLatestUserMessageContent(conversation: AssistantMessage[]): string {
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    const message = conversation[index];
    if (message?.role === 'user') {
      return message.content.trim();
    }
  }

  return '';
}

function buildFastLocalAssistantReply(
  conversation: AssistantMessage[],
  languageCode?: string | null,
): LocalAssistantResponse | null {
  const latestUserMessage = getLatestUserMessageContent(conversation);
  const normalized = latestUserMessage.toLowerCase().replace(/[.!?\s]+$/g, '').trim();
  if (!/^(hi|hello|hey|habari|mambo|sasa|good morning|good afternoon|good evening)$/.test(normalized)) {
    return null;
  }

  return {
    content: getAssistantLanguageCopy(languageCode).fastGreeting,
    sourceLabel: LOCAL_ASSISTANT_FAST_GREETING_SOURCE,
  };
}

function buildLanguageAwareLocalAssistantConversation(
  conversation: AssistantMessage[],
  languageCode?: string | null,
): AssistantMessage[] {
  const compactedConversation = compactLocalAssistantConversation(
    conversation.filter(message => message.role !== 'system'),
  );
  return [
    {
      role: 'system',
      content: getAssistantLanguageInstruction(languageCode),
    },
    ...compactedConversation,
  ];
}

function isNonFatalLocalAssistantGenerationError(error: unknown): boolean {
  return !isLikelyFatalLocalAssistantRuntimeError(error);
}

function isLikelyFatalLocalAssistantRuntimeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes('failed to initialize') ||
    message.includes('failed to load') ||
    message.includes('init') ||
    message.includes('native module') ||
    message.includes('context') ||
    message.includes('release')
  );
}

export async function generateLocalAssistantReply(
  conversation: AssistantMessage[],
  options?: AssistantOptions,
  onProgress?: (percent: number) => void,
): Promise<LocalAssistantResponse> {
  assertAssistantEnabled();
  const generationRequestId = ++nextGenerationRequestId;
  activeGenerationRequests.add(generationRequestId);
  const modelConfig = getActiveLocalModelConfig();
  try {
    const blocker = emitArtifactBlockedState(modelConfig);
    if (blocker) {
      throw new Error(blocker);
    }

    const fastReply = buildFastLocalAssistantReply(conversation, options?.languageCode);
    if (fastReply) {
      return fastReply;
    }

    await prepareLocalAssistant(onProgress, options?.downloadAuthorization);
    throwIfLocalAssistantReplyStopped(generationRequestId);
    const content = await localModelEngine.generateResponse(
      modelConfig,
      buildLanguageAwareLocalAssistantConversation(conversation, options?.languageCode),
      {
        ...options,
        allowRealLiteRtLmRuntime: localAssistantConfig.allowRealLiteRtLmRuntime,
      },
      adaptProgress(onProgress),
    );
    throwIfLocalAssistantReplyStopped(generationRequestId);
    return { content: toUserFacingAssistantText(content, options?.languageCode) };
  } catch (error) {
    if (stoppedGenerationRequests.has(generationRequestId) || isLocalAssistantReplyStoppedError(error)) {
      if (lastModelDownloaded) {
        emitState({ state: 'ready', percent: 100, modelDownloaded: true, resumable: false });
      }
      throw isLocalAssistantReplyStoppedError(error) ? error : new LocalModelGenerationStoppedError();
    }

    if (getRuntimeArtifactBlocker(modelConfig)) {
      throw error;
    }

    devPrivacyError('local assistant generation failed', { reason: getPrivacySafeErrorReason(error) });
    const canKeepWarmRuntime =
      lastModelDownloaded &&
      localModelEngine.isReady(modelConfig) &&
      isNonFatalLocalAssistantGenerationError(error);
    if (canKeepWarmRuntime) {
      emitState({
        state: 'ready',
        percent: 100,
        modelDownloaded: true,
        resumable: false,
        error: localAssistantFailureCategory(error) === 'memory'
          ? getLocalAiPilotCopy().failure.statusMessage('memory', true)
          : 'Reply stopped. Try again or send a shorter message.',
      });
      throw error;
    }

    await unloadLocalAssistantRuntime('local assistant runtime unload after generation failure failed');
    emitState({
      state: lastModelDownloaded ? 'downloaded' : 'error',
      percent: lastModelDownloaded ? 100 : lastPercent,
      modelDownloaded: lastModelDownloaded,
      resumable: lastResumable,
      error: describeLocalAssistantFailure(
        error,
        lastModelDownloaded,
        lastModelDownloaded
          ? 'The model is saved, but the reply failed. Try again.'
          : 'Model setup failed. Check connection and storage, then try again.',
      ),
    });
    throw error;
  } finally {
    activeGenerationRequests.delete(generationRequestId);
    stoppedGenerationRequests.delete(generationRequestId);
  }
}

export async function transcribeWithLocalAssistant(
  audioPath: string,
  options?: TranscriptionOptions,
  onProgress?: (percent: number) => void,
): Promise<string> {
  assertAssistantEnabled();
  const modelConfig = getActiveLocalModelConfig();
  const blocker = emitArtifactBlockedState(modelConfig);
  if (blocker) {
    throw new Error(blocker);
  }
  if (!modelConfig.capabilities.audioTranscription) {
    throw new Error(`${modelConfig.label} does not support local audio transcription.`);
  }
  await prepareLocalAssistant(onProgress);
  return localModelEngine.transcribeAudio(modelConfig, audioPath, options, adaptProgress(onProgress));
}

export function getLocalAssistantStatus(): StatePayload {
  return {
    state: currentState,
    percent: lastPercent,
    error: cachedError,
    modelDownloaded: lastModelDownloaded,
    resumable: lastResumable,
    receivedBytes: lastReceivedBytes,
    totalBytes: lastTotalBytes,
  };
}

export async function refreshLocalAssistantStatus(): Promise<StatePayload> {
  if (
    !localAssistantConfig.enabled ||
    currentState === 'ready' ||
    currentState === 'checking' ||
    currentState === 'downloading' ||
    currentState === 'verifying' ||
    currentState === 'configuring'
  ) {
    return getLocalAssistantStatus();
  }

  try {
    const modelConfig = getActiveLocalModelConfig();
    if (await enforceTunedArtifactRuntimeControl(modelConfig)) {
      return getLocalAssistantStatus();
    }
    if (emitArtifactBlockedState(modelConfig)) {
      return getLocalAssistantStatus();
    }

    if (localModelEngine.isReady(modelConfig)) {
      const nextState: StatePayload = {
        state: 'ready',
        percent: 100,
        modelDownloaded: true,
        resumable: false,
      };
      emitState(nextState);
      return nextState;
    }

    const availability = await inspectModelAvailability(modelConfig);
    let nextState: StatePayload;
    if (availability.downloaded) {
      nextState = {
        state: 'downloaded',
        percent: 100,
        modelDownloaded: true,
        resumable: false,
        receivedBytes: availability.receivedBytes,
        totalBytes: availability.totalBytes,
      };
    } else if (availability.invalid) {
      nextState = {
        state: 'error',
        percent: progressToPercent(availability.receivedBytes, availability.totalBytes),
        modelDownloaded: false,
        resumable: false,
        receivedBytes: availability.receivedBytes,
        totalBytes: availability.totalBytes,
        error: 'The saved model file is invalid. Download it again.',
      };
    } else {
      nextState = {
        state: 'idle',
        percent: progressToPercent(availability.receivedBytes, availability.totalBytes),
        modelDownloaded: false,
        resumable: availability.resumable,
        receivedBytes: availability.receivedBytes,
        totalBytes: availability.totalBytes,
      };
    }

    emitState(nextState);
    return nextState;
  } catch (error) {
    devPrivacyWarn('local assistant availability check failed', { reason: getPrivacySafeErrorReason(error) });
    return getLocalAssistantStatus();
  }
}

export function getLocalAssistantDescriptor() {
  const modelConfig = getActiveLocalModelConfig();
  const primaryFile = modelConfig.files.find(file => file.fileName === modelConfig.runtime.modelFileName);
  return {
    id: modelConfig.id,
    label: modelConfig.label,
    runtimeModelId: modelConfig.runtime.modelId,
    providerFamily: modelConfig.providerFamily,
    variant: modelConfig.variant,
    approximateSize: formatApproximateModelSize(modelConfig),
    exactSizeBytes: primaryFile?.sizeBytes,
    storageRequiredBytes: modelConfig.runtime.kind === 'litert-lm'
      ? modelConfig.runtime.storageRequiredBytes
      : undefined,
    manifestId: modelConfig.manifestId,
    artifactSha256: primaryFile?.sha256,
    fileName: primaryFile?.fileName,
    qaOnly: Boolean(modelConfig.qaOnly),
    lifecycleStatus: modelConfig.lifecycleStatus,
    vramRequiredMb: modelConfig.runtime.vramRequiredMb,
    appReady: !getRuntimeArtifactBlocker(modelConfig),
    artifact: modelConfig.artifact,
    capabilities: modelConfig.capabilities,
  };
}

export function getLocalAssistantSourceLabel(): string {
  return getLocalAssistantDescriptor().label;
}
