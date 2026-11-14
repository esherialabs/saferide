import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Appearance, ColorSchemeName } from 'react-native';
import { MD3DarkTheme, MD3LightTheme, PaperProvider, type MD3Theme } from 'react-native-paper';
import {
  radii,
  safeRideTokens,
  semanticStates,
  themeColors,
  type SafeRideTokens,
  type ThemeColors,
  type ThemeMode,
  type ThemePreference,
} from './tokens';
import { Storage } from '../lib/storage';
import { getVisualStyleColors, normalizeVisualStyle, type VisualStyle } from './visualStyles';

export type Theme = ThemePreference;
export type ResolvedColorScheme = 'light' | 'dark';

export interface ThemeContextType {
  theme: ThemePreference;
  mode: ThemeMode;
  colorScheme: ResolvedColorScheme;
  colors: ThemeColors;
  tokens: SafeRideTokens;
  semanticStates: typeof semanticStates;
  paperTheme: MD3Theme;
  isHighContrast: boolean;
  visualStyle: VisualStyle;
  setVisualStyle: (style: VisualStyle) => Promise<void>;
  setTheme: (theme: ThemePreference) => Promise<void>;
}

function toResolvedColorScheme(colorScheme: ColorSchemeName | null | undefined): ResolvedColorScheme {
  return colorScheme === 'dark' ? 'dark' : 'light';
}

function resolveThemeMode(theme: ThemePreference, systemColorScheme: ResolvedColorScheme): ThemeMode {
  if (theme === 'system') {
    return systemColorScheme;
  }

  return theme;
}

function buildPaperTheme(mode: ThemeMode, style: VisualStyle = 'warm'): MD3Theme {
  const baseTheme = mode === 'dark' ? MD3DarkTheme : MD3LightTheme;
  const colors = getVisualStyleColors(style, mode);
  const isDark = mode === 'dark';

  return {
    ...baseTheme,
    dark: isDark,
    roundness: radii.md,
    colors: {
      ...baseTheme.colors,
      primary: colors.primary,
      onPrimary: colors.primaryForeground,
      primaryContainer: colors.primaryMuted,
      onPrimaryContainer: colors.primary,
      secondary: colors.evidence,
      onSecondary: colors.evidenceForeground,
      secondaryContainer: colors.evidenceMuted,
      onSecondaryContainer: colors.evidence,
      tertiary: colors.privacy,
      onTertiary: colors.privacyForeground,
      tertiaryContainer: colors.privacyMuted,
      onTertiaryContainer: colors.privacy,
      error: colors.destructive,
      onError: colors.destructiveForeground,
      errorContainer: colors.dangerMuted,
      onErrorContainer: colors.destructive,
      background: colors.background,
      onBackground: colors.foreground,
      surface: colors.surface,
      onSurface: colors.foreground,
      surfaceVariant: colors.surfaceAlt,
      onSurfaceVariant: colors.textSecondary,
      outline: colors.border,
      outlineVariant: colors.divider,
      shadow: isDark ? 'rgba(0,0,0,0.64)' : 'rgba(17,24,39,0.24)',
      scrim: colors.scrim,
      inverseSurface: colors.foreground,
      inverseOnSurface: colors.textInverse,
      inversePrimary: colors.primaryForeground,
      backdrop: colors.scrim,
      elevation: {
        ...baseTheme.colors.elevation,
        level0: 'transparent',
        level1: colors.surface,
        level2: colors.surfaceAlt,
        level3: colors.surfaceAlt,
        level4: colors.surfaceAlt,
        level5: colors.surfaceAlt,
      },
    },
  };
}

export const safeRidePaperThemes: Record<ThemeMode, MD3Theme> = {
  light: buildPaperTheme('light'),
  dark: buildPaperTheme('dark'),
  highContrast: buildPaperTheme('highContrast'),
};

const defaultMode: ThemeMode = 'light';
const defaultPaperTheme = safeRidePaperThemes[defaultMode];

const defaultThemeContext: ThemeContextType = {
  theme: 'light',
  mode: defaultMode,
  colorScheme: 'light',
  colors: themeColors[defaultMode],
  tokens: safeRideTokens,
  semanticStates,
  paperTheme: defaultPaperTheme,
  isHighContrast: false,
  visualStyle: 'warm',
  setVisualStyle: async () => {},
  setTheme: async () => {},
};

const ThemeContext = createContext<ThemeContextType>(defaultThemeContext);

export function SimpleThemeProvider({
  children,
  initialTheme = 'light',
  initialVisualStyle = 'warm',
}: {
  children: React.ReactNode;
  initialTheme?: ThemePreference;
  initialVisualStyle?: VisualStyle;
}) {
  const [theme, setThemeState] = useState<ThemePreference>(initialTheme);
  const [visualStyle, setVisualStyleState] = useState<VisualStyle>(initialVisualStyle);
  const [systemColorScheme, setSystemColorScheme] = useState<ResolvedColorScheme>(() =>
    toResolvedColorScheme(Appearance.getColorScheme()),
  );

  useEffect(() => {
    const subscription = Appearance.addChangeListener(({ colorScheme }) => {
      setSystemColorScheme(toResolvedColorScheme(colorScheme));
    });

    return () => subscription.remove();
  }, []);

  useEffect(() => {
    let mounted = true;

    Storage.getSettings()
      .then(settings => {
        if (mounted) {
          setThemeState(settings.theme);
          setVisualStyleState(normalizeVisualStyle(settings.visualStyle));
        }
      })
      .catch(() => undefined);

    return () => {
      mounted = false;
    };
  }, []);

  const setTheme = useCallback(async (nextTheme: ThemePreference) => {
    await Storage.saveSettings({ theme: nextTheme });
    setThemeState(nextTheme);
  }, []);

  const mode = useMemo(() => resolveThemeMode(theme, systemColorScheme), [theme, systemColorScheme]);
  const setVisualStyle = useCallback(async (nextStyle: VisualStyle) => {
    await Storage.saveSettings({ visualStyle: nextStyle });
    setVisualStyleState(nextStyle);
  }, []);
  const colorScheme: ResolvedColorScheme = mode === 'dark' ? 'dark' : 'light';
  const colors = getVisualStyleColors(visualStyle, mode);
  const paperTheme = useMemo(() => buildPaperTheme(mode, visualStyle), [mode, visualStyle]);

  const contextValue = useMemo<ThemeContextType>(
    () => ({
      theme,
      mode,
      colorScheme,
      colors,
      tokens: safeRideTokens,
      semanticStates,
      paperTheme,
      isHighContrast: mode === 'highContrast',
      visualStyle,
      setVisualStyle,
      setTheme,
    }),
    [colorScheme, colors, mode, paperTheme, theme, visualStyle, setVisualStyle, setTheme],
  );

  return (
    <ThemeContext.Provider value={contextValue}>
      <PaperProvider theme={paperTheme}>{children}</PaperProvider>
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
