import AsyncStorage from '@react-native-async-storage/async-storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const secureStoreMock = vi.hoisted(() => {
  const store = new Map<string, string>();

  return {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
    store,
    isAvailableAsync: vi.fn(async () => true),
    getItemAsync: vi.fn(async (key: string) => store.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    deleteItemAsync: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    reset() {
      store.clear();
      this.isAvailableAsync.mockClear();
      this.getItemAsync.mockClear();
      this.setItemAsync.mockClear();
      this.deleteItemAsync.mockClear();
    },
  };
});

const fileSystemMock = vi.hoisted(() => {
  const writes: Array<{ filePath: string; contents: string }> = [];
  const deleted: string[] = [];
  const directoryEntries = new Map<string, string[]>([
    ['file:///docs/', [
      'saferide_privacy_export_old.json',
      'SafeRide_Statement_draft.pdf',
      'case-123_2026-06-06T12-00-00-000Z.json',
      '550e8400-e29b-41d4-a716-446655440000_2026-06-06T12-01-00-000Z.sealed',
      'keep_2026-06-06T12-00-00-000Z.txt',
      'notes_2026-06-06T12-00-00-000Z.json',
      'keep.txt',
    ]],
    ['file:///cache/', [
      'bulk_export_old.json',
      'case-456_2026-06-06T12-02-00-000Z.pdf',
      'keep-cache.txt',
    ]],
  ]);

  return {
    documentDirectory: 'file:///docs/',
    cacheDirectory: 'file:///cache/',
    EncodingType: {
      Base64: 'base64',
    },
    writes,
    deleted,
    directoryEntries,
    writeAsStringAsync: vi.fn(async (filePath: string, contents: string) => {
      writes.push({ filePath, contents });
    }),
    getInfoAsync: vi.fn(async (uri: string) => ({
      exists: !uri.includes('missing'),
      size: uri.includes('privacy_export') ? 4096 : 128,
    })),
    readAsStringAsync: vi.fn(async () => 'ZmFrZS1maWxlLWJ5dGVz'),
    readDirectoryAsync: vi.fn(async (uri: string) => directoryEntries.get(uri) ?? []),
    deleteAsync: vi.fn(async (uri: string) => {
      deleted.push(uri);
    }),
    getContentUriAsync: vi.fn(async (uri: string) => `content://${uri}`),
    reset() {
      writes.length = 0;
      deleted.length = 0;
      this.writeAsStringAsync.mockClear();
      this.getInfoAsync.mockClear();
      this.readAsStringAsync.mockClear();
      this.readDirectoryAsync.mockClear();
      this.deleteAsync.mockClear();
      this.getContentUriAsync.mockClear();
    },
  };
});

const authClientMock = vi.hoisted(() => ({
  signOut: vi.fn(async () => ({ data: null, error: null })),
}));

const httpClientMock = vi.hoisted(() => ({
  setAuthToken: vi.fn(),
}));

const offlineSyncMock = vi.hoisted(() => ({
  pauseForPrivacyDelete: vi.fn(),
  resumeAfterPrivacyDeleteCancel: vi.fn(),
  reset: vi.fn(async () => {}),
}));

const appResetMock = vi.hoisted(() => ({
  runAppReset: vi.fn(async () => {}),
}));

const reactNativeMock = vi.hoisted(() => ({
  Platform: { OS: 'ios' },
  Share: {
    sharedAction: 'sharedAction',
    dismissedAction: 'dismissedAction',
    share: vi.fn(async () => ({ action: 'sharedAction' })),
  },
}));

vi.mock('expo-secure-store', () => secureStoreMock);

vi.mock('expo-file-system/legacy', () => fileSystemMock);

vi.mock('react-native', () => reactNativeMock);

vi.mock('../../lib/auth/authClient', () => ({
  authClient: authClientMock,
}));

vi.mock('../../lib/api/httpClient', () => httpClientMock);

vi.mock('../offlineSync', () => ({
  offlineSyncManager: offlineSyncMock,
}));

vi.mock('../appReset', () => appResetMock);

import {
  createPrivacyDataExport,
  createPrivacyDeleteFlowController,
  deleteLocalPrivacyData,
  DeleteLocalPrivacyDataResult,
  getPrivacyRetentionPreference,
  PRIVACY_RETENTION_PREFERENCE_KEY,
  savePrivacyRetentionPreference,
  sharePrivacyDataExportFile,
} from '../privacyDataControls';
import { draftStorage } from '../draftStorage';
import { AI_PILOT_DIAGNOSTICS_KEY, AI_PILOT_INFLIGHT_KEY, TUNED_ARTIFACT_ROLLOUT_BUCKET_KEY } from '../storageKeys';

type ResettableAsyncStorage = typeof AsyncStorage & {
  __dump: () => Map<string, string>;
};

function lastExportPayload() {
  const lastWrite = fileSystemMock.writes[fileSystemMock.writes.length - 1];
  if (!lastWrite) {
    throw new Error('No export file was written.');
  }
  return JSON.parse(lastWrite.contents);
}

function storedDraft(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    createdAt: '2026-06-06T10:00:00.000Z',
    updatedAt: '2026-06-06T11:00:00.000Z',
    currentStep: 'WhatHappened',
    completedSteps: [],
    ...extra,
  };
}

function createDeleteResult(overrides: Partial<DeleteLocalPrivacyDataResult> = {}): DeleteLocalPrivacyDataResult {
  return {
    asyncStorageKeysDeleted: [],
    secureStoreKeysDeleted: [],
    filesystemUrisDeleted: [],
    failures: [],
    includedStores: [],
    excludedStores: [],
    ...overrides,
  };
}

function createManualScheduler() {
  let nextId = 1;
  const callbacks = new Map<number, () => void>();

  return {
    setTimeout: vi.fn((callback: () => void) => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id as unknown as ReturnType<typeof setTimeout>;
    }),
    clearTimeout: vi.fn((timer: ReturnType<typeof setTimeout>) => {
      callbacks.delete(timer as unknown as number);
    }),
    runNext() {
      const next = callbacks.entries().next();
      if (next.done) {
        throw new Error('No scheduled timer to run.');
      }

      const [id, callback] = next.value;
      callbacks.delete(id);
      callback();
    },
    runAll() {
      while (callbacks.size > 0) {
        this.runNext();
      }
    },
    get size() {
      return callbacks.size;
    },
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('privacy data controls', () => {
  beforeEach(async () => {
    secureStoreMock.reset();
    fileSystemMock.reset();
    authClientMock.signOut.mockClear();
    httpClientMock.setAuthToken.mockClear();
    offlineSyncMock.pauseForPrivacyDelete.mockClear();
    offlineSyncMock.resumeAfterPrivacyDeleteCancel.mockClear();
    offlineSyncMock.reset.mockClear();
    appResetMock.runAppReset.mockClear();
    reactNativeMock.Platform.OS = 'ios';
    reactNativeMock.Share.share.mockClear();
    reactNativeMock.Share.share.mockResolvedValue({ action: 'sharedAction' });
    await draftStorage.clearAll();
  });

  it('persists retention as a local preference only', async () => {
    expect(await getPrivacyRetentionPreference()).toBe('local-manual-v1');

    await savePrivacyRetentionPreference('local-manual-v1');

    expect(await AsyncStorage.getItem(PRIVACY_RETENTION_PREFERENCE_KEY)).not.toBe('local-manual-v1');
    expect(await getPrivacyRetentionPreference()).toBe('local-manual-v1');
    await expect(savePrivacyRetentionPreference('local-30-days-v1')).rejects.toThrow(/unavailable/);
  });

  it('creates a scoped local JSON export without auth tokens or delete-only stores', async () => {
    await AsyncStorage.setItem('incident_drafts', JSON.stringify([
      storedDraft('draft-a', {
        incidentDescription: 'Saved draft text',
        mediaFiles: [
          {
            id: 'media-a',
            type: 'photo',
            uri: 'file:///docs/evidence/photo.jpg',
            fileName: 'photo.jpg',
          },
        ],
      }),
    ]));
    await AsyncStorage.setItem('@sync_queue', JSON.stringify([{ id: 'queue-a', type: 'submit' }]));
    await AsyncStorage.setItem('@offline_case-a', JSON.stringify({ id: 'case-a', data: { summary: 'cached' } }));
    await AsyncStorage.setItem('chat_messages:default', JSON.stringify([{ id: 'chat-a', content: 'offline' }]));
    await AsyncStorage.setItem('@catalog_providers', JSON.stringify({ items: [{ id: 'provider-a' }] }));
    await AsyncStorage.setItem('saferide_legacy_secure_user_data', JSON.stringify({ alias: 'legacy-user' }));
    await AsyncStorage.setItem('NAVIGATION_STATE', 'navigation should stay out of export');
    await AsyncStorage.setItem(TUNED_ARTIFACT_ROLLOUT_BUCKET_KEY, '42');
    await AsyncStorage.setItem('safe_ride_decoy_pin', 'hashed pin should stay out of export');
    await AsyncStorage.setItem('saferide_auth_saferide_local_auth_session', 'token should stay out of export');
    await AsyncStorage.setItem('saferide_auth_saferide_local_guest_session', 'guest marker should stay out of export');
    secureStoreMock.store.set('app_settings', JSON.stringify({ theme: 'system' }));
    secureStoreMock.store.set('incident_drafts', JSON.stringify([{ id: 'legacy-draft' }]));
    secureStoreMock.store.set('saferide_auth_saferide_local_auth_session', 'native token should stay out');
    secureStoreMock.store.set('saferide_auth_saferide_local_guest_session', 'native guest marker should stay out');

    const result = await createPrivacyDataExport({
      includeMediaMetadata: true,
      now: new Date('2026-06-06T12:00:00.000Z'),
    });
    const payload = lastExportPayload();
    const exportedKeys = payload.stores.map((store: { key: string }) => store.key);

    expect(result.filePath).toBe('file:///docs/saferide_privacy_export_2026-06-06T12-00-00-000Z.json');
    expect(payload.schema).toBe('com.saferide.privacy-data-export');
    expect(payload.schemaVersion).toBe(2);
    expect(payload.retentionPolicyId).toBe('local-manual-v1');
    expect(payload).not.toHaveProperty('retentionPreference');
    expect(exportedKeys).toEqual(expect.arrayContaining([
      'incident_draft_records',
      '@sync_queue',
      '@offline_case-a',
      'chat_messages:default',
      '@catalog_providers',
      'secure_store:app_settings',
      'secure_store:incident_drafts',
      'saferide_legacy_secure_user_data',
    ]));
    expect(exportedKeys).not.toContain('NAVIGATION_STATE');
    expect(exportedKeys).not.toContain(TUNED_ARTIFACT_ROLLOUT_BUCKET_KEY);
    expect(exportedKeys).not.toContain('safe_ride_decoy_pin');
    expect(exportedKeys).not.toContain('saferide_auth_saferide_local_auth_session');
    expect(exportedKeys).not.toContain('saferide_auth_saferide_local_guest_session');
    expect(exportedKeys).not.toContain('secure_store:saferide_auth_saferide_local_auth_session');
    expect(exportedKeys).not.toContain('secure_store:saferide_auth_saferide_local_guest_session');
    expect(payload.media).toEqual([
      expect.objectContaining({
        draftId: 'draft-a',
        mediaId: 'media-a',
        uriScope: 'app-document',
        exists: true,
        size: 128,
        sha256: expect.stringMatching(/^[0-9a-f]+$/),
      }),
    ]);
  });

  it('clears supported local stores and app-owned files without deleting unrelated AsyncStorage keys', async () => {
    await AsyncStorage.setItem('incident_drafts', JSON.stringify([
      storedDraft('draft-a', {
        mediaFiles: [
          { id: 'media-a', uri: 'file:///docs/evidence/photo.jpg', fileName: 'photo.jpg' },
          { id: 'media-b', uri: 'file:///external/photo.jpg', fileName: 'external.jpg' },
        ],
      }),
    ]));
    await AsyncStorage.setItem('@sync_queue', JSON.stringify([{ id: 'queue-a' }]));
    await AsyncStorage.setItem('@offline_case-a', JSON.stringify({ id: 'case-a' }));
    await AsyncStorage.setItem('@workflow_report-a', JSON.stringify({ id: 'workflow-a' }));
    await AsyncStorage.setItem('chat_messages:default', JSON.stringify([{ id: 'chat-a' }]));
    await AsyncStorage.setItem('message_retry_queue:default', JSON.stringify([{ id: 'retry-a' }]));
    await AsyncStorage.setItem('@catalog_tips', JSON.stringify({ items: [] }));
    await AsyncStorage.setItem('safe_ride_decoy_pin', 'hashed-pin');
    await AsyncStorage.setItem('calculator_state', '{}');
    await AsyncStorage.setItem('NAVIGATION_STATE', '{}');
    await AsyncStorage.setItem('@saferide_runtime_config_override', '{}');
    await AsyncStorage.setItem(TUNED_ARTIFACT_ROLLOUT_BUCKET_KEY, '42');
    await AsyncStorage.setItem('@error_log', '[]');
    await AsyncStorage.setItem('saferide_auth_saferide_local_auth_session', 'web-token');
    await AsyncStorage.setItem('saferide_auth_saferide_local_guest_session', 'web-local-guest');
    await AsyncStorage.setItem('@saferide_local_model_download:test-model:model.litertlm', '{}');
    await AsyncStorage.setItem('@saferide_local_model_verification:test-model:model.litertlm', '{}');
    await AsyncStorage.setItem('saferide_legacy_secure_user_data', JSON.stringify({ alias: 'legacy-user' }));
    await AsyncStorage.setItem('saferide_legacy_secure_incident_drafts', JSON.stringify([
      {
        id: 'legacy-web-draft',
        evidence: {
          photos: ['file:///cache/legacy-web-photo.jpg', 'file:///external/legacy-web-photo.jpg'],
          audioRecordings: ['file:///docs/legacy-web-audio.m4a'],
        },
      },
    ]));
    await AsyncStorage.setItem('unrelated_key', 'keep');
    secureStoreMock.store.set('app_settings', JSON.stringify({ theme: 'dark' }));
    secureStoreMock.store.set('incident_drafts', JSON.stringify([
      {
        id: 'legacy-secure-draft',
        evidence: {
          photos: ['file:///docs/legacy-secure-photo.jpg'],
          audioRecordings: ['file:///cache/legacy-secure-audio.m4a', 'file:///external/legacy-secure-audio.m4a'],
        },
      },
    ]));
    secureStoreMock.store.set('saferide_auth_saferide_local_auth_session', 'native-token');
    secureStoreMock.store.set('saferide_auth_saferide_local_guest_session', 'native-local-guest');
    secureStoreMock.store.set('safe_ride_decoy_pin', JSON.stringify({ hashedPin: 'verifier', salt: 'salt' }));
    secureStoreMock.store.set('safe_ride_decoy_pin_attempts', JSON.stringify({ failedAttempts: 2, lastFailedAt: 1 }));
    await AsyncStorage.setItem(AI_PILOT_DIAGNOSTICS_KEY, '{"events":[]}');
    await AsyncStorage.setItem(AI_PILOT_INFLIGHT_KEY, '{"startedAt":1}');

    const result = await deleteLocalPrivacyData();
    const remaining = (AsyncStorage as ResettableAsyncStorage).__dump();

    expect(result.failures).toEqual([]);
    expect(remaining.get('unrelated_key')).toBe('keep');
    expect(remaining.has('incident_drafts')).toBe(false);
    expect(remaining.has('@sync_queue')).toBe(false);
    expect(remaining.has('@offline_case-a')).toBe(false);
    expect(remaining.has('@workflow_report-a')).toBe(false);
    expect(remaining.has('chat_messages:default')).toBe(false);
    expect(remaining.has('message_retry_queue:default')).toBe(false);
    expect(remaining.has('@catalog_tips')).toBe(false);
    expect(remaining.has('safe_ride_decoy_pin')).toBe(false);
    expect(remaining.has(TUNED_ARTIFACT_ROLLOUT_BUCKET_KEY)).toBe(false);
    expect(remaining.has('saferide_auth_saferide_local_auth_session')).toBe(false);
    expect(remaining.has('saferide_auth_saferide_local_guest_session')).toBe(false);
    expect(remaining.has('@saferide_local_model_download:test-model:model.litertlm')).toBe(false);
    expect(remaining.has('@saferide_local_model_verification:test-model:model.litertlm')).toBe(false);
    expect(remaining.has('saferide_legacy_secure_user_data')).toBe(false);
    expect(remaining.has('saferide_legacy_secure_incident_drafts')).toBe(false);
    expect(secureStoreMock.store.has('app_settings')).toBe(false);
    expect(secureStoreMock.store.has('incident_drafts')).toBe(false);
    expect(secureStoreMock.store.has('saferide_auth_saferide_local_auth_session')).toBe(false);
    expect(secureStoreMock.store.has('saferide_auth_saferide_local_guest_session')).toBe(false);
    expect(secureStoreMock.store.has('safe_ride_decoy_pin')).toBe(false);
    expect(secureStoreMock.store.has('safe_ride_decoy_pin_attempts')).toBe(false);
    expect(remaining.has(AI_PILOT_DIAGNOSTICS_KEY)).toBe(false);
    expect(remaining.has(AI_PILOT_INFLIGHT_KEY)).toBe(false);
    expect(secureStoreMock.deleteItemAsync).toHaveBeenCalledWith('saferide_local_data_aes_key_v1');
    expect(result.secureStoreKeysDeleted).toContain('saferide_local_data_aes_key_v1');
    expect(authClientMock.signOut).toHaveBeenCalledTimes(1);
    expect(httpClientMock.setAuthToken).toHaveBeenCalledWith(null);
    expect(offlineSyncMock.pauseForPrivacyDelete).toHaveBeenCalledTimes(1);
    expect(offlineSyncMock.reset).toHaveBeenCalledWith({ throwOnFailure: true });
    expect(appResetMock.runAppReset).toHaveBeenCalledWith('privacy-delete');
    expect(fileSystemMock.deleted).toEqual(expect.arrayContaining([
      'file:///docs/evidence/photo.jpg',
      'file:///cache/legacy-web-photo.jpg',
      'file:///docs/legacy-web-audio.m4a',
      'file:///docs/legacy-secure-photo.jpg',
      'file:///cache/legacy-secure-audio.m4a',
      'file:///cache/saferide-evidence',
      'file:///docs/saferide-evidence',
      'file:///docs/models',
      'file:///docs/saferide_privacy_export_old.json',
      'file:///docs/SafeRide_Statement_draft.pdf',
      'file:///docs/case-123_2026-06-06T12-00-00-000Z.json',
      'file:///docs/550e8400-e29b-41d4-a716-446655440000_2026-06-06T12-01-00-000Z.sealed',
      'file:///cache/bulk_export_old.json',
      'file:///cache/case-456_2026-06-06T12-02-00-000Z.pdf',
    ]));
    expect(fileSystemMock.deleted).not.toContain('file:///docs/keep_2026-06-06T12-00-00-000Z.txt');
    expect(fileSystemMock.deleted).not.toContain('file:///docs/notes_2026-06-06T12-00-00-000Z.json');
    expect(fileSystemMock.deleted).not.toContain('file:///external/photo.jpg');
    expect(fileSystemMock.deleted).not.toContain('file:///external/legacy-web-photo.jpg');
    expect(fileSystemMock.deleted).not.toContain('file:///external/legacy-secure-audio.m4a');
  });

  it('reports share handoff results without claiming Android or failed shares succeeded', async () => {
    const shared = await sharePrivacyDataExportFile('file:///docs/export.json', 'SafeRide privacy data export');

    expect(shared).toEqual({ success: true, shared: true });
    expect(reactNativeMock.Share.share).toHaveBeenCalledWith(
      { url: 'file:///docs/export.json', message: 'SafeRide privacy data export' },
      { dialogTitle: 'SafeRide privacy data export' },
    );

    reactNativeMock.Platform.OS = 'android';
    reactNativeMock.Share.share.mockClear();

    const androidResult = await sharePrivacyDataExportFile('file:///docs/export.json', 'SafeRide privacy data export');

    expect(androidResult).toMatchObject({
      success: true,
      shared: false,
      localOnly: true,
      unavailable: true,
    });
    expect(androidResult.unavailableReason).toContain('SafeRide local storage');
    expect(reactNativeMock.Share.share).not.toHaveBeenCalled();

    reactNativeMock.Platform.OS = 'ios';
    reactNativeMock.Share.share.mockRejectedValueOnce(new Error('file:///docs/export.json'));

    const failed = await sharePrivacyDataExportFile('file:///docs/export.json', 'SafeRide privacy data export');

    expect(failed).toEqual({
      success: false,
      shared: false,
      error: 'The file was created locally, but sharing did not open.',
    });
  });

  it('reports local delete cleanup failures without exposing file URIs', async () => {
    await AsyncStorage.setItem('incident_drafts', JSON.stringify([
      storedDraft('draft-sensitive', {
        mediaFiles: [
          { id: 'media-sensitive', uri: 'file:///docs/evidence/sensitive-photo.jpg' },
        ],
      }),
    ]));
    fileSystemMock.deleteAsync.mockImplementationOnce(async () => {
      throw new Error('delete failed for sensitive-photo.jpg');
    });

    const result = await deleteLocalPrivacyData();
    const renderedFailures = result.failures.join('; ');

    expect(result.failures).toContain('media files');
    expect(renderedFailures).not.toContain('file:///');
    expect(renderedFailures).not.toContain('sensitive-photo.jpg');
  });

  it('continues a committed delete countdown after subscribers unsubscribe', async () => {
    const scheduler = createManualScheduler();
    const pauseForPrivacyDelete = vi.fn();
    const resumeAfterPrivacyDeleteCancel = vi.fn();
    const deleteLocalData = vi.fn(async () => createDeleteResult());
    const controller = createPrivacyDeleteFlowController({
      pauseForPrivacyDelete,
      resumeAfterPrivacyDeleteCancel,
      deleteLocalData,
      setTimeout: scheduler.setTimeout,
      clearTimeout: scheduler.clearTimeout,
      countdownSeconds: 2,
    });
    const snapshots: string[] = [];
    const unsubscribe = controller.subscribe((snapshot) => {
      snapshots.push(`${snapshot.status}:${snapshot.countdownRemaining}`);
    });

    expect(controller.startCountdown()).toBe(true);
    expect(pauseForPrivacyDelete).toHaveBeenCalledTimes(1);
    expect(snapshots).toEqual(['idle:0', 'countdown:2']);

    unsubscribe();
    scheduler.runNext();

    expect(controller.getSnapshot()).toMatchObject({
      status: 'countdown',
      countdownRemaining: 1,
    });
    expect(deleteLocalData).not.toHaveBeenCalled();

    scheduler.runNext();
    await flushPromises();

    expect(deleteLocalData).toHaveBeenCalledTimes(1);
    expect(resumeAfterPrivacyDeleteCancel).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      status: 'completed',
      countdownRemaining: 0,
    });
  });

  it('cancels a committed countdown by resuming sync and preventing delete', async () => {
    const scheduler = createManualScheduler();
    const pauseForPrivacyDelete = vi.fn();
    const resumeAfterPrivacyDeleteCancel = vi.fn();
    const deleteLocalData = vi.fn(async () => createDeleteResult());
    const controller = createPrivacyDeleteFlowController({
      pauseForPrivacyDelete,
      resumeAfterPrivacyDeleteCancel,
      deleteLocalData,
      setTimeout: scheduler.setTimeout,
      clearTimeout: scheduler.clearTimeout,
      countdownSeconds: 2,
    });

    expect(controller.startCountdown()).toBe(true);
    expect(controller.cancelCountdown()).toBe(true);
    scheduler.runAll();
    await flushPromises();

    expect(resumeAfterPrivacyDeleteCancel).toHaveBeenCalledTimes(1);
    expect(deleteLocalData).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toEqual({
      status: 'idle',
      countdownRemaining: 0,
    });
  });

  it('resumes sync if the durable delete task fails after the countdown', async () => {
    const scheduler = createManualScheduler();
    const pauseForPrivacyDelete = vi.fn();
    const resumeAfterPrivacyDeleteCancel = vi.fn();
    const deleteLocalData = vi.fn(async () => {
      throw new Error('storage unavailable');
    });
    const controller = createPrivacyDeleteFlowController({
      pauseForPrivacyDelete,
      resumeAfterPrivacyDeleteCancel,
      deleteLocalData,
      setTimeout: scheduler.setTimeout,
      clearTimeout: scheduler.clearTimeout,
      countdownSeconds: 1,
    });

    expect(controller.startCountdown()).toBe(true);
    scheduler.runNext();
    await flushPromises();

    expect(deleteLocalData).toHaveBeenCalledTimes(1);
    expect(resumeAfterPrivacyDeleteCancel).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toMatchObject({
      status: 'failed',
      countdownRemaining: 0,
    });
  });
});
