import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo, { NetInfoState } from './netinfoShim';

import { authClient } from '../lib/auth/authClient';
import { encryptedAsyncStorage } from '../lib/encryptedAsyncStorage';
import { draftStorage } from './draftStorage';
import { OFFLINE_DATA_KEY_PREFIX, SYNC_QUEUE_KEY } from './storageKeys';
import { PartnerRoutingConflictError, submitCase } from '../services/caseService';
import { isCaseSubmissionEnabled } from '../config/runtime/caseSubmissionGate';
import { CASE_SUBMISSION_COPY } from '../i18n/caseSubmissionCopy';
import { devPrivacyError, devPrivacyWarn, getPrivacySafeErrorReason } from './privacyLog';

export interface SyncQueueItem {
  id: string;
  type: 'create' | 'update' | 'delete' | 'submit';
  data: any;
  timestamp: Date;
  retryCount: number;
  maxRetries: number;
  lastAttemptAt?: Date;
  lastError?: string;
  blockedReason?: 'auth_required' | 'max_retries' | 'retry_pending' | 'needs_confirmation' | 'sending_paused';
  blockedAt?: Date;
}

export interface OfflineStorageItem {
  id: string;
  data: any;
  lastModified: Date;
  synced: boolean;
  pendingSync?: boolean;
}

class PrivacyDeleteSyncCancelledError extends Error {
  constructor() {
    super('Offline sync paused for privacy delete.');
    this.name = 'PrivacyDeleteSyncCancelledError';
  }
}

class OfflineSyncManager {
  private syncQueue: SyncQueueItem[] = [];
  private isOnline: boolean = true;
  private isSyncing: boolean = false;
  private syncCallbacks: Array<(status: 'syncing' | 'success' | 'error', progress?: number) => void> = [];
  private authResetInProgress: boolean = false;
  private privacyDeletePauseActive: boolean = false;
  private privacyDeletePauseGeneration: number = 0;

  constructor() {
    this.initializeNetworkListener();
    this.loadSyncQueue();
  }

  // Network state management
  private initializeNetworkListener() {
    NetInfo.addEventListener((state: NetInfoState) => {
      const wasOffline = !this.isOnline;
      this.isOnline = state.isConnected ?? false;
      
      // If we just came online and have items in queue, start sync
      if (wasOffline && this.isOnline && this.syncQueue.length > 0 && !this.privacyDeletePauseActive) {
        this.startSync();
      }
    });
  }

  public isNetworkAvailable(): boolean {
    return this.isOnline;
  }

  public pauseForPrivacyDelete(): void {
    this.privacyDeletePauseActive = true;
    this.privacyDeletePauseGeneration += 1;
  }

  public resumeAfterPrivacyDeleteCancel(): void {
    this.privacyDeletePauseActive = false;

    if (this.isOnline && this.syncQueue.length > 0 && !this.isSyncing) {
      this.startSync();
    }
  }

  private isPrivacyDeleteSyncCancelled(error: unknown): boolean {
    return error instanceof PrivacyDeleteSyncCancelledError;
  }

  private throwIfPrivacyDeletePaused(syncGeneration: number): void {
    if (this.privacyDeletePauseActive || syncGeneration !== this.privacyDeletePauseGeneration) {
      throw new PrivacyDeleteSyncCancelledError();
    }
  }

  // Sync queue management
  private async loadSyncQueue(options: { throwOnFailure?: boolean } = {}) {
    try {
      const queueData = await encryptedAsyncStorage.getItem(SYNC_QUEUE_KEY);
      if (queueData) {
        const loadedQueue = JSON.parse(queueData).map((item: any) => ({
          ...item,
          timestamp: new Date(item.timestamp),
          lastAttemptAt: item.lastAttemptAt ? new Date(item.lastAttemptAt) : undefined,
          blockedAt: item.blockedAt ? new Date(item.blockedAt) : undefined,
        }));
        this.syncQueue = loadedQueue.filter((item: SyncQueueItem) => !this.isDraftSyncQueueItem(item));
        if (this.syncQueue.length !== loadedQueue.length) {
          await this.saveSyncQueue(options);
        }
      } else {
        this.syncQueue = [];
      }
    } catch (error) {
      devPrivacyError('sync queue load failed', { reason: getPrivacySafeErrorReason(error) });
      if (options.throwOnFailure) {
        throw error;
      }
    }
  }

  public async rehydrateFromStorage(): Promise<void> {
    await this.loadSyncQueue({ throwOnFailure: true });
    this.notifyCallbacks('success');
  }

  private async saveSyncQueue(options: { throwOnFailure?: boolean } = {}) {
    try {
      await encryptedAsyncStorage.setItem(SYNC_QUEUE_KEY, JSON.stringify(this.syncQueue));
    } catch (error) {
      devPrivacyError('sync queue save failed', { reason: getPrivacySafeErrorReason(error) });
      if (options.throwOnFailure) {
        throw error;
      }
    }
  }

  public async addToSyncQueue(item: Omit<SyncQueueItem, 'retryCount'>) {
    const queueItem: SyncQueueItem = {
      ...item,
      retryCount: 0,
      timestamp: new Date(),
    };

    if (this.isDraftSyncQueueItem(queueItem)) {
      await this.loadSyncQueue();
      return;
    }

    const existingSubmit = this.findDuplicateSubmitItem(queueItem);
    if (existingSubmit) {
      await this.saveSyncQueue();
      return;
    }

    this.syncQueue.push(queueItem);
    await this.saveSyncQueue();

    // If online, try to sync immediately
    if (this.isOnline && !this.isSyncing && !this.privacyDeletePauseActive) {
      this.startSync();
    }
  }

  public getSyncQueueSize(): number {
    return this.syncQueue.length;
  }

  public getSyncQueueItems(): SyncQueueItem[] {
    return [...this.syncQueue];
  }

  public getSyncQueueRecoveryMessage(): string | null {
    return buildSyncQueueRecoveryMessage(this.syncQueue);
  }

  private isQueueItemForDraft(item: SyncQueueItem, draftId: string, types?: SyncQueueItem['type'][]): boolean {
    if (types && !types.includes(item.type)) {
      return false;
    }

    const data = item.data ?? {};
    const payload = data.payload ?? {};

    return (
      data.draftId === draftId ||
      payload.id === draftId ||
      payload.draftId === draftId
    );
  }

  private isDraftSyncQueueItem(item: Pick<SyncQueueItem, 'data'>): boolean {
    return item.data?.resource === 'draft';
  }

  private notifyQueueRemoval(): void {
    const remainingItemsNeedAttention = this.syncQueue.some(item => (
      item.retryCount > 0 ||
      Boolean(item.lastError) ||
      Boolean(item.blockedReason)
    ));
    this.notifyCallbacks(remainingItemsNeedAttention ? 'error' : 'success');
  }

  public async removeSubmitQueueItemsForDraft(draftId: string): Promise<number> {
    const normalizedDraftId = draftId.trim();
    if (!normalizedDraftId) {
      return 0;
    }

    await this.loadSyncQueue({ throwOnFailure: true });

    const previousSize = this.syncQueue.length;
    this.syncQueue = this.syncQueue.filter(item => !this.isQueueItemForDraft(item, normalizedDraftId, ['submit']));

    const removedCount = previousSize - this.syncQueue.length;
    if (removedCount > 0) {
      await this.saveSyncQueue({ throwOnFailure: true });
      this.notifyQueueRemoval();
    }

    return removedCount;
  }

  public async removeQueueItemsForDraft(draftId: string): Promise<number> {
    const normalizedDraftId = draftId.trim();
    if (!normalizedDraftId) {
      return 0;
    }

    await this.loadSyncQueue({ throwOnFailure: true });

    const previousSize = this.syncQueue.length;
    this.syncQueue = this.syncQueue.filter(item => !this.isQueueItemForDraft(item, normalizedDraftId));

    const removedCount = previousSize - this.syncQueue.length;
    if (removedCount > 0) {
      await this.saveSyncQueue({ throwOnFailure: true });
      this.notifyQueueRemoval();
    }

    return removedCount;
  }

  private findDuplicateSubmitItem(item: SyncQueueItem): SyncQueueItem | undefined {
    const draftId = item.type === 'submit' ? item.data?.draftId : undefined;
    if (!draftId) return undefined;
    return this.syncQueue.find(existing => (
      existing.type === 'submit' &&
      existing.data?.draftId === draftId
    ));
  }

  private clearQueueRecoveryState(item: SyncQueueItem): void {
    item.lastAttemptAt = new Date();
    item.lastError = undefined;
    item.blockedReason = undefined;
    item.blockedAt = undefined;
  }

  /** Marks submit items 0..lastIndex as paused (not sent, no retry counted). Returns whether any were. */
  private pauseQueuedSubmissions(lastIndex: number): boolean {
    let paused = false;
    for (let index = Math.min(lastIndex, this.syncQueue.length - 1); index >= 0; index--) {
      const item = this.syncQueue[index];
      if (!item || item.type !== 'submit') continue;
      if (item.blockedReason === 'max_retries' || item.blockedReason === 'needs_confirmation' || item.blockedReason === 'auth_required') {
        continue;
      }
      item.blockedReason = 'sending_paused';
      item.blockedAt = new Date();
      paused = true;
    }
    return paused;
  }

  private retainFailedQueueItem(
    item: SyncQueueItem,
    error: unknown,
    blockedReason: NonNullable<SyncQueueItem['blockedReason']>,
  ): void {
    item.lastAttemptAt = new Date();
    item.lastError = getPrivacySafeErrorReason(error) || 'Sync did not complete.';
    item.blockedReason = blockedReason;
    item.blockedAt = blockedReason === 'retry_pending' ? undefined : new Date();
  }

  // Offline storage operations
  public async storeOfflineData(key: string, data: any, synced: boolean = false): Promise<void> {
    try {
      const item: OfflineStorageItem = {
        id: key,
        data,
        lastModified: new Date(),
        synced,
        pendingSync: !synced,
      };

      await encryptedAsyncStorage.setItem(`${OFFLINE_DATA_KEY_PREFIX}${key}`, JSON.stringify(item));
    } catch (error) {
      devPrivacyError('offline data store failed', { reason: getPrivacySafeErrorReason(error) });
      throw error;
    }
  }

  public async getOfflineData(key: string): Promise<OfflineStorageItem | null> {
    try {
      const data = await encryptedAsyncStorage.getItem(`${OFFLINE_DATA_KEY_PREFIX}${key}`);
      if (data) {
        const item = JSON.parse(data);
        return {
          ...item,
          lastModified: new Date(item.lastModified),
        };
      }
      return null;
    } catch (error) {
      devPrivacyError('offline data read failed', { reason: getPrivacySafeErrorReason(error) });
      return null;
    }
  }

  public async getAllOfflineData(prefix?: string): Promise<OfflineStorageItem[]> {
    try {
      const keys = await encryptedAsyncStorage.getAllKeys();
      const offlineKeys = keys.filter(key => 
        key.startsWith(OFFLINE_DATA_KEY_PREFIX) && 
        (!prefix || key.includes(prefix))
      );

      const items = await encryptedAsyncStorage.multiGet(offlineKeys);
      return items
        .map(([key, value]) => {
          if (value) {
            const item = JSON.parse(value);
            return {
              ...item,
              lastModified: new Date(item.lastModified),
            };
          }
          return null;
        })
        .filter((item): item is OfflineStorageItem => item !== null);
    } catch (error) {
      devPrivacyError('offline data list failed', { reason: getPrivacySafeErrorReason(error) });
      return [];
    }
  }

  public async deleteOfflineData(key: string): Promise<void> {
    try {
      await encryptedAsyncStorage.removeItem(`${OFFLINE_DATA_KEY_PREFIX}${key}`);
    } catch (error) {
      devPrivacyError('offline data delete failed', { reason: getPrivacySafeErrorReason(error) });
      throw error;
    }
  }

  public async markAsSynced(key: string): Promise<void> {
    try {
      const item = await this.getOfflineData(key);
      if (item) {
        item.synced = true;
        item.pendingSync = false;
        await encryptedAsyncStorage.setItem(`${OFFLINE_DATA_KEY_PREFIX}${key}`, JSON.stringify(item));
      }
    } catch (error) {
      devPrivacyError('offline data mark-synced failed', { reason: getPrivacySafeErrorReason(error) });
    }
  }

  // Sync operations
  public async startSync(force: boolean = false): Promise<void> {
    if (this.isSyncing && !force) {
      return;
    }

    if (this.privacyDeletePauseActive) {
      this.notifyCallbacks('error');
      return;
    }

    if (!this.isOnline) {
      this.notifyCallbacks('error');
      throw new Error('Cannot sync while offline');
    }

    // Sending is switched on only by a fresh server runtime config. While it
    // is off, queued reports stay on this phone, paused and unsent.
    if (!isCaseSubmissionEnabled()) {
      if (this.pauseQueuedSubmissions(this.syncQueue.length - 1)) {
        await this.saveSyncQueue();
        this.notifyCallbacks('error');
      }
      return;
    }

    const syncGeneration = this.privacyDeletePauseGeneration;
    this.isSyncing = true;
    this.notifyCallbacks('syncing');

    try {
      const totalItems = this.syncQueue.length;
      let processedItems = 0;
      let abortedForAuth = false;
      let abortedForPrivacyDelete = false;
      let retainedFailedItem = false;

      for (let i = this.syncQueue.length - 1; i >= 0; i--) {
        this.throwIfPrivacyDeletePaused(syncGeneration);
        const item = this.syncQueue[i];
        if (!item) {
          continue;
        }

        if ((item.blockedReason === 'max_retries' || item.blockedReason === 'needs_confirmation') && !force) {
          retainedFailedItem = true;
          continue;
        }

        // The switch can turn off mid-queue: this and every item not yet sent pause.
        if (!isCaseSubmissionEnabled()) {
          this.pauseQueuedSubmissions(i);
          retainedFailedItem = true;
          break;
        }
        
        try {
          this.clearQueueRecoveryState(item);
          await this.processSyncItem(item, syncGeneration);
          this.throwIfPrivacyDeletePaused(syncGeneration);
          
          // Remove from queue on success
          this.syncQueue.splice(i, 1);
          processedItems++;
          
          // Notify progress
          this.notifyCallbacks('syncing', processedItems / totalItems);
        } catch (error) {
          if (this.isPrivacyDeleteSyncCancelled(error)) {
            abortedForPrivacyDelete = true;
            break;
          }

          devPrivacyWarn('sync item processing failed', {
            reason: getPrivacySafeErrorReason(error),
            type: item.type,
            retryCount: item.retryCount,
          });

          // The survivor must confirm sharing with HURIA again (or turn it off);
          // retrying on its own would never succeed, so hold the item instead.
          if (error instanceof PartnerRoutingConflictError) {
            this.retainFailedQueueItem(item, error, 'needs_confirmation');
            retainedFailedItem = true;
            continue;
          }

          if (this.isAuthMissingError(error)) {
            this.retainFailedQueueItem(item, error, 'auth_required');
            devPrivacyWarn('auth session invalid during sync; retaining queue and signing out');
            await this.resetAuthSession();
            abortedForAuth = true;
            break;
          }
          
          // Increment retry count
          item.retryCount++;
          
          if (item.retryCount >= item.maxRetries) {
            devPrivacyWarn('sync item reached max retries', {
              type: item.type,
              maxRetries: item.maxRetries,
            });
            this.retainFailedQueueItem(item, error, 'max_retries');
            retainedFailedItem = true;
          } else {
            this.retainFailedQueueItem(item, error, 'retry_pending');
            retainedFailedItem = true;
          }
        }
      }

      await this.saveSyncQueue();
      this.notifyCallbacks(abortedForAuth || abortedForPrivacyDelete || retainedFailedItem ? 'error' : 'success');
    } catch (error) {
      if (this.isPrivacyDeleteSyncCancelled(error)) {
        await this.saveSyncQueue();
        this.notifyCallbacks('error');
        return;
      }

      devPrivacyError('sync run failed', { reason: getPrivacySafeErrorReason(error) });
      this.notifyCallbacks('error');
      throw error;
    } finally {
      this.isSyncing = false;
    }
  }

  private getErrorMessage(error: unknown): string {
    if (!error) return '';
    if (error instanceof Error && typeof error.message === 'string') {
      return error.message;
    }
    if (typeof error === 'string') {
      return error;
    }
    if (typeof error === 'object' && error !== null && 'message' in error) {
      const maybeMessage = (error as { message?: unknown }).message;
      if (typeof maybeMessage === 'string') {
        return maybeMessage;
      }
    }
    try {
      return JSON.stringify(error);
    } catch {
      return '';
    }
  }

  private isAuthMissingError(error: unknown): boolean {
    const message = this.getErrorMessage(error);
    if (!message) return false;
    const normalized = message.toLowerCase();

    return normalized.includes('invalid or expired token') ||
      normalized.includes('jwt verification failed') ||
      normalized.includes('no authenticated api session') ||
      normalized.includes('unauthorized') ||
      normalized.includes('not authenticated');
  }

  private async resetAuthSession(): Promise<void> {
    if (this.authResetInProgress) {
      return;
    }
    this.authResetInProgress = true;
    try {
      await authClient.signOut().catch(signOutError => {
        devPrivacyWarn('auth reset sign-out failed', {
          reason: getPrivacySafeErrorReason(signOutError),
        });
      });
    } finally {
      this.authResetInProgress = false;
    }
  }

  private async processSyncItem(item: SyncQueueItem, syncGeneration: number): Promise<void> {
    this.throwIfPrivacyDeletePaused(syncGeneration);
    const payload = item.data ?? {};

    if (item.type === 'submit') {
      if (!payload.draftId) {
        throw new Error('Submit sync payload missing draftId');
      }
      const draft = await draftStorage.getDraft(payload.draftId);
      if (!draft) {
        throw new Error('Draft not found for submission');
      }
      this.throwIfPrivacyDeletePaused(syncGeneration);
      await submitCase({
        draft,
        pathway: payload.pathway,
      });
      return;
    }

    if (payload.resource === 'draft') {
      devPrivacyWarn('obsolete draft sync queue item skipped', { type: item.type });
      return;
    }

    // Fallback: log and continue (prevents queue lock if payload type unknown)
    devPrivacyWarn('no sync handler for queued item', { type: item.type });
  }

  // Callback management
  public addSyncCallback(callback: (status: 'syncing' | 'success' | 'error', progress?: number) => void) {
    this.syncCallbacks.push(callback);
    return () => {
      const index = this.syncCallbacks.indexOf(callback);
      if (index > -1) {
        this.syncCallbacks.splice(index, 1);
      }
    };
  }

  private notifyCallbacks(status: 'syncing' | 'success' | 'error', progress?: number) {
    this.syncCallbacks.forEach(callback => callback(status, progress));
  }

  // Utility methods
  public async clearAllOfflineData(): Promise<void> {
    try {
      const keys = await encryptedAsyncStorage.getAllKeys();
      const offlineKeys = keys.filter(key => key.startsWith(OFFLINE_DATA_KEY_PREFIX));
      await encryptedAsyncStorage.multiRemove(offlineKeys);
    } catch (error) {
      devPrivacyError('offline data clear failed', { reason: getPrivacySafeErrorReason(error) });
      throw error;
    }
  }

  public async reset(options: { throwOnFailure?: boolean } = {}): Promise<void> {
    this.privacyDeletePauseActive = false;
    this.privacyDeletePauseGeneration += 1;
    this.syncQueue = [];
    const failures: string[] = [];

    try {
      await this.saveSyncQueue({ throwOnFailure: true });
    } catch (error) {
      failures.push('sync queue');
    }

    try {
      await this.clearAllOfflineData();
    } catch (error) {
      failures.push('offline cache');
    }

    if (options.throwOnFailure && failures.length > 0) {
      throw new Error(`Unable to clear all offline data (${failures.join(', ')}).`);
    }
  }

  public async getStorageInfo(): Promise<{
    totalItems: number;
    syncedItems: number;
    pendingItems: number;
    queueSize: number;
    storageSize: string;
  }> {
    try {
      const allItems = await this.getAllOfflineData();
      const syncedItems = allItems.filter(item => item.synced).length;
      const pendingItems = allItems.filter(item => item.pendingSync).length;
      
      // Calculate approximate storage size
      const keys = await encryptedAsyncStorage.getAllKeys();
      const offlineKeys = keys.filter(key => key.startsWith(OFFLINE_DATA_KEY_PREFIX));
      const storageData = await encryptedAsyncStorage.multiGet(offlineKeys);
      const storageSize = storageData.reduce((total, [_, value]) => 
        total + (value ? JSON.stringify(value).length : 0), 0
      );

      return {
        totalItems: allItems.length,
        syncedItems,
        pendingItems,
        queueSize: this.syncQueue.length,
        storageSize: this.formatBytes(storageSize),
      };
    } catch (error) {
      devPrivacyError('offline storage info failed', { reason: getPrivacySafeErrorReason(error) });
      return {
        totalItems: 0,
        syncedItems: 0,
        pendingItems: 0,
        queueSize: 0,
        storageSize: '0 B',
      };
    }
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}

export function buildSyncQueueRecoveryMessage(items: SyncQueueItem[]): string | null {
  if (!items.length) return null;

  if (items.some(item => item.blockedReason === 'auth_required')) {
    return 'Optional online sync needs attention. The local copy and evidence remain saved on this device.';
  }

  if (items.some(item => item.blockedReason === 'sending_paused')) {
    return CASE_SUBMISSION_COPY.pausedRecovery;
  }

  if (items.some(item => item.blockedReason === 'needs_confirmation')) {
    return 'A report is waiting for you to confirm sharing with HURIA, or to turn it off. Open the case to review. Nothing has been sent.';
  }

  if (items.some(item => item.blockedReason === 'max_retries')) {
    return 'Some optional online sync work needs a manual retry. The local copy and evidence remain saved on this device.';
  }

  if (items.some(item => item.lastError || item.retryCount > 0 || item.blockedReason === 'retry_pending')) {
    return 'Optional online sync did not complete. Local records remain saved on this device.';
  }

  return `${items.length} optional online sync item(s) saved on this device.`;
}

// Export singleton instance
export const offlineSyncManager = new OfflineSyncManager();

// Convenience functions for common operations
export const storeOffline = offlineSyncManager.storeOfflineData.bind(offlineSyncManager);
export const getOffline = offlineSyncManager.getOfflineData.bind(offlineSyncManager);
export const deleteOffline = offlineSyncManager.deleteOfflineData.bind(offlineSyncManager);
export const syncNow = offlineSyncManager.startSync.bind(offlineSyncManager);
export const isOnline = offlineSyncManager.isNetworkAvailable.bind(offlineSyncManager);
export const addToQueue = offlineSyncManager.addToSyncQueue.bind(offlineSyncManager);
export const removeSubmitQueueForDraft = offlineSyncManager.removeSubmitQueueItemsForDraft.bind(offlineSyncManager);
export const removeQueueForDraft = offlineSyncManager.removeQueueItemsForDraft.bind(offlineSyncManager);
export const getSyncStatus = () => ({
  queueSize: offlineSyncManager.getSyncQueueSize(),
  isOnline: offlineSyncManager.isNetworkAvailable(),
});
