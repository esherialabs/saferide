import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { devPrivacyError, getPrivacySafeErrorReason } from '../utils/privacyLog';
import { normalizeThemePreference, type ThemePreference } from '../theme/tokens';
import { normalizeVisualStyle, type VisualStyle } from '../theme/visualStyles';

export interface IncidentDraft {
  id: string;
  timestamp: number;
  evidence: {
    photos: string[];
    audioRecordings: string[];
    notes: string;
  };
  details: {
    whatHappened: string;
    location: {
      address: string;
      coordinates?: {
        latitude: number;
        longitude: number;
      };
    };
    datetime: number;
  };
  legalFraming?: {
    suggestedActions: string[];
    relevantLaws: string[];
  };
  status: 'draft' | 'submitted' | 'archived';
}

export interface AppSettings {
  stealthTrigger: 'volume' | 'shake' | 'power' | 'tap';
  stealthHapticsEnabled: boolean;
  stealthAutoRecordEnabled: boolean;
  emergencyContacts: {
    name: string;
    phone: string;
    relationship: string;
  }[];
  theme: ThemePreference;
  visualStyle: VisualStyle;
  notifications: boolean;
  autoLocation: boolean;
  autoBackup: boolean;
}

const STORAGE_KEYS = {
  DRAFTS: 'incident_drafts',
  SETTINGS: 'app_settings',
  USER_DATA: 'user_data',
} as const;

const WEB_LEGACY_STORAGE_PREFIX = 'saferide_legacy_secure_';

function buildWebLegacyKey(key: string): string {
  return `${WEB_LEGACY_STORAGE_PREFIX}${key}`;
}

async function getSecureItem(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    return AsyncStorage.getItem(buildWebLegacyKey(key));
  }

  return SecureStore.getItemAsync(key);
}

async function setSecureItem(key: string, value: string): Promise<void> {
  if (Platform.OS === 'web') {
    await AsyncStorage.setItem(buildWebLegacyKey(key), value);
    return;
  }

  await SecureStore.setItemAsync(key, value, {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  });
}

async function deleteSecureItem(key: string): Promise<void> {
  if (Platform.OS === 'web') {
    await AsyncStorage.removeItem(buildWebLegacyKey(key));
    return;
  }

  await SecureStore.deleteItemAsync(key);
}

export class Storage {
  private static settingsSaveQueue: Promise<void> = Promise.resolve();
  static async saveDraft(draft: IncidentDraft): Promise<void> {
    try {
      const existingDrafts = await this.getDrafts();
      const updatedDrafts = existingDrafts.filter(d => d.id !== draft.id);
      updatedDrafts.push(draft);
      
      await setSecureItem(
        STORAGE_KEYS.DRAFTS,
        JSON.stringify(updatedDrafts)
      );
    } catch (error) {
      devPrivacyError('secure draft save failed', { reason: getPrivacySafeErrorReason(error) });
      throw error;
    }
  }

  static async getDrafts(): Promise<IncidentDraft[]> {
    try {
      const draftsJson = await getSecureItem(STORAGE_KEYS.DRAFTS);
      return draftsJson ? JSON.parse(draftsJson) : [];
    } catch (error) {
      devPrivacyError('secure drafts read failed', { reason: getPrivacySafeErrorReason(error) });
      return [];
    }
  }

  static async getDraft(id: string): Promise<IncidentDraft | null> {
    try {
      const drafts = await this.getDrafts();
      return drafts.find(draft => draft.id === id) || null;
    } catch (error) {
      devPrivacyError('secure draft read failed', { reason: getPrivacySafeErrorReason(error) });
      return null;
    }
  }

  static async deleteDraft(id: string): Promise<void> {
    try {
      const drafts = await this.getDrafts();
      const updatedDrafts = drafts.filter(draft => draft.id !== id);
      
      await setSecureItem(
        STORAGE_KEYS.DRAFTS,
        JSON.stringify(updatedDrafts)
      );
    } catch (error) {
      devPrivacyError('secure draft delete failed', { reason: getPrivacySafeErrorReason(error) });
      throw error;
    }
  }

  static async saveSettings(settings: Partial<AppSettings>): Promise<void> {
    const save = this.settingsSaveQueue.then(() => this.writeSettings(settings));
    this.settingsSaveQueue = save.catch(() => undefined);
    return save;
  }

  private static async writeSettings(settings: Partial<AppSettings>): Promise<void> {
    try {
      const currentSettings = await this.getSettings();
      const updatedSettings = { ...currentSettings, ...settings };
      
      await setSecureItem(
        STORAGE_KEYS.SETTINGS,
        JSON.stringify(updatedSettings)
      );
    } catch (error) {
      devPrivacyError('settings save failed', { reason: getPrivacySafeErrorReason(error) });
      throw error;
    }
  }

  static async getSettings(): Promise<AppSettings> {
    try {
      const settingsJson = await getSecureItem(STORAGE_KEYS.SETTINGS);
      
      const defaultSettings: AppSettings = {
        stealthTrigger: 'shake',
        stealthHapticsEnabled: true,
        stealthAutoRecordEnabled: true,
        emergencyContacts: [],
        theme: 'light',
        visualStyle: 'warm',
        notifications: true,
        autoLocation: true,
        autoBackup: false,
      };

      if (!settingsJson) {
        return defaultSettings;
      }

      const parsed = JSON.parse(settingsJson) as Partial<AppSettings>;
      return {
        ...defaultSettings,
        ...parsed,
        theme: normalizeThemePreference(parsed.theme, defaultSettings.theme),
        visualStyle: normalizeVisualStyle(parsed.visualStyle),
      };
    } catch (error) {
      devPrivacyError('settings read failed', { reason: getPrivacySafeErrorReason(error) });
      return {
        stealthTrigger: 'shake',
        stealthHapticsEnabled: true,
        stealthAutoRecordEnabled: true,
        emergencyContacts: [],
        theme: 'light',
        visualStyle: 'warm',
        notifications: true,
        autoLocation: true,
        autoBackup: false,
      };
    }
  }

  static async clearAllData(): Promise<void> {
    try {
      await Promise.all([
        deleteSecureItem(STORAGE_KEYS.DRAFTS),
        deleteSecureItem(STORAGE_KEYS.SETTINGS),
        deleteSecureItem(STORAGE_KEYS.USER_DATA),
      ]);
    } catch (error) {
      devPrivacyError('local data clear failed', { reason: getPrivacySafeErrorReason(error) });
      throw error;
    }
  }

  static async exportData(): Promise<string> {
    try {
      const [drafts, settings] = await Promise.all([
        this.getDrafts(),
        this.getSettings(),
      ]);

      return JSON.stringify({
        drafts,
        settings,
        exportedAt: new Date().toISOString(),
      }, null, 2);
    } catch (error) {
      devPrivacyError('local data export failed', { reason: getPrivacySafeErrorReason(error) });
      throw error;
    }
  }
}
