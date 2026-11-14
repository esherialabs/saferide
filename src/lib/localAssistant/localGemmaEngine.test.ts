import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GEMMA_4_E2B_LITERTLM_CONFIG, type LocalModelConfig } from './modelRegistry';

const storageMock = vi.hoisted(() => ({
  ensureModelAvailability: vi.fn(async () => undefined),
  resolveModelFilePath: vi.fn(() => 'file:///safeRide/models/gemma-4-E2B-it.litertlm'),
}));

const liteRtBridgeMock = vi.hoisted(() => ({
  prepare: vi.fn(async () => ({ state: 'prepared', runtimeAvailable: true, mockMode: false })),
  load: vi.fn(async () => ({ state: 'loaded', runtimeAvailable: true, mockMode: false })),
  generate: vi.fn(async () => ({ content: 'ready', mockMode: false })),
  cancel: vi.fn(async () => ({ state: 'loaded', runtimeAvailable: true, mockMode: false })),
  unload: vi.fn(async () => ({ state: 'idle', runtimeAvailable: true, mockMode: false })),
  createConfig: vi.fn((modelConfig: LocalModelConfig, options: Record<string, unknown> = {}) => ({
    modelId: modelConfig.id,
    manifestId: modelConfig.manifestId,
    modelPath: options.modelPath,
    mockMode: false,
    allowRealRuntime: options.allowRealRuntime,
    maxOutputTokens: 'maxOutputTokens' in modelConfig.runtime ? modelConfig.runtime.maxOutputTokens : 64,
    expectedFileName: modelConfig.runtime.modelFileName,
    expectedSizeBytes: modelConfig.files[0]?.sizeBytes,
    expectedSha256: modelConfig.files[0]?.sha256,
    contextWindow: modelConfig.runtime.contextWindow,
    backendPlan: 'backendPlan' in modelConfig.runtime ? modelConfig.runtime.backendPlan : [],
    cachePolicy: 'cachePolicy' in modelConfig.runtime ? modelConfig.runtime.cachePolicy : 'app-cache',
    systemPrompt: modelConfig.systemPrompt,
  })),
}));

vi.mock('./modelStorage', () => ({
  ensureModelAvailability: storageMock.ensureModelAvailability,
  resolveModelFilePath: storageMock.resolveModelFilePath,
}));

vi.mock('./liteRtLmBridge', () => ({
  cancelSafeRideLiteRtLmBridge: liteRtBridgeMock.cancel,
  createSafeRideLiteRtLmBridgeConfig: liteRtBridgeMock.createConfig,
  generateSafeRideLiteRtLmResponse: liteRtBridgeMock.generate,
  isLiteRtLmModelConfig: (modelConfig: LocalModelConfig) => modelConfig.runtime.kind === 'litert-lm',
  loadSafeRideLiteRtLmBridge: liteRtBridgeMock.load,
  prepareSafeRideLiteRtLmBridge: liteRtBridgeMock.prepare,
  unloadSafeRideLiteRtLmBridge: liteRtBridgeMock.unload,
}));

const legacyModelConfig = {
  id: 'legacy-test-model',
  label: 'Legacy local model',
  variant: 'legacy/model',
  providerFamily: 'qwen',
  runtime: {
    kind: 'llama-rn-gguf',
    modelId: 'legacy-test-model',
    modelFileName: 'model.gguf',
    contextWindow: 128,
    gpuLayers: 0,
  },
  storageDir: 'legacy-test-model',
  files: [],
  systemPrompt: 'SafeRide test prompt',
  capabilities: {
    textGeneration: false,
    audioTranscription: false,
    offenceTagging: false,
  },
} as unknown as LocalModelConfig;

function pilotModelConfig(): LocalModelConfig {
  return {
    ...GEMMA_4_E2B_LITERTLM_CONFIG,
    manifestId: GEMMA_4_E2B_LITERTLM_CONFIG.manifestId ?? 'synthetic-pilot-manifest',
    files: GEMMA_4_E2B_LITERTLM_CONFIG.files.map(file => ({ ...file, sha256: file.sha256 ?? 'e'.repeat(64) })),
  };
}

function flushAsyncWork(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

describe('localGemmaEngine', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    storageMock.ensureModelAvailability.mockClear();
    storageMock.resolveModelFilePath.mockClear();
    storageMock.resolveModelFilePath.mockReturnValue('file:///safeRide/models/gemma-4-E2B-it.litertlm');
    liteRtBridgeMock.prepare.mockClear();
    liteRtBridgeMock.load.mockClear();
    liteRtBridgeMock.generate.mockClear();
    liteRtBridgeMock.generate.mockResolvedValue({ content: 'ready', mockMode: false });
    liteRtBridgeMock.cancel.mockClear();
    liteRtBridgeMock.unload.mockClear();
    liteRtBridgeMock.createConfig.mockClear();
  });

  it('loads and verifies Gemma 4 E2B through the SafeRide LiteRT-LM bridge only', async () => {
    const { localModelEngine } = await import('./localGemmaEngine');

    await expect(localModelEngine.ensureReady(GEMMA_4_E2B_LITERTLM_CONFIG, undefined, {
      allowRealLiteRtLmRuntime: true,
    })).resolves.toBeUndefined();

    expect(storageMock.ensureModelAvailability).toHaveBeenCalledWith(GEMMA_4_E2B_LITERTLM_CONFIG, undefined);
    expect(liteRtBridgeMock.createConfig).toHaveBeenCalledWith(
      GEMMA_4_E2B_LITERTLM_CONFIG,
      {
        modelPath: 'file:///safeRide/models/gemma-4-E2B-it.litertlm',
        allowRealRuntime: true,
      },
    );
    expect(liteRtBridgeMock.prepare).toHaveBeenCalledTimes(1);
    expect(liteRtBridgeMock.load).toHaveBeenCalledTimes(1);
    expect(liteRtBridgeMock.generate).toHaveBeenCalledWith(
      [{ role: 'user', content: 'Say ready.' }],
      { temperature: 0, maxOutputTokens: 4 },
    );
    expect(localModelEngine.isReady(GEMMA_4_E2B_LITERTLM_CONFIG)).toBe(true);
  });

  it('records content-free QA diagnostics at the load, readiness, and reply call sites', async () => {
    liteRtBridgeMock.load.mockResolvedValueOnce({
      state: 'loaded',
      runtimeAvailable: true,
      mockMode: false,
      artifactValidated: true,
      realRuntimeLoaded: true,
      activeBackend: 'gpu',
    } as never);
    liteRtBridgeMock.generate
      .mockResolvedValueOnce({ content: 'ready', mockMode: false })
      .mockResolvedValueOnce({
        content: 'SYNTHETIC-SECRET-REPLY You can call 1195 for support.',
        mockMode: false,
        activeBackend: 'gpu',
      } as never);
    const pilot = await import('./pilotDiagnostics');
    const device = await import('./pilotDeviceProfile');
    device.__setLocalAiDeviceProvidersForTests({
      deviceFacts: async () => ({ totalMemory: 7.4 * 1024 ** 3 }),
      freeStorage: async () => 9e9,
    });
    pilot.__configureAiPilotDiagnosticsForTests({ enabled: true });
    const { localModelEngine } = await import('./localGemmaEngine');

    await localModelEngine.generateResponse(
      pilotModelConfig(),
      [{ role: 'user', content: 'SYNTHETIC-SECRET-PROMPT' }],
      { allowRealLiteRtLmRuntime: true },
    );
    await pilot.flushAiPilotDiagnosticsWrites();

    const store = await pilot.getAiPilotDiagnosticsStore();
    const qa = store.events.flatMap(event => (event.kind === 'qa' ? [event] : []));
    expect(qa.map(event => event.diagnostic.phase)).toEqual(['load', 'readiness-probe', 'generation']);
    expect(qa.map(event => event.diagnostic.result.status)).toEqual(['passed', 'passed', 'passed']);
    expect(qa[0]).toMatchObject({ diagnostic: { backend: 'gpu', realRuntimeLoaded: true } });
    expect(qa[2]).toMatchObject({
      diagnostic: { backend: 'gpu', throughput: { estimatedOutputTokens: expect.any(Number) } },
      replySignals: { refusalLike: false, emergencyGuidanceLike: true },
    });
    expect(JSON.stringify(store)).not.toContain('SYNTHETIC-SECRET');
    expect(JSON.stringify(store)).not.toContain('Say ready');
    pilot.__resetAiPilotDiagnosticsForTests();
    device.__setLocalAiDeviceProvidersForTests();
  });

  it('records a failed local reply with an allowlisted code only', async () => {
    liteRtBridgeMock.generate
      .mockResolvedValueOnce({ content: 'ready', mockMode: false })
      .mockRejectedValueOnce(Object.assign(
        new Error('LiteRT-LM bridge generation failed. SYNTHETIC-SECRET'),
        { code: 'ERR_LITERT_GENERATE_FAILED' },
      ));
    const pilot = await import('./pilotDiagnostics');
    const device = await import('./pilotDeviceProfile');
    device.__setLocalAiDeviceProvidersForTests({ deviceFacts: async () => ({}), freeStorage: async () => 9e9 });
    pilot.__configureAiPilotDiagnosticsForTests({ enabled: true });
    const { localModelEngine } = await import('./localGemmaEngine');

    await expect(localModelEngine.generateResponse(
      pilotModelConfig(),
      [{ role: 'user', content: 'SYNTHETIC-SECRET-PROMPT' }],
      { allowRealLiteRtLmRuntime: true },
    )).rejects.toThrow('generation failed');
    await pilot.flushAiPilotDiagnosticsWrites();

    const store = await pilot.getAiPilotDiagnosticsStore();
    expect(store.events.at(-1)).toMatchObject({
      kind: 'qa',
      failureCode: 'GENERATION_FAILED',
      replySignals: null,
      diagnostic: { phase: 'generation', result: { status: 'failed', errorCode: 'GENERATION_FAILED' } },
    });
    expect(JSON.stringify(store)).not.toContain('SYNTHETIC-SECRET');
    pilot.__resetAiPilotDiagnosticsForTests();
    device.__setLocalAiDeviceProvidersForTests();
  });

  it('generates replies through LiteRT-LM after readiness proof', async () => {
    liteRtBridgeMock.generate
      .mockResolvedValueOnce({ content: 'ready', mockMode: false })
      .mockResolvedValueOnce({ content: 'short reply', mockMode: false });
    const { localModelEngine } = await import('./localGemmaEngine');

    const reply = await localModelEngine.generateResponse(
      GEMMA_4_E2B_LITERTLM_CONFIG,
      [{ role: 'user', content: 'hi' }],
      { allowRealLiteRtLmRuntime: true, maxTokens: 12, temperature: 0.1 },
    );

    expect(reply).toBe('short reply');
    expect(liteRtBridgeMock.generate).toHaveBeenLastCalledWith(
      [{ role: 'user', content: 'hi' }],
      { temperature: 0.1, maxOutputTokens: 12 },
    );
  });

  it('uses the manifest output budget for default replies', async () => {
    liteRtBridgeMock.generate
      .mockResolvedValueOnce({ content: 'ready', mockMode: false })
      .mockResolvedValueOnce({ content: 'complete reply', mockMode: false });
    const { localModelEngine } = await import('./localGemmaEngine');

    const reply = await localModelEngine.generateResponse(
      GEMMA_4_E2B_LITERTLM_CONFIG,
      [{ role: 'user', content: 'What should I do if unsafe?' }],
      { allowRealLiteRtLmRuntime: true },
    );
    const expectedBudget = 'maxOutputTokens' in GEMMA_4_E2B_LITERTLM_CONFIG.runtime
      ? GEMMA_4_E2B_LITERTLM_CONFIG.runtime.maxOutputTokens
      : 128;

    expect(reply).toBe('complete reply');
    expect(liteRtBridgeMock.generate).toHaveBeenLastCalledWith(
      [{ role: 'user', content: 'What should I do if unsafe?' }],
      { temperature: 0.2, maxOutputTokens: expectedBudget },
    );
  });

  it('rejects legacy GGUF model configs instead of routing to llama.rn', async () => {
    const { localModelEngine } = await import('./localGemmaEngine');

    await expect(localModelEngine.ensureReady(legacyModelConfig)).rejects.toThrow('LiteRT-LM runtime entries');
    expect(storageMock.ensureModelAvailability).not.toHaveBeenCalled();
    expect(liteRtBridgeMock.prepare).not.toHaveBeenCalled();
  });

  it('cancels active LiteRT-LM generation', async () => {
    liteRtBridgeMock.generate.mockResolvedValueOnce({ content: 'ready', mockMode: false });
    const { localModelEngine } = await import('./localGemmaEngine');

    await localModelEngine.ensureReady(GEMMA_4_E2B_LITERTLM_CONFIG, undefined, {
      allowRealLiteRtLmRuntime: true,
    });

    liteRtBridgeMock.generate.mockReturnValueOnce(new Promise(() => {}));
    void localModelEngine.generateResponse(
      GEMMA_4_E2B_LITERTLM_CONFIG,
      [{ role: 'user', content: 'hi' }],
      { allowRealLiteRtLmRuntime: true },
    );
    await flushAsyncWork();

    expect(localModelEngine.cancelActiveGeneration()).toBe(true);
    expect(liteRtBridgeMock.cancel).toHaveBeenCalledTimes(1);
  });

  it('unloads the LiteRT-LM bridge', async () => {
    const { localModelEngine } = await import('./localGemmaEngine');

    await localModelEngine.ensureReady(GEMMA_4_E2B_LITERTLM_CONFIG, undefined, {
      allowRealLiteRtLmRuntime: true,
    });
    await localModelEngine.unload();

    expect(liteRtBridgeMock.unload).toHaveBeenCalledTimes(1);
    expect(localModelEngine.isReady(GEMMA_4_E2B_LITERTLM_CONFIG)).toBe(false);
  });
});
