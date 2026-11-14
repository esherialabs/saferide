import { type LocalLiteRtLmRuntime, type LocalModelConfig } from './modelRegistry';
import {
  ensureModelAvailability,
  resolveModelFilePath,
  type LargeModelDownloadAuthorization,
  type ProgressCallback,
} from './modelStorage';
import type { SelectableAppLanguageCode } from '../../config/languageAvailability';
import {
  cancelSafeRideLiteRtLmBridge,
  createSafeRideLiteRtLmBridgeConfig,
  generateSafeRideLiteRtLmResponse,
  isLiteRtLmModelConfig,
  loadSafeRideLiteRtLmBridge,
  prepareSafeRideLiteRtLmBridge,
  unloadSafeRideLiteRtLmBridge,
  type SafeRideLiteRtLmBridgeStatus,
  type SafeRideLiteRtLmGenerateResult,
} from './liteRtLmBridge';
import { recordAiPilotQaDiagnostic, runWithAiPilotInFlight } from './pilotDiagnostics';

export type AssistantMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type AssistantOptions = {
  temperature?: number;
  maxTokens?: number;
  allowRealLiteRtLmRuntime?: boolean;
  languageCode?: SelectableAppLanguageCode;
  downloadAuthorization?: LargeModelDownloadAuthorization;
};

export type TranscriptionOptions = {
  temperature?: number;
  prompt?: string;
};

type LiteRtLmModelConfig = LocalModelConfig & { runtime: LocalLiteRtLmRuntime };
type LiteRtLmRuntimeOptions = {
  allowRealLiteRtLmRuntime?: boolean;
  downloadAuthorization?: LargeModelDownloadAuthorization;
};

export class LocalModelGenerationStoppedError extends Error {
  constructor() {
    super('Local assistant reply was stopped.');
    this.name = 'LocalModelGenerationStoppedError';
  }
}

const DEFAULT_GENERATION_OPTS: Required<Pick<AssistantOptions, 'temperature' | 'maxTokens'>> = {
  temperature: 0.2,
  maxTokens: 128,
};

const LITERT_LOAD_TIMEOUT_MS = 600_000;
const COMPLETION_TIMEOUT_MS = 600_000;
const READINESS_PROBE_TIMEOUT_MS = 120_000;
const READINESS_PROBE_MAX_TOKENS = 4;

function assertLiteRtLmModelConfig(modelConfig: LocalModelConfig): asserts modelConfig is LiteRtLmModelConfig {
  if (!isLiteRtLmModelConfig(modelConfig)) {
    throw new Error(
      `${modelConfig.label} uses ${modelConfig.runtime.kind}; SafeRide now supports only Gemma 4 E2B LiteRT-LM runtime entries.`,
    );
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout?: () => void | Promise<void>,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => {
      Promise.resolve(onTimeout?.()).catch(() => {});
      reject(new Error(message));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

function bridgeStatusFromGenerateResult(payload: SafeRideLiteRtLmGenerateResult): SafeRideLiteRtLmBridgeStatus {
  const mockMode = payload.mockMode === true;
  return {
    state: 'loaded',
    nativeAvailable: true,
    runtimeAvailable: true,
    mockMode,
    realRuntimeLoaded: !mockMode,
    artifactValidated: !mockMode,
    activeBackend: payload.activeBackend,
    backendLabel: payload.backendLabel,
  };
}

class LocalModelEngine {
  private liteRtLoadedModelId: string | null = null;
  private liteRtVerifiedModelId: string | null = null;
  private liteRtGenerationActive = false;

  async ensureLoaded(
    modelConfig: LocalModelConfig,
    onProgress?: ProgressCallback,
    runtimeOptions: LiteRtLmRuntimeOptions = {},
  ): Promise<void> {
    assertLiteRtLmModelConfig(modelConfig);
    if (this.liteRtLoadedModelId === modelConfig.id) return;

    if (this.liteRtLoadedModelId) {
      await this.unload();
    }

    if (runtimeOptions.downloadAuthorization) {
      await ensureModelAvailability(modelConfig, onProgress, runtimeOptions.downloadAuthorization);
    } else {
      await ensureModelAvailability(modelConfig, onProgress);
    }
    const modelPath = resolveModelFilePath(modelConfig, modelConfig.runtime.modelFileName);
    const bridgeConfig = createSafeRideLiteRtLmBridgeConfig(modelConfig, {
      modelPath,
      allowRealRuntime: runtimeOptions.allowRealLiteRtLmRuntime === true,
    });

    onProgress?.({
      fileName: modelConfig.runtime.modelFileName,
      receivedBytes: 0,
      totalBytes: 100,
      phase: 'load',
    });
    const loadStartedAt = Date.now();
    let loadedStatus: SafeRideLiteRtLmBridgeStatus;
    try {
      loadedStatus = await runWithAiPilotInFlight('load', async () => {
        await prepareSafeRideLiteRtLmBridge(bridgeConfig);
        return withTimeout(
          loadSafeRideLiteRtLmBridge(bridgeConfig),
          LITERT_LOAD_TIMEOUT_MS,
          'LiteRT-LM model configuration timed out.',
          async () => {
            await unloadSafeRideLiteRtLmBridge();
          },
        );
      });
    } catch (error) {
      recordAiPilotQaDiagnostic({ modelConfig, phase: 'load', durationMs: Date.now() - loadStartedAt, error });
      throw error;
    }
    recordAiPilotQaDiagnostic({
      modelConfig,
      phase: 'load',
      durationMs: Date.now() - loadStartedAt,
      bridgeStatus: loadedStatus,
    });
    this.liteRtLoadedModelId = modelConfig.id;
    this.liteRtVerifiedModelId = null;
    onProgress?.({
      fileName: modelConfig.runtime.modelFileName,
      receivedBytes: 100,
      totalBytes: 100,
      phase: 'load',
    });
  }

  async unload(): Promise<void> {
    if (!this.liteRtLoadedModelId && !this.liteRtVerifiedModelId) return;
    try {
      await unloadSafeRideLiteRtLmBridge();
    } finally {
      this.liteRtLoadedModelId = null;
      this.liteRtVerifiedModelId = null;
      this.liteRtGenerationActive = false;
    }
  }

  isReady(modelConfig: LocalModelConfig): boolean {
    return isLiteRtLmModelConfig(modelConfig) && this.liteRtVerifiedModelId === modelConfig.id;
  }

  async ensureReady(
    modelConfig: LocalModelConfig,
    onProgress?: ProgressCallback,
    runtimeOptions: LiteRtLmRuntimeOptions = {},
  ): Promise<void> {
    assertLiteRtLmModelConfig(modelConfig);
    await this.ensureLoaded(modelConfig, onProgress, runtimeOptions);
    if (this.liteRtVerifiedModelId === modelConfig.id) return;

    const probeStartedAt = Date.now();
    let payload: SafeRideLiteRtLmGenerateResult;
    try {
      payload = await runWithAiPilotInFlight('readiness-probe', () => withTimeout(
        generateSafeRideLiteRtLmResponse(
          [{ role: 'user', content: 'Say ready.' }],
          { temperature: 0, maxOutputTokens: READINESS_PROBE_MAX_TOKENS },
        ),
        READINESS_PROBE_TIMEOUT_MS,
        'LiteRT-LM readiness check timed out.',
        async () => {
          await cancelSafeRideLiteRtLmBridge();
        },
      ));
      if (!payload.content.trim()) {
        throw new Error('LiteRT-LM readiness check produced an empty response');
      }
    } catch (error) {
      recordAiPilotQaDiagnostic({
        modelConfig,
        phase: 'readiness-probe',
        durationMs: Date.now() - probeStartedAt,
        error,
      });
      throw error;
    }
    recordAiPilotQaDiagnostic({
      modelConfig,
      phase: 'readiness-probe',
      durationMs: Date.now() - probeStartedAt,
      bridgeStatus: bridgeStatusFromGenerateResult(payload),
    });
    this.liteRtVerifiedModelId = modelConfig.id;
  }

  async generateResponse(
    modelConfig: LocalModelConfig,
    messages: AssistantMessage[],
    options: AssistantOptions = {},
    onProgress?: ProgressCallback,
  ): Promise<string> {
    assertLiteRtLmModelConfig(modelConfig);
    await this.ensureReady(modelConfig, onProgress, {
      allowRealLiteRtLmRuntime: options.allowRealLiteRtLmRuntime === true,
      downloadAuthorization: options.downloadAuthorization,
    });
    this.liteRtGenerationActive = true;
    const generationStartedAt = Date.now();
    try {
      const payload = await runWithAiPilotInFlight('generation', () => withTimeout(
        generateSafeRideLiteRtLmResponse(messages, {
          temperature: options.temperature ?? DEFAULT_GENERATION_OPTS.temperature,
          maxOutputTokens: options.maxTokens ?? modelConfig.runtime.maxOutputTokens ?? DEFAULT_GENERATION_OPTS.maxTokens,
        }),
        COMPLETION_TIMEOUT_MS,
        'Local assistant reply timed out.',
        async () => {
          await cancelSafeRideLiteRtLmBridge();
        },
      ));
      const text = payload.content.trim();
      if (!text) {
        throw new Error('LiteRT-LM local model engine produced an empty response');
      }
      // The reply is read in memory for length and two keyword booleans; it is not stored.
      recordAiPilotQaDiagnostic({
        modelConfig,
        phase: 'generation',
        durationMs: Date.now() - generationStartedAt,
        bridgeStatus: bridgeStatusFromGenerateResult(payload),
        replyText: text,
      });
      return text;
    } catch (error) {
      recordAiPilotQaDiagnostic({
        modelConfig,
        phase: 'generation',
        durationMs: Date.now() - generationStartedAt,
        error,
      });
      throw error;
    } finally {
      this.liteRtGenerationActive = false;
    }
  }

  cancelActiveGeneration(): boolean {
    if (!this.liteRtGenerationActive) return false;
    void cancelSafeRideLiteRtLmBridge().catch(() => undefined);
    return true;
  }

  async transcribeAudio(
    modelConfig: LocalModelConfig,
    _audioPath: string,
    _options: TranscriptionOptions = {},
    _onProgress?: ProgressCallback,
  ): Promise<string> {
    assertLiteRtLmModelConfig(modelConfig);
    throw new Error(`${modelConfig.label} does not support local audio transcription.`);
  }
}

export const localModelEngine = new LocalModelEngine();
export const localGemmaEngine = localModelEngine;
