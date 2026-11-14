import React from 'react';
import { describe, expect, it, vi } from 'vitest';

const { renderToStaticMarkup } = require('react-dom/server') as {
  renderToStaticMarkup: (node: React.ReactNode) => string;
};

vi.mock('react-native', () => ({
  Appearance: {
    getColorScheme: vi.fn(() => 'dark'),
    addChangeListener: vi.fn(() => ({ remove: vi.fn() })),
  },
}));

vi.mock('react-native-paper', () => {
  const lightTheme = { dark: false, roundness: 0, colors: { elevation: {} } };
  const darkTheme = { dark: true, roundness: 0, colors: { elevation: {} } };

  return {
    MD3DarkTheme: darkTheme,
    MD3LightTheme: lightTheme,
    PaperProvider: ({ children }: { children: React.ReactNode }) => children,
  };
});

vi.mock('../lib/storage', () => ({
  Storage: {
    getSettings: vi.fn(),
    saveSettings: vi.fn(),
  },
}));

import {
  SimpleThemeProvider,
  useTheme,
  type ThemeContextType,
} from './SimpleThemeProvider';

function renderTheme(initialTheme?: ThemeContextType['theme'], initialVisualStyle?: ThemeContextType['visualStyle']): ThemeContextType {
  let observedTheme: ThemeContextType | undefined;

  function ThemeProbe() {
    observedTheme = useTheme();
    return null;
  }

  renderToStaticMarkup(
    React.createElement(
      SimpleThemeProvider,
      { initialTheme, initialVisualStyle, children: React.createElement(ThemeProbe) },
    ),
  );

  if (!observedTheme) {
    throw new Error('Theme provider did not render its child.');
  }

  return observedTheme;
}

describe('SimpleThemeProvider defaults', () => {
  it('starts in warm light even when the operating system is dark', () => {
    expect(renderTheme()).toMatchObject({
      theme: 'light',
      mode: 'light',
      colorScheme: 'light',
      isHighContrast: false,
      visualStyle: 'warm',
    });
  });

  it('respects explicit light and dark preferences', () => {
    expect(renderTheme('light')).toMatchObject({
      theme: 'light',
      mode: 'light',
      colorScheme: 'light',
      isHighContrast: false,
    });
    expect(renderTheme('dark')).toMatchObject({
      theme: 'dark',
      mode: 'dark',
      colorScheme: 'dark',
      isHighContrast: false,
    });
  });

  it('still resolves explicitly injected system and high-contrast preferences', () => {
    expect(renderTheme('system')).toMatchObject({
      theme: 'system',
      mode: 'dark',
      colorScheme: 'dark',
    });
    expect(renderTheme('highContrast')).toMatchObject({
      theme: 'highContrast',
      mode: 'highContrast',
      colorScheme: 'light',
      isHighContrast: true,
    });
  });

  it('uses the selected look in Paper and screen colors without changing dark or high contrast', () => {
    const classic = renderTheme('dark', 'classic');
    expect(classic.visualStyle).toBe('classic');
    expect(classic.mode).toBe('dark');
    expect(classic.paperTheme.colors.background).toBe(classic.colors.canvas);
    expect(classic.colors.primary).not.toBe(renderTheme('dark', 'warm').colors.primary);
    expect(renderTheme('highContrast', 'classic').colors).toEqual(renderTheme('highContrast', 'warm').colors);
  });
});
