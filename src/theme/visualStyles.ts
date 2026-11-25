import { themeColors, type ThemeColors, type ThemeMode } from './tokens';

export type VisualStyle = 'warm' | 'classic';

export function normalizeVisualStyle(value: unknown): VisualStyle {
  return value === 'classic' ? 'classic' : 'warm';
}

// The familiar bright lavender look, with the same safety-state meanings.
const classicLight: ThemeColors = {
  ...themeColors.light,
  canvas: '#FCFAFF', background: '#FCFAFF', surface: '#F6EEFC',
  surfaceAlt: '#F5F1FC', parchment: '#FAF3E5', card: '#F6EEFC', popover: '#F6EEFC',
  foreground: '#22251F', textPrimary: '#22251F', textSecondary: '#55554D',
  textTertiary: '#706D64', cardForeground: '#22251F', popoverForeground: '#22251F',
  border: '#D9D6CE', divider: '#D9D6CE', input: '#8A857A', chipBorder: '#8A857A',
  primary: '#7045A0', primaryMuted: '#F0E8FC', primaryDisabled: '#A58FB2',
  primaryGradientStart: '#7045A0', primaryGradientEnd: '#7045A0',
  ring: '#7045A0', focusRing: '#7045A0', chipSelectedBorder: '#7045A0',
  secondary: '#F5F1FC', secondaryForeground: '#2E302A', muted: '#F5F1FC',
  mutedForeground: '#706D64', accent: '#F0E8FC', accentForeground: '#7045A0',
  chipDisabledBackground: '#F5F1FC', chipDisabledBorder: '#BBB8AE',
  privacy: '#714268', privacyMuted: '#F3E7F0',
};

const classicDark: ThemeColors = {
  ...themeColors.dark,
  canvas: '#121713', background: '#121713', surface: '#1B241F',
  surfaceAlt: '#25312A', parchment: '#3B3528', card: '#1B241F', popover: '#1B241F',
  foreground: '#F4F7F5', textPrimary: '#F4F7F5', textSecondary: '#CBD5CE',
  textTertiary: '#A9B8AE', textInverse: '#12150F',
  cardForeground: '#F4F7F5', popoverForeground: '#F4F7F5',
  border: '#536159', divider: '#3A493F', input: '#83958E', chipBorder: '#83958E',
  primary: '#CBB5DE', primaryForeground: '#2C1834', primaryMuted: '#35243F',
  primaryDisabled: '#776581', primaryGradientStart: '#CBB5DE', primaryGradientEnd: '#CBB5DE',
  ring: '#CBB5DE', focusRing: '#CBB5DE', chipSelectedBorder: '#CBB5DE',
  secondary: '#25312A', secondaryForeground: '#F4F7F5', muted: '#25312A',
  mutedForeground: '#CBD5CE', accent: '#35243F', accentForeground: '#CBB5DE',
  chipDisabledBackground: '#25312A', chipDisabledBorder: '#3A493F',
  privacy: '#DEB6D3', privacyMuted: '#3D2638', privacyForeground: '#2B1727',
};

export function getVisualStyleColors(style: VisualStyle, mode: ThemeMode): ThemeColors {
  // Accessibility contrast has priority over the decorative look.
  if (mode === 'highContrast' || style === 'warm') return themeColors[mode];
  return mode === 'dark' ? classicDark : classicLight;
}
