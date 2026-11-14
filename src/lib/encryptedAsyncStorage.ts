import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  AESEncryptionKey,
  AESSealedData,
  aesDecryptAsync,
  aesEncryptAsync,
  getRandomBytesAsync,
} from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

import { bytesToUtf8, utf8ToBytes } from './utf8';
import * as storageKeys from '../utils/storageKeys';

const SECURE_KEY_NAME = 'saferide_local_data_aes_key_v1';
const WEB_KEY_NAME = `${SECURE_KEY_NAME}_web_fallback`;
const ENVELOPE_MARKER = '__saferideEncrypted';
const ENVELOPE_VERSION = 1;
const KEY_LENGTH_BYTES = 32;
const IV_LENGTH_BYTES = 12;
const TAG_LENGTH_BYTES = 16 as const;
export const DEVICE_BOUND_LOCAL_ENCRYPTION_KEY_NAME = SECURE_KEY_NAME;
export const WEB_FALLBACK_LOCAL_ENCRYPTION_KEY_NAME = WEB_KEY_NAME;
export type LocalEncryptionKeyDeletionResult = {
  deviceBoundKeyDeleted: boolean;
  webFallbackKeyDeleted: boolean;
};

type EncryptedEnvelope = {
  [ENVELOPE_MARKER]: true;
  version: typeof ENVELOPE_VERSION;
  algorithm: 'AES-256-GCM';
  keyName: typeof SECURE_KEY_NAME;
  data: string;
  createdAt: string;
};

let cachedKey: AESEncryptionKey | null = null;
let cachedEncodedKey: string | null = null;
let keyResolutionPromise: Promise<AESEncryptionKey> | null = null;
let keyDeletionPromise: Promise<LocalEncryptionKeyDeletionResult> | null = null;

function bytesToBase64(bytes: Uint8Array): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  let i = 0;

  for (; i + 2 < bytes.length; i += 3) {
    output += chars[bytes[i] >> 2];
    output += chars[((bytes[i] & 3) << 4) | (bytes[i + 1] >> 4)];
    output += chars[((bytes[i + 1] & 15) << 2) | (bytes[i + 2] >> 6)];
    output += chars[bytes[i + 2] & 63];
  }

  if (i < bytes.length) {
    output += chars[bytes[i] >> 2];
    if (i === bytes.length - 1) {
      output += chars[(bytes[i] & 3) << 4];
      output += '==';
    } else {
      output += chars[((bytes[i] & 3) << 4) | (bytes[i + 1] >> 4)];
      output += chars[(bytes[i + 1] & 15) << 2];
      output += '=';
    }
  }

  return output;
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
      throw new Error('Invalid encoded encrypted storage value.');
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

function parseEnvelope(raw: string): EncryptedEnvelope | null {
  try {
    const parsed = JSON.parse(raw) as Partial<EncryptedEnvelope>;
    if (
      parsed?.[ENVELOPE_MARKER] === true &&
      parsed.version === ENVELOPE_VERSION &&
      parsed.algorithm === 'AES-256-GCM' &&
      parsed.keyName === SECURE_KEY_NAME &&
      typeof parsed.data === 'string'
    ) {
      return parsed as EncryptedEnvelope;
    }
  } catch {
    return null;
  }

  return null;
}

function additionalDataForKey(key: string): Uint8Array {
  return utf8ToBytes(`saferide:${ENVELOPE_VERSION}:${key}`);
}

async function assertSecureStoreAvailable(): Promise<void> {
  if (typeof SecureStore.isAvailableAsync !== 'function') {
    return;
  }

  const isAvailable = await SecureStore.isAvailableAsync();
  if (!isAvailable) {
    throw new Error('SecureStore is not available for encrypted local persistence.');
  }
}

function isWebRuntime(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

/**
 * Survivor report data must never use the web fallback key, which is stored
 * beside its ciphertext. Callers handling sensitive native-only state use
 * this gate before reading or writing so an unavailable platform keystore is
 * a hard failure rather than a downgrade.
 */
export async function assertDeviceBoundLocalEncryptionAvailable(): Promise<void> {
  if (isWebRuntime()) {
    throw new Error('Device-bound encrypted local persistence is unavailable on web.');
  }

  await assertSecureStoreAvailable();
}

async function shouldUseWebKeyFallback(): Promise<boolean> {
  if (!isWebRuntime()) return false;
  if (typeof SecureStore.isAvailableAsync !== 'function') return true;

  try {
    return !(await SecureStore.isAvailableAsync());
  } catch {
    return true;
  }
}

async function getStoredEncodedKey(): Promise<string | null> {
  if (await shouldUseWebKeyFallback()) {
    return AsyncStorage.getItem(WEB_KEY_NAME);
  }

  await assertSecureStoreAvailable();
  return SecureStore.getItemAsync(SECURE_KEY_NAME);
}

async function setStoredEncodedKey(encodedKey: string): Promise<void> {
  if (await shouldUseWebKeyFallback()) {
    await AsyncStorage.setItem(WEB_KEY_NAME, encodedKey);
    return;
  }

  await assertSecureStoreAvailable();
  await SecureStore.setItemAsync(SECURE_KEY_NAME, encodedKey, {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  });
}

async function importKey(encodedKey: string): Promise<AESEncryptionKey> {
  return await AESEncryptionKey.import(base64ToBytes(encodedKey)) as AESEncryptionKey;
}

async function resolveEncryptionKey(): Promise<AESEncryptionKey> {
  const storedKey = await getStoredEncodedKey();
  if (storedKey) {
    if (cachedKey && cachedEncodedKey === storedKey) {
      return cachedKey;
    }

    cachedKey = await importKey(storedKey);
    cachedEncodedKey = storedKey;
    return cachedKey;
  }

  const keyBytes = await getRandomBytesAsync(KEY_LENGTH_BYTES);
  const encodedKey = bytesToBase64(keyBytes);
  const key = await AESEncryptionKey.import(keyBytes) as AESEncryptionKey;
  await setStoredEncodedKey(encodedKey);

  cachedKey = key;
  cachedEncodedKey = encodedKey;
  return key;
}

async function getEncryptionKey(): Promise<AESEncryptionKey> {
  if (keyDeletionPromise) {
    await keyDeletionPromise;
  }
  if (!keyResolutionPromise) {
    keyResolutionPromise = resolveEncryptionKey();
  }
  const pending = keyResolutionPromise;
  try {
    return await pending;
  } finally {
    if (keyResolutionPromise === pending) {
      keyResolutionPromise = null;
    }
  }
}

export async function destroyDeviceBoundLocalEncryptionKey(): Promise<LocalEncryptionKeyDeletionResult> {
  if (keyDeletionPromise) return keyDeletionPromise;
  const pendingResolution = keyResolutionPromise;
  const deletion = (async () => {
    if (pendingResolution) {
      await pendingResolution.catch(() => undefined);
    }
    cachedKey = null;
    cachedEncodedKey = null;
    keyResolutionPromise = null;

    await AsyncStorage.removeItem(WEB_KEY_NAME);
    if (await AsyncStorage.getItem(WEB_KEY_NAME)) {
      throw new Error('Web fallback encryption key deletion could not be verified.');
    }
    if (isWebRuntime()) {
      return { deviceBoundKeyDeleted: false, webFallbackKeyDeleted: true };
    }
    await assertSecureStoreAvailable();
    await SecureStore.deleteItemAsync(SECURE_KEY_NAME);
    if (await SecureStore.getItemAsync(SECURE_KEY_NAME)) {
      throw new Error('Device-bound encryption key deletion could not be verified.');
    }
    return { deviceBoundKeyDeleted: true, webFallbackKeyDeleted: true };
  })();
  keyDeletionPromise = deletion;
  try {
    return await deletion;
  } finally {
    if (keyDeletionPromise === deletion) {
      keyDeletionPromise = null;
    }
  }
}

async function encryptString(key: string, value: string): Promise<string> {
  const encryptionKey = await getEncryptionKey();
  const nonce = await getRandomBytesAsync(IV_LENGTH_BYTES);
  const sealed = await aesEncryptAsync(utf8ToBytes(value), encryptionKey, {
    additionalData: additionalDataForKey(key),
    nonce: { bytes: nonce },
    tagLength: TAG_LENGTH_BYTES,
  });

  const envelope: EncryptedEnvelope = {
    [ENVELOPE_MARKER]: true,
    version: ENVELOPE_VERSION,
    algorithm: 'AES-256-GCM',
    keyName: SECURE_KEY_NAME,
    data: await sealed.combined('base64'),
    createdAt: new Date().toISOString(),
  };

  return JSON.stringify(envelope);
}

async function decryptString(key: string, envelope: EncryptedEnvelope): Promise<string> {
  const encryptionKey = await getEncryptionKey();
  // Expo Crypto's Android JSI bridge requires a typed byte object here even
  // though the TypeScript surface also accepts base64 strings. Passing the
  // stored string directly fails at runtime before any draft can be read.
  const sealed = AESSealedData.fromCombined(base64ToBytes(envelope.data), {
    ivLength: IV_LENGTH_BYTES,
    tagLength: TAG_LENGTH_BYTES,
  });
  const decrypted = await aesDecryptAsync(sealed, encryptionKey, {
    additionalData: additionalDataForKey(key),
  });

  return typeof decrypted === 'string' ? decrypted : bytesToUtf8(decrypted);
}

export async function encryptLocalDataString(key: string, value: string): Promise<string> {
  return encryptString(key, value);
}

export async function decryptLocalDataString(key: string, raw: string): Promise<string> {
  const envelope = parseEnvelope(raw);
  if (!envelope) return raw;

  return decryptString(key, envelope);
}

export function isEncryptedActivePersistenceKey(key: string): boolean {
  return key === storageKeys.DRAFT_STORAGE_KEY ||
    key === storageKeys.ACTIVE_DRAFT_ID_KEY ||
    key === storageKeys.SYNC_QUEUE_KEY ||
    key.startsWith(storageKeys.OFFLINE_DATA_KEY_PREFIX) ||
    key.startsWith(storageKeys.WORKFLOW_KEY_PREFIX) ||
    key === storageKeys.CHAT_MESSAGES_KEY ||
    key.startsWith(storageKeys.CHAT_MESSAGES_KEY_PREFIX) ||
    key.startsWith(storageKeys.CHAT_LOCAL_SESSIONS_KEY_PREFIX) ||
    key === storageKeys.MESSAGE_RETRY_QUEUE_KEY ||
    key.startsWith(storageKeys.MESSAGE_RETRY_QUEUE_KEY_PREFIX) ||
    key === storageKeys.PRIVACY_RETENTION_POLICY_KEY ||
    key === storageKeys.PRIVACY_CONSENT_LEDGER_KEY ||
    key === storageKeys.MEASUREMENT_CONSENT_KEY ||
    key === storageKeys.MEASUREMENT_SESSION_KEY ||
    key === storageKeys.MEASUREMENT_EVENTS_KEY ||
    key === storageKeys.MEASUREMENT_ISSUES_KEY ||
    key === storageKeys.AI_PILOT_DIAGNOSTICS_KEY ||
    key === storageKeys.AI_PILOT_INFLIGHT_KEY;
}

export function isEncryptedAsyncStorageEnvelope(raw: string | null): boolean {
  return typeof raw === 'string' && parseEnvelope(raw) !== null;
}

export function __resetEncryptedAsyncStorageForTests(): void {
  cachedKey = null;
  cachedEncodedKey = null;
  keyResolutionPromise = null;
  keyDeletionPromise = null;
}

export const encryptedAsyncStorage = {
  async getItem(key: string): Promise<string | null> {
    if (isEncryptedActivePersistenceKey(key)) {
      await assertDeviceBoundLocalEncryptionAvailable();
    }

    const raw = await AsyncStorage.getItem(key);
    if (!raw) return null;

    const envelope = parseEnvelope(raw);
    if (envelope) {
      return decryptString(key, envelope);
    }

    await this.setItem(key, raw);
    const confirmed = await AsyncStorage.getItem(key);
    if (!isEncryptedAsyncStorageEnvelope(confirmed)) {
      throw new Error('Encrypted storage migration could not be verified.');
    }

    return raw;
  },

  async setItem(key: string, value: string): Promise<void> {
    if (isEncryptedActivePersistenceKey(key)) {
      await assertDeviceBoundLocalEncryptionAvailable();
    }

    await AsyncStorage.setItem(key, await encryptString(key, value));
  },

  async removeItem(key: string): Promise<void> {
    await AsyncStorage.removeItem(key);
  },

  async multiGet(keys: readonly string[]): Promise<Array<[string, string | null]>> {
    return Promise.all(keys.map(async key => [key, await this.getItem(key)]));
  },

  async multiRemove(keys: readonly string[]): Promise<void> {
    await AsyncStorage.multiRemove(keys);
  },

  async getAllKeys(): Promise<readonly string[]> {
    return AsyncStorage.getAllKeys();
  },
};
