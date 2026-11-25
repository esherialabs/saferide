import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';
import * as SecureStore from 'expo-secure-store';
import { Platform, Share } from 'react-native';

import { setAuthToken } from '../lib/api/httpClient';
import { authClient } from '../lib/auth/authClient';
import {
  DEVICE_BOUND_LOCAL_ENCRYPTION_KEY_NAME,
  WEB_FALLBACK_LOCAL_ENCRYPTION_KEY_NAME,
  destroyDeviceBoundLocalEncryptionKey,
  encryptedAsyncStorage,
  isEncryptedActivePersistenceKey,
} from '../lib/encryptedAsyncStorage';
import {
  MODEL_DOWNLOAD_STATE_KEY_PREFIX,
  MODEL_VERIFICATION_STATE_KEY_PREFIX,
} from '../lib/localAssistant/modelStorage';
import { draftStorage } from './draftStorage';
import { runAppReset } from './appReset';
import { offlineSyncManager } from './offlineSync';
import { devPrivacyError, devPrivacyWarn, getPrivacySafeErrorReason } from './privacyLog';
import {
  DECOY_PIN_ATTEMPTS_STORE_KEY,
  DECOY_PIN_STORE_KEY,
  PRIVACY_CONSENT_LEDGER_KEY,
  TUNED_ARTIFACT_ROLLOUT_BUCKET_KEY,
  AI_PILOT_DIAGNOSTICS_KEY,
  AI_PILOT_INFLIGHT_KEY,
} from './storageKeys';
import {
  getPrivacyRetentionPreference,
  LEGACY_PRIVACY_RETENTION_PREFERENCE_KEY,
  PRIVACY_RETENTION_PREFERENCE_KEY,
  type PrivacyRetentionPreference,
  savePrivacyRetentionPreference,
} from './retentionPolicy';

export {
  getPrivacyRetentionPreference,
  PRIVACY_RETENTION_PREFERENCE_KEY,
  type PrivacyRetentionPreference,
  savePrivacyRetentionPreference,
} from './retentionPolicy';

const EXPORT_SCHEMA = 'com.saferide.privacy-data-export' as const;
const EXPORT_SCHEMA_VERSION = 2;
const AUTH_SESSION_STORE_KEY = 'saferide_auth_saferide_local_auth_session';
const LOCAL_GUEST_SESSION_STORE_KEY = 'saferide_auth_saferide_local_guest_session';
const ANDROID_LOCAL_ONLY_SHARE_REASON = 'Android sharing for privacy files is disabled in this release. The file remains in SafeRide local storage.';

const ASYNC_EXPORT_EXACT_KEYS = new Set([
  'incident_drafts',
  '@sync_queue',
  'chat_messages',
  'message_retry_queue',
  'onboarding_state_v1',
  'safe_ride_quick_exit_config',
  PRIVACY_RETENTION_PREFERENCE_KEY,
  LEGACY_PRIVACY_RETENTION_PREFERENCE_KEY,
  PRIVACY_CONSENT_LEDGER_KEY,
  'saferide_legacy_secure_incident_drafts',
  'saferide_legacy_secure_app_settings',
  'saferide_legacy_secure_user_data',
  '@catalog_providers',
  '@catalog_legal_tags',
  '@catalog_tips',
]);

const ASYNC_EXPORT_KEY_PREFIXES = [
  '@offline_',
  '@workflow_',
  'chat_messages:',
  'chat_local_sessions:',
  'message_retry_queue:',
];

const ASYNC_DELETE_EXACT_KEYS = new Set([
  ...ASYNC_EXPORT_EXACT_KEYS,
  'safe_ride_decoy_pin',
  'calculator_state',
  'NAVIGATION_STATE',
  '@saferide_runtime_config_override',
  TUNED_ARTIFACT_ROLLOUT_BUCKET_KEY,
  AI_PILOT_DIAGNOSTICS_KEY,
  AI_PILOT_INFLIGHT_KEY,
  '@error_log',
  AUTH_SESSION_STORE_KEY,
  LOCAL_GUEST_SESSION_STORE_KEY,
]);

const ASYNC_DELETE_KEY_PREFIXES = [
  ...ASYNC_EXPORT_KEY_PREFIXES,
  '@catalog_',
  MODEL_DOWNLOAD_STATE_KEY_PREFIX,
  MODEL_VERIFICATION_STATE_KEY_PREFIX,
];

const SECURE_EXPORT_KEYS = new Set([
  'incident_drafts',
  'app_settings',
  'user_data',
]);

// The Decoy PIN verifier and attempt record live in SecureStore. The privacy
// controls inventory marks the Decoy PIN as deleted by this wipe; only its
// legacy AsyncStorage copy used to be removed.
const SECURE_DELETE_KEYS = new Set([
  ...SECURE_EXPORT_KEYS,
  AUTH_SESSION_STORE_KEY,
  LOCAL_GUEST_SESSION_STORE_KEY,
  DECOY_PIN_STORE_KEY,
  DECOY_PIN_ATTEMPTS_STORE_KEY,
]);

const GENERATED_FILE_PATTERNS = [
  /^saferide_privacy_export_/i,
  /^saferide_local_backup_/i,
  /^SafeRide_Statement_/,
  /^SafeRide_Case_/,
  /^complete_data_export_/i,
  /^bulk_export_/i,
  /^(?:case[-_][A-Za-z0-9_-]{1,100}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.(?:json|pdf|sealed)$/i,
];

export const PRIVACY_DATA_EXPORT_INCLUDED_STORES = [
  'local report drafts and saved statement text',
  'queued offline submissions and cached offline packets',
  'local case-update notes saved for later review',
  'offline chat cache and retry queue',
  'report workflow state and onboarding state',
  'support catalog caches',
  'privacy, backup, quick-exit, and app settings that are not auth tokens',
  'media file metadata and checksums when selected',
];

export const PRIVACY_DATA_EXPORT_EXCLUDED_STORES = [
  'auth sessions, refresh tokens, and bearer tokens',
  'remote cases, remote chat history, server audit logs, and cloud evidence objects',
  'raw media file bytes',
  'hashed decoy PIN credentials',
  'navigation state, runtime endpoint overrides, and diagnostic error logs',
  'generated exports, backups, PDFs, statement files, and files already shared outside SafeRide',
];

export const PRIVACY_DATA_DELETE_INCLUDED_STORES = [
  'local report drafts and legacy secure drafts',
  'queued offline submissions and cached offline packets',
  'local case-update notes saved under offline packet storage',
  'offline chat cache and retry queue',
  'report workflow state, onboarding state, privacy consent history, retention preference, local settings, and the Decoy PIN (set it again to use Quick-Exit)',
  'support catalog caches, navigation state, runtime endpoint overrides, local rollout assignments, diagnostic error logs, and AI pilot diagnostics',
  'auth session state stored by the owned auth adapter',
  'app-managed media, generated exports/backups/PDFs/statements, downloaded evidence cache, and on-device model files',
];

export const PRIVACY_DATA_DELETE_EXCLUDED_STORES = [
  'remote cases, remote chat history, server audit logs, cloud evidence objects, and deletion requests',
  'files already exported, backed up, or shared outside SafeRide app storage',
  'media files outside SafeRide app document/cache storage',
  'OS clipboard contents and third-party share targets',
];

type StoreStorageType = 'asyncStorage' | 'secureStore' | 'sqlite';
type MediaScope = 'app-document' | 'app-cache' | 'external-or-unknown';

export interface PrivacyDataStoreSnapshot {
  storage: StoreStorageType;
  key: string;
  label: string;
  value: unknown;
}

export interface PrivacyDataMediaSnapshot {
  draftId: string;
  mediaId: string | null;
  fileName: string | null;
  type: string | null;
  uriScope: MediaScope;
  exists: boolean;
  size: number | null;
  sha256: string | null;
  error: string | null;
}

export interface PrivacyDataExportFile {
  schema: typeof EXPORT_SCHEMA;
  schemaVersion: number;
  createdAt: string;
  scope: {
    includedStores: string[];
    excludedStores: string[];
  };
  retentionPolicyId: PrivacyRetentionPreference;
  stores: PrivacyDataStoreSnapshot[];
  media: PrivacyDataMediaSnapshot[];
}

export interface CreatePrivacyDataExportOptions {
  includeMediaMetadata?: boolean;
  now?: Date;
  fileName?: string;
}

export interface CreatePrivacyDataExportResult {
  filePath: string;
  size?: number;
  itemCount: number;
  includedStores: string[];
  excludedStores: string[];
}

export interface DeleteLocalPrivacyDataResult {
  asyncStorageKeysDeleted: string[];
  secureStoreKeysDeleted: string[];
  filesystemUrisDeleted: string[];
  failures: string[];
  includedStores: string[];
  excludedStores: string[];
}

export interface PrivacyDataShareResult {
  success: boolean;
  shared: boolean;
  localOnly?: boolean;
  unavailable?: boolean;
  unavailableReason?: string;
  dismissed?: boolean;
  error?: string;
}

export type PrivacyDeleteFlowStatus = 'idle' | 'countdown' | 'deleting' | 'completed' | 'failed';

export interface PrivacyDeleteFlowSnapshot {
  status: PrivacyDeleteFlowStatus;
  countdownRemaining: number;
  result?: DeleteLocalPrivacyDataResult;
  error?: unknown;
}

export type PrivacyDeleteFlowListener = (snapshot: PrivacyDeleteFlowSnapshot) => void;
export type PrivacyDeleteFlowTimer = ReturnType<typeof setTimeout>;

export interface PrivacyDeleteFlowDependencies {
  pauseForPrivacyDelete: () => void;
  resumeAfterPrivacyDeleteCancel: () => void;
  deleteLocalData: () => Promise<DeleteLocalPrivacyDataResult>;
  setTimeout: (callback: () => void, milliseconds: number) => PrivacyDeleteFlowTimer;
  clearTimeout: (timer: PrivacyDeleteFlowTimer) => void;
  countdownSeconds: number;
}

export interface PrivacyDeleteFlowController {
  getSnapshot: () => PrivacyDeleteFlowSnapshot;
  subscribe: (listener: PrivacyDeleteFlowListener) => () => void;
  startCountdown: () => boolean;
  cancelCountdown: () => boolean;
  resetTerminalState: () => void;
}

const DEFAULT_DELETE_COUNTDOWN_SECONDS = 10;

function isExactOrPrefixed(key: string, exactKeys: Set<string>, prefixes: string[]): boolean {
  return exactKeys.has(key) || prefixes.some(prefix => key.startsWith(prefix));
}

function shouldExportAsyncStorageKey(key: string): boolean {
  return isExactOrPrefixed(key, ASYNC_EXPORT_EXACT_KEYS, ASYNC_EXPORT_KEY_PREFIXES);
}

function shouldDeleteAsyncStorageKey(key: string): boolean {
  return isExactOrPrefixed(key, ASYNC_DELETE_EXACT_KEYS, ASYNC_DELETE_KEY_PREFIXES);
}

function parseStoredValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function labelForAsyncStorageKey(key: string): string {
  if (key === 'incident_drafts') return 'local report drafts';
  if (key === '@sync_queue') return 'encrypted offline sync queue';
  if (key.startsWith('@offline_')) return 'encrypted offline cached packet';
  if (key.startsWith('@workflow_')) return 'encrypted report workflow state';
  if (key === 'chat_messages' || key.startsWith('chat_messages:')) return 'encrypted offline chat messages';
  if (key.startsWith('chat_local_sessions:')) return 'encrypted local chat thread index';
  if (key === 'message_retry_queue' || key.startsWith('message_retry_queue:')) return 'encrypted offline chat retry queue';
  if (key === 'onboarding_state_v1') return 'onboarding state';
  if (key === 'safe_ride_quick_exit_config') return 'quick-exit settings';
  if (key === PRIVACY_RETENTION_PREFERENCE_KEY) return 'privacy retention preference';
  if (key === LEGACY_PRIVACY_RETENTION_PREFERENCE_KEY) return 'legacy privacy retention preference';
  if (key === PRIVACY_CONSENT_LEDGER_KEY) return 'privacy consent history';
  if (key.startsWith('@catalog_')) return 'support catalog cache';
  if (key === 'saferide_legacy_secure_incident_drafts') return 'web legacy secure drafts';
  if (key === 'saferide_legacy_secure_app_settings') return 'web legacy app settings';
  if (key === 'saferide_legacy_secure_user_data') return 'web legacy user data';
  return 'SafeRide local store';
}

function labelForSecureStoreKey(key: string): string {
  if (key === 'incident_drafts') return 'legacy secure report drafts';
  if (key === 'app_settings') return 'native app settings';
  if (key === 'user_data') return 'legacy secure user data';
  return 'native secure SafeRide store';
}

async function isSecureStoreAvailable(): Promise<boolean> {
  if (typeof SecureStore.isAvailableAsync !== 'function') {
    return true;
  }

  try {
    return await SecureStore.isAvailableAsync();
  } catch {
    return false;
  }
}

async function collectAsyncStorageExportStores(): Promise<PrivacyDataStoreSnapshot[]> {
  const keys = (await AsyncStorage.getAllKeys())
    .filter(shouldExportAsyncStorageKey)
    .sort();

  if (keys.length === 0) {
    return [];
  }

  const pairs = await Promise.all(keys.map(async (key): Promise<[string, string | null]> => {
    if (isEncryptedActivePersistenceKey(key)) {
      return [key, await encryptedAsyncStorage.getItem(key)];
    }

    return [key, await AsyncStorage.getItem(key)];
  }));
  return pairs
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, value]) => ({
      storage: 'asyncStorage' as const,
      key,
      label: labelForAsyncStorageKey(key),
      value: parseStoredValue(value),
    }));
}

async function collectDraftDatabaseExportStore(): Promise<PrivacyDataStoreSnapshot[]> {
  const drafts = await draftStorage.getAllDrafts();
  if (drafts.length === 0) {
    return [];
  }

  return [{
    storage: 'sqlite',
    key: 'incident_draft_records',
    label: 'legacy local report draft database',
    value: drafts,
  }];
}

async function collectSecureStoreExportStores(): Promise<PrivacyDataStoreSnapshot[]> {
  if (!(await isSecureStoreAvailable())) {
    return [];
  }

  const stores: PrivacyDataStoreSnapshot[] = [];
  for (const key of Array.from(SECURE_EXPORT_KEYS).sort()) {
    const value = await SecureStore.getItemAsync(key);
    if (typeof value === 'string') {
      stores.push({
        storage: 'secureStore',
        key: `secure_store:${key}`,
        label: labelForSecureStoreKey(key),
        value: parseStoredValue(value),
      });
    }
  }
  return stores;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseDraftObjects(raw: string | null): Array<Record<string, any>> {
  if (!raw) return [];

  try {
    return asArray(JSON.parse(raw)).filter((draft): draft is Record<string, any> => (
      draft !== null && typeof draft === 'object'
    ));
  } catch {
    return [];
  }
}

async function readLocalReportDrafts(): Promise<Array<Record<string, any>>> {
  const drafts = await draftStorage.getAllDrafts();
  if (drafts.length > 0) {
    return drafts as unknown as Array<Record<string, any>>;
  }

  const raw = await AsyncStorage.getItem('incident_drafts');
  return parseDraftObjects(raw);
}

async function readWebLegacyDrafts(): Promise<Array<Record<string, any>>> {
  const raw = await AsyncStorage.getItem('saferide_legacy_secure_incident_drafts');
  return parseDraftObjects(raw);
}

async function readNativeLegacyDrafts(): Promise<Array<Record<string, any>>> {
  if (!(await isSecureStoreAvailable())) {
    return [];
  }

  try {
    const raw = await SecureStore.getItemAsync('incident_drafts');
    return parseDraftObjects(raw);
  } catch (error) {
    devPrivacyWarn('legacy draft media inventory failed', {
      reason: getPrivacySafeErrorReason(error),
    });
    return [];
  }
}

function getUriScope(uri: string): MediaScope {
  if (FileSystem.documentDirectory && uri.startsWith(FileSystem.documentDirectory)) {
    return 'app-document';
  }
  if (FileSystem.cacheDirectory && uri.startsWith(FileSystem.cacheDirectory)) {
    return 'app-cache';
  }
  return 'external-or-unknown';
}

function isAppOwnedUri(uri: string): boolean {
  return getUriScope(uri) !== 'external-or-unknown';
}

async function collectMediaSnapshots(includeChecksums: boolean): Promise<PrivacyDataMediaSnapshot[]> {
  const drafts = await readLocalReportDrafts();
  const snapshots: PrivacyDataMediaSnapshot[] = [];

  for (const draft of drafts) {
    const draftId = typeof draft.id === 'string' ? draft.id : 'unknown-draft';
    const mediaFiles = asArray(draft.mediaFiles).filter((media): media is Record<string, any> => (
      media !== null && typeof media === 'object'
    ));

    for (const media of mediaFiles) {
      const uri = typeof media.uri === 'string' ? media.uri : '';
      const snapshot: PrivacyDataMediaSnapshot = {
        draftId,
        mediaId: typeof media.id === 'string' ? media.id : null,
        fileName: typeof media.fileName === 'string' ? media.fileName : null,
        type: typeof media.type === 'string' ? media.type : null,
        uriScope: uri ? getUriScope(uri) : 'external-or-unknown',
        exists: false,
        size: null,
        sha256: null,
        error: null,
      };

      if (!uri) {
        snapshot.error = 'media URI missing';
        snapshots.push(snapshot);
        continue;
      }

      try {
        const info = await FileSystem.getInfoAsync(uri);
        snapshot.exists = info.exists;
        snapshot.size = info.exists && 'size' in info && typeof info.size === 'number'
          ? info.size
          : null;

        if (includeChecksums && info.exists) {
          const base64 = await FileSystem.readAsStringAsync(uri, {
            encoding: FileSystem.EncodingType.Base64,
          });
          snapshot.sha256 = await sha256Base64FileBytes(base64);
        }
      } catch (error) {
        snapshot.error = getPrivacySafeErrorReason(error);
      }

      snapshots.push(snapshot);
    }
  }

  return snapshots;
}

function base64ToBytes(base64: string): Uint8Array {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  const sanitized = base64.replace(/[^A-Za-z0-9+/=]/g, '');
  const bytes: number[] = [];

  for (let i = 0; i < sanitized.length;) {
    const enc1 = chars.indexOf(sanitized.charAt(i++));
    const enc2 = chars.indexOf(sanitized.charAt(i++));
    const enc3 = chars.indexOf(sanitized.charAt(i++));
    const enc4 = chars.indexOf(sanitized.charAt(i++));

    if (enc1 < 0 || enc2 < 0 || enc3 < 0 || enc4 < 0) {
      throw new Error('Invalid base64 media data.');
    }

    bytes.push((enc1 << 2) | (enc2 >> 4));

    if (enc3 !== 64) {
      bytes.push(((enc2 & 15) << 4) | (enc3 >> 2));
    }
    if (enc4 !== 64) {
      bytes.push(((enc3 & 3) << 6) | enc4);
    }
  }

  return new Uint8Array(bytes);
}

function arrayBufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Base64FileBytes(base64: string): Promise<string> {
  const bytes = base64ToBytes(base64);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, buffer);
  return arrayBufferToHex(digest);
}

export async function createPrivacyDataExport({
  includeMediaMetadata = false,
  now = new Date(),
  fileName,
}: CreatePrivacyDataExportOptions = {}): Promise<CreatePrivacyDataExportResult> {
  if (!FileSystem.documentDirectory) {
    throw new Error('Local document storage is not available on this device.');
  }

  // Complete any legacy draft migration before enumerating AsyncStorage so a
  // concurrent export cannot capture both the source and canonical database.
  const draftDatabaseStores = await collectDraftDatabaseExportStore();
  const [asyncStores, secureStores, media, retentionPolicyId] = await Promise.all([
    collectAsyncStorageExportStores(),
    collectSecureStoreExportStores(),
    includeMediaMetadata ? collectMediaSnapshots(true) : Promise.resolve([]),
    getPrivacyRetentionPreference(),
  ]);
  const createdAt = now.toISOString();
  const exportFile: PrivacyDataExportFile = {
    schema: EXPORT_SCHEMA,
    schemaVersion: EXPORT_SCHEMA_VERSION,
    createdAt,
    scope: {
      includedStores: PRIVACY_DATA_EXPORT_INCLUDED_STORES,
      excludedStores: PRIVACY_DATA_EXPORT_EXCLUDED_STORES,
    },
    retentionPolicyId,
    stores: [...draftDatabaseStores, ...asyncStores, ...secureStores],
    media,
  };

  const safeTimestamp = createdAt.replace(/[:.]/g, '-');
  const exportFileName = fileName ?? `saferide_privacy_export_${safeTimestamp}.json`;
  const filePath = `${FileSystem.documentDirectory}${exportFileName}`;
  await FileSystem.writeAsStringAsync(filePath, JSON.stringify(exportFile, null, 2));

  const fileInfo = await FileSystem.getInfoAsync(filePath);
  return {
    filePath,
    size: fileInfo.exists ? fileInfo.size : undefined,
    itemCount: exportFile.stores.length + exportFile.media.length,
    includedStores: PRIVACY_DATA_EXPORT_INCLUDED_STORES,
    excludedStores: PRIVACY_DATA_EXPORT_EXCLUDED_STORES,
  };
}

export async function sharePrivacyDataExportFile(
  filePath: string,
  title = 'SafeRide privacy data export',
): Promise<PrivacyDataShareResult> {
  try {
    if (Platform.OS === 'android') {
      return {
        success: true,
        shared: false,
        localOnly: true,
        unavailable: true,
        unavailableReason: ANDROID_LOCAL_ONLY_SHARE_REASON,
      };
    }

    const result = await Share.share(
      {
        url: filePath,
        message: title,
      },
      { dialogTitle: title },
    );

    if (result.action === Share.sharedAction) {
      return { success: true, shared: true };
    }

    if ('dismissedAction' in Share && result.action === Share.dismissedAction) {
      return { success: true, shared: false, dismissed: true };
    }

    return { success: true, shared: false };
  } catch (error) {
    devPrivacyWarn('privacy data export share failed', {
      reason: getPrivacySafeErrorReason(error),
    });
    return {
      success: false,
      shared: false,
      error: 'The file was created locally, but sharing did not open.',
    };
  }
}

async function deleteSecureStoreKeys(): Promise<{
  deleted: string[];
  failures: string[];
}> {
  const deleted: string[] = [];
  const failures: string[] = [];

  if (!(await isSecureStoreAvailable())) {
    return { deleted, failures };
  }

  for (const key of Array.from(SECURE_DELETE_KEYS).sort()) {
    try {
      await SecureStore.deleteItemAsync(key);
      deleted.push(key);
    } catch (error) {
      if (!failures.includes('secure store')) {
        failures.push('secure store');
      }
      devPrivacyWarn('privacy secure store delete failed', {
        store: key,
        reason: getPrivacySafeErrorReason(error),
      });
    }
  }

  return { deleted, failures };
}

function collectModernDraftMediaUris(drafts: Array<Record<string, any>>, uris: Set<string>): void {
  for (const draft of drafts) {
    const mediaFiles = asArray(draft.mediaFiles).filter((media): media is Record<string, any> => (
      media !== null && typeof media === 'object'
    ));

    for (const media of mediaFiles) {
      const uri = typeof media.uri === 'string' ? media.uri : '';
      if (uri && isAppOwnedUri(uri)) {
        uris.add(uri);
      }
    }
  }
}

function collectLegacyDraftMediaUris(drafts: Array<Record<string, any>>, uris: Set<string>): void {
  for (const draft of drafts) {
    const evidence = draft.evidence && typeof draft.evidence === 'object'
      ? draft.evidence as Record<string, any>
      : {};
    const legacyUris = [
      ...asArray(evidence.photos),
      ...asArray(evidence.audioRecordings),
    ];

    for (const candidate of legacyUris) {
      if (typeof candidate === 'string' && isAppOwnedUri(candidate)) {
        uris.add(candidate);
      }
    }
  }
}

async function collectAppOwnedDraftMediaUris(): Promise<string[]> {
  const [modernDrafts, webLegacyDrafts, nativeLegacyDrafts] = await Promise.all([
    readLocalReportDrafts(),
    readWebLegacyDrafts(),
    readNativeLegacyDrafts(),
  ]);
  const uris = new Set<string>();

  collectModernDraftMediaUris(modernDrafts, uris);
  collectLegacyDraftMediaUris(webLegacyDrafts, uris);
  collectLegacyDraftMediaUris(nativeLegacyDrafts, uris);

  return Array.from(uris).sort();
}

async function deleteIfPresent(uri: string): Promise<boolean> {
  await FileSystem.deleteAsync(uri, { idempotent: true });
  return true;
}

function shouldDeleteGeneratedFileName(fileName: string): boolean {
  return GENERATED_FILE_PATTERNS.some(pattern => pattern.test(fileName));
}

async function deleteGeneratedFilesInDirectory(baseUri: string | null | undefined): Promise<string[]> {
  if (!baseUri || typeof FileSystem.readDirectoryAsync !== 'function') {
    return [];
  }

  const deleted: string[] = [];
  let entries: string[];

  try {
    entries = await FileSystem.readDirectoryAsync(baseUri);
  } catch {
    return deleted;
  }

  for (const entry of entries) {
    if (!shouldDeleteGeneratedFileName(entry)) {
      continue;
    }

    const uri = `${baseUri}${entry}`;
    await deleteIfPresent(uri);
    deleted.push(uri);
  }

  return deleted;
}

async function deleteFilesystemArtifacts(mediaUris: string[]): Promise<{
  deleted: string[];
  failures: string[];
}> {
  const deleted: string[] = [];
  const failures: string[] = [];
  const candidateUris = new Set<string>(mediaUris);
  const mediaUriSet = new Set(mediaUris);

  const recordFailure = (category: string, error: unknown) => {
    if (!failures.includes(category)) {
      failures.push(category);
    }
    devPrivacyWarn('privacy data filesystem delete failed', {
      category,
      reason: getPrivacySafeErrorReason(error),
    });
  };

  if (FileSystem.cacheDirectory) {
    candidateUris.add(`${FileSystem.cacheDirectory}saferide-evidence`);
  }

  if (FileSystem.documentDirectory) {
    candidateUris.add(`${FileSystem.documentDirectory}saferide-evidence`);
    candidateUris.add(`${FileSystem.documentDirectory}models`);
  }

  for (const uri of candidateUris) {
    try {
      await deleteIfPresent(uri);
      deleted.push(uri);
    } catch (error) {
      recordFailure(mediaUriSet.has(uri) ? 'media files' : 'filesystem artifacts', error);
    }
  }

  for (const baseUri of [FileSystem.documentDirectory, FileSystem.cacheDirectory]) {
    try {
      deleted.push(...await deleteGeneratedFilesInDirectory(baseUri));
    } catch (error) {
      recordFailure('generated files', error);
    }
  }

  return {
    deleted: Array.from(new Set(deleted)).sort(),
    failures,
  };
}

export async function deleteLocalPrivacyData(): Promise<DeleteLocalPrivacyDataResult> {
  const failures: string[] = [];
  offlineSyncManager.pauseForPrivacyDelete();
  const allAsyncKeys = await AsyncStorage.getAllKeys();
  let mediaUris: string[] = [];
  try {
    mediaUris = await collectAppOwnedDraftMediaUris();
  } catch (error) {
    failures.push('draft media inventory');
    devPrivacyWarn('privacy draft media inventory failed', {
      reason: getPrivacySafeErrorReason(error),
    });
  }
  const asyncKeysToDelete = allAsyncKeys.filter(shouldDeleteAsyncStorageKey).sort();

  try {
    await draftStorage.clearAll({ purgeSqliteRemnants: true });
  } catch (error) {
    failures.push('draft storage');
    devPrivacyWarn('privacy draft storage delete failed', {
      reason: getPrivacySafeErrorReason(error),
    });
  }

  try {
    await offlineSyncManager.reset({ throwOnFailure: true });
  } catch (error) {
    failures.push('offline queue/cache');
    devPrivacyWarn('privacy offline queue/cache delete failed', {
      reason: getPrivacySafeErrorReason(error),
    });
  }

  try {
    if (asyncKeysToDelete.length > 0) {
      await AsyncStorage.multiRemove(asyncKeysToDelete);
    }
  } catch (error) {
    failures.push('AsyncStorage stores');
    devPrivacyWarn('privacy AsyncStorage delete failed', {
      reason: getPrivacySafeErrorReason(error),
    });
  }

  try {
    await authClient.signOut();
    setAuthToken(null);
  } catch (error) {
    failures.push('auth session');
    devPrivacyWarn('privacy auth session delete failed', {
      reason: getPrivacySafeErrorReason(error),
    });
  }

  const secureDelete = await deleteSecureStoreKeys();
  failures.push(...secureDelete.failures);

  try {
    await runAppReset('privacy-delete');
  } catch (error) {
    failures.push('app reset');
    devPrivacyWarn('privacy app reset failed', {
      reason: getPrivacySafeErrorReason(error),
    });
  }

  let filesystemDelete: { deleted: string[]; failures: string[] };
  try {
    filesystemDelete = await deleteFilesystemArtifacts(mediaUris);
  } catch (error) {
    filesystemDelete = { deleted: [], failures: ['filesystem artifacts'] };
    devPrivacyWarn('privacy filesystem delete failed', {
      reason: getPrivacySafeErrorReason(error),
    });
  }
  failures.push(...filesystemDelete.failures);

  let encryptionKeyDeletion = {
    deviceBoundKeyDeleted: false,
    webFallbackKeyDeleted: false,
  };
  try {
    encryptionKeyDeletion = await destroyDeviceBoundLocalEncryptionKey();
  } catch (error) {
    failures.push('device-bound encryption key');
    devPrivacyWarn('privacy encryption key delete failed', {
      reason: getPrivacySafeErrorReason(error),
    });
  }

  if (failures.length > 0) {
    devPrivacyError('privacy data delete completed with failures', { failures: failures.join('; ') });
  }

  return {
    asyncStorageKeysDeleted: encryptionKeyDeletion.webFallbackKeyDeleted
      ? [...asyncKeysToDelete, WEB_FALLBACK_LOCAL_ENCRYPTION_KEY_NAME].sort()
      : asyncKeysToDelete,
    secureStoreKeysDeleted: encryptionKeyDeletion.deviceBoundKeyDeleted
      ? [...secureDelete.deleted, DEVICE_BOUND_LOCAL_ENCRYPTION_KEY_NAME].sort()
      : secureDelete.deleted,
    filesystemUrisDeleted: filesystemDelete.deleted,
    failures,
    includedStores: PRIVACY_DATA_DELETE_INCLUDED_STORES,
    excludedStores: PRIVACY_DATA_DELETE_EXCLUDED_STORES,
  };
}

export function createPrivacyDeleteFlowController(
  dependencyOverrides: Partial<PrivacyDeleteFlowDependencies> = {},
): PrivacyDeleteFlowController {
  const dependencies: PrivacyDeleteFlowDependencies = {
    pauseForPrivacyDelete: () => offlineSyncManager.pauseForPrivacyDelete(),
    resumeAfterPrivacyDeleteCancel: () => offlineSyncManager.resumeAfterPrivacyDeleteCancel(),
    deleteLocalData: deleteLocalPrivacyData,
    setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearTimeout: (timer) => clearTimeout(timer),
    countdownSeconds: DEFAULT_DELETE_COUNTDOWN_SECONDS,
    ...dependencyOverrides,
  };

  const listeners = new Set<PrivacyDeleteFlowListener>();
  let snapshot: PrivacyDeleteFlowSnapshot = {
    status: 'idle',
    countdownRemaining: 0,
  };
  let activeTimer: PrivacyDeleteFlowTimer | null = null;

  const getSnapshot = () => ({ ...snapshot });

  const emit = () => {
    const nextSnapshot = getSnapshot();
    listeners.forEach((listener) => listener(nextSnapshot));
  };

  const clearActiveTimer = () => {
    if (activeTimer !== null) {
      dependencies.clearTimeout(activeTimer);
      activeTimer = null;
    }
  };

  const setSnapshot = (nextSnapshot: PrivacyDeleteFlowSnapshot) => {
    snapshot = nextSnapshot;
    emit();
  };

  const runDelete = async () => {
    clearActiveTimer();
    setSnapshot({ status: 'deleting', countdownRemaining: 0 });

    try {
      const result = await dependencies.deleteLocalData();
      setSnapshot({ status: 'completed', countdownRemaining: 0, result });
    } catch (error) {
      dependencies.resumeAfterPrivacyDeleteCancel();
      setSnapshot({ status: 'failed', countdownRemaining: 0, error });
    }
  };

  const scheduleNextTick = () => {
    clearActiveTimer();
    activeTimer = dependencies.setTimeout(() => {
      if (snapshot.status !== 'countdown') {
        return;
      }

      const nextRemaining = snapshot.countdownRemaining - 1;
      if (nextRemaining > 0) {
        setSnapshot({ status: 'countdown', countdownRemaining: nextRemaining });
        scheduleNextTick();
        return;
      }

      void runDelete();
    }, 1000);
  };

  return {
    getSnapshot,
    subscribe(listener) {
      listeners.add(listener);
      listener(getSnapshot());

      return () => {
        listeners.delete(listener);
      };
    },
    startCountdown() {
      if (snapshot.status === 'countdown' || snapshot.status === 'deleting') {
        return false;
      }

      dependencies.pauseForPrivacyDelete();
      setSnapshot({
        status: 'countdown',
        countdownRemaining: Math.max(1, dependencies.countdownSeconds),
      });
      scheduleNextTick();
      return true;
    },
    cancelCountdown() {
      if (snapshot.status !== 'countdown') {
        return false;
      }

      clearActiveTimer();
      dependencies.resumeAfterPrivacyDeleteCancel();
      setSnapshot({ status: 'idle', countdownRemaining: 0 });
      return true;
    },
    resetTerminalState() {
      if (snapshot.status !== 'completed' && snapshot.status !== 'failed') {
        return;
      }

      clearActiveTimer();
      setSnapshot({ status: 'idle', countdownRemaining: 0 });
    },
  };
}

export const privacyDeleteFlowController = createPrivacyDeleteFlowController();
