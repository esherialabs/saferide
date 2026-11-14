import AsyncStorage from '@react-native-async-storage/async-storage';
import { describe, expect, it } from 'vitest';

import { encryptedAsyncStorage, isEncryptedAsyncStorageEnvelope } from '../../lib/encryptedAsyncStorage';
import {
  PERSISTENCE_KEY,
  createNavigationStatePersister,
  normalizeRestoredNavigationState,
  type NavigationStateStore,
  type PersistedNavigationState,
} from '../navigationStatePersistence';

function buildMainTabsState(reportState: PersistedNavigationState): PersistedNavigationState {
  return {
    index: 0,
    routes: [
      {
        name: 'MainTabs',
        state: {
          index: 1,
          routes: [
            { name: 'Home' },
            { name: 'Report', state: reportState },
            { name: 'Support' },
            { name: 'Learn' },
          ],
        },
      },
    ],
  };
}

describe('normalizeRestoredNavigationState', () => {
  it('repairs duplicate workspaces left by Cases resume while retaining the current draft and screen', () => {
    const latest = buildMainTabsState({
      index: 1, routes: [
        { name: 'ReportHome' },
        { name: 'WhereWhen', params: { draftId: 'draft-1' } },
      ],
    }).routes![0];
    latest.key = 'current-workspace';
    const restored: PersistedNavigationState = {
      key: 'root', index: 3,
      routes: [
        { name: 'MainTabs', key: 'old-workspace' },
        { name: 'Cases', key: 'old-cases' },
        latest,
        { name: 'Cases', key: 'current-cases' },
      ],
    };
    const normalized = normalizeRestoredNavigationState(restored, new Set(['draft-1']));
    expect(normalized?.routes?.map(route => route.key)).toEqual(['current-workspace', 'current-cases']);
    expect(normalized?.index).toBe(1);
    expect(normalized?.routes?.[0].state?.routes?.[1].state?.routes?.[1].params?.draftId).toBe('draft-1');
    expect(restored.routes).toHaveLength(4);
  });

  it('resets a restored report stack when the active draft route is missing locally', () => {
    const restored = buildMainTabsState({
      index: 1,
      routes: [
        { name: 'ReportHome' },
        {
          name: 'ConsentGate',
          params: { draftId: 'missing-draft', pathway: 'save-private' },
        },
      ],
    });

    const normalized = normalizeRestoredNavigationState(restored, new Set(['other-draft']));
    const reportState = normalized?.routes?.[0].state?.routes?.[1].state;

    expect(reportState?.index).toBe(0);
    expect(reportState?.routes).toEqual([{ name: 'ReportHome' }]);
  });

  it('lets Cases close directly after an upgrade with completed editor history underneath', () => {
    const restored = buildMainTabsState({
      index: 2, routes: [
        { name: 'ReportHome' },
        { name: 'WhereWhen', params: { draftId: 'finished-draft' } },
        { name: 'ConsentGate', params: { draftId: 'finished-draft' } },
      ],
    });
    restored.routes!.push({ name: 'Cases' });
    restored.index = 1;
    const normalized = normalizeRestoredNavigationState(restored, new Set(['finished-draft']), new Set(['finished-draft']));
    expect(normalized?.routes?.map(route => route.name)).toEqual(['MainTabs', 'Cases']);
    expect(normalized?.index).toBe(1);
    expect(normalized?.routes?.[0].state?.routes?.[1].state?.routes).toEqual([{ name: 'ReportHome' }]);
  });

  it('preserves explicit amendment routes and incomplete draft state during history repair', () => {
    const restored = buildMainTabsState({
      index: 1, routes: [
        { name: 'ReportHome' },
        { name: 'WhatHappened', params: { draftId: 'finished-draft', editCompleted: true } },
      ],
    });
    const normalized = normalizeRestoredNavigationState(restored, new Set(['finished-draft']), new Set(['finished-draft']));
    expect(normalized?.routes?.[0].state?.routes?.[1].state?.routes?.[1].params).toEqual({ draftId: 'finished-draft', editCompleted: true });
  });

  it('does not replay stale navigator params over the repaired materialized draft state', () => {
    const restored = buildMainTabsState({
      index: 0, routes: [{ name: 'ReportHome' }],
    });
    const main = restored.routes![0];
    main.params = { screen: 'Report', params: { state: {
      index: 1, routes: [{ name: 'ReportHome' }, { name: 'ConsentGate', params: { draftId: 'finished-draft' } }],
    } } };
    const report = main.state!.routes![1];
    report.params = { state: main.params.params, screen: 'ConsentGate', params: { draftId: 'finished-draft' }, initial: false };
    const normalized = normalizeRestoredNavigationState(restored, new Set(['finished-draft']), new Set(['finished-draft']));
    expect(normalized?.routes?.[0].params).toEqual({});
    expect(normalized?.routes?.[0].state?.routes?.[1].params).toEqual({});
    expect(normalized?.routes?.[0].state?.routes?.[1].state?.routes).toEqual([{ name: 'ReportHome' }]);
    expect(main.params.screen).toBe('Report');
  });

  it('retains post-completion referral actions while removing obsolete editor history', () => {
    const restored = buildMainTabsState({
      index: 1, routes: [
        { name: 'ReportHome' },
        { name: 'ConsentGate', params: { draftId: 'finished-draft' } },
      ],
    });
    restored.routes!.push({ name: 'ReferralPicker', params: { draftId: 'finished-draft' } });
    restored.index = 1;
    const normalized = normalizeRestoredNavigationState(restored, new Set(['finished-draft']), new Set(['finished-draft']));
    expect(normalized?.routes?.map(route => route.name)).toEqual(['MainTabs', 'ReferralPicker']);
    expect(normalized?.routes?.[0].state?.routes?.[1].state?.routes).toEqual([{ name: 'ReportHome' }]);
  });

  it('keeps a restored report draft route when the draft still exists locally', () => {
    const restored = buildMainTabsState({
      index: 1,
      routes: [
        { name: 'ReportHome' },
        {
          name: 'ConsentGate',
          params: { draftId: 'draft-1', pathway: 'save-private' },
        },
      ],
    });

    const normalized = normalizeRestoredNavigationState(restored, new Set(['draft-1']));
    const reportState = normalized?.routes?.[0].state?.routes?.[1].state;

    expect(reportState?.index).toBe(1);
    expect(reportState?.routes?.[1]).toEqual({
      name: 'ConsentGate',
      params: { draftId: 'draft-1', pathway: 'save-private' },
    });
  });

  it('allows draftless step one restore because no local draft exists before step one data is saved', () => {
    const restored = buildMainTabsState({
      index: 1,
      routes: [
        { name: 'ReportHome' },
        { name: 'WhatHappened' },
      ],
    });

    const normalized = normalizeRestoredNavigationState(restored, new Set());
    const reportState = normalized?.routes?.[0].state?.routes?.[1].state;

    expect(reportState?.index).toBe(1);
    expect(reportState?.routes?.[1]).toEqual({ name: 'WhatHappened' });
  });

  it('drops legacy persisted tab state instead of restoring unknown tabs', () => {
    const restored: PersistedNavigationState = {
      index: 0,
      routes: [
        {
          name: 'MainTabs',
          state: {
            index: 1,
            routes: [
              { name: 'Home' },
              { name: 'Report' },
              { name: 'LegacyChat' },
            ],
          },
        },
      ],
    };

    expect(normalizeRestoredNavigationState(restored, new Set())).toBeUndefined();
  });
});

describe('createNavigationStatePersister', () => {
  const draftState = buildMainTabsState({
    index: 1,
    routes: [
      { name: 'ReportHome' },
      { name: 'EvidenceDetail', params: { draftId: 'draft-sensitive-123' } },
    ],
  });

  it('stores navigation history as an encrypted envelope without draft IDs in clear text', async () => {
    const persister = createNavigationStatePersister(encryptedAsyncStorage);

    await persister.save(draftState);

    const raw = await AsyncStorage.getItem(PERSISTENCE_KEY);
    expect(isEncryptedAsyncStorageEnvelope(raw)).toBe(true);
    expect(raw).not.toContain('draft-sensitive-123');
    expect(raw).not.toContain('EvidenceDetail');
    expect(JSON.parse(await encryptedAsyncStorage.getItem(PERSISTENCE_KEY) ?? 'null')).toEqual(draftState);
  });

  it('re-encrypts plaintext history saved by earlier builds on first read', async () => {
    await AsyncStorage.setItem(PERSISTENCE_KEY, JSON.stringify(draftState));

    expect(JSON.parse(await encryptedAsyncStorage.getItem(PERSISTENCE_KEY) ?? 'null')).toEqual(draftState);
    const raw = await AsyncStorage.getItem(PERSISTENCE_KEY);
    expect(isEncryptedAsyncStorageEnvelope(raw)).toBe(true);
    expect(raw).not.toContain('draft-sensitive-123');
  });

  it('applies saves and clears in call order when the store resolves out of order', async () => {
    const values = new Map<string, string>();
    const delays = [30, 0, 10];
    const store: NavigationStateStore = {
      async getItem(key) {
        return values.get(key) ?? null;
      },
      async setItem(key, value) {
        await new Promise(resolve => setTimeout(resolve, delays.shift() ?? 0));
        values.set(key, value);
      },
      async removeItem(key) {
        values.delete(key);
      },
    };
    const persister = createNavigationStatePersister(store);

    void persister.save({ index: 0, step: 'first' });
    void persister.save({ index: 0, step: 'second' });
    const cleared = persister.clear();
    const latest = persister.save({ index: 0, step: 'after-clear' });

    await cleared;
    expect(values.has(PERSISTENCE_KEY)).toBe(false);
    await latest;
    expect(JSON.parse(values.get(PERSISTENCE_KEY) ?? 'null')).toEqual({ index: 0, step: 'after-clear' });
  });

  it('re-encrypts legacy plaintext inside the queue, before a later save lands', async () => {
    const persister = createNavigationStatePersister(encryptedAsyncStorage);
    await AsyncStorage.setItem(PERSISTENCE_KEY, JSON.stringify({ index: 0, step: 'legacy' }));

    const loaded = persister.load();
    const saved = persister.save({ index: 0, step: 'newer' });
    expect(JSON.parse(await loaded ?? 'null')).toEqual({ index: 0, step: 'legacy' });
    await saved;

    const raw = await AsyncStorage.getItem(PERSISTENCE_KEY);
    expect(isEncryptedAsyncStorageEnvelope(raw)).toBe(true);
    expect(JSON.parse(await encryptedAsyncStorage.getItem(PERSISTENCE_KEY) ?? 'null'))
      .toEqual({ index: 0, step: 'newer' });
  });

  it('removes stored history it cannot read instead of leaving plaintext behind', async () => {
    const values = new Map<string, string>([[PERSISTENCE_KEY, JSON.stringify(draftState)]]);
    const store: NavigationStateStore = {
      async getItem() {
        throw new Error('SecureStore is not available for encrypted local persistence.');
      },
      async setItem(key, value) {
        values.set(key, value);
      },
      async removeItem(key) {
        values.delete(key);
      },
    };
    const persister = createNavigationStatePersister(store);

    await expect(persister.load()).rejects.toThrow(/SecureStore/);
    expect(values.has(PERSISTENCE_KEY)).toBe(false);
    await persister.save({ index: 2 });
    expect(values.get(PERSISTENCE_KEY)).toBe(JSON.stringify({ index: 2 }));
  });

  it('keeps later writes going after a failed write', async () => {
    const values = new Map<string, string>();
    let failNext = true;
    const store: NavigationStateStore = {
      async getItem(key) {
        return values.get(key) ?? null;
      },
      async setItem(key, value) {
        if (failNext) {
          failNext = false;
          throw new Error('keystore unavailable');
        }
        values.set(key, value);
      },
      async removeItem(key) {
        values.delete(key);
      },
    };
    const persister = createNavigationStatePersister(store);

    await expect(persister.save({ index: 0 })).resolves.toBeUndefined();
    await persister.save({ index: 1 });
    expect(values.get(PERSISTENCE_KEY)).toBe(JSON.stringify({ index: 1 }));
  });
});
