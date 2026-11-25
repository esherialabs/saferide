import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
const storage = vi.hoisted(() => ({ saveSettings: vi.fn(), getSettings: vi.fn() }));

vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = state.cursor++;
      if (!(index in state.values)) {
        state.values[index] = typeof initial === 'function' ? initial() : initial;
      }
      return [state.values[index], (value: unknown) => { state.values[index] = value; }];
    },
    useEffect: vi.fn(),
    useCallback: (callback: unknown) => callback,
    useMemo: (factory: () => unknown) => factory(),
  };
});
vi.mock('react-native', () => ({ Appearance: { getColorScheme: () => 'dark' } }));
vi.mock('react-native-paper', () => ({
  MD3LightTheme: { colors: { elevation: {} } },
  MD3DarkTheme: { colors: { elevation: {} } },
  PaperProvider: () => null,
}));
vi.mock('../lib/storage', () => ({ Storage: storage }));

import { SimpleThemeProvider, type ThemeContextType } from './SimpleThemeProvider';

function renderProvider() {
  state.cursor = 0;
  return SimpleThemeProvider({ children: null }).props.value as ThemeContextType;
}

beforeEach(() => {
  state.values = [];
  storage.saveSettings.mockReset();
});

describe('display-mode protected-settings persistence', () => {
  it('applies a new display mode only after its save resolves and keeps the selected look', async () => {
    let completeSave!: () => void;
    storage.saveSettings.mockReturnValueOnce(new Promise<void>(resolve => { completeSave = resolve; }));
    const saving = renderProvider().setTheme('dark');

    expect(storage.saveSettings).toHaveBeenCalledWith({ theme: 'dark' });
    expect(renderProvider()).toMatchObject({ theme: 'light', visualStyle: 'warm' });
    completeSave();
    await saving;
    expect(renderProvider()).toMatchObject({ theme: 'dark', mode: 'dark', visualStyle: 'warm' });
  });

  it('rejects a failed save without changing the mode and permits a successful retry', async () => {
    storage.saveSettings.mockRejectedValueOnce(new Error('Synthetic protected-storage failure'));
    await expect(renderProvider().setTheme('highContrast')).rejects.toThrow('Synthetic protected-storage failure');
    expect(renderProvider()).toMatchObject({ theme: 'light', isHighContrast: false, visualStyle: 'warm' });

    storage.saveSettings.mockResolvedValueOnce(undefined);
    await renderProvider().setTheme('highContrast');
    expect(renderProvider()).toMatchObject({ theme: 'highContrast', isHighContrast: true, visualStyle: 'warm' });
  });
});
