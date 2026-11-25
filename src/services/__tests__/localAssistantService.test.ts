import { beforeEach, describe, expect, it, vi } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';

import type { LocalModelConfig, ModelAvailability } from '../../lib/localAssistant';

const asyncStorageMock = AsyncStorage as typeof AsyncStorage & {
  __reset: () => void;
};

function flushAsyncWork(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

const serviceMock = vi.hoisted(() => {
  const modelConfig: LocalModelConfig = {
    id: 'test-model',
    label: 'Test local model',
    variant: 'test/model',
    providerFamily: 'gemma',
    runtime: {
      kind: 'litert-lm',
      modelId: 'test-model',
      modelFileName: 'model.litertlm',
      contextWindow: 128,
      maxOutputTokens: 64,
      backendPlan: ['cpu-text'],
      cachePolicy: 'app-cache',
      approximateSizeBytes: 100,
    },
    storageDir: 'test-model',
    files: [
      {
        fileName: 'model.litertlm',
        downloadUrl: 'https://models.example/model.litertlm',
        sizeBytes: 100,
      },
    ],
    systemPrompt: 'Test prompt',
    capabilities: {
      textGeneration: true,
      audioTranscription: false,
      offenceTagging: true,
    },
  };

  const completeAvailability: ModelAvailability = {
    modelId: 'test-model',
    downloaded: true,
    complete: true,
    invalid: false,
    partial: false,
    resumable: false,
    receivedBytes: 100,
    totalBytes: 100,
    files: [
      {
        fileName: 'model.litertlm',
        path: 'file:///safeRide/models/test-model/model.litertlm',
        state: 'complete',
        expectedSizeBytes: 100,
        actualSizeBytes: 100,
        resumable: false,
      },
    ],
  };

  const tunedModelConfig: LocalModelConfig = {
    ...modelConfig,
    manifestId: 'synthetic-tuned-manifest',
    manifestSha256: 'b'.repeat(64),
    lifecycleStatus: 'release-ready',
    rolloutDownloadMode: 'app-download',
    files: modelConfig.files.map(file => ({ ...file, sha256: 'a'.repeat(64), downloadMode: 'app-download' })),
  };

  const partialAvailability: ModelAvailability = {
    modelId: 'test-model',
    downloaded: false,
    complete: false,
    invalid: false,
    partial: true,
    resumable: true,
    receivedBytes: 40,
    totalBytes: 100,
    files: [
      {
        fileName: 'model.litertlm',
        path: 'file:///safeRide/models/test-model/model.litertlm',
        state: 'partial',
        expectedSizeBytes: 100,
        actualSizeBytes: 40,
        resumable: true,
        progress: {
          fileName: 'model.litertlm',
          receivedBytes: 40,
          totalBytes: 100,
          phase: 'download',
        },
      },
    ],
  };

  const downloadedAvailability: ModelAvailability = {
    ...completeAvailability,
    complete: false,
    files: completeAvailability.files.map(file => ({
      ...file,
      state: 'downloaded',
    })),
  };

  class ModelDownloadPausedError extends Error {
    constructor(fileName: string) {
      super(`Download paused for ${fileName}`);
      this.name = 'ModelDownloadPausedError';
    }
  }

  class ModelDownloadCancelledError extends Error {
    constructor(fileName: string) {
      super(`Download cancelled for ${fileName}`);
      this.name = 'ModelDownloadCancelledError';
    }
  }

  class LocalModelGenerationStoppedError extends Error {
    constructor() {
      super('Local assistant reply was stopped.');
      this.name = 'LocalModelGenerationStoppedError';
    }
  }

  return {
    modelConfig,
    tunedModelConfig,
    completeAvailability,
    downloadedAvailability,
    partialAvailability,
    ModelDownloadCancelledError,
    ModelDownloadPausedError,
    LocalModelGenerationStoppedError,
    localModelEngine: {
      ensureReady: vi.fn(),
      generateResponse: vi.fn(),
      transcribeAudio: vi.fn(),
      cancelActiveGeneration: vi.fn(),
      isReady: vi.fn(),
      unload: vi.fn(),
    },
    getModelAvailability: vi.fn(),
    getLocalModelArtifactBlocker: vi.fn(),
    cancelActiveModelDownload: vi.fn(),
    pauseActiveModelDownload: vi.fn(),
    removeModelArtifacts: vi.fn(),
    tunedArtifactRemovalReason: vi.fn(),
    getBundledTunedArtifactRemovalCandidate: vi.fn(),
    resolveTunedArtifactRuntimeSelection: vi.fn(),
  };
});

const keepAwakeMock = vi.hoisted(() => ({
  activateKeepAwakeAsync: vi.fn(async () => undefined),
  deactivateKeepAwake: vi.fn(async () => undefined),
}));

vi.mock('../../config/localAssistant', () => ({
  localAssistantConfig: {
    enabled: true,
    modelId: 'test-model',
  },
}));

vi.mock('../../lib/localAssistant', () => ({
  localModelEngine: serviceMock.localModelEngine,
  getModelAvailability: serviceMock.getModelAvailability,
  inspectModelAvailability: serviceMock.getModelAvailability,
  getLocalModelArtifactBlocker: serviceMock.getLocalModelArtifactBlocker,
  LocalModelGenerationStoppedError: serviceMock.LocalModelGenerationStoppedError,
  ModelDownloadCancelledError: serviceMock.ModelDownloadCancelledError,
  ModelDownloadPausedError: serviceMock.ModelDownloadPausedError,
  cancelActiveModelDownload: serviceMock.cancelActiveModelDownload,
  pauseActiveModelDownload: serviceMock.pauseActiveModelDownload,
  removeModelArtifacts: serviceMock.removeModelArtifacts,
  tunedArtifactRemovalReason: serviceMock.tunedArtifactRemovalReason,
  getBundledTunedArtifactRemovalCandidate: serviceMock.getBundledTunedArtifactRemovalCandidate,
  resolveTunedArtifactRuntimeSelection: serviceMock.resolveTunedArtifactRuntimeSelection,
  resolveLocalModelConfig: vi.fn(() => serviceMock.modelConfig),
  formatApproximateModelSize: vi.fn(() => '100 bytes'),
}));

vi.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: keepAwakeMock.activateKeepAwakeAsync,
  deactivateKeepAwake: keepAwakeMock.deactivateKeepAwake,
}));

describe('localAssistantService', () => {
  beforeEach(() => {
    vi.resetModules();
    asyncStorageMock.__reset();
    serviceMock.localModelEngine.ensureReady.mockReset();
    serviceMock.localModelEngine.generateResponse.mockReset();
    serviceMock.localModelEngine.cancelActiveGeneration.mockReset();
    serviceMock.localModelEngine.isReady.mockReset();
    serviceMock.localModelEngine.unload.mockReset();
    serviceMock.getModelAvailability.mockReset();
    serviceMock.getLocalModelArtifactBlocker.mockReset();
    serviceMock.cancelActiveModelDownload.mockReset();
    serviceMock.pauseActiveModelDownload.mockReset();
    serviceMock.removeModelArtifacts.mockReset();
    serviceMock.tunedArtifactRemovalReason.mockReset();
    serviceMock.getBundledTunedArtifactRemovalCandidate.mockReset();
    serviceMock.resolveTunedArtifactRuntimeSelection.mockReset();
    keepAwakeMock.activateKeepAwakeAsync.mockClear();
    keepAwakeMock.deactivateKeepAwake.mockClear();
    serviceMock.getModelAvailability.mockResolvedValue(serviceMock.completeAvailability);
    serviceMock.getLocalModelArtifactBlocker.mockReturnValue(null);
    serviceMock.tunedArtifactRemovalReason.mockReturnValue(null);
    serviceMock.getBundledTunedArtifactRemovalCandidate.mockReturnValue(null);
    serviceMock.resolveTunedArtifactRuntimeSelection.mockReturnValue({
      selectionRequired: false,
      config: null,
      decision: {
        enabled: false,
        reason: 'controls-disabled',
        manifestId: null,
        artifactSha256: null,
        rolloutPercent: 0,
        rollbackTargetManifestId: 'fail-closed:no-local-ai',
      },
    });
    serviceMock.localModelEngine.isReady.mockReturnValue(false);
  });

  it('keeps the screen awake only while foreground preparation is active', async () => {
    serviceMock.localModelEngine.ensureReady.mockResolvedValue(undefined);
    const service = await import('../localAssistantService');

    await service.prepareLocalAssistant();

    expect(keepAwakeMock.activateKeepAwakeAsync).toHaveBeenCalledWith('saferide-local-assistant-preparation');
    expect(keepAwakeMock.deactivateKeepAwake).toHaveBeenCalledWith('saferide-local-assistant-preparation');
    expect(service.getLocalAssistantStatus()).toMatchObject({
      state: 'ready',
      percent: 100,
      modelDownloaded: true,
      resumable: false,
    });
  });

  it('blocks a selected target model that is missing a mobile runtime artifact', async () => {
    serviceMock.getLocalModelArtifactBlocker.mockReturnValue(
      'This build cannot start local AI yet.',
    );
    const service = await import('../localAssistantService');

    await expect(service.prepareLocalAssistant()).rejects.toThrow('This build cannot start local AI yet.');

    expect(serviceMock.getModelAvailability).not.toHaveBeenCalled();
    expect(serviceMock.localModelEngine.ensureReady).not.toHaveBeenCalled();
    expect(service.getLocalAssistantStatus()).toMatchObject({
      state: 'error',
      percent: 0,
      modelDownloaded: false,
      resumable: false,
      error: expect.stringContaining('cannot start local AI'),
    });
    expect(service.getLocalAssistantDescriptor()).toMatchObject({
      appReady: false,
    });
  });

  it('does not replace the missing-artifact error during chat generation, including greetings', async () => {
    serviceMock.getLocalModelArtifactBlocker.mockReturnValue(
      'This build cannot start local AI yet.',
    );
    const service = await import('../localAssistantService');

    await expect(service.generateLocalAssistantReply([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      'This build cannot start local AI yet.',
    );

    expect(serviceMock.getModelAvailability).not.toHaveBeenCalled();
    expect(serviceMock.localModelEngine.ensureReady).not.toHaveBeenCalled();
    expect(serviceMock.localModelEngine.generateResponse).not.toHaveBeenCalled();
    expect(serviceMock.localModelEngine.unload).not.toHaveBeenCalled();
    expect(service.getLocalAssistantStatus()).toMatchObject({
      state: 'error',
      modelDownloaded: false,
      error: expect.stringContaining('cannot start local AI'),
    });
  });


  it('does not request keep-awake while the app is backgrounded', async () => {
    serviceMock.localModelEngine.ensureReady.mockResolvedValue(undefined);
    const service = await import('../localAssistantService');

    await service.setLocalAssistantForegroundActive(false);
    await service.prepareLocalAssistant();

    expect(keepAwakeMock.activateKeepAwakeAsync).not.toHaveBeenCalled();
    expect(keepAwakeMock.deactivateKeepAwake).not.toHaveBeenCalled();
  });

  it('emits byte counts during model download progress for ETA calculation', async () => {
    serviceMock.getModelAvailability.mockResolvedValue(serviceMock.partialAvailability);
    serviceMock.localModelEngine.ensureReady.mockImplementation(async (_config, onProgress) => {
      onProgress?.({
        fileName: 'model.litertlm',
        phase: 'download',
        receivedBytes: 65,
        totalBytes: 100,
      });
    });
    const service = await import('../localAssistantService');
    const states: Array<ReturnType<typeof service.getLocalAssistantStatus>> = [];

    service.subscribeToAssistantState(state => {
      states.push(state);
    });

    await service.prepareLocalAssistant();

    expect(states).toContainEqual(expect.objectContaining({
      state: 'downloading',
      percent: 65,
      receivedBytes: 65,
      totalBytes: 100,
    }));
    expect(service.getLocalAssistantStatus()).toMatchObject({
      state: 'ready',
      percent: 100,
      receivedBytes: 65,
      totalBytes: 100,
    });
  });

  it('separates checksum verification progress from network download progress', async () => {
    serviceMock.getModelAvailability.mockResolvedValue(serviceMock.downloadedAvailability);
    serviceMock.localModelEngine.ensureReady.mockImplementation(async (_config, onProgress) => {
      onProgress?.({
        fileName: 'model.litertlm',
        phase: 'verify',
        receivedBytes: 55,
        totalBytes: 100,
      });
    });
    const service = await import('../localAssistantService');
    const states: Array<ReturnType<typeof service.getLocalAssistantStatus>> = [];

    service.subscribeToAssistantState(state => {
      states.push(state);
    });

    await service.prepareLocalAssistant();

    expect(states).toContainEqual(expect.objectContaining({
      state: 'verifying',
      percent: 55,
      modelDownloaded: true,
      resumable: false,
      receivedBytes: 55,
      totalBytes: 100,
    }));
    expect(service.getLocalAssistantStatus()).toMatchObject({
      state: 'ready',
      percent: 100,
      modelDownloaded: true,
    });
  });

  it('deduplicates concurrent preparation requests', async () => {
    let resolveReady: () => void = () => {};
    serviceMock.localModelEngine.ensureReady.mockReturnValue(
      new Promise<void>(resolve => {
        resolveReady = resolve;
      }),
    );
    const service = await import('../localAssistantService');

    const first = service.prepareLocalAssistant();
    const second = service.prepareLocalAssistant();
    await flushAsyncWork();

    expect(serviceMock.localModelEngine.ensureReady).toHaveBeenCalledTimes(1);
    resolveReady();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(service.getLocalAssistantStatus()).toMatchObject({ state: 'ready', percent: 100 });
  });

  it('releases keep-awake and preserves resumable state when preparation is paused', async () => {
    serviceMock.getModelAvailability.mockResolvedValue(serviceMock.partialAvailability);
    serviceMock.localModelEngine.ensureReady.mockRejectedValue(new serviceMock.ModelDownloadPausedError('model.litertlm'));
    const service = await import('../localAssistantService');

    await expect(service.prepareLocalAssistant()).rejects.toThrow('Download paused for model.litertlm');

    expect(keepAwakeMock.activateKeepAwakeAsync).toHaveBeenCalledWith('saferide-local-assistant-preparation');
    expect(keepAwakeMock.deactivateKeepAwake).toHaveBeenCalledWith('saferide-local-assistant-preparation');
    expect(service.getLocalAssistantStatus()).toMatchObject({
      state: 'idle',
      percent: 40,
      modelDownloaded: false,
      resumable: true,
      receivedBytes: 40,
      totalBytes: 100,
    });
  });

  it('hydrates saved partial progress into the UI-facing preparation state', async () => {
    serviceMock.getModelAvailability.mockResolvedValue(serviceMock.partialAvailability);
    const service = await import('../localAssistantService');
    const states: Array<ReturnType<typeof service.getLocalAssistantStatus>> = [];

    service.subscribeToAssistantState(state => {
      states.push(state);
    });

    await service.hydrateLocalAssistantPreparationState();

    expect(states.at(-1)).toMatchObject({
      state: 'idle',
      percent: 40,
      modelDownloaded: false,
      resumable: true,
      receivedBytes: 40,
      totalBytes: 100,
    });
  });

  it('recognizes a fully downloaded unverified file after restart without requesting another download', async () => {
    serviceMock.getModelAvailability.mockResolvedValue(serviceMock.downloadedAvailability);
    const service = await import('../localAssistantService');
    const states: Array<ReturnType<typeof service.getLocalAssistantStatus>> = [];

    service.subscribeToAssistantState(state => {
      states.push(state);
    });

    await service.hydrateLocalAssistantPreparationState();

    expect(states).toContainEqual(expect.objectContaining({
      state: 'checking',
      modelDownloaded: false,
    }));
    expect(states.at(-1)).toMatchObject({
      state: 'downloaded',
      percent: 100,
      modelDownloaded: true,
      receivedBytes: 100,
      totalBytes: 100,
    });
    expect(serviceMock.localModelEngine.ensureReady).not.toHaveBeenCalled();
  });

  it('auto-configures a previously verified downloaded model after a cold restart', async () => {
    serviceMock.localModelEngine.ensureReady.mockResolvedValue(undefined);
    const service = await import('../localAssistantService');
    const storage = (await import('@react-native-async-storage/async-storage')).default as typeof AsyncStorage;

    await service.prepareLocalAssistant();
    expect(storage.setItem).toHaveBeenCalledWith(
      '@saferide_local_assistant_ready_state',
      expect.stringContaining('"modelId":"test-model"'),
    );
    expect(service.getLocalAssistantStatus()).toMatchObject({
      state: 'ready',
      percent: 100,
      modelDownloaded: true,
    });

    vi.resetModules();
    serviceMock.localModelEngine.isReady.mockReset();
    serviceMock.localModelEngine.isReady.mockReturnValue(false);
    serviceMock.localModelEngine.ensureReady.mockReset();
    serviceMock.localModelEngine.ensureReady.mockImplementation(async () => {
      serviceMock.localModelEngine.isReady.mockReturnValue(true);
    });
    const restartedStorage = (await import('@react-native-async-storage/async-storage')).default as typeof AsyncStorage;
    await restartedStorage.setItem('@saferide_local_assistant_ready_state', JSON.stringify({
      schema: 'com.saferide.local-assistant-ready-state',
      version: 2,
      modelId: 'test-model',
      runtimeModelId: 'test-model',
      runtimeKind: 'litert-lm',
      files: [{ fileName: 'model.litertlm', sizeBytes: 100 }],
      verifiedAt: '2026-06-24T00:00:00.000Z',
    }));
    const restartedService = await import('../localAssistantService');

    await restartedService.hydrateLocalAssistantPreparationState();
    expect(restartedService.getLocalAssistantStatus()).toMatchObject({
      state: 'downloaded',
      percent: 100,
      modelDownloaded: true,
    });

    await expect(restartedService.resumeVerifiedLocalAssistantPreparation()).resolves.toBe(true);

    expect(serviceMock.localModelEngine.ensureReady).toHaveBeenCalledTimes(1);
    expect(restartedService.getLocalAssistantStatus()).toMatchObject({
      state: 'ready',
      percent: 100,
      modelDownloaded: true,
      resumable: false,
    });
  });

  it('does not auto-configure a downloaded model without prior readiness proof', async () => {
    serviceMock.localModelEngine.ensureReady.mockResolvedValue(undefined);
    const service = await import('../localAssistantService');

    await service.hydrateLocalAssistantPreparationState();
    await expect(service.resumeVerifiedLocalAssistantPreparation()).resolves.toBe(false);

    expect(serviceMock.localModelEngine.ensureReady).not.toHaveBeenCalled();
    expect(service.getLocalAssistantStatus()).toMatchObject({
      state: 'downloaded',
      percent: 100,
      modelDownloaded: true,
    });
  });

  it('starts automatic preparation for a downloaded model without a setup screen', async () => {
    serviceMock.getModelAvailability.mockResolvedValue(serviceMock.downloadedAvailability);
    serviceMock.localModelEngine.ensureReady.mockResolvedValue(undefined);
    const service = await import('../localAssistantService');

    await service.hydrateLocalAssistantPreparationState();
    await expect(service.startAutomaticLocalAssistantPreparation()).resolves.toBe(true);

    expect(serviceMock.localModelEngine.ensureReady).toHaveBeenCalledTimes(1);
    expect(service.getLocalAssistantStatus()).toMatchObject({
      state: 'ready',
      percent: 100,
      modelDownloaded: true,
      resumable: false,
    });
  });

  it('does not automatically resume a partial model without fresh user consent', async () => {
    serviceMock.getModelAvailability.mockResolvedValue(serviceMock.partialAvailability);
    serviceMock.localModelEngine.ensureReady.mockResolvedValue(undefined);
    const service = await import('../localAssistantService');

    await service.hydrateLocalAssistantPreparationState();
    expect(service.getLocalAssistantStatus()).toMatchObject({
      state: 'idle',
      percent: 40,
      resumable: true,
    });

    await expect(service.startAutomaticLocalAssistantPreparation()).resolves.toBe(false);

    expect(serviceMock.localModelEngine.ensureReady).not.toHaveBeenCalled();
    expect(service.getLocalAssistantStatus()).toMatchObject({
      state: 'idle',
      percent: 40,
      modelDownloaded: false,
      resumable: true,
    });
  });

  it('does not start automatic preparation while the app is backgrounded', async () => {
    serviceMock.localModelEngine.ensureReady.mockResolvedValue(undefined);
    const service = await import('../localAssistantService');

    await service.setLocalAssistantForegroundActive(false);
    await expect(service.startAutomaticLocalAssistantPreparation()).resolves.toBe(false);

    expect(serviceMock.localModelEngine.ensureReady).not.toHaveBeenCalled();
  });

  it('emits a resumable idle state after a successful explicit pause', async () => {
    serviceMock.getModelAvailability.mockResolvedValue(serviceMock.partialAvailability);
    serviceMock.pauseActiveModelDownload.mockResolvedValue(true);
    const service = await import('../localAssistantService');
    const states: Array<ReturnType<typeof service.getLocalAssistantStatus>> = [];

    service.subscribeToAssistantState(state => {
      states.push(state);
    });

    await service.hydrateLocalAssistantPreparationState();
    await expect(service.pauseLocalAssistantPreparation()).resolves.toBe(true);

    expect(serviceMock.pauseActiveModelDownload).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toMatchObject({
      state: 'idle',
      percent: 40,
      modelDownloaded: false,
      resumable: true,
      receivedBytes: 40,
      totalBytes: 100,
    });
  });

  it('cancels and removes an active or resumable partial model download', async () => {
    serviceMock.getModelAvailability.mockResolvedValue(serviceMock.partialAvailability);
    serviceMock.cancelActiveModelDownload.mockResolvedValue(true);
    serviceMock.removeModelArtifacts.mockResolvedValue(undefined);
    const service = await import('../localAssistantService');

    await service.hydrateLocalAssistantPreparationState();
    await expect(service.cancelLocalAssistantPreparation()).resolves.toBe(true);

    expect(serviceMock.cancelActiveModelDownload).toHaveBeenCalledTimes(1);
    expect(serviceMock.removeModelArtifacts).toHaveBeenCalledWith(serviceMock.modelConfig);
    expect(service.getLocalAssistantStatus()).toMatchObject({
      state: 'idle',
      percent: 0,
      modelDownloaded: false,
      resumable: false,
      receivedBytes: 0,
    });
  });

  it('keeps the downloaded model state when native runtime loading fails', async () => {
    serviceMock.localModelEngine.ensureReady.mockRejectedValue(new Error('LiteRT-LM init failed'));
    const service = await import('../localAssistantService');
    const states: Array<ReturnType<typeof service.getLocalAssistantStatus>> = [];

    service.subscribeToAssistantState(state => {
      states.push(state);
    });

    await expect(service.prepareLocalAssistant()).rejects.toThrow('LiteRT-LM init failed');

    expect(states.at(-1)).toMatchObject({
      state: 'error',
      percent: 100,
      modelDownloaded: true,
      resumable: false,
      error: 'Model failed to start: The AI model could not start on this phone. Try again. '
        + 'The model file is still saved on this phone.',
    });
    expect(serviceMock.localModelEngine.unload).toHaveBeenCalledTimes(1);
  });

  it('keeps generic setup guidance when a preparation failure cannot be classified', async () => {
    serviceMock.localModelEngine.ensureReady.mockRejectedValue(new Error('synthetic unclassified failure'));
    const service = await import('../localAssistantService');

    await expect(service.prepareLocalAssistant()).rejects.toThrow('synthetic unclassified failure');

    expect(service.getLocalAssistantStatus()).toMatchObject({
      state: 'error',
      error: 'The model is saved, but SafeRide could not start it. Try again.',
    });
  });

  it('names a storage shortfall instead of the generic setup failure', async () => {
    serviceMock.getModelAvailability.mockResolvedValue(serviceMock.partialAvailability);
    serviceMock.localModelEngine.ensureReady.mockRejectedValue(
      new Error('Not enough device storage for model.litertlm. Free at least 400 MB and resume.'),
    );
    const service = await import('../localAssistantService');

    await expect(service.prepareLocalAssistant()).rejects.toThrow('Not enough device storage');

    expect(service.getLocalAssistantStatus()).toMatchObject({
      state: 'error',
      modelDownloaded: false,
      error: 'Not enough storage: There is not enough free storage for the AI model. Free up space, then resume.',
    });
  });

  it('can recover a downloaded model from a runtime error state without redownloading', async () => {
    const storage = (await import('@react-native-async-storage/async-storage')).default as typeof AsyncStorage;
    await storage.setItem('@saferide_local_assistant_ready_state', JSON.stringify({
      schema: 'com.saferide.local-assistant-ready-state',
      version: 2,
      modelId: 'test-model',
      runtimeModelId: 'test-model',
      runtimeKind: 'litert-lm',
      files: [{ fileName: 'model.litertlm', sizeBytes: 100 }],
      verifiedAt: '2026-06-24T00:00:00.000Z',
    }));
    serviceMock.localModelEngine.ensureReady.mockRejectedValueOnce(new Error('LiteRT-LM init failed'));
    const service = await import('../localAssistantService');

    await expect(service.prepareLocalAssistant()).rejects.toThrow('LiteRT-LM init failed');
    expect(service.getLocalAssistantStatus()).toMatchObject({
      state: 'error',
      percent: 100,
      modelDownloaded: true,
    });

    await service.refreshLocalAssistantStatus();

    expect(service.getLocalAssistantStatus()).toMatchObject({
      state: 'downloaded',
      percent: 100,
      modelDownloaded: true,
    });
    expect(storage.removeItem).not.toHaveBeenCalledWith('@saferide_local_assistant_ready_state');
    serviceMock.localModelEngine.ensureReady.mockResolvedValue(undefined);
    await expect(service.resumeVerifiedLocalAssistantPreparation()).resolves.toBe(true);
    expect(service.getLocalAssistantStatus()).toMatchObject({
      state: 'ready',
      percent: 100,
      modelDownloaded: true,
    });
  });

  it('keeps a verified warm runtime after a single local generation failure', async () => {
    serviceMock.localModelEngine.ensureReady.mockImplementation(async () => {
      serviceMock.localModelEngine.isReady.mockReturnValue(true);
    });
    serviceMock.localModelEngine.generateResponse.mockRejectedValue(new Error('completion stalled'));
    const service = await import('../localAssistantService');
    const storage = (await import('@react-native-async-storage/async-storage')).default as typeof AsyncStorage;

    await service.prepareLocalAssistant();
    expect(storage.setItem).toHaveBeenCalledWith(
      '@saferide_local_assistant_ready_state',
      expect.stringContaining('"modelId":"test-model"'),
    );

    await expect(service.generateLocalAssistantReply([{ role: 'user', content: 'How do I report?' }])).rejects.toThrow(
      'completion stalled',
    );

    expect(service.getLocalAssistantStatus()).toMatchObject({
      state: 'ready',
      percent: 100,
      modelDownloaded: true,
      resumable: false,
      error: 'Reply stopped. Try again or send a shorter message.',
    });
    expect(serviceMock.localModelEngine.unload).not.toHaveBeenCalled();
    await service.hydrateLocalAssistantPreparationState();
    await service.refreshLocalAssistantStatus();
    expect(service.getLocalAssistantStatus()).toMatchObject({
      state: 'ready',
      modelDownloaded: true,
    });
    expect(storage.removeItem).not.toHaveBeenCalledWith('@saferide_local_assistant_ready_state');

    vi.resetModules();
    serviceMock.localModelEngine.isReady.mockReset();
    serviceMock.localModelEngine.isReady.mockReturnValue(false);
    serviceMock.localModelEngine.ensureReady.mockReset();
    serviceMock.localModelEngine.ensureReady.mockImplementation(async () => {
      serviceMock.localModelEngine.isReady.mockReturnValue(true);
    });
    const restartedStorage = (await import('@react-native-async-storage/async-storage')).default as typeof AsyncStorage;
    await restartedStorage.setItem('@saferide_local_assistant_ready_state', JSON.stringify({
      schema: 'com.saferide.local-assistant-ready-state',
      version: 2,
      modelId: 'test-model',
      runtimeModelId: 'test-model',
      runtimeKind: 'litert-lm',
      files: [{ fileName: 'model.litertlm', sizeBytes: 100 }],
      verifiedAt: '2026-06-24T00:00:00.000Z',
    }));
    const restartedService = await import('../localAssistantService');
    await restartedService.hydrateLocalAssistantPreparationState();

    await expect(restartedService.resumeVerifiedLocalAssistantPreparation()).resolves.toBe(true);
    expect(serviceMock.localModelEngine.ensureReady).toHaveBeenCalledTimes(1);
    expect(restartedService.getLocalAssistantStatus()).toMatchObject({
      state: 'ready',
      percent: 100,
      modelDownloaded: true,
    });
  });

  it('keeps the warm runtime after repeated non-fatal generation failures', async () => {
    serviceMock.localModelEngine.ensureReady.mockImplementation(async () => {
      serviceMock.localModelEngine.isReady.mockReturnValue(true);
    });
    serviceMock.localModelEngine.generateResponse.mockRejectedValue(new Error('completion stalled'));
    const service = await import('../localAssistantService');

    await service.prepareLocalAssistant();
    await expect(service.generateLocalAssistantReply([{ role: 'user', content: 'How do I report?' }])).rejects.toThrow(
      'completion stalled',
    );
    await expect(service.generateLocalAssistantReply([{ role: 'user', content: 'How do I report?' }])).rejects.toThrow(
      'completion stalled',
    );

    expect(serviceMock.localModelEngine.unload).not.toHaveBeenCalled();
    expect(service.getLocalAssistantStatus()).toMatchObject({
      state: 'ready',
      percent: 100,
      modelDownloaded: true,
      error: 'Reply stopped. Try again or send a shorter message.',
    });
  });

  it('stops a pending reply after preparation without clearing readiness proof', async () => {
    let resolveReady: () => void = () => {};
    serviceMock.localModelEngine.ensureReady.mockReturnValue(
      new Promise<void>(resolve => {
        resolveReady = resolve;
      }),
    );
    serviceMock.localModelEngine.generateResponse.mockResolvedValue('late reply');
    const service = await import('../localAssistantService');

    const pending = service.generateLocalAssistantReply([{ role: 'user', content: 'How do I report?' }]);
    await flushAsyncWork();

    expect(service.cancelActiveLocalAssistantReply()).toBe(true);
    resolveReady();

    await expect(pending).rejects.toThrow('Local assistant reply was stopped.');
    expect(serviceMock.localModelEngine.generateResponse).not.toHaveBeenCalled();
    expect(service.getLocalAssistantStatus()).toMatchObject({
      state: 'ready',
      percent: 100,
      modelDownloaded: true,
    });
  });

  it('does not mark the assistant unavailable when an active reply is stopped', async () => {
    serviceMock.localModelEngine.ensureReady.mockResolvedValue(undefined);
    serviceMock.localModelEngine.generateResponse.mockRejectedValue(
      new serviceMock.LocalModelGenerationStoppedError(),
    );
    const service = await import('../localAssistantService');

    await service.prepareLocalAssistant();
    await expect(service.generateLocalAssistantReply([{ role: 'user', content: 'How do I report?' }])).rejects.toThrow(
      'Local assistant reply was stopped.',
    );

    expect(service.getLocalAssistantStatus()).toMatchObject({
      state: 'ready',
      percent: 100,
      modelDownloaded: true,
      resumable: false,
      receivedBytes: 100,
      totalBytes: 100,
    });
  });

  it('limits local model prompt history and message size for reply latency', async () => {
    serviceMock.localModelEngine.ensureReady.mockResolvedValue(undefined);
    serviceMock.localModelEngine.generateResponse.mockResolvedValue('short reply');
    const service = await import('../localAssistantService');
    const longText = `${'start '.repeat(260)}middle ${' end'.repeat(260)}`;
    const conversation = Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: index === 11 ? longText : `message ${index}`,
    }));

    await service.generateLocalAssistantReply(conversation);

    const [, compactedConversation] = serviceMock.localModelEngine.generateResponse.mock.calls[0];
    expect(compactedConversation).toHaveLength(5);
    expect(compactedConversation[0]).toMatchObject({
      role: 'system',
      content: expect.stringContaining('Reply in English'),
    });
    expect(compactedConversation[1]).toMatchObject({ content: 'message 8' });
    expect(compactedConversation.at(-1)?.content.length).toBeLessThanOrEqual(650);
    expect(compactedConversation.at(-1)?.content).toContain('[...]');
  });

  it('injects the source instruction when Kiswahili is disabled', async () => {
    serviceMock.localModelEngine.ensureReady.mockResolvedValue(undefined);
    serviceMock.localModelEngine.generateResponse.mockResolvedValue('sawa');
    const service = await import('../localAssistantService');

    await service.generateLocalAssistantReply(
      [{ role: 'user', content: 'Ninawezaje kuripoti?' }],
      { languageCode: 'sw' },
    );

    const [, compactedConversation] = serviceMock.localModelEngine.generateResponse.mock.calls[0];
    expect(compactedConversation[0]).toMatchObject({
      role: 'system',
      content: expect.stringContaining('Reply in English'),
    });
  });

  it('uses an instant local fast path for simple greetings without blocking on model preparation', async () => {
    serviceMock.localModelEngine.ensureReady.mockReturnValue(new Promise<void>(() => {}));
    serviceMock.localModelEngine.generateResponse.mockResolvedValue('model reply');
    const service = await import('../localAssistantService');

    const reply = await service.generateLocalAssistantReply([{ role: 'user', content: 'hi' }]);

    expect(serviceMock.localModelEngine.ensureReady).not.toHaveBeenCalled();
    expect(serviceMock.localModelEngine.generateResponse).not.toHaveBeenCalled();
    expect(reply).toMatchObject({
      sourceLabel: 'SafeRide local quick reply',
    });
    expect(reply.content).toContain('What do you need?');
  });

  it('uses the source-locale fast path when Kiswahili is disabled', async () => {
    serviceMock.localModelEngine.ensureReady.mockReturnValue(new Promise<void>(() => {}));
    serviceMock.localModelEngine.generateResponse.mockResolvedValue('model reply');
    const service = await import('../localAssistantService');

    const reply = await service.generateLocalAssistantReply(
      [{ role: 'user', content: 'habari' }],
      { languageCode: 'sw' },
    );

    expect(serviceMock.localModelEngine.ensureReady).not.toHaveBeenCalled();
    expect(serviceMock.localModelEngine.generateResponse).not.toHaveBeenCalled();
    expect(reply.content).toContain('I can help');
    expect(reply.content).toContain('What do you need?');
  });

  it('unloads, deletes, and clears readiness when tuned runtime controls revoke the artifact', async () => {
    serviceMock.resolveTunedArtifactRuntimeSelection.mockReturnValue({
      selectionRequired: true,
      config: serviceMock.tunedModelConfig,
      decision: {
        enabled: true,
        reason: 'enabled',
        manifestId: serviceMock.tunedModelConfig.manifestId,
        artifactSha256: serviceMock.tunedModelConfig.files[0].sha256,
        rolloutPercent: 100,
        rollbackTargetManifestId: 'fail-closed:no-local-ai',
      },
    });
    serviceMock.tunedArtifactRemovalReason.mockReturnValue('artifact-revoked');
    const service = await import('../localAssistantService');
    const storage = (await import('@react-native-async-storage/async-storage')).default;
    await storage.setItem('@saferide_local_assistant_ready_state', 'synthetic-ready-state');

    await expect(service.prepareLocalAssistant()).rejects.toThrow('artifact-revoked');
    expect(serviceMock.localModelEngine.unload).toHaveBeenCalledTimes(1);
    expect(serviceMock.removeModelArtifacts).toHaveBeenCalledWith(serviceMock.tunedModelConfig);
    await expect(storage.getItem('@saferide_local_assistant_ready_state')).resolves.toBeNull();
    expect(service.getLocalAssistantStatus()).toMatchObject({
      state: 'error',
      modelDownloaded: false,
      error: expect.stringContaining('SafeRide remains available without local AI'),
    });
  });

  it('applies a live remote disable without waiting for another assistant action', async () => {
    serviceMock.resolveTunedArtifactRuntimeSelection.mockReturnValue({
      selectionRequired: true,
      config: serviceMock.tunedModelConfig,
      decision: {
        enabled: true,
        reason: 'enabled',
        manifestId: serviceMock.tunedModelConfig.manifestId,
        artifactSha256: serviceMock.tunedModelConfig.files[0].sha256,
        rolloutPercent: 100,
        rollbackTargetManifestId: 'fail-closed:no-local-ai',
      },
    });
    serviceMock.tunedArtifactRemovalReason.mockReturnValue('remote-disabled');
    const service = await import('../localAssistantService');

    await service.handleLocalAssistantRuntimeConfigUpdate({
      enabled: false,
      reasonCode: 'remote-revocation',
      controlId: 'synthetic-controls',
      activeManifestId: null,
      activeManifestSha256: null,
      rolloutPercent: 0,
      minimumAppVersion: '1.0.0',
      remoteDisableSupported: true,
      revokedManifestIds: [],
      revokedArtifactSha256: [],
      rollbackTargetManifestId: 'fail-closed:no-local-ai',
      expiresAt: '2026-08-14T00:00:00.000Z',
    });

    expect(serviceMock.localModelEngine.unload).toHaveBeenCalledTimes(1);
    expect(serviceMock.removeModelArtifacts).toHaveBeenCalledWith(serviceMock.tunedModelConfig);
    expect(service.getLocalAssistantStatus()).toMatchObject({
      state: 'error',
      error: expect.stringContaining('remote-disabled'),
    });
  });
});
