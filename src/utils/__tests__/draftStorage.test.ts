import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  decryptLocalDataString,
  isEncryptedAsyncStorageEnvelope,
} from '../../lib/encryptedAsyncStorage';
import { localDraftDatabase } from '../localDraftDatabase';
import { DraftData, draftStorage } from '../draftStorage';
import {
  ACTIVE_DRAFT_ID_KEY,
  DRAFT_STORAGE_KEY,
  DRAFT_STORAGE_V2_MIGRATION_STATE_KEY,
} from '../storageKeys';

function buildDraft(overrides: Partial<DraftData> = {}): DraftData {
  return {
    id: 'draft-1',
    createdAt: new Date('2026-06-01T08:00:00.000Z'),
    updatedAt: new Date('2026-06-01T08:00:00.000Z'),
    currentStep: 'WhatHappened',
    completedSteps: ['WhatHappened'],
    incidentDescription: 'Driver blocked the door and made threats.',
    impactLevel: 'high',
    location: {
      description: 'Stage near the market',
      address: 'River Road',
      coordinates: {
        latitude: -1.283,
        longitude: 36.817,
      },
    },
    mediaFiles: [
      {
        id: 'media-1',
        type: 'photo',
        uri: 'file:///evidence/photo.jpg',
        fileName: 'photo.jpg',
        size: 2048,
        timestamp: new Date('2026-06-01T08:05:00.000Z'),
      },
    ],
    selectedTags: ['physical_threat'],
    privacySettings: {
      blurFaces: true,
      removeMetadata: true,
      encryptFiles: true,
    },
    ...overrides,
  };
}

describe('draftStorage', () => {
  beforeEach(async () => {
    await draftStorage.clearAll();
  });

  it('updates existing drafts in queue order and preserves independent appended media', async () => {
    await draftStorage.saveDraft(buildDraft({ mediaFiles: [] }));
    await Promise.all(['media-a', 'media-b'].map(id => draftStorage.updateExistingDraft('draft-1', draft => ({
      mediaFiles: [...(draft.mediaFiles ?? []), { ...buildDraft().mediaFiles![0], id }],
    }))));
    expect((await draftStorage.getDraft('draft-1'))?.mediaFiles?.map(media => media.id)).toEqual(['media-a', 'media-b']);
  });

  it('preserves atomic attachment membership through stale blur flushes in both directions', async () => {
    const initial = buildDraft();
    const first = initial.mediaFiles![0];
    await draftStorage.saveDraft(initial);
    await draftStorage.updateExistingDraft(initial.id, draft => ({ mediaFiles: [...draft.mediaFiles!, { ...first, id: 'new-capture' }] }));
    await draftStorage.saveDraft({ ...initial, textEvidence: 'Unsaved synthetic note' }, { explicitKeys: new Set() });
    expect((await draftStorage.getDraft(initial.id))?.mediaFiles?.map(media => media.id)).toEqual([first.id, 'new-capture']);
    expect((await draftStorage.getDraft(initial.id))?.textEvidence).toBe('Unsaved synthetic note');
    const stale = (await draftStorage.getDraft(initial.id))!;
    await draftStorage.updateExistingDraft(initial.id, () => ({ mediaFiles: [] }));
    await draftStorage.saveDraft(stale, { explicitKeys: new Set() });
    expect((await draftStorage.getDraft(initial.id))?.mediaFiles).toEqual([]);
    await draftStorage.saveDraft({ id: initial.id, mediaFiles: [first] });
    expect((await draftStorage.getDraft(initial.id))?.mediaFiles?.map(media => media.id)).toEqual([first.id]);
  });

  it.each(['delete', 'clear'])('does not recreate a draft after a queued %s', async action => {
    await draftStorage.saveDraft(buildDraft());
    const removal = action === 'delete' ? draftStorage.deleteDraft('draft-1') : draftStorage.clearAll();
    const updater = vi.fn(() => ({ textEvidence: 'delayed synthetic capture' }));
    const update = draftStorage.updateExistingDraft('draft-1', updater);
    await removal;
    expect(await update).toBeNull();
    expect(updater).not.toHaveBeenCalled();
    expect(await draftStorage.getDraft('draft-1')).toBeNull();
  });

  it('merges partial saves into existing drafts without dropping captured report data', async () => {
    const initial = buildDraft();

    await draftStorage.saveDraft(initial);

    await expect(AsyncStorage.getItem(DRAFT_STORAGE_KEY)).resolves.toBeNull();
    const persistedRow = await localDraftDatabase.getDraftRow(initial.id);
    expect(isEncryptedAsyncStorageEnvelope(persistedRow?.encrypted_payload ?? null)).toBe(true);
    expect(persistedRow?.encrypted_payload).not.toContain(initial.incidentDescription);
    expect(persistedRow?.encrypted_payload).not.toContain('River Road');

    await draftStorage.saveDraft({
      id: initial.id,
      selectedPathway: 'save-private',
      completedSteps: ['WhatHappened', 'WhereWhen', 'EvidenceDetail', 'ConsentGate'],
      currentStep: 'completed',
    });

    const saved = await draftStorage.getDraft(initial.id);

    expect(saved).toMatchObject({
      id: initial.id,
      incidentDescription: initial.incidentDescription,
      impactLevel: initial.impactLevel,
      selectedPathway: 'save-private',
      selectedTags: ['physical_threat'],
      currentStep: 'completed',
      privacySettings: initial.privacySettings,
    });
    expect(saved?.createdAt).toEqual(initial.createdAt);
    expect(saved?.location?.description).toBe('Stage near the market');
    expect(saved?.mediaFiles?.[0]).toMatchObject({
      id: 'media-1',
      uri: 'file:///evidence/photo.jpg',
      fileName: 'photo.jpg',
    });
    expect(saved?.mediaFiles?.[0].timestamp).toEqual(new Date('2026-06-01T08:05:00.000Z'));
  });

  it('hydrates persisted draft and media dates when loading from storage', async () => {
    const initial = buildDraft({
      lastAutoSave: new Date('2026-06-01T08:10:00.000Z'),
    });

    await draftStorage.setDrafts([initial]);

    const [saved] = await draftStorage.getAllDrafts();

    expect(saved.createdAt).toBeInstanceOf(Date);
    expect(saved.updatedAt).toBeInstanceOf(Date);
    expect(saved.lastAutoSave).toEqual(new Date('2026-06-01T08:10:00.000Z'));
    expect(saved.mediaFiles?.[0].timestamp).toBeInstanceOf(Date);
  });

  it('hydrates older media with safe privacy status defaults and updates requests when toggles change', async () => {
    const initial = buildDraft({
      mediaFiles: [
        {
          id: 'legacy-document',
          type: 'document',
          uri: 'file:///evidence/letter.pdf',
          fileName: 'letter.pdf',
          size: 4096,
          timestamp: new Date('2026-06-01T08:05:00.000Z'),
        },
      ],
      privacySettings: undefined,
    });

    await draftStorage.setDrafts([initial]);

    const legacy = await draftStorage.getDraft(initial.id);
    expect(legacy?.privacySettings).toBeUndefined();
    expect(legacy?.mediaFiles?.[0].privacyStatus).toMatchObject({
      faceBlur: { status: 'not_requested' },
      metadataRemoval: { status: 'not_requested' },
      fileEncryption: { status: 'not_requested' },
    });

    await draftStorage.saveDraft({
      id: initial.id,
      privacySettings: {
        blurFaces: true,
        removeMetadata: true,
        encryptFiles: true,
      },
    });

    const saved = await draftStorage.getDraft(initial.id);
    expect(saved?.mediaFiles?.[0].privacyStatus).toMatchObject({
      faceBlur: { status: 'unavailable' },
      metadataRemoval: { status: 'requested' },
      fileEncryption: { status: 'requested' },
    });
  });

  it('persists sequential legal tag action patches without erasing earlier draft data', async () => {
    const initial = buildDraft({
      selectedTags: [],
      acceptedSuggestions: [],
      dismissedTagSuggestions: [],
    });

    await draftStorage.saveDraft(initial);
    await draftStorage.saveDraft({
      id: initial.id,
      selectedTags: ['intimidation'],
      acceptedSuggestions: [],
      dismissedTagSuggestions: [],
    });
    await draftStorage.saveDraft({
      id: initial.id,
      selectedTags: ['intimidation'],
      acceptedSuggestions: [],
      dismissedTagSuggestions: ['following'],
    });
    await draftStorage.saveDraft({
      id: initial.id,
      selectedTags: ['intimidation', 'blocking_path'],
      acceptedSuggestions: [],
      dismissedTagSuggestions: ['following'],
    });

    const saved = await draftStorage.getDraft(initial.id);

    expect(saved).toMatchObject({
      incidentDescription: initial.incidentDescription,
      selectedTags: ['intimidation', 'blocking_path'],
      acceptedSuggestions: [],
      dismissedTagSuggestions: ['following'],
    });
    expect(saved?.location?.description).toBe('Stage near the market');
  });

  it('serializes overlapping saves so no draft write is lost', async () => {
    const firstSave = draftStorage.saveDraft(buildDraft({
      id: 'draft-a',
      incidentDescription: 'First report',
    }));
    const secondSave = draftStorage.saveDraft(buildDraft({
      id: 'draft-b',
      incidentDescription: 'Second report',
    }));

    await Promise.all([firstSave, secondSave]);

    const savedIds = (await draftStorage.getAllDrafts()).map(draft => draft.id).sort();
    expect(savedIds).toEqual(['draft-a', 'draft-b']);
  });

  it('tracks the active local draft separately from navigation state', async () => {
    const first = buildDraft({
      id: 'draft-active-a',
      currentStep: 'WhatHappened',
      completedSteps: [],
    });
    const second = buildDraft({
      id: 'draft-active-b',
      currentStep: 'WhereWhen',
      completedSteps: ['WhatHappened'],
      updatedAt: new Date('2026-06-01T08:30:00.000Z'),
    });

    await draftStorage.saveDraft(first);
    await draftStorage.saveDraft(second);

    await expect(draftStorage.getActiveDraftId()).resolves.toBe(second.id);
    await draftStorage.setActiveDraftId(second.id);
    await expect(AsyncStorage.getItem(ACTIVE_DRAFT_ID_KEY)).resolves.toBeNull();
    const rawActiveDraftId = await localDraftDatabase.getKeyValue(ACTIVE_DRAFT_ID_KEY);
    expect(isEncryptedAsyncStorageEnvelope(rawActiveDraftId)).toBe(true);
    expect(rawActiveDraftId).not.toContain(second.id);
    await expect(decryptLocalDataString(ACTIVE_DRAFT_ID_KEY, rawActiveDraftId ?? ''))
      .resolves.toBe(second.id);
  });

  it('recovers the latest editable draft when the active pointer is stale', async () => {
    await draftStorage.saveDraft(buildDraft({
      id: 'draft-stale-active',
      currentStep: 'completed',
      status: 'closed',
      completedSteps: ['WhatHappened', 'WhereWhen', 'EvidenceDetail', 'ConsentGate'],
    }));
    const editable = buildDraft({
      id: 'draft-editable-active',
      currentStep: 'WhereWhen',
      completedSteps: ['WhatHappened'],
      updatedAt: new Date('2026-06-01T08:45:00.000Z'),
    });
    await draftStorage.saveDraft(editable);
    await draftStorage.setActiveDraftId('draft-stale-active');

    await expect(draftStorage.getActiveDraftId()).resolves.toBe(editable.id);
  });

  it('fails closed when encrypted active-pointer persistence fails without losing the draft', async () => {
    const draft = buildDraft({ id: 'pointer-failure-draft' });
    const setKeyValueSpy = vi.spyOn(localDraftDatabase, 'setKeyValue')
      .mockRejectedValueOnce(new Error('synthetic pointer write failure'));

    try {
      await expect(draftStorage.saveDraft(draft)).rejects.toThrow('synthetic pointer write failure');
    } finally {
      setKeyValueSpy.mockRestore();
    }

    const row = await localDraftDatabase.getDraftRow(draft.id);
    expect(isEncryptedAsyncStorageEnvelope(row?.encrypted_payload ?? null)).toBe(true);
    expect(row?.encrypted_payload).not.toContain(draft.incidentDescription);
    await expect(draftStorage.getDraft(draft.id)).resolves.toMatchObject({
      id: draft.id,
      incidentDescription: draft.incidentDescription,
    });
  });

  it('calculates draft progress with stable next-step routing', () => {
    const emptyDraft: DraftData = {
      id: 'empty-draft',
      createdAt: new Date('2026-06-01T08:00:00.000Z'),
      updatedAt: new Date('2026-06-01T08:00:00.000Z'),
      completedSteps: [],
    };

    expect(draftStorage.getDraftProgress(emptyDraft)).toEqual({
      completedSteps: 0,
      totalSteps: 4,
      percentage: 0,
      nextStep: 'WhatHappened',
    });

    expect(draftStorage.getDraftProgress({
      ...emptyDraft,
      completedSteps: ['WhatHappened', 'WhereWhen'],
    })).toEqual({
      completedSteps: 2,
      totalSteps: 4,
      percentage: 50,
      nextStep: 'EvidenceDetail',
    });

    expect(draftStorage.getDraftProgress(buildDraft({
      completedSteps: ['WhatHappened', 'WhereWhen', 'EvidenceDetail', 'ConsentGate'],
      selectedPathway: 'save-private',
      currentStep: 'completed',
    }))).toEqual({
      completedSteps: 4,
      totalSteps: 4,
      percentage: 100,
      nextStep: undefined,
    });
  });

  it('persists referral selection fields without dropping report data', async () => {
    const initial = buildDraft();

    await draftStorage.saveDraft(initial);
    await draftStorage.saveDraft({
      id: initial.id,
      selectedPathway: 'referral',
      selectedProvider: '1195',
      selectedChannel: 'call',
      includeBrief: true,
      fallbackNumber: '1195',
      referralSelection: {
        providerId: '1195',
        providerName: 'National GBV Toll-Free Helpline (HAK 1195)',
        providerType: 'Hotline',
        selectedChannel: 'call',
        includeBrief: true,
        phone: '1195',
        serviceScope: ['GBV support', 'Referral services'],
        availability: '24/7',
        catalogSource: 'cache',
        catalogLastUpdated: '2026-06-05T09:00:00.000Z',
        selectedAt: '2026-06-05T10:00:00.000Z',
      },
      currentStep: 'ConsentGate',
    });

    const saved = await draftStorage.getDraft(initial.id);

    expect(saved).toMatchObject({
      incidentDescription: initial.incidentDescription,
      selectedPathway: 'referral',
      selectedProvider: '1195',
      selectedChannel: 'call',
      includeBrief: true,
      fallbackNumber: '1195',
      referralSelection: {
        providerName: 'National GBV Toll-Free Helpline (HAK 1195)',
        selectedChannel: 'call',
        includeBrief: true,
        catalogSource: 'cache',
      },
    });
    expect(saved?.mediaFiles?.[0].fileName).toBe('photo.jpg');
  });

  it('persists escalation fields without dropping saved report draft data', async () => {
    const initial = buildDraft({
      textEvidence: 'Driver threatened me after I asked to exit.',
      witnessDetails: 'Passenger in the back row saw it.',
      completedSteps: ['WhatHappened', 'WhereWhen', 'EvidenceDetail'],
    });

    await draftStorage.saveDraft(initial);
    await draftStorage.saveDraft({
      id: initial.id,
      selectedPathway: 'escalate',
      escalationData: {
        redactionLevel: 'heavy',
        vehiclePlate: 'KDD 123A',
        saccoOperator: 'Super Metro',
        contactPreference: 'none',
      },
      completedSteps: ['WhatHappened', 'WhereWhen', 'EvidenceDetail', 'EscalationForm'],
      currentStep: 'ConsentGate',
    });

    const saved = await draftStorage.getDraft(initial.id);

    expect(saved).toMatchObject({
      id: initial.id,
      incidentDescription: initial.incidentDescription,
      textEvidence: 'Driver threatened me after I asked to exit.',
      witnessDetails: 'Passenger in the back row saw it.',
      selectedPathway: 'escalate',
      currentStep: 'ConsentGate',
      escalationData: {
        redactionLevel: 'heavy',
        vehiclePlate: 'KDD 123A',
        saccoOperator: 'Super Metro',
        contactPreference: 'none',
      },
    });
    expect(saved?.location?.description).toBe('Stage near the market');
    expect(saved?.mediaFiles?.[0].fileName).toBe('photo.jpg');
    expect(saved?.privacySettings).toEqual(initial.privacySettings);
  });

  it('protects persisted evidence from a stale full-draft snapshot save', async () => {
    const initial = buildDraft({
      textEvidence: 'Original evidence note.',
    });
    await draftStorage.saveDraft(initial);

    // Another screen adds evidence while a stale snapshot is still mounted.
    await draftStorage.saveDraft({
      id: initial.id,
      mediaFiles: [
        ...(initial.mediaFiles ?? []),
        {
          id: 'media-2',
          type: 'audio' as const,
          uri: 'file:///evidence/audio.m4a',
          fileName: 'audio.m4a',
          size: 1024,
          timestamp: new Date('2026-06-01T09:00:00.000Z'),
        },
      ],
    });

    // The stale screen now saves its full snapshot, which is missing the new
    // media file and carries empty defaults. Without explicitKeys the storage
    // layer must protect the persisted evidence.
    const staleSnapshot = buildDraft({
      mediaFiles: [],
      textEvidence: '',
      completedSteps: [],
    });
    await draftStorage.saveDraft(staleSnapshot, { explicitKeys: new Set() });

    const saved = await draftStorage.getDraft(initial.id);
    expect(saved?.mediaFiles?.map(media => media.id)).toEqual(['media-1', 'media-2']);
    expect(saved?.textEvidence).toBe('Original evidence note.');
    expect(saved?.completedSteps).toEqual(['WhatHappened']);
  });

  it('protects persisted text evidence from a stale media-only snapshot save', async () => {
    const initial = buildDraft({
      textEvidence: 'Original evidence note.',
    });
    await draftStorage.saveDraft(initial);

    await draftStorage.saveDraft(
      {
        ...initial,
        mediaFiles: [
          ...(initial.mediaFiles ?? []),
          {
            id: 'media-stale-photo',
            type: 'photo',
            uri: 'file:///evidence/stale-photo.jpg',
            fileName: 'stale-photo.jpg',
            size: 2048,
            timestamp: new Date('2026-06-01T09:15:00.000Z'),
          },
        ],
        textEvidence: '',
      },
      { explicitKeys: new Set<keyof DraftData>(['mediaFiles']) },
    );

    const saved = await draftStorage.getDraft(initial.id);
    expect(saved?.textEvidence).toBe('Original evidence note.');
    expect(saved?.mediaFiles?.map(media => media.id)).toEqual(['media-1', 'media-stale-photo']);
  });

  it('unions completed steps so wizard progress is never lost to a stale patch', async () => {
    await draftStorage.saveDraft(buildDraft({
      completedSteps: ['WhatHappened', 'WhereWhen'],
    }));

    await draftStorage.saveDraft({
      id: 'draft-1',
      completedSteps: ['WhatHappened', 'EvidenceDetail'],
      currentStep: 'EvidenceDetail',
    });

    const saved = await draftStorage.getDraft('draft-1');
    expect(saved?.completedSteps).toEqual(
      expect.arrayContaining(['WhatHappened', 'WhereWhen', 'EvidenceDetail']),
    );
    expect(saved?.completedSteps).toHaveLength(3);
  });

  it('notifies subscribers after saves, deletes, and clears commit', async () => {
    const events: Array<{ type: string; draftId?: string }> = [];
    const unsubscribe = draftStorage.subscribe(event => {
      events.push(event);
    });

    try {
      await draftStorage.saveDraft(buildDraft({ id: 'draft-events' }));
      await draftStorage.deleteDraft('draft-events');
      await draftStorage.setDrafts([buildDraft({ id: 'draft-replaced' })]);
      await draftStorage.clearAll();
    } finally {
      unsubscribe();
    }

    expect(events).toEqual([
      { type: 'save', draftId: 'draft-events' },
      { type: 'delete', draftId: 'draft-events' },
      { type: 'replace' },
      { type: 'clear' },
    ]);

    await draftStorage.saveDraft(buildDraft({ id: 'draft-after-unsubscribe' }));
    expect(events).toHaveLength(4);
  });

  it('merges concurrent patches to the same draft without losing either write', async () => {
    await draftStorage.saveDraft(buildDraft({ id: 'draft-concurrent' }));

    await Promise.all([
      draftStorage.saveDraft({ id: 'draft-concurrent', impactSummary: 'Summary A' }),
      draftStorage.saveDraft({ id: 'draft-concurrent', witnessDetails: 'Witness B' }),
    ]);

    const saved = await draftStorage.getDraft('draft-concurrent');
    expect(saved).toMatchObject({
      impactSummary: 'Summary A',
      witnessDetails: 'Witness B',
    });
  });

  it('fails closed on a corrupted draft row without deleting recoverable records', async () => {
    const healthy = buildDraft({ id: 'draft-healthy' });
    await draftStorage.saveDraft(healthy);

    await localDraftDatabase.upsertDraftRow({
      id: 'draft-corrupted',
      createdAt: '2026-06-01T08:00:00.000Z',
      updatedAt: '2026-06-01T08:00:00.000Z',
      encryptedPayload: '{"not":"a valid encrypted envelope"',
    });

    await expect(draftStorage.getAllDrafts()).rejects.toThrow('not an encrypted envelope');
    await expect(draftStorage.getDraft('draft-corrupted')).rejects.toThrow('not an encrypted envelope');
    await expect(localDraftDatabase.getDraftCount()).resolves.toBe(2);

    await localDraftDatabase.deleteDraftRow('draft-corrupted');
    await expect(draftStorage.getDraft(healthy.id)).resolves.toMatchObject({ id: healthy.id });
  });

  it('atomically upgrades plaintext SQLite rows in place and never writes AsyncStorage plaintext', async () => {
    const sqliteOnlyDraft = buildDraft({
      id: 'sqlite-only-draft',
      incidentDescription: 'Imported from previous SQLite APK.',
      updatedAt: new Date('2026-06-01T10:00:00.000Z'),
    });

    await localDraftDatabase.upsertDraftRow({
      id: sqliteOnlyDraft.id,
      createdAt: sqliteOnlyDraft.createdAt.toISOString(),
      updatedAt: sqliteOnlyDraft.updatedAt.toISOString(),
      status: sqliteOnlyDraft.status ?? null,
      currentStep: sqliteOnlyDraft.currentStep ?? null,
      encryptedPayload: JSON.stringify(sqliteOnlyDraft),
    });
    await localDraftDatabase.setKeyValue('incident_active_draft_id', sqliteOnlyDraft.id);

    await expect(draftStorage.getDraft(sqliteOnlyDraft.id)).resolves.toMatchObject({
      id: sqliteOnlyDraft.id,
      incidentDescription: sqliteOnlyDraft.incidentDescription,
    });

    await expect(AsyncStorage.getItem(DRAFT_STORAGE_KEY)).resolves.toBeNull();
    await expect(AsyncStorage.getItem(ACTIVE_DRAFT_ID_KEY)).resolves.toBeNull();
    await expect(localDraftDatabase.getDraftCount()).resolves.toBe(1);

    const migratedRow = await localDraftDatabase.getDraftRow(sqliteOnlyDraft.id);
    expect(isEncryptedAsyncStorageEnvelope(migratedRow?.encrypted_payload ?? null)).toBe(true);
    expect(migratedRow?.encrypted_payload).not.toContain(sqliteOnlyDraft.incidentDescription);
    const migratedActive = await localDraftDatabase.getKeyValue(ACTIVE_DRAFT_ID_KEY);
    expect(isEncryptedAsyncStorageEnvelope(migratedActive)).toBe(true);
    await expect(decryptLocalDataString(ACTIVE_DRAFT_ID_KEY, migratedActive ?? ''))
      .resolves.toBe(sqliteOnlyDraft.id);
    await expect(localDraftDatabase.getKeyValue(DRAFT_STORAGE_V2_MIGRATION_STATE_KEY))
      .resolves.toContain('"status":"committed"');
  });

  it('migrates a newer legacy AsyncStorage draft into encrypted SQLite and removes the source', async () => {
    const older = buildDraft({
      id: 'legacy-merge-draft',
      incidentDescription: 'Older database copy',
      updatedAt: new Date('2026-06-01T08:00:00.000Z'),
    });
    const newer = buildDraft({
      id: older.id,
      incidentDescription: 'Newer synthetic legacy copy',
      updatedAt: new Date('2026-06-01T11:00:00.000Z'),
    });
    await localDraftDatabase.upsertDraftRow({
      id: older.id,
      createdAt: older.createdAt.toISOString(),
      updatedAt: older.updatedAt.toISOString(),
      encryptedPayload: JSON.stringify(older),
    });
    await AsyncStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify([newer]));
    await AsyncStorage.setItem(ACTIVE_DRAFT_ID_KEY, newer.id);

    await expect(draftStorage.getDraft(newer.id)).resolves.toMatchObject({
      incidentDescription: newer.incidentDescription,
    });

    await expect(AsyncStorage.getItem(DRAFT_STORAGE_KEY)).resolves.toBeNull();
    await expect(AsyncStorage.getItem(ACTIVE_DRAFT_ID_KEY)).resolves.toBeNull();
    const row = await localDraftDatabase.getDraftRow(newer.id);
    expect(isEncryptedAsyncStorageEnvelope(row?.encrypted_payload ?? null)).toBe(true);
    expect(row?.encrypted_payload).not.toContain(newer.incidentDescription);
  });

  it('preserves plaintext migration sources when the destination commit fails', async () => {
    const legacy = buildDraft({
      id: 'legacy-commit-failure',
      incidentDescription: 'Synthetic recoverable migration source',
    });
    const rawLegacy = JSON.stringify([legacy]);
    await AsyncStorage.setItem(DRAFT_STORAGE_KEY, rawLegacy);
    const commitSpy = vi.spyOn(localDraftDatabase, 'commitLegacyDraftMigration')
      .mockRejectedValueOnce(new Error('synthetic transaction failure'));

    try {
      await expect(draftStorage.getAllDrafts()).rejects.toThrow('synthetic transaction failure');
    } finally {
      commitSpy.mockRestore();
    }

    await expect(AsyncStorage.getItem(DRAFT_STORAGE_KEY)).resolves.toBe(rawLegacy);
    await expect(localDraftDatabase.getDraftCount()).resolves.toBe(0);
    await expect(localDraftDatabase.getKeyValue(DRAFT_STORAGE_V2_MIGRATION_STATE_KEY))
      .resolves.toBeNull();
  });

  it('retries source cleanup after an encrypted migration commit', async () => {
    const legacy = buildDraft({ id: 'legacy-cleanup-retry' });
    const rawLegacy = JSON.stringify([legacy]);
    await AsyncStorage.setItem(DRAFT_STORAGE_KEY, rawLegacy);
    const multiRemoveSpy = vi.spyOn(AsyncStorage, 'multiRemove')
      .mockRejectedValueOnce(new Error('synthetic cleanup failure'));

    await expect(draftStorage.getAllDrafts()).rejects.toThrow('synthetic cleanup failure');
    multiRemoveSpy.mockRestore();

    await expect(AsyncStorage.getItem(DRAFT_STORAGE_KEY)).resolves.toBe(rawLegacy);
    const committedRow = await localDraftDatabase.getDraftRow(legacy.id);
    expect(isEncryptedAsyncStorageEnvelope(committedRow?.encrypted_payload ?? null)).toBe(true);
    await expect(localDraftDatabase.getKeyValue(DRAFT_STORAGE_V2_MIGRATION_STATE_KEY))
      .resolves.not.toBeNull();

    await expect(draftStorage.getDraft(legacy.id)).resolves.toMatchObject({ id: legacy.id });
    await expect(AsyncStorage.getItem(DRAFT_STORAGE_KEY)).resolves.toBeNull();
  });

  it('blocks on corrupted legacy SQLite state and keeps it available for recovery', async () => {
    await localDraftDatabase.upsertDraftRow({
      id: 'draft-corrupt-recovery',
      createdAt: '2026-06-01T08:00:00.000Z',
      updatedAt: '2026-06-01T08:00:00.000Z',
      encryptedPayload: '{"not":"recoverable yet"',
    });
    await localDraftDatabase.setKeyValue('incident_active_draft_id', JSON.stringify({
      __saferideEncrypted: true,
      version: 1,
      algorithm: 'AES-256-GCM',
      keyName: 'saferide_local_data_aes_key_v1',
      data: 'not-valid-sealed-data',
      createdAt: '2026-06-01T08:00:00.000Z',
    }));

    await expect(draftStorage.getAllDrafts()).rejects.toThrow();

    await expect(localDraftDatabase.getDraftCount()).resolves.toBe(1);
    await expect(localDraftDatabase.getKeyValue('incident_active_draft_id')).resolves.not.toBeNull();
  });

  it('uses the database row id when a payload id disagrees after corruption', async () => {
    await localDraftDatabase.upsertDraftRow({
      id: 'draft-row-id',
      createdAt: '2026-06-01T08:00:00.000Z',
      updatedAt: '2026-06-01T08:00:00.000Z',
      encryptedPayload: JSON.stringify({
        id: 'draft-imposter',
        createdAt: '2026-06-01T08:00:00.000Z',
        updatedAt: '2026-06-01T08:00:00.000Z',
      }),
    });

    const loaded = await draftStorage.getDraft('draft-row-id');
    expect(loaded?.id).toBe('draft-row-id');
  });

  it('blocks draft access when the native device-bound keystore is unavailable', async () => {
    vi.mocked(SecureStore.isAvailableAsync).mockResolvedValueOnce(false);

    await expect(draftStorage.getAllDrafts()).rejects.toThrow(
      'SecureStore is not available for encrypted local persistence',
    );
  });

  it('blocks survivor draft persistence on web instead of using a colocated fallback key', async () => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: {} });

    try {
      await expect(draftStorage.saveDraft(buildDraft({ id: 'web-blocked-draft' })))
        .rejects.toThrow('unavailable on web');
      await expect(AsyncStorage.getItem(DRAFT_STORAGE_KEY)).resolves.toBeNull();
    } finally {
      Reflect.deleteProperty(globalThis, 'window');
      Reflect.deleteProperty(globalThis, 'document');
    }
  });

  it('waits for pending local writes before reading drafts', async () => {
    const draft = buildDraft({ id: 'queued-draft' });
    let resolveWrite: (() => void) | undefined;
    let resolveStarted: (() => void) | undefined;
    const writeStarted = new Promise<void>(resolve => {
      resolveStarted = resolve;
    });

    const originalUpsert = localDraftDatabase.upsertDraftRow.bind(localDraftDatabase);
    const upsertSpy = vi.spyOn(localDraftDatabase, 'upsertDraftRow').mockImplementation(async row => {
      resolveStarted?.();
      await new Promise<void>(resolve => {
        resolveWrite = resolve;
      });
      await originalUpsert(row);
    });

    try {
      const savePromise = draftStorage.saveDraft(draft);
      await writeStarted;

      let readSettled = false;
      const readPromise = draftStorage.getDraft(draft.id).finally(() => {
        readSettled = true;
      });
      await Promise.resolve();

      expect(readSettled).toBe(false);

      resolveWrite?.();
      await savePromise;
      await expect(readPromise).resolves.toMatchObject({ id: draft.id });
    } finally {
      upsertSpy.mockRestore();
    }
  });

  it('uses encrypted native AsyncStorage when the SQLite draft database cannot open', async () => {
    vi.resetModules();

    const sqlite = await import('expo-sqlite');
    vi.mocked(sqlite.openDatabaseAsync).mockRejectedValueOnce(new Error('native sqlite unavailable'));

    const { draftStorage: isolatedDraftStorage } = await import('../draftStorage');
    const isolatedAsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    const draft = buildDraft({ id: 'sqlite-fallback-draft' });

    await expect(isolatedDraftStorage.saveDraft(draft)).resolves.toMatchObject({ id: draft.id });
    await expect(isolatedDraftStorage.getDraft(draft.id)).resolves.toMatchObject({
      id: draft.id,
      incidentDescription: draft.incidentDescription,
    });
    const rawFallback = await isolatedAsyncStorage.getItem(DRAFT_STORAGE_KEY);
    expect(isEncryptedAsyncStorageEnvelope(rawFallback)).toBe(true);
    expect(rawFallback).not.toContain(draft.incidentDescription);
    await expect(decryptLocalDataString(DRAFT_STORAGE_KEY, rawFallback ?? ''))
      .resolves.toContain(draft.incidentDescription);
  });

  it('does not read a plaintext fallback value unless its encrypted replacement commits', async () => {
    vi.resetModules();
    const sqlite = await import('expo-sqlite');
    vi.mocked(sqlite.openDatabaseAsync).mockRejectedValueOnce(new Error('native sqlite unavailable'));
    const isolatedAsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    const legacy = buildDraft({ id: 'fallback-migration-failure' });
    const rawLegacy = JSON.stringify([legacy]);
    await isolatedAsyncStorage.setItem(DRAFT_STORAGE_KEY, rawLegacy);
    const setItemSpy = vi.spyOn(isolatedAsyncStorage, 'setItem')
      .mockRejectedValueOnce(new Error('synthetic encrypted fallback write failure'));
    const { draftStorage: isolatedDraftStorage } = await import('../draftStorage');

    try {
      await expect(isolatedDraftStorage.getAllDrafts())
        .rejects.toThrow('synthetic encrypted fallback write failure');
    } finally {
      setItemSpy.mockRestore();
    }
    await expect(isolatedAsyncStorage.getItem(DRAFT_STORAGE_KEY)).resolves.toBe(rawLegacy);
  });

});
