import { beforeEach, describe, expect, it, vi } from 'vitest';

const chatServiceMock = vi.hoisted(() => ({
  localStatus: {
    state: 'idle' as string,
    modelDownloaded: false,
    percent: 0,
    resumable: false,
  },
  generateLocalAssistantReply: vi.fn(),
  getLocalAssistantSourceLabel: vi.fn(() => 'SafeRide local test model'),
  isLocalAssistantReplyStoppedError: vi.fn((error: unknown) => (
    error instanceof Error && error.name === 'LocalModelGenerationStoppedError'
  )),
}));

vi.mock('../localAssistantService', () => ({
  generateLocalAssistantReply: chatServiceMock.generateLocalAssistantReply,
  getLocalAssistantSourceLabel: chatServiceMock.getLocalAssistantSourceLabel,
  getLocalAssistantStatus: vi.fn(() => chatServiceMock.localStatus),
  isLocalAssistantReplyStoppedError: chatServiceMock.isLocalAssistantReplyStoppedError,
}));

vi.mock('../../config/localAssistant', () => ({
  localAssistantConfig: {
    enabled: true,
    preferOnDevice: true,
  },
}));

vi.mock('../../lib/api/httpClient', () => ({
  request: vi.fn(),
  setAuthToken: vi.fn(),
}));

vi.mock('../../lib/auth/authClient', () => ({
  authClient: {
    getSession: vi.fn(),
  },
}));

vi.mock('../../config/runtime/runtimeConfigStore', () => ({
  getRuntimeConfigSnapshot: vi.fn(() => ({ wsBaseUrl: 'wss://safe.example' })),
}));

vi.mock('socket.io-client', () => ({
  io: vi.fn(),
}));

describe('requestAssistantReply', () => {
  beforeEach(() => {
    vi.resetModules();
    chatServiceMock.localStatus = {
      state: 'idle',
      modelDownloaded: false,
      percent: 0,
      resumable: false,
    };
    chatServiceMock.generateLocalAssistantReply.mockReset();
    chatServiceMock.getLocalAssistantSourceLabel.mockClear();
    chatServiceMock.isLocalAssistantReplyStoppedError.mockClear();
  });

  it('does not start local model preparation when no downloaded model is available', async () => {
    const { requestAssistantReply } = await import('../chatService');

    const reply = await requestAssistantReply([{ role: 'user', content: 'hi' }], { preferLocal: true });

    expect(chatServiceMock.generateLocalAssistantReply).not.toHaveBeenCalled();
    expect(reply.sources).toEqual(['System notice']);
    expect(reply.content).toContain('AI is not ready yet');
  });

  it('uses the local assistant when a downloaded model can be configured', async () => {
    chatServiceMock.localStatus = {
      state: 'downloaded',
      modelDownloaded: true,
      percent: 100,
      resumable: false,
    };
    chatServiceMock.generateLocalAssistantReply.mockResolvedValueOnce({ content: 'Hello from the phone.' });
    const { requestAssistantReply } = await import('../chatService');

    const reply = await requestAssistantReply([{ role: 'user', content: 'hi' }], { preferLocal: true });

    expect(chatServiceMock.generateLocalAssistantReply).toHaveBeenCalledWith(
      [{ role: 'user', content: 'hi' }],
      undefined,
      undefined,
    );
    expect(reply).toEqual({
      content: 'Hello from the phone.',
      sources: ['SafeRide local test model'],
    });
  });

  it('normalizes a disabled locale before local assistant requests', async () => {
    chatServiceMock.localStatus = {
      state: 'ready',
      modelDownloaded: true,
      percent: 100,
      resumable: false,
    };
    chatServiceMock.generateLocalAssistantReply.mockResolvedValueOnce({ content: 'Swahili reply.' });
    const { requestAssistantReply } = await import('../chatService');

    await requestAssistantReply([{ role: 'user', content: 'habari' }], {
      preferLocal: true,
      languageCode: 'sw',
    });

    expect(chatServiceMock.generateLocalAssistantReply).toHaveBeenCalledWith(
      [{ role: 'user', content: 'habari' }],
      { languageCode: 'en' },
      undefined,
    );
  });

  it('uses source copy when an unavailable locale is requested', async () => {
    const { requestAssistantReply } = await import('../chatService');

    const reply = await requestAssistantReply([{ role: 'user', content: 'habari' }], {
      preferLocal: true,
      languageCode: 'sw',
    });

    expect(chatServiceMock.generateLocalAssistantReply).not.toHaveBeenCalled();
    expect(reply.content).toContain('AI is not ready yet');
  });

  it('retries configuration from disk when a downloaded model is in a local runtime error state', async () => {
    chatServiceMock.localStatus = {
      state: 'error',
      modelDownloaded: true,
      percent: 100,
      resumable: false,
    };
    chatServiceMock.generateLocalAssistantReply.mockResolvedValueOnce({ content: 'Recovered from disk.' });
    const { requestAssistantReply } = await import('../chatService');

    const reply = await requestAssistantReply([{ role: 'user', content: 'hi' }], { preferLocal: true });

    expect(chatServiceMock.generateLocalAssistantReply).toHaveBeenCalledWith(
      [{ role: 'user', content: 'hi' }],
      undefined,
      undefined,
    );
    expect(reply).toEqual({
      content: 'Recovered from disk.',
      sources: ['SafeRide local test model'],
    });
  });

  it('uses an already-ready local assistant even when local is not preferred', async () => {
    chatServiceMock.localStatus = {
      state: 'ready',
      modelDownloaded: true,
      percent: 100,
      resumable: false,
    };
    chatServiceMock.generateLocalAssistantReply.mockResolvedValueOnce({ content: 'Ready reply.' });
    const { requestAssistantReply } = await import('../chatService');

    const reply = await requestAssistantReply([{ role: 'user', content: 'hi' }], { preferLocal: false });

    expect(chatServiceMock.generateLocalAssistantReply).toHaveBeenCalledTimes(1);
    expect(reply.content).toBe('Ready reply.');
  });

  it('throws instead of falling back when unavailable fallback is disabled', async () => {
    const { requestAssistantReply } = await import('../chatService');

    await expect(
      requestAssistantReply([{ role: 'user', content: 'hi' }], {
        preferLocal: true,
        allowUnavailableFallback: false,
      }),
    ).rejects.toThrow('Local assistant is not ready on this device.');
  });

  it('does not turn user-stopped local replies into unavailable fallback copy', async () => {
    chatServiceMock.localStatus = {
      state: 'ready',
      modelDownloaded: true,
      percent: 100,
      resumable: false,
    };
    const stoppedError = new Error('Local assistant reply was stopped.');
    stoppedError.name = 'LocalModelGenerationStoppedError';
    chatServiceMock.generateLocalAssistantReply.mockRejectedValueOnce(stoppedError);
    const { requestAssistantReply } = await import('../chatService');

    await expect(requestAssistantReply([{ role: 'user', content: 'hi' }], { preferLocal: true })).rejects.toThrow(
      'Local assistant reply was stopped.',
    );
  });

  it('shows a short failure reason instead of the silent fallback and records the code', async () => {
    chatServiceMock.localStatus = {
      state: 'ready',
      modelDownloaded: true,
      percent: 100,
      resumable: false,
    };
    chatServiceMock.generateLocalAssistantReply.mockRejectedValueOnce(Object.assign(
      new Error('LiteRT-LM bridge load failed. SYNTHETIC-SECRET-PROMPT'),
      { code: 'ERR_LITERT_INIT_FAILED' },
    ));
    const pilot = await import('../../lib/localAssistant/pilotDiagnostics');
    const device = await import('../../lib/localAssistant/pilotDeviceProfile');
    device.__setLocalAiDeviceProvidersForTests({
      deviceFacts: async () => ({ totalMemory: 7.4 * 1024 ** 3 }),
      freeStorage: async () => 10e9,
    });
    pilot.__configureAiPilotDiagnosticsForTests({ enabled: true });
    const { requestAssistantReply } = await import('../chatService');

    const reply = await requestAssistantReply([{ role: 'user', content: 'synthetic question' }], { preferLocal: true });

    expect(reply.sources).toEqual(['System notice']);
    expect(reply.content).toContain('AI could not reply (Model failed to start).');
    expect(reply.content).toContain('1195');
    expect(reply.content).not.toContain('SYNTHETIC-SECRET');
    expect(reply.content).not.toContain('AI is not ready yet');
    await pilot.flushAiPilotDiagnosticsWrites();
    const store = await pilot.getAiPilotDiagnosticsStore();
    expect(store.events).toEqual([expect.objectContaining({
      kind: 'fallback',
      failureCode: 'MODEL_START_FAILED',
      failureCategory: 'model-start',
      attemptedLocal: true,
    })]);
    expect(JSON.stringify(store)).not.toContain('synthetic question');
    pilot.__resetAiPilotDiagnosticsForTests();
  });

  it('names memory as the likely reason on phones below the RAM guidance', async () => {
    chatServiceMock.localStatus = {
      state: 'ready',
      modelDownloaded: true,
      percent: 100,
      resumable: false,
    };
    chatServiceMock.generateLocalAssistantReply.mockRejectedValueOnce(
      Object.assign(new Error('LiteRT-LM bridge generation failed.'), { code: 'ERR_LITERT_GENERATE_FAILED' }),
    );
    const device = await import('../../lib/localAssistant/pilotDeviceProfile');
    device.__setLocalAiDeviceProvidersForTests({ deviceFacts: async () => ({ totalMemory: 3.6 * 1024 ** 3 }) });
    await device.loadLocalAiDeviceFacts();
    const { requestAssistantReply } = await import('../chatService');

    const reply = await requestAssistantReply([{ role: 'user', content: 'synthetic question' }], { preferLocal: true });

    expect(reply.content).toContain('AI could not reply (Not enough memory).');
    expect(reply.content).toContain('999');
  });

  it('records why the local model was not attempted while keeping the not-ready notice', async () => {
    const pilot = await import('../../lib/localAssistant/pilotDiagnostics');
    const device = await import('../../lib/localAssistant/pilotDeviceProfile');
    device.__setLocalAiDeviceProvidersForTests({ deviceFacts: async () => ({}), freeStorage: async () => 1e9 });
    pilot.__configureAiPilotDiagnosticsForTests({ enabled: true });
    const { requestAssistantReply } = await import('../chatService');

    const reply = await requestAssistantReply([{ role: 'user', content: 'hi' }], { preferLocal: true });

    expect(reply.content).toContain('AI is not ready yet');
    await pilot.flushAiPilotDiagnosticsWrites();
    expect((await pilot.getAiPilotDiagnosticsStore()).events).toEqual([expect.objectContaining({
      kind: 'fallback',
      failureCode: 'MODEL_NOT_DOWNLOADED',
      failureCategory: 'not-ready',
      attemptedLocal: false,
    })]);
    pilot.__resetAiPilotDiagnosticsForTests();
  });

  it('deletes an owned chat session through the SafeRide API', async () => {
    const { authClient } = await import('../../lib/auth/authClient');
    const { request, setAuthToken } = await import('../../lib/api/httpClient');
    vi.mocked(authClient.getSession).mockResolvedValue({
      data: { session: { access_token: 'token' } },
      error: null,
    } as any);
    vi.mocked(request).mockResolvedValue({ deleted: true });
    const { deleteChatSession } = await import('../chatService');

    await deleteChatSession('session-1');

    expect(setAuthToken).toHaveBeenCalledWith('token');
    expect(request).toHaveBeenCalledWith({
      path: '/chat/session/session-1',
      method: 'DELETE',
    });
  });
});
