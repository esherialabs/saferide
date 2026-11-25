import AsyncStorage from '@react-native-async-storage/async-storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const netInfoMock = vi.hoisted(() => {
  let listener: ((state: { isConnected?: boolean | null }) => void) | null = null;

  return {
    addEventListener: vi.fn((callback: (state: { isConnected?: boolean | null }) => void) => {
      listener = callback;
      return vi.fn();
    }),
    emit(state: { isConnected?: boolean | null }) {
      listener?.(state);
    },
    fetch: vi.fn(async () => ({ isConnected: true })),
  };
});

const authMock = vi.hoisted(() => ({
  getSession: vi.fn(),
  signOut: vi.fn(),
}));

const httpMock = vi.hoisted(() => ({
  request: vi.fn(),
  setAuthToken: vi.fn(),
}));

const gateMock = vi.hoisted(() => ({
  enabled: true as boolean | 'real',
}));

const caseServiceMock = vi.hoisted(() => ({
  submitCase: vi.fn(),
  PartnerRoutingConflictError: class PartnerRoutingConflictError extends Error {
    reason: string;

    constructor(reason: string) {
      super(`partner routing needs confirmation: ${reason}`);
      this.name = 'PartnerRoutingConflictError';
      this.reason = reason;
    }
  },
}));

vi.mock('../netinfoShim', () => ({
  default: {
    addEventListener: netInfoMock.addEventListener,
    fetch: netInfoMock.fetch,
  },
}));

vi.mock('../../lib/auth/authClient', () => ({
  authClient: authMock,
}));

vi.mock('../../lib/api/httpClient', () => ({
  request: httpMock.request,
  setAuthToken: httpMock.setAuthToken,
}));

vi.mock('../../config/runtime/caseSubmissionGate', async importOriginal => {
  const actual = await importOriginal<typeof import('../../config/runtime/caseSubmissionGate')>();
  return {
    ...actual,
    // 'real' uses the actual fail-closed gate over the (bundled) runtime config.
    isCaseSubmissionEnabled: () => (gateMock.enabled === 'real' ? actual.isCaseSubmissionEnabled() : gateMock.enabled),
  };
});

vi.mock('../../services/caseService', () => ({
  submitCase: caseServiceMock.submitCase,
  PartnerRoutingConflictError: caseServiceMock.PartnerRoutingConflictError,
}));

vi.mock('../privacyLog', () => ({
  devPrivacyError: vi.fn(),
  devPrivacyWarn: vi.fn(),
  getPrivacySafeErrorReason: (error: unknown) => (
    error instanceof Error ? error.message : String(error ?? '')
  ),
  getPrivacySafeHttpStatus: () => undefined,
}));

import { encryptedAsyncStorage, isEncryptedAsyncStorageEnvelope } from '../../lib/encryptedAsyncStorage';
import type { DraftData } from '../draftStorage';
import { draftStorage } from '../draftStorage';
import { buildSyncQueueRecoveryMessage, offlineSyncManager } from '../offlineSync';

function buildDraft(overrides: Partial<DraftData> = {}): DraftData {
  return {
    id: 'draft-submit-1',
    createdAt: new Date('2026-06-05T08:00:00.000Z'),
    updatedAt: new Date('2026-06-05T08:10:00.000Z'),
    status: 'queued',
    incidentDescription: 'Unsafe conduct during a ride.',
    selectedPathway: 'referral',
    ...overrides,
  };
}

describe('offlineSyncManager submit queue', () => {
  beforeEach(async () => {
    netInfoMock.emit({ isConnected: true });
    authMock.getSession.mockResolvedValue({
      data: { session: { access_token: 'owned-token' } },
      error: null,
    });
    authMock.signOut.mockResolvedValue({ data: null, error: null });
    httpMock.request.mockResolvedValue(undefined);
    caseServiceMock.submitCase.mockResolvedValue({ caseRecord: null, attachments: [] });
    gateMock.enabled = true;
    await offlineSyncManager.reset();
  });

  it('keeps optional online sync work local while the device is offline', async () => {
    netInfoMock.emit({ isConnected: false });

    await offlineSyncManager.addToSyncQueue({
      id: 'submit-draft-offline',
      type: 'submit',
      data: {
        draftId: 'draft-offline-1',
        pathway: 'referral',
      },
      timestamp: new Date('2026-06-05T08:30:00.000Z'),
      maxRetries: 5,
    });

    expect(caseServiceMock.submitCase).not.toHaveBeenCalled();
    expect(offlineSyncManager.getSyncQueueSize()).toBe(1);
    expect(offlineSyncManager.getSyncQueueItems()[0]).toMatchObject({
      id: 'submit-draft-offline',
      type: 'submit',
      retryCount: 0,
      maxRetries: 5,
      data: {
        draftId: 'draft-offline-1',
        pathway: 'referral',
      },
    });

    const rawStoredQueue = await AsyncStorage.getItem('@sync_queue');
    expect(isEncryptedAsyncStorageEnvelope(rawStoredQueue)).toBe(true);
    expect(rawStoredQueue).not.toContain('submit-draft-offline');
    const storedQueue = JSON.parse(await encryptedAsyncStorage.getItem('@sync_queue') ?? '[]');
    expect(storedQueue).toEqual([
      expect.objectContaining({
        id: 'submit-draft-offline',
        type: 'submit',
        retryCount: 0,
      }),
    ]);

    await expect(offlineSyncManager.startSync()).rejects.toThrow('Cannot sync while offline');
    expect(offlineSyncManager.getSyncQueueSize()).toBe(1);
  });

  it('does not enqueue duplicate offline submissions for the same draft', async () => {
    netInfoMock.emit({ isConnected: false });

    const queueInput = {
      id: 'submit-draft-offline',
      type: 'submit' as const,
      data: {
        draftId: 'draft-offline-1',
        pathway: 'referral',
      },
      timestamp: new Date('2026-06-05T08:30:00.000Z'),
      maxRetries: 5,
    };

    await offlineSyncManager.addToSyncQueue(queueInput);
    await offlineSyncManager.addToSyncQueue({
      ...queueInput,
      id: 'submit-draft-offline-duplicate',
    });

    expect(offlineSyncManager.getSyncQueueSize()).toBe(1);
    expect(offlineSyncManager.getSyncQueueItems()[0]).toMatchObject({
      id: 'submit-draft-offline',
      data: { draftId: 'draft-offline-1' },
    });
  });

  it('ignores obsolete draft update and delete queue work', async () => {
    netInfoMock.emit({ isConnected: false });

    await offlineSyncManager.addToSyncQueue({
      id: 'draft-update-obsolete',
      type: 'update',
      data: {
        resource: 'draft',
        payload: {
          id: 'draft-local-only',
          payload: { currentStep: 'ConsentGate' },
        },
      },
      timestamp: new Date('2026-06-05T08:32:00.000Z'),
      maxRetries: 5,
    });
    await offlineSyncManager.addToSyncQueue({
      id: 'draft-delete-obsolete',
      type: 'delete',
      data: {
        resource: 'draft',
        payload: {
          id: 'draft-local-only',
        },
      },
      timestamp: new Date('2026-06-05T08:33:00.000Z'),
      maxRetries: 5,
    });

    expect(offlineSyncManager.getSyncQueueSize()).toBe(0);
    expect(JSON.parse(await encryptedAsyncStorage.getItem('@sync_queue') ?? '[]')).toEqual([]);
    expect(httpMock.request).not.toHaveBeenCalled();
  });

  it('prunes stale stored draft sync work while preserving submit work', async () => {
    await encryptedAsyncStorage.setItem('@sync_queue', JSON.stringify([
      {
        id: 'draft-update-stale',
        type: 'update',
        data: {
          resource: 'draft',
          payload: {
            id: 'draft-stale',
            payload: { currentStep: 'EvidenceDetail' },
          },
        },
        timestamp: '2026-06-05T08:31:00.000Z',
        retryCount: 0,
        maxRetries: 5,
      },
      {
        id: 'submit-draft-preserved',
        type: 'submit',
        data: {
          draftId: 'draft-stale',
          pathway: 'referral',
        },
        timestamp: '2026-06-05T08:32:00.000Z',
        retryCount: 0,
        maxRetries: 5,
      },
    ]));

    await offlineSyncManager.rehydrateFromStorage();

    expect(offlineSyncManager.getSyncQueueItems()).toEqual([
      expect.objectContaining({ id: 'submit-draft-preserved', type: 'submit' }),
    ]);
    const storedQueue = JSON.parse(await encryptedAsyncStorage.getItem('@sync_queue') ?? '[]');
    expect(storedQueue.map((item: { id: string }) => item.id)).toEqual(['submit-draft-preserved']);
  });

  it('removes legacy queued submits for a draft after local completion', async () => {
    netInfoMock.emit({ isConnected: false });

    await offlineSyncManager.addToSyncQueue({
      id: 'submit-draft-completed',
      type: 'submit',
      data: {
        draftId: 'draft-completed-local',
        pathway: 'escalate',
      },
      timestamp: new Date('2026-06-05T08:30:00.000Z'),
      maxRetries: 5,
    });
    await offlineSyncManager.addToSyncQueue({
      id: 'submit-other-draft',
      type: 'submit',
      data: {
        draftId: 'draft-other',
        pathway: 'referral',
      },
      timestamp: new Date('2026-06-05T08:31:00.000Z'),
      maxRetries: 5,
    });
    await offlineSyncManager.addToSyncQueue({
      id: 'draft-update-completed',
      type: 'update',
      data: {
        resource: 'draft',
        payload: {
          id: 'draft-completed-local',
          payload: { currentStep: 'ConsentGate' },
        },
      },
      timestamp: new Date('2026-06-05T08:32:00.000Z'),
      maxRetries: 5,
    });

    await expect(
      offlineSyncManager.removeSubmitQueueItemsForDraft('draft-completed-local'),
    ).resolves.toBe(1);

    expect(offlineSyncManager.getSyncQueueItems()).toEqual([
      expect.objectContaining({ id: 'submit-other-draft', type: 'submit' }),
    ]);
    const rawStoredQueue = await AsyncStorage.getItem('@sync_queue');
    expect(isEncryptedAsyncStorageEnvelope(rawStoredQueue)).toBe(true);
    const storedQueue = JSON.parse(await encryptedAsyncStorage.getItem('@sync_queue') ?? '[]');
    expect(storedQueue.map((item: { id: string }) => item.id)).toEqual([
      'submit-other-draft',
    ]);
  });

  it('removes all queued work for a locally deleted or closed draft', async () => {
    netInfoMock.emit({ isConnected: false });

    await offlineSyncManager.addToSyncQueue({
      id: 'submit-draft-local-delete',
      type: 'submit',
      data: {
        draftId: 'draft-local-delete',
        pathway: 'referral',
      },
      timestamp: new Date('2026-06-05T08:33:00.000Z'),
      maxRetries: 5,
    });
    await offlineSyncManager.addToSyncQueue({
      id: 'draft-update-local-delete',
      type: 'update',
      data: {
        resource: 'draft',
        payload: {
          id: 'draft-local-delete',
          currentStep: 'completed',
        },
      },
      timestamp: new Date('2026-06-05T08:34:00.000Z'),
      maxRetries: 5,
    });
    await offlineSyncManager.addToSyncQueue({
      id: 'draft-delete-other',
      type: 'delete',
      data: {
        resource: 'draft',
        payload: {
          id: 'draft-other',
        },
      },
      timestamp: new Date('2026-06-05T08:35:00.000Z'),
      maxRetries: 5,
    });

    await expect(
      offlineSyncManager.removeQueueItemsForDraft('draft-local-delete'),
    ).resolves.toBe(1);

    expect(offlineSyncManager.getSyncQueueItems()).toEqual([]);
    const storedQueue = JSON.parse(await encryptedAsyncStorage.getItem('@sync_queue') ?? '[]');
    expect(storedQueue).toEqual([]);
  });

  it('does not replay queued work while privacy delete pause is active', async () => {
    netInfoMock.emit({ isConnected: false });
    const draft = buildDraft({ id: 'draft-paused-privacy-delete' });
    await draftStorage.saveDraft(draft);

    await offlineSyncManager.addToSyncQueue({
      id: 'submit-draft-paused-privacy-delete',
      type: 'submit',
      data: {
        draftId: draft.id,
        pathway: 'referral',
      },
      timestamp: new Date('2026-06-05T08:40:00.000Z'),
      maxRetries: 5,
    });

    offlineSyncManager.pauseForPrivacyDelete();
    netInfoMock.emit({ isConnected: true });
    await offlineSyncManager.startSync();

    expect(caseServiceMock.submitCase).not.toHaveBeenCalled();
    expect(offlineSyncManager.getSyncQueueSize()).toBe(1);
    const rawPausedQueue = await AsyncStorage.getItem('@sync_queue');
    expect(isEncryptedAsyncStorageEnvelope(rawPausedQueue)).toBe(true);
    expect(rawPausedQueue).not.toContain('draft-paused-privacy-delete');
    expect(JSON.parse(await encryptedAsyncStorage.getItem('@sync_queue') ?? '[]')).toEqual([
      expect.objectContaining({
        id: 'submit-draft-paused-privacy-delete',
        retryCount: 0,
      }),
    ]);
  });

  it('cancels an active queued submit before the network call when privacy delete starts', async () => {
    const draft = buildDraft({ id: 'draft-active-privacy-delete' });
    await draftStorage.saveDraft(draft);
    const originalGetDraft = draftStorage.getDraft.bind(draftStorage);
    const getDraftSpy = vi.spyOn(draftStorage, 'getDraft').mockImplementationOnce(async (id: string) => {
      const storedDraft = await originalGetDraft(id);
      offlineSyncManager.pauseForPrivacyDelete();
      return storedDraft;
    });

    const syncFinished = new Promise<'error'>((resolve) => {
      const unsubscribe = offlineSyncManager.addSyncCallback((status) => {
        if (status === 'error') {
          unsubscribe();
          resolve(status);
        }
      });
    });

    await offlineSyncManager.addToSyncQueue({
      id: 'submit-draft-active-privacy-delete',
      type: 'submit',
      data: {
        draftId: draft.id,
        pathway: 'referral',
      },
      timestamp: new Date('2026-06-05T08:45:00.000Z'),
      maxRetries: 5,
    });

    await expect(syncFinished).resolves.toBe('error');

    expect(caseServiceMock.submitCase).not.toHaveBeenCalled();
    expect(offlineSyncManager.getSyncQueueSize()).toBe(1);
    const rawActivePauseQueue = await AsyncStorage.getItem('@sync_queue');
    expect(isEncryptedAsyncStorageEnvelope(rawActivePauseQueue)).toBe(true);
    expect(rawActivePauseQueue).not.toContain('draft-active-privacy-delete');
    expect(JSON.parse(await encryptedAsyncStorage.getItem('@sync_queue') ?? '[]')).toEqual([
      expect.objectContaining({
        id: 'submit-draft-active-privacy-delete',
        retryCount: 0,
      }),
    ]);

    getDraftSpy.mockRestore();
  });

  it('retains queued submit work and signs out when replay loses auth', async () => {
    const draft = buildDraft();
    await draftStorage.saveDraft(draft);
    caseServiceMock.submitCase.mockRejectedValue(new Error('User is not authenticated'));

    const syncFinished = new Promise<'error'>((resolve) => {
      const unsubscribe = offlineSyncManager.addSyncCallback((status) => {
        if (status === 'error') {
          unsubscribe();
          resolve(status);
        }
      });
    });

    await offlineSyncManager.addToSyncQueue({
      id: 'submit-draft-auth-loss',
      type: 'submit',
      data: {
        draftId: draft.id,
        pathway: 'referral',
      },
      timestamp: new Date('2026-06-05T08:35:00.000Z'),
      maxRetries: 5,
    });

    await expect(syncFinished).resolves.toBe('error');

    expect(caseServiceMock.submitCase).toHaveBeenCalledTimes(1);
    expect(caseServiceMock.submitCase).toHaveBeenCalledWith({
      draft: expect.objectContaining({ id: draft.id }),
      pathway: 'referral',
    });
    expect(authMock.signOut).toHaveBeenCalledTimes(1);
    expect(offlineSyncManager.getSyncQueueSize()).toBe(1);
    expect(offlineSyncManager.getSyncQueueItems()[0]).toMatchObject({
      id: 'submit-draft-auth-loss',
      blockedReason: 'auth_required',
      lastError: 'User is not authenticated',
      retryCount: 0,
    });
    expect(buildSyncQueueRecoveryMessage(offlineSyncManager.getSyncQueueItems())).toContain('Optional online sync needs attention');
    const rawAuthLossQueue = await AsyncStorage.getItem('@sync_queue');
    expect(isEncryptedAsyncStorageEnvelope(rawAuthLossQueue)).toBe(true);
    expect(rawAuthLossQueue).not.toContain('User is not authenticated');
    expect(JSON.parse(await encryptedAsyncStorage.getItem('@sync_queue') ?? '[]')).toEqual([
      expect.objectContaining({
        id: 'submit-draft-auth-loss',
        blockedReason: 'auth_required',
        lastError: 'User is not authenticated',
      }),
    ]);
  });

  it('retains max-retry failures for manual retry instead of deleting the queue item', async () => {
    const draft = buildDraft({ id: 'draft-max-retry' });
    await draftStorage.saveDraft(draft);
    caseServiceMock.submitCase.mockRejectedValue(new Error('Evidence upload failed'));

    const syncFinished = new Promise<'error'>((resolve) => {
      const unsubscribe = offlineSyncManager.addSyncCallback((status) => {
        if (status === 'error') {
          unsubscribe();
          resolve(status);
        }
      });
    });

    await offlineSyncManager.addToSyncQueue({
      id: 'submit-draft-max-retry',
      type: 'submit',
      data: {
        draftId: draft.id,
        pathway: 'referral',
      },
      timestamp: new Date('2026-06-05T08:50:00.000Z'),
      maxRetries: 1,
    });

    await expect(syncFinished).resolves.toBe('error');

    expect(offlineSyncManager.getSyncQueueItems()[0]).toMatchObject({
      id: 'submit-draft-max-retry',
      retryCount: 1,
      maxRetries: 1,
      blockedReason: 'max_retries',
      lastError: 'Evidence upload failed',
    });
    expect(buildSyncQueueRecoveryMessage(offlineSyncManager.getSyncQueueItems())).toContain('manual retry');

    caseServiceMock.submitCase.mockClear();
    await offlineSyncManager.startSync();
    expect(caseServiceMock.submitCase).not.toHaveBeenCalled();

    await offlineSyncManager.startSync(true);
    expect(caseServiceMock.submitCase).toHaveBeenCalledTimes(1);
    expect(offlineSyncManager.getSyncQueueItems()[0]).toMatchObject({
      retryCount: 2,
      blockedReason: 'max_retries',
    });
  });

  it('holds a HURIA consent conflict for the survivor instead of retrying it', async () => {
    const draft = buildDraft({ id: 'draft-partner-conflict', selectedPathway: 'escalate' });
    await draftStorage.saveDraft(draft);
    caseServiceMock.submitCase.mockRejectedValue(
      new caseServiceMock.PartnerRoutingConflictError('partner_consent_missing'),
    );

    const syncFinished = new Promise<'error'>((resolve) => {
      const unsubscribe = offlineSyncManager.addSyncCallback((status) => {
        if (status === 'error') {
          unsubscribe();
          resolve(status);
        }
      });
    });

    await offlineSyncManager.addToSyncQueue({
      id: 'submit-draft-partner-conflict',
      type: 'submit',
      data: { draftId: draft.id, pathway: 'escalate' },
      timestamp: new Date('2026-10-21T08:50:00.000Z'),
      maxRetries: 3,
    });

    await expect(syncFinished).resolves.toBe('error');
    expect(offlineSyncManager.getSyncQueueItems()[0]).toMatchObject({
      id: 'submit-draft-partner-conflict',
      retryCount: 0,
      blockedReason: 'needs_confirmation',
    });
    expect(buildSyncQueueRecoveryMessage(offlineSyncManager.getSyncQueueItems())).toContain('confirm sharing with HURIA');

    caseServiceMock.submitCase.mockClear();
    await offlineSyncManager.startSync();
    expect(caseServiceMock.submitCase).not.toHaveBeenCalled();
  });

});

describe('offlineSyncManager and the server switch (features.caseSubmission)', () => {
  beforeEach(async () => {
    netInfoMock.emit({ isConnected: true });
    authMock.getSession.mockResolvedValue({ data: { session: { access_token: 'owned-token' } }, error: null });
    caseServiceMock.submitCase.mockReset();
    caseServiceMock.submitCase.mockResolvedValue({ caseRecord: null, attachments: [] });
    gateMock.enabled = true;
    await offlineSyncManager.reset();
  });

  async function queueSubmit(draftId: string) {
    await draftStorage.saveDraft(buildDraft({ id: draftId }));
    await offlineSyncManager.addToSyncQueue({
      id: `submit-${draftId}`,
      type: 'submit',
      data: { draftId, pathway: 'referral' },
      timestamp: new Date('2026-10-22T08:00:00.000Z'),
      maxRetries: 3,
    });
  }

  it('flag off: queued reports are paused and nothing is sent', async () => {
    gateMock.enabled = false;
    await queueSubmit('draft-switch-off');
    await offlineSyncManager.startSync(true);

    expect(caseServiceMock.submitCase).not.toHaveBeenCalled();
    expect(offlineSyncManager.getSyncQueueItems()[0]).toMatchObject({ blockedReason: 'sending_paused', retryCount: 0 });
    expect(buildSyncQueueRecoveryMessage(offlineSyncManager.getSyncQueueItems())).toContain('Sending to SafeRide is paused');
  });

  it('flag on: queued reports are sent', async () => {
    const synced = new Promise<void>(resolve => {
      const unsubscribe = offlineSyncManager.addSyncCallback(status => {
        if (status === 'success') {
          unsubscribe();
          resolve();
        }
      });
    });
    await queueSubmit('draft-switch-on'); // online and on: queueing starts sending at once
    await synced;

    expect(caseServiceMock.submitCase).toHaveBeenCalledTimes(1);
    expect(offlineSyncManager.getSyncQueueItems()).toHaveLength(0);
  });

  it('flag turning off mid-queue: the remaining reports pause and are not sent', async () => {
    gateMock.enabled = false;
    await queueSubmit('draft-mid-1');
    await queueSubmit('draft-mid-2');
    await queueSubmit('draft-mid-3');
    caseServiceMock.submitCase.mockImplementationOnce(async () => {
      gateMock.enabled = false; // the server switch goes off while the first report is sending
      return { caseRecord: null, attachments: [] };
    });

    gateMock.enabled = true;
    await offlineSyncManager.startSync(true);

    expect(caseServiceMock.submitCase).toHaveBeenCalledTimes(1);
    const remaining = offlineSyncManager.getSyncQueueItems();
    expect(remaining).toHaveLength(2);
    expect(remaining.every(item => item.blockedReason === 'sending_paused' && item.retryCount === 0)).toBe(true);

    // Switched back on: the paused reports go out.
    gateMock.enabled = true;
    await offlineSyncManager.startSync(true);
    expect(caseServiceMock.submitCase).toHaveBeenCalledTimes(3);
    expect(offlineSyncManager.getSyncQueueItems()).toHaveLength(0);
  });

  it('missing runtime config: the real gate keeps everything on the phone', async () => {
    gateMock.enabled = false;
    await queueSubmit('draft-no-config');
    gateMock.enabled = 'real';
    await offlineSyncManager.startSync(true);

    expect(caseServiceMock.submitCase).not.toHaveBeenCalled();
    expect(offlineSyncManager.getSyncQueueItems()[0]).toMatchObject({ blockedReason: 'sending_paused' });
  });
});

