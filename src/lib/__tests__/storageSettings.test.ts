import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  secureItems: new Map<string, string>(),
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => mockState.secureItems.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    mockState.secureItems.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    mockState.secureItems.delete(key);
  }),
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
}));

import { Storage } from '../storage';

describe('Storage safety settings', () => {
  beforeEach(() => {
    mockState.secureItems.clear();
  });

  it('defaults to a supported stealth trigger and persists settings durably', async () => {
    expect((await Storage.getSettings()).stealthTrigger).toBe('shake');

    await Storage.saveSettings({
      stealthTrigger: 'tap',
      stealthHapticsEnabled: false,
      stealthAutoRecordEnabled: false,
    });

    expect(await Storage.getSettings()).toMatchObject({
      stealthTrigger: 'tap',
      stealthHapticsEnabled: false,
      stealthAutoRecordEnabled: false,
    });
    expect(JSON.parse(mockState.secureItems.get('app_settings') ?? '{}')).toMatchObject({
      stealthTrigger: 'tap',
      stealthHapticsEnabled: false,
      stealthAutoRecordEnabled: false,
    });
  });

  it('uses warm light for fresh or incomplete settings without changing safety preferences', async () => {
    expect(await Storage.getSettings()).toMatchObject({ theme: 'light', visualStyle: 'warm' });
    mockState.secureItems.set('app_settings', JSON.stringify({ stealthTrigger: 'tap', autoLocation: false }));
    expect(await Storage.getSettings()).toMatchObject({
      theme: 'light', visualStyle: 'warm', stealthTrigger: 'tap', autoLocation: false,
    });
  });

  it('retains each saved display preference and look across reads', async () => {
    for (const theme of ['light', 'dark', 'system', 'highContrast'] as const) {
      await Storage.saveSettings({ theme, visualStyle: 'classic' });
      expect(await Storage.getSettings()).toMatchObject({ theme, visualStyle: 'classic' });
    }
  });

  it('persists high contrast and uses the landing default for corrupt theme values', async () => {
    await Storage.saveSettings({ theme: 'highContrast' });
    expect((await Storage.getSettings()).theme).toBe('highContrast');

    mockState.secureItems.set('app_settings', JSON.stringify({ theme: 'neon' }));
    expect((await Storage.getSettings()).theme).toBe('light');
  });

  it('persists the look while preserving theme and safety preferences across reads', async () => {
    await Storage.saveSettings({ theme: 'dark', stealthTrigger: 'tap', autoLocation: false, autoBackup: false });
    await Storage.saveSettings({ visualStyle: 'classic' });
    expect(await Storage.getSettings()).toMatchObject({
      visualStyle: 'classic', theme: 'dark', stealthTrigger: 'tap', autoLocation: false, autoBackup: false,
    });
    await Storage.saveSettings({ theme: 'highContrast' });
    expect(await Storage.getSettings()).toMatchObject({ visualStyle: 'classic', theme: 'highContrast' });
  });

  it('uses warm for legacy or malformed looks without resetting saved safety settings', async () => {
    for (const visualStyle of [undefined, null, 'unsupported']) {
      mockState.secureItems.set('app_settings', JSON.stringify({ visualStyle, theme: 'dark', stealthTrigger: 'tap' }));
      expect(await Storage.getSettings()).toMatchObject({ visualStyle: 'warm', theme: 'dark', stealthTrigger: 'tap' });
    }
  });

  it('retains concurrent appearance and safety updates instead of overwriting either', async () => {
    await Promise.all([
      Storage.saveSettings({ visualStyle: 'classic' }),
      Storage.saveSettings({ theme: 'dark' }),
      Storage.saveSettings({ stealthTrigger: 'tap', autoLocation: false }),
    ]);
    expect(await Storage.getSettings()).toMatchObject({
      visualStyle: 'classic', theme: 'dark', stealthTrigger: 'tap', autoLocation: false,
    });
  });
});
