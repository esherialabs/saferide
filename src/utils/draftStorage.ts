import type { EvidencePrivacyStatusMap } from './evidencePrivacyStatus';
import type { AnonymousAggregateConsentCheckpoint } from './consentLedger';
import type { PartnerSharingDraft } from './partnerSharing';
import AsyncStorage from '@react-native-async-storage/async-storage';

import type { EvidenceVaultCaptureSource } from './evidenceVaultStatus';
import {
  normalizeEvidencePrivacySettings,
  normalizeMediaPrivacyStatuses,
} from './evidencePrivacyStatus';
import { getDraftUpdateKeys, mergeDraftForLocalPersistence } from './draftMerge';
import {
  localDraftDatabase,
  type LocalDraftRow,
  type LocalDraftRowInput,
} from './localDraftDatabase';
import { devPrivacyError, devPrivacyWarn, getPrivacySafeErrorReason } from './privacyLog';
import {
  ACTIVE_DRAFT_ID_KEY,
  DRAFT_ROW_ENCRYPTION_KEY_PREFIX,
  DRAFT_STORAGE_KEY,
  DRAFT_STORAGE_V2_MIGRATION_STATE_KEY,
} from './storageKeys';
import {
  assertDeviceBoundLocalEncryptionAvailable,
  decryptLocalDataString,
  encryptLocalDataString,
  isEncryptedAsyncStorageEnvelope,
} from '../lib/encryptedAsyncStorage';
import { getReportWizardProgress } from '../navigation/reportPathwayFlow';

export type ReferralCatalogSource = 'remote' | 'cache' | 'rollback' | 'seed';
export type ReferralContactChannel = 'call' | 'whatsapp' | 'sms';

export interface ReferralSelectionData {
  providerId: string;
  providerName: string;
  providerType: 'Hotline' | 'GBV center' | 'Legal aid';
  selectedChannel?: ReferralContactChannel;
  contactStatus?: 'verified' | 'pending' | 'expired' | 'revoked';
  includeBrief: boolean;
  phone?: string;
  address?: string;
  serviceScope: string[];
  coverage?: string;
  availability?: string;
  safetyPhrase?: string;
  reviewStatus?: string;
  catalogSource?: ReferralCatalogSource;
  catalogLastUpdated?: string | null;
  catalogPackVersion?: string;
  listingExpiresAt?: string;
  selectedAt: string;
}

export interface DraftData {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  status?: 'draft' | 'queued' | 'submitted' | 'archived' | 'closed';
  // WhatHappened
  patterns?: string[];
  incidentDescription?: string;
  impactLevel?: 'low' | 'medium' | 'high';
  impactSummary?: string;
  witnesses?: boolean;
  witnessDetails?: string;
  immediateHelp?: boolean;
  
  followUpAnswers?: Record<string, string>;
  
  location?: {
    coordinates?: {
      latitude: number;
      longitude: number;
    };
    address?: string;
    description?: string;
    type?: string;
  };
  datetime?: {
    date: string;
    time: string;
    accuracy: 'exact' | 'approximate' | 'estimated';
  };
  duration?: string;
  isOngoing?: boolean;
  
  mediaFiles?: Array<{
    id: string;
    type: 'photo' | 'audio' | 'video' | 'document';
    uri: string;
    fileName: string;
    size: number;
    timestamp: Date;
    description?: string;
    captureSource?: EvidenceVaultCaptureSource | string;
    isFromStealth?: boolean;
    annotations?: any[];
    storagePath?: string;
    mimeType?: string;
    uploadedAt?: Date;
    checksum?: string;
    transcript?: string;
    privacyStatus?: EvidencePrivacyStatusMap;
    uploadStatus?: 'pending' | 'uploaded' | 'failed';
    uploadError?: string;
    attachmentId?: string;
  }>;
  textEvidence?: string;
  privacySettings?: {
    blurFaces: boolean;
    removeMetadata: boolean;
    encryptFiles: boolean;
  };
  
  acceptedSuggestions?: string[];
  selectedTags?: string[];
  customTags?: string[];
  dismissedTagSuggestions?: string[];
  selectedPathway?: string;
  caseId?: string;
  caseSubmissionError?: string;
  pathwayConsent?: {
    recordId: string;
    purpose: 'pathway_submission';
    version: 'pathway-consent.v1';
    pathway: 'save-private' | 'anonymous-map' | 'referral' | 'escalate';
    grantedAt: string;
  };
  anonymousAggregateConsent?: AnonymousAggregateConsentCheckpoint;
  /** Optional, per-report choice to also share with SafeRide's partner HURIA (off unless chosen). */
  partnerSharing?: PartnerSharingDraft;
  selectedProvider?: string;
  selectedChannel?: ReferralContactChannel;
  fallbackNumber?: string;
  includeBrief?: boolean;
  referralSelection?: ReferralSelectionData;
  escalationData?: {
    redactionLevel?: 'none' | 'light' | 'heavy';
    vehiclePlate?: string;
    saccoOperator?: string;
    contactPreference?: 'alias' | 'none';
    alias?: string;
  };
  
  currentStep?: string;
  completedSteps?: string[];
  
  autoSaveEnabled?: boolean;
  lastAutoSave?: Date;
}

const NON_EDITABLE_DRAFT_STATUSES = new Set<NonNullable<DraftData['status']>>([
  'archived',
  'closed',
  'queued',
  'submitted',
]);
const FINAL_CURRENT_STEPS = new Set(['completed', 'queued', 'submitted']);
const DRAFT_STORAGE_MIGRATION_STATE = JSON.stringify({
  version: 2,
  status: 'committed',
});

type DraftStorageBackend = 'sqlite' | 'encrypted-async-storage';

function isEditableDraft(draft: DraftData): boolean {
  if (draft.status && NON_EDITABLE_DRAFT_STATUSES.has(draft.status)) {
    return false;
  }

  if (draft.currentStep && FINAL_CURRENT_STEPS.has(draft.currentStep)) {
    return false;
  }

  return true;
}

function compareDraftsByUpdatedAtDesc(a: DraftData, b: DraftData): number {
  return b.updatedAt.getTime() - a.updatedAt.getTime();
}

function draftRowEncryptionKey(draftId: string): string {
  return `${DRAFT_ROW_ENCRYPTION_KEY_PREFIX}:${draftId}`;
}

function hydrateDraft(rawDraft: any): DraftData {
  if (!rawDraft || typeof rawDraft !== 'object' || typeof rawDraft.id !== 'string' || !rawDraft.id) {
    throw new Error('Stored draft has an invalid identity.');
  }

  const createdAt = new Date(rawDraft.createdAt);
  const updatedAt = new Date(rawDraft.updatedAt);
  if (Number.isNaN(createdAt.getTime()) || Number.isNaN(updatedAt.getTime())) {
    throw new Error('Stored draft has an invalid timestamp.');
  }

  const privacySettings = rawDraft.privacySettings
    ? normalizeEvidencePrivacySettings(rawDraft.privacySettings)
    : undefined;
  const mediaFiles = Array.isArray(rawDraft.mediaFiles)
    ? normalizeMediaPrivacyStatuses(
        rawDraft.mediaFiles.map((m: any) => ({
          ...m,
          timestamp: new Date(m.timestamp),
          uploadedAt: m.uploadedAt ? new Date(m.uploadedAt) : undefined,
        })),
        privacySettings,
      )
    : undefined;

  return {
    ...rawDraft,
    createdAt,
    updatedAt,
    lastAutoSave: rawDraft.lastAutoSave ? new Date(rawDraft.lastAutoSave) : undefined,
    privacySettings,
    mediaFiles,
  };
}

async function draftFromDatabaseRow(
  row: LocalDraftRow,
  allowLegacyPlaintext = false,
): Promise<DraftData> {
  if (!allowLegacyPlaintext && !isEncryptedAsyncStorageEnvelope(row.encrypted_payload)) {
    throw new Error('Draft database row is not an encrypted envelope.');
  }

  const decrypted = await decryptLocalDataString(
    draftRowEncryptionKey(row.id),
    row.encrypted_payload,
  );
  // The primary-key column is authoritative: a corrupted or mismatched payload
  // id must never let one draft masquerade as another.
  return hydrateDraft({ ...JSON.parse(decrypted), id: row.id });
}

async function draftToDatabaseRow(draft: DraftData): Promise<LocalDraftRowInput> {
  return {
    id: draft.id,
    createdAt: draft.createdAt.toISOString(),
    updatedAt: draft.updatedAt.toISOString(),
    status: draft.status ?? null,
    currentStep: draft.currentStep ?? null,
    encryptedPayload: await encryptLocalDataString(
      draftRowEncryptionKey(draft.id),
      JSON.stringify(draft),
    ),
  };
}

function parseDraftArray(raw: string, source: string): DraftData[] {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${source} is not a draft array.`);
  }

  return parsed.map(hydrateDraft);
}

async function getEncryptedFallbackItem(key: string): Promise<string | null> {
  const raw = await AsyncStorage.getItem(key);
  if (!raw) return null;

  if (isEncryptedAsyncStorageEnvelope(raw)) {
    return decryptLocalDataString(key, raw);
  }

  // AsyncStorage setItem is an atomic key replacement. Do not return the
  // legacy plaintext until the encrypted replacement is confirmed at rest.
  const encrypted = await encryptLocalDataString(key, raw);
  await AsyncStorage.setItem(key, encrypted);
  const confirmed = await AsyncStorage.getItem(key);
  if (!isEncryptedAsyncStorageEnvelope(confirmed)) {
    throw new Error('Encrypted draft fallback migration could not be verified.');
  }

  return raw;
}

async function setEncryptedFallbackItem(key: string, value: string): Promise<void> {
  const encrypted = await encryptLocalDataString(key, value);
  await AsyncStorage.setItem(key, encrypted);
}

async function removeFallbackItem(key: string): Promise<void> {
  await AsyncStorage.removeItem(key);
}

export type DraftStorageChangeEvent =
  | { type: 'save'; draftId: string }
  | { type: 'delete'; draftId: string }
  | { type: 'replace' }
  | { type: 'clear' };

export type DraftStorageChangeListener = (event: DraftStorageChangeEvent) => void;

export interface SaveDraftOptions {
  /**
   * Fields the caller deliberately set (even to an empty value). Fields NOT
   * listed here keep their persisted value when the incoming value is empty,
   * which protects report data from stale screen snapshots. When omitted, the
   * keys present in the patch are treated as explicit.
   */
  explicitKeys?: Set<keyof DraftData>;
}

class DraftStorageManager {
  private autoSaveTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private writeQueue: Promise<void> = Promise.resolve();
  private activeDraftIdCache: string | null = null;
  private backendPromise: Promise<DraftStorageBackend> | null = null;
  private migrationPromise: Promise<void> | null = null;
  private changeListeners: Set<DraftStorageChangeListener> = new Set();

  generateDraftId(): string {
    return `draft_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Notifies whenever a draft write commits, so screens can refresh instead of
   * holding stale snapshots. Listeners fire after the write queue entry has
   * fully persisted.
   */
  subscribe(listener: DraftStorageChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  private emitChange(event: DraftStorageChangeEvent): void {
    this.changeListeners.forEach(listener => {
      try {
        listener(event);
      } catch (error) {
        devPrivacyWarn('draft storage change listener failed', {
          reason: getPrivacySafeErrorReason(error),
        });
      }
    });
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async waitForPendingWrites(): Promise<void> {
    await this.writeQueue;
  }

  private async resolveBackend(): Promise<DraftStorageBackend> {
    await assertDeviceBoundLocalEncryptionAvailable();

    try {
      if (await localDraftDatabase.isAvailable()) {
        return 'sqlite';
      }
    } catch (error) {
      devPrivacyWarn('native draft database unavailable; using encrypted fallback', {
        reason: getPrivacySafeErrorReason(error),
      });
    }

    // A native AsyncStorage fallback remains encrypted with the same
    // SecureStore-held device key. The backend choice is sticky for this app
    // process so an intermittent database error cannot split a write.
    return 'encrypted-async-storage';
  }

  private getBackend(): Promise<DraftStorageBackend> {
    if (!this.backendPromise) {
      this.backendPromise = this.resolveBackend();
    }

    return this.backendPromise;
  }

  private ensureSqliteMigrated(): Promise<void> {
    if (!this.migrationPromise) {
      const attempt = this.migrateLegacyDraftStorage();
      this.migrationPromise = attempt.catch(error => {
        // A transient transaction or source-cleanup failure remains
        // recoverable and must be retryable without restarting the app.
        this.migrationPromise = null;
        throw error;
      });
    }

    return this.migrationPromise;
  }

  private async validateEncryptedDatabase(): Promise<void> {
    const rows = await localDraftDatabase.getAllDraftRows();
    for (const row of rows) {
      await draftFromDatabaseRow(row);
    }

    const activeRaw = await localDraftDatabase.getKeyValue(ACTIVE_DRAFT_ID_KEY);
    if (activeRaw) {
      if (!isEncryptedAsyncStorageEnvelope(activeRaw)) {
        throw new Error('Active draft pointer is not an encrypted envelope.');
      }

      await decryptLocalDataString(ACTIVE_DRAFT_ID_KEY, activeRaw);
    }
  }

  private async migrateLegacyDraftStorage(): Promise<void> {
    const migrationState = await localDraftDatabase.getKeyValue(
      DRAFT_STORAGE_V2_MIGRATION_STATE_KEY,
    );
    if (migrationState !== null && migrationState !== DRAFT_STORAGE_MIGRATION_STATE) {
      throw new Error('Draft migration state is invalid.');
    }

    const [legacyDraftsRaw, legacyActiveRaw] = await Promise.all([
      AsyncStorage.getItem(DRAFT_STORAGE_KEY),
      AsyncStorage.getItem(ACTIVE_DRAFT_ID_KEY),
    ]);

    if (
      migrationState === DRAFT_STORAGE_MIGRATION_STATE &&
      legacyDraftsRaw === null &&
      legacyActiveRaw === null
    ) {
      await this.validateEncryptedDatabase();
      return;
    }

    const sqliteRows = await localDraftDatabase.getAllDraftRows();
    const mergedById = new Map<string, DraftData>();
    for (const row of sqliteRows) {
      const draft = await draftFromDatabaseRow(row, true);
      mergedById.set(draft.id, draft);
    }

    if (legacyDraftsRaw !== null) {
      const decrypted = await decryptLocalDataString(DRAFT_STORAGE_KEY, legacyDraftsRaw);
      const legacyDrafts = parseDraftArray(decrypted, 'Legacy draft storage');
      for (const draft of legacyDrafts) {
        const existing = mergedById.get(draft.id);
        if (!existing || draft.updatedAt.getTime() > existing.updatedAt.getTime()) {
          mergedById.set(draft.id, draft);
        }
      }
    }

    const sqliteActiveRaw = await localDraftDatabase.getKeyValue(ACTIVE_DRAFT_ID_KEY);
    const sqliteActiveDraftId = sqliteActiveRaw
      ? await decryptLocalDataString(ACTIVE_DRAFT_ID_KEY, sqliteActiveRaw)
      : null;
    const legacyActiveDraftId = legacyActiveRaw
      ? await decryptLocalDataString(ACTIVE_DRAFT_ID_KEY, legacyActiveRaw)
      : null;
    const activeDraftId = (
      sqliteActiveDraftId && mergedById.has(sqliteActiveDraftId)
        ? sqliteActiveDraftId
        : legacyActiveDraftId && mergedById.has(legacyActiveDraftId)
          ? legacyActiveDraftId
          : null
    );

    const drafts = Array.from(mergedById.values()).sort(compareDraftsByUpdatedAtDesc);
    const encryptedRows: LocalDraftRowInput[] = [];
    for (const draft of drafts) {
      encryptedRows.push(await draftToDatabaseRow(draft));
    }
    const activeDraftEncryptedValue = activeDraftId
      ? await encryptLocalDataString(ACTIVE_DRAFT_ID_KEY, activeDraftId)
      : null;

    await localDraftDatabase.commitLegacyDraftMigration({
      rows: encryptedRows,
      activeDraftEncryptedValue,
      migrationStateKey: DRAFT_STORAGE_V2_MIGRATION_STATE_KEY,
      migrationStateValue: DRAFT_STORAGE_MIGRATION_STATE,
    });

    // Source cleanup is intentionally after the transaction. A cleanup error
    // blocks use and is retried on the next initialization; the encrypted
    // destination and recoverable source remain available.
    await AsyncStorage.multiRemove([DRAFT_STORAGE_KEY, ACTIVE_DRAFT_ID_KEY]);
    this.activeDraftIdCache = activeDraftId;
  }

  private async ensureReady(): Promise<DraftStorageBackend> {
    await assertDeviceBoundLocalEncryptionAvailable();
    const backend = await this.getBackend();
    if (backend === 'sqlite') {
      await this.ensureSqliteMigrated();
    }

    return backend;
  }

  private async readAllDraftsFromBackend(backend: DraftStorageBackend): Promise<DraftData[]> {
    if (backend === 'sqlite') {
      const rows = await localDraftDatabase.getAllDraftRows();
      const drafts: DraftData[] = [];
      for (const row of rows) {
        drafts.push(await draftFromDatabaseRow(row));
      }
      return drafts.sort(compareDraftsByUpdatedAtDesc);
    }

    const draftsJson = await getEncryptedFallbackItem(DRAFT_STORAGE_KEY);
    return draftsJson ? parseDraftArray(draftsJson, 'Encrypted draft fallback') : [];
  }

  private async replaceDraftsInBackend(
    backend: DraftStorageBackend,
    drafts: DraftData[],
  ): Promise<void> {
    if (backend === 'sqlite') {
      const rows: LocalDraftRowInput[] = [];
      for (const draft of drafts) {
        rows.push(await draftToDatabaseRow(draft));
      }
      await localDraftDatabase.replaceDraftRows(rows);
      return;
    }

    await setEncryptedFallbackItem(DRAFT_STORAGE_KEY, JSON.stringify(drafts));
  }

  private async upsertDraftInBackend(
    backend: DraftStorageBackend,
    draft: DraftData,
    allDrafts: DraftData[],
  ): Promise<void> {
    if (backend === 'sqlite') {
      await localDraftDatabase.upsertDraftRow(await draftToDatabaseRow(draft));
      return;
    }

    await setEncryptedFallbackItem(DRAFT_STORAGE_KEY, JSON.stringify(allDrafts));
  }

  private async readActiveDraftId(backend: DraftStorageBackend): Promise<string | null> {
    if (backend === 'sqlite') {
      const raw = await localDraftDatabase.getKeyValue(ACTIVE_DRAFT_ID_KEY);
      if (!raw) return null;
      if (!isEncryptedAsyncStorageEnvelope(raw)) {
        throw new Error('Active draft pointer is not encrypted.');
      }
      return decryptLocalDataString(ACTIVE_DRAFT_ID_KEY, raw);
    }

    return getEncryptedFallbackItem(ACTIVE_DRAFT_ID_KEY);
  }

  private async persistActiveDraftId(
    backend: DraftStorageBackend,
    draftId: string | null,
  ): Promise<void> {
    if (backend === 'sqlite') {
      if (draftId) {
        await localDraftDatabase.setKeyValue(
          ACTIVE_DRAFT_ID_KEY,
          await encryptLocalDataString(ACTIVE_DRAFT_ID_KEY, draftId),
        );
      } else {
        await localDraftDatabase.removeKeyValue(ACTIVE_DRAFT_ID_KEY);
      }
    } else if (draftId) {
      await setEncryptedFallbackItem(ACTIVE_DRAFT_ID_KEY, draftId);
    } else {
      await removeFallbackItem(ACTIVE_DRAFT_ID_KEY);
    }

    this.activeDraftIdCache = draftId;
  }

  private async readAllDrafts(): Promise<DraftData[]> {
    const backend = await this.ensureReady();
    return this.readAllDraftsFromBackend(backend);
  }

  async getAllDrafts(): Promise<DraftData[]> {
    await this.waitForPendingWrites();
    return this.readAllDrafts();
  }
  
  async getDraft(draftId: string): Promise<DraftData | null> {
    try {
      await this.waitForPendingWrites();
      const drafts = await this.readAllDrafts();
      return drafts.find(draft => draft.id === draftId) || null;
    } catch (error) {
      devPrivacyError('draft storage load-one failed', { reason: getPrivacySafeErrorReason(error) });
      throw error;
    }
  }

  async getActiveDraftId(): Promise<string | null> {
    await this.waitForPendingWrites();
    const backend = await this.ensureReady();

    try {
      const drafts = await this.readAllDraftsFromBackend(backend);
      const latestEditableDraft = drafts
        .filter(isEditableDraft)
        .sort(compareDraftsByUpdatedAtDesc)[0];

      if (!latestEditableDraft) {
        await this.persistActiveDraftId(backend, null);
        return null;
      }

      if (this.activeDraftIdCache === latestEditableDraft.id) {
        return latestEditableDraft.id;
      }

      const storedDraftId = await this.readActiveDraftId(backend);
      if (storedDraftId) {
        const draft = drafts.find(item => item.id === storedDraftId);
        if (
          draft &&
          isEditableDraft(draft) &&
          draft.updatedAt.getTime() >= latestEditableDraft.updatedAt.getTime()
        ) {
          this.activeDraftIdCache = storedDraftId;
          return storedDraftId;
        }
      }

      const latestDraftId = latestEditableDraft.id;
      await this.persistActiveDraftId(backend, latestDraftId);
      return latestDraftId;
    } catch (error) {
      devPrivacyError('draft storage active-id load failed', { reason: getPrivacySafeErrorReason(error) });
      throw error;
    }
  }

  getCachedActiveDraftId(): string | null {
    return this.activeDraftIdCache;
  }

  async setActiveDraftId(draftId: string | null): Promise<void> {
    await this.enqueueWrite(async () => {
      const backend = await this.ensureReady();
      await this.persistActiveDraftId(backend, draftId);
    });
  }
  
  async saveDraft(
    draftData: Partial<DraftData> & { id: string },
    options: SaveDraftOptions = {},
  ): Promise<DraftData> {
    const explicitKeys = options.explicitKeys ?? getDraftUpdateKeys(draftData);

    const savedDraft = await this.enqueueWrite(async () => {
      try {
        const backend = await this.ensureReady();
        const drafts = await this.readAllDraftsFromBackend(backend);
        const existingIndex = drafts.findIndex(draft => draft.id === draftData.id);

        const now = new Date();
        const existingDraft = existingIndex >= 0 ? drafts[existingIndex] : undefined;
        const incomingDraft: DraftData = {
          ...existingDraft,
          ...draftData,
          id: draftData.id,
          createdAt: existingDraft?.createdAt ?? draftData.createdAt ?? now,
          updatedAt: now,
          status: draftData.status ?? existingDraft?.status ?? 'draft',
          autoSaveEnabled: draftData.autoSaveEnabled ?? existingDraft?.autoSaveEnabled ?? true,
        };

        // The read-merge-write happens inside the write queue, so a stale
        // caller snapshot cannot overwrite fields another screen persisted
        // between this caller's read and this write.
        const updatedDraft = mergeDraftForLocalPersistence(existingDraft, incomingDraft, explicitKeys);
        // Blur/autosave snapshots cannot add or remove attachments. Membership
        // changes must come from an explicit edit or the existing-draft queue.
        if (existingDraft && !explicitKeys.has('mediaFiles')) {
          updatedDraft.mediaFiles = existingDraft.mediaFiles;
        }

        const rescuedFields = (['patterns', 'location', 'datetime', 'mediaFiles', 'textEvidence'] as const)
          .filter(key => updatedDraft[key] !== incomingDraft[key]);
        if (rescuedFields.length > 0) {
          devPrivacyWarn('draft save kept persisted fields over a stale snapshot', {
            fields: rescuedFields.join(','),
          });
        }

        if (updatedDraft.privacySettings) {
          updatedDraft.privacySettings = normalizeEvidencePrivacySettings(updatedDraft.privacySettings);
        }

        if (updatedDraft.mediaFiles) {
          updatedDraft.mediaFiles = normalizeMediaPrivacyStatuses(
            updatedDraft.mediaFiles,
            updatedDraft.privacySettings,
          );
        }

        if (existingIndex >= 0) {
          drafts[existingIndex] = updatedDraft;
        } else {
          drafts.push(updatedDraft);
        }

        await this.upsertDraftInBackend(backend, updatedDraft, drafts);
        if (isEditableDraft(updatedDraft)) {
          await this.persistActiveDraftId(backend, updatedDraft.id);
        } else if (this.activeDraftIdCache === updatedDraft.id) {
          await this.persistActiveDraftId(backend, null);
        }

        return updatedDraft;
      } catch (error) {
        devPrivacyError('draft storage save failed', { reason: getPrivacySafeErrorReason(error) });
        throw error;
      }
    });

    this.emitChange({ type: 'save', draftId: savedDraft.id });
    return savedDraft;
  }

  async deleteDraft(draftId: string): Promise<void> {
    await this.enqueueWrite(async () => {
      try {
        const backend = await this.ensureReady();
        const drafts = await this.readAllDraftsFromBackend(backend);
        const filteredDrafts = drafts.filter(draft => draft.id !== draftId);
        const removedDraft = drafts.find(draft => draft.id === draftId);
        const managedUris = [...new Set((removedDraft?.mediaFiles ?? []).map(media => media.uri))]
          .filter(uri => /\/saferide-evidence\/evidence-[a-f0-9-]+\.[a-z0-9]+$/i.test(uri))
          .filter(uri => !filteredDrafts.some(draft => draft.mediaFiles?.some(media => media.uri === uri)));
        if (managedUris.length) {
          const files = await import('expo-file-system/legacy');
          const directory = files.documentDirectory ? `${files.documentDirectory}saferide-evidence/` : null;
          for (const uri of managedUris) {
            // Exact app-generated filenames only; never follow nested paths or
            // remove imported/cache files. Retain the row on failure for retry.
            if (directory && uri.startsWith(directory) && !uri.slice(directory.length).includes('/')) {
              await files.deleteAsync(uri, { idempotent: true });
            }
          }
        }
        if (backend === 'sqlite') {
          await localDraftDatabase.deleteDraftRow(draftId);
        } else {
          await setEncryptedFallbackItem(DRAFT_STORAGE_KEY, JSON.stringify(filteredDrafts));
        }

        this.stopAutoSave(draftId);
        const storedActiveDraftId = await this.readActiveDraftId(backend);
        if (this.activeDraftIdCache === draftId || storedActiveDraftId === draftId) {
          await this.persistActiveDraftId(backend, null);
        }
      } catch (error) {
        devPrivacyError('draft storage delete failed', { reason: getPrivacySafeErrorReason(error) });
        throw error;
      }
    });

    this.emitChange({ type: 'delete', draftId });
  }

  /** Mutate an existing draft atomically; delayed work must never recreate it after deletion. */
  async updateExistingDraft(
    draftId: string,
    update: (current: DraftData) => Partial<DraftData> | null,
  ): Promise<DraftData | null> {
    const saved = await this.enqueueWrite(async () => {
      const backend = await this.ensureReady();
      const drafts = await this.readAllDraftsFromBackend(backend);
      const index = drafts.findIndex(draft => draft.id === draftId);
      if (index < 0) return null;
      const current = drafts[index];
      const patch = update(current);
      if (!patch) return null;
      const incoming = { ...current, ...patch, id: draftId, createdAt: current.createdAt, updatedAt: new Date() };
      const next = mergeDraftForLocalPersistence(current, incoming, getDraftUpdateKeys(patch));
      if (next.privacySettings) next.privacySettings = normalizeEvidencePrivacySettings(next.privacySettings);
      if (next.mediaFiles) next.mediaFiles = normalizeMediaPrivacyStatuses(next.mediaFiles, next.privacySettings);
      drafts[index] = next;
      await this.upsertDraftInBackend(backend, next, drafts);
      if (isEditableDraft(next)) await this.persistActiveDraftId(backend, next.id);
      return next;
    });
    if (saved) this.emitChange({ type: 'save', draftId: saved.id });
    return saved;
  }

  async setDrafts(drafts: DraftData[]): Promise<void> {
    await this.enqueueWrite(async () => {
      try {
        const backend = await this.ensureReady();
        await this.replaceDraftsInBackend(backend, drafts);
      } catch (error) {
        devPrivacyError('draft storage replace-all failed', { reason: getPrivacySafeErrorReason(error) });
        throw error;
      }
    });

    this.emitChange({ type: 'replace' });
  }
  
  startAutoSave(draftId: string, getDraftData: () => Partial<DraftData>): void {
    this.stopAutoSave(draftId);
    
    const timer = setInterval(async () => {
      try {
        const draftData = getDraftData();
        await this.saveDraft({ id: draftId, ...draftData, lastAutoSave: new Date() });
      } catch (error) {
        devPrivacyError('draft autosave failed', { reason: getPrivacySafeErrorReason(error) });
      }
    }, 30000);
    
    this.autoSaveTimers.set(draftId, timer);
  }
  
  stopAutoSave(draftId: string): void {
    const timer = this.autoSaveTimers.get(draftId);
    if (timer) {
      clearInterval(timer);
      this.autoSaveTimers.delete(draftId);
    }
  }

  async clearAll(options: { purgeSqliteRemnants?: boolean } = {}): Promise<void> {
    await this.enqueueWrite(async () => {
      try {
        this.autoSaveTimers.forEach((timer) => clearInterval(timer));
        this.autoSaveTimers.clear();
        this.activeDraftIdCache = null;
        this.migrationPromise = null;
        const failures: unknown[] = [];
        try {
          if (options.purgeSqliteRemnants) {
            await localDraftDatabase.purgeAllDraftData();
          } else {
            await localDraftDatabase.clearAllDraftData();
          }
        } catch (error) {
          failures.push(error);
        }
        try {
          await AsyncStorage.multiRemove([DRAFT_STORAGE_KEY, ACTIVE_DRAFT_ID_KEY]);
        } catch (error) {
          failures.push(error);
        }

        if (failures.length > 0) {
          const firstFailure = failures[0];
          throw firstFailure instanceof Error
            ? firstFailure
            : new Error('One or more draft stores could not be cleared.');
        }
      } catch (error) {
        devPrivacyError('draft storage clear failed', { reason: getPrivacySafeErrorReason(error) });
        throw error;
      }
    });

    this.emitChange({ type: 'clear' });
  }
  
  getDraftProgress(draft: DraftData): {
    completedSteps: number;
    totalSteps: number;
    percentage: number;
    nextStep?: string;
  } {
    const progress = getReportWizardProgress(draft);

    return {
      completedSteps: progress.completedSteps,
      totalSteps: progress.totalSteps,
      percentage: progress.percentage,
      nextStep: progress.nextStep?.route === 'DraftOverview' ? undefined : progress.nextStep?.route,
    };
  }
}

export const draftStorage = new DraftStorageManager();
