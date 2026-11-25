export type ThemeMode = 'light' | 'dark' | 'highContrast';
export type ThemePreference = ThemeMode | 'system';

export function normalizeThemePreference(
  value: unknown,
  fallback: ThemePreference = 'system',
): ThemePreference {
  return value === 'light' ||
    value === 'dark' ||
    value === 'highContrast' ||
    value === 'system'
    ? value
    : fallback;
}

export type SemanticStateName =
  | 'critical'
  | 'safety'
  | 'warning'
  | 'offline'
  | 'queued'
  | 'consent'
  | 'evidence'
  | 'support'
  | 'case'
  | 'success'
  | 'destructive'
  | 'privacy'
  | 'info'
  | 'unavailable';

export interface ThemeColors {
  canvas: string;
  background: string;
  surface: string;
  surfaceAlt: string;
  parchment: string;
  foreground: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  textInverse: string;
  border: string;
  divider: string;
  input: string;
  ring: string;
  focusRing: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  chipBorder: string;
  chipSelectedBorder: string;
  chipDisabledBorder: string;
  chipDisabledBackground: string;
  chipPressedOverlay: string;
  primary: string;
  primaryForeground: string;
  primaryMuted: string;
  primaryDisabled: string;
  primaryGradientStart: string;
  primaryGradientEnd: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  destructiveForeground: string;
  dangerMuted: string;
  critical: string;
  criticalForeground: string;
  criticalMuted: string;
  success: string;
  successForeground: string;
  successMuted: string;
  warning: string;
  warningForeground: string;
  warningMuted: string;
  info: string;
  infoForeground: string;
  infoMuted: string;
  safety: string;
  safetyForeground: string;
  safetyMuted: string;
  offline: string;
  offlineForeground: string;
  offlineMuted: string;
  queued: string;
  queuedForeground: string;
  queuedMuted: string;
  consent: string;
  consentForeground: string;
  consentMuted: string;
  evidence: string;
  evidenceForeground: string;
  evidenceMuted: string;
  support: string;
  supportForeground: string;
  supportMuted: string;
  case: string;
  caseForeground: string;
  caseMuted: string;
  privacy: string;
  privacyForeground: string;
  privacyMuted: string;
  unavailable: string;
  unavailableForeground: string;
  unavailableMuted: string;
  overlay: string;
  scrim: string;
}

type SemanticColorRole = keyof Pick<
  ThemeColors,
  | 'safety'
  | 'warning'
  | 'offline'
  | 'queued'
  | 'consent'
  | 'evidence'
  | 'support'
  | 'case'
  | 'success'
  | 'destructive'
  | 'critical'
  | 'privacy'
  | 'info'
  | 'unavailable'
>;

type SemanticMutedRole = keyof Pick<
  ThemeColors,
  | 'safetyMuted'
  | 'warningMuted'
  | 'offlineMuted'
  | 'queuedMuted'
  | 'consentMuted'
  | 'evidenceMuted'
  | 'supportMuted'
  | 'caseMuted'
  | 'successMuted'
  | 'dangerMuted'
  | 'criticalMuted'
  | 'privacyMuted'
  | 'infoMuted'
  | 'unavailableMuted'
>;

type SemanticForegroundRole = keyof Pick<
  ThemeColors,
  | 'safetyForeground'
  | 'warningForeground'
  | 'offlineForeground'
  | 'queuedForeground'
  | 'consentForeground'
  | 'evidenceForeground'
  | 'supportForeground'
  | 'caseForeground'
  | 'successForeground'
  | 'destructiveForeground'
  | 'criticalForeground'
  | 'privacyForeground'
  | 'infoForeground'
  | 'unavailableForeground'
>;

export const palette = {
  neutral: {
    0: '#FFFFFF',
    25: '#FFF9F2',
    50: '#FFF0E3',
    100: '#DECABD',
    200: '#BAA08E',
    300: '#927768',
    400: '#876D5D',
    500: '#715A4D',
    600: '#665246',
    700: '#513F35',
    800: '#3C2C24',
    900: '#2D211B',
    950: '#211711',
  },
  trust: {
    50: '#FFE7D2',
    100: '#EDC3A3',
    300: '#F2BA91',
    500: '#B66447',
    600: '#B34E30',
    700: '#803E2B',
    900: '#3D2118',
  },
  safety: {
    50: '#EAF6E7',
    100: '#CBD9BE',
    500: '#356747',
    600: '#285239',
    900: '#172D1D',
  },
  evidence: {
    50: '#E9F4FA',
    100: '#CADCD6',
    500: '#385F6D',
    600: '#2B4C58',
    900: '#1B3035',
  },
  support: {
    50: '#EAF6E7',
    100: '#D4DDBD',
    500: '#3F684C',
    600: '#31533B',
    900: '#152C1D',
  },
  case: {
    50: '#E9EEF0',
    100: '#D4DFE2',
    500: '#47606A',
    600: '#364F59',
    900: '#172A31',
  },
  consent: {
    50: '#FFF0CD',
    100: '#F2CFB0',
    500: '#8B4F22',
    600: '#713D16',
    900: '#351A08',
  },
  privacy: {
    50: '#F3ECF8',
    100: '#DDCDE9',
    500: '#6B4D83',
    600: '#553B6A',
    900: '#2A1C35',
  },
  feedback: {
    success: '#2B7549',
    warning: '#9A5F1B',
    destructive: '#A93442',
    info: '#2F648C',
    offline: '#6A6260',
  },
} as const;

export const themeColors: Record<ThemeMode, ThemeColors> = {
  light: {
    canvas: '#FCF6EE',
    background: '#FCF6EE',
    surface: '#FFFDFA',
    surfaceAlt: '#F6EDE3',
    parchment: '#FFE4C2',
    foreground: palette.neutral[900],
    textPrimary: palette.neutral[900],
    textSecondary: palette.neutral[600],
    textTertiary: palette.neutral[500],
    textInverse: palette.neutral[0],
    border: '#E3D3C5',
    divider: '#EDE1D5',
    input: palette.neutral[300],
    ring: palette.trust[600],
    focusRing: palette.trust[600],
    card: '#FFFDFA',
    cardForeground: palette.neutral[900],
    popover: '#FFFDFA',
    popoverForeground: palette.neutral[900],
    chipBorder: palette.neutral[300],
    chipSelectedBorder: palette.trust[600],
    chipDisabledBorder: palette.neutral[200],
    chipDisabledBackground: '#F6EDE3',
    chipPressedOverlay: 'rgba(33,21,19,0.08)',
    primary: palette.trust[600],
    primaryForeground: palette.neutral[0],
    primaryMuted: '#FEEDE0',
    primaryDisabled: '#C2937F',
    primaryGradientStart: palette.trust[600],
    primaryGradientEnd: palette.trust[600],
    secondary: '#F6EDE3',
    secondaryForeground: palette.neutral[800],
    muted: '#F6EDE3',
    mutedForeground: palette.neutral[500],
    accent: '#FEEDE0',
    accentForeground: palette.trust[600],
    destructive: palette.feedback.destructive,
    destructiveForeground: palette.neutral[0],
    dangerMuted: '#F8DFE3',
    critical: '#8F2534',
    criticalForeground: palette.neutral[0],
    criticalMuted: '#F8DDE1',
    success: palette.feedback.success,
    successForeground: palette.neutral[0],
    successMuted: '#E2F2E7',
    warning: palette.feedback.warning,
    warningForeground: palette.neutral[0],
    warningMuted: '#FCECD8',
    info: palette.feedback.info,
    infoForeground: palette.neutral[0],
    infoMuted: palette.evidence[50],
    safety: palette.safety[500],
    safetyForeground: palette.neutral[0],
    safetyMuted: palette.safety[50],
    offline: palette.feedback.offline,
    offlineForeground: palette.neutral[0],
    offlineMuted: '#F3ECE6',
    queued: '#6A6260',
    queuedForeground: palette.neutral[0],
    queuedMuted: '#F3ECE6',
    consent: palette.consent[500],
    consentForeground: palette.neutral[0],
    consentMuted: palette.consent[50],
    evidence: palette.evidence[500],
    evidenceForeground: palette.neutral[0],
    evidenceMuted: palette.evidence[50],
    support: palette.support[500],
    supportForeground: palette.neutral[0],
    supportMuted: palette.support[50],
    case: palette.case[500],
    caseForeground: palette.neutral[0],
    caseMuted: palette.case[50],
    privacy: palette.privacy[500],
    privacyForeground: palette.neutral[0],
    privacyMuted: palette.privacy[50],
    unavailable: '#6A6260',
    unavailableForeground: palette.neutral[0],
    unavailableMuted: '#F3ECE6',
    overlay: 'rgba(33,21,19,0.08)',
    scrim: 'rgba(33,21,19,0.46)',
  },
  dark: {
    canvas: '#261C18',
    background: '#261C18',
    surface: '#352823',
    surfaceAlt: '#44332C',
    parchment: '#503929',
    foreground: '#FFF3E6',
    textPrimary: '#FFF3E6',
    textSecondary: '#E1C8B6',
    textTertiary: '#C4A58E',
    textInverse: palette.neutral[950],
    border: '#745A4E',
    divider: '#584238',
    input: '#997D6B',
    ring: palette.trust[300],
    focusRing: palette.trust[300],
    card: '#352823',
    cardForeground: '#FFF3E6',
    popover: '#352823',
    popoverForeground: '#FFF3E6',
    chipBorder: '#997D6B',
    chipSelectedBorder: palette.trust[300],
    chipDisabledBorder: '#584238',
    chipDisabledBackground: '#44332C',
    chipPressedOverlay: 'rgba(244,247,245,0.10)',
    primary: palette.trust[300],
    primaryForeground: palette.trust[900],
    primaryMuted: '#50362A',
    primaryDisabled: '#88614A',
    primaryGradientStart: palette.trust[300],
    primaryGradientEnd: palette.trust[300],
    secondary: '#44332C',
    secondaryForeground: '#FFF3E6',
    muted: '#44332C',
    mutedForeground: '#E1C8B6',
    accent: '#50362A',
    accentForeground: '#F2BA91',
    destructive: '#FFB4AB',
    destructiveForeground: '#3B0904',
    dangerMuted: '#4D1713',
    critical: '#FFB4AB',
    criticalForeground: '#3B0904',
    criticalMuted: '#4D1713',
    success: '#7BDDA7',
    successForeground: '#052B17',
    successMuted: '#103620',
    warning: '#F3B75F',
    warningForeground: '#2C1A00',
    warningMuted: '#3F2A0A',
    info: '#9CCAFF',
    infoForeground: '#09213B',
    infoMuted: '#102A43',
    safety: '#B7CCA0',
    safetyForeground: palette.safety[900],
    safetyMuted: '#303D2A',
    offline: '#B7C0CA',
    offlineForeground: palette.neutral[900],
    offlineMuted: '#3C332D',
    queued: '#C3CBD5',
    queuedForeground: '#1B2430',
    queuedMuted: '#3C332D',
    consent: '#FFD080',
    consentForeground: palette.consent[900],
    consentMuted: '#46320E',
    evidence: '#B8D2CE',
    evidenceForeground: palette.evidence[900],
    evidenceMuted: '#2B3C3A',
    support: '#BCD2A5',
    supportForeground: palette.support[900],
    supportMuted: '#303D2A',
    case: '#A9CBD0',
    caseForeground: palette.case[900],
    caseMuted: '#1A3338',
    privacy: '#D9C2EC',
    privacyForeground: palette.privacy[900],
    privacyMuted: '#3A2D44',
    unavailable: '#BBC3CC',
    unavailableForeground: '#161D24',
    unavailableMuted: '#2B3139',
    overlay: 'rgba(244,247,245,0.12)',
    scrim: 'rgba(0,0,0,0.72)',
  },
  highContrast: {
    canvas: palette.neutral[0],
    background: palette.neutral[0],
    surface: palette.neutral[0],
    surfaceAlt: '#F2F4F7',
    parchment: '#F4E1C1',
    foreground: '#000000',
    textPrimary: '#000000',
    textSecondary: palette.neutral[900],
    textTertiary: '#374151',
    textInverse: palette.neutral[0],
    border: '#000000',
    divider: palette.neutral[900],
    input: '#000000',
    ring: '#000000',
    focusRing: '#000000',
    card: palette.neutral[0],
    cardForeground: '#000000',
    popover: palette.neutral[0],
    popoverForeground: '#000000',
    chipBorder: '#000000',
    chipSelectedBorder: '#004B50',
    chipDisabledBorder: '#555555',
    chipDisabledBackground: '#EEEEEE',
    chipPressedOverlay: 'rgba(0,0,0,0.14)',
    primary: '#004B50',
    primaryForeground: palette.neutral[0],
    primaryMuted: '#D8FFFF',
    primaryDisabled: '#71717A',
    primaryGradientStart: '#004B50',
    primaryGradientEnd: '#004B50',
    secondary: '#E5E7EB',
    secondaryForeground: '#000000',
    muted: '#F3F4F6',
    mutedForeground: '#111827',
    accent: '#E0ECFF',
    accentForeground: '#003D75',
    destructive: '#8A0E07',
    destructiveForeground: palette.neutral[0],
    dangerMuted: '#FFE3DE',
    critical: '#7A0000',
    criticalForeground: palette.neutral[0],
    criticalMuted: '#FFE3DE',
    success: '#005F2F',
    successForeground: palette.neutral[0],
    successMuted: '#D6F5E4',
    warning: '#7A4200',
    warningForeground: palette.neutral[0],
    warningMuted: '#FFE8B8',
    info: '#003D75',
    infoForeground: palette.neutral[0],
    infoMuted: '#DCEBFF',
    safety: '#005840',
    safetyForeground: palette.neutral[0],
    safetyMuted: '#D8F6E9',
    offline: '#3F4752',
    offlineForeground: palette.neutral[0],
    offlineMuted: '#E5E7EB',
    queued: '#000000',
    queuedForeground: palette.neutral[0],
    queuedMuted: '#E5E7EB',
    consent: '#6B3B00',
    consentForeground: palette.neutral[0],
    consentMuted: '#FFE5B4',
    evidence: '#004F91',
    evidenceForeground: palette.neutral[0],
    evidenceMuted: '#DCEBFF',
    support: '#005F2F',
    supportForeground: palette.neutral[0],
    supportMuted: '#D6F5E4',
    case: '#003D4A',
    caseForeground: palette.neutral[0],
    caseMuted: '#D8F6FF',
    privacy: '#3F2E78',
    privacyForeground: palette.neutral[0],
    privacyMuted: '#E7E0FF',
    unavailable: '#3F4752',
    unavailableForeground: palette.neutral[0],
    unavailableMuted: '#E5E7EB',
    overlay: 'rgba(0,0,0,0.18)',
    scrim: 'rgba(0,0,0,0.78)',
  },
};

export const colors = themeColors.light;

export const semanticStates: Record<
  SemanticStateName,
  {
    color: SemanticColorRole;
    foreground: SemanticForegroundRole;
    muted: SemanticMutedRole;
  }
> = {
  critical: { color: 'critical', foreground: 'criticalForeground', muted: 'criticalMuted' },
  safety: { color: 'safety', foreground: 'safetyForeground', muted: 'safetyMuted' },
  warning: { color: 'warning', foreground: 'warningForeground', muted: 'warningMuted' },
  offline: { color: 'offline', foreground: 'offlineForeground', muted: 'offlineMuted' },
  queued: { color: 'queued', foreground: 'queuedForeground', muted: 'queuedMuted' },
  consent: { color: 'consent', foreground: 'consentForeground', muted: 'consentMuted' },
  evidence: { color: 'evidence', foreground: 'evidenceForeground', muted: 'evidenceMuted' },
  support: { color: 'support', foreground: 'supportForeground', muted: 'supportMuted' },
  case: { color: 'case', foreground: 'caseForeground', muted: 'caseMuted' },
  success: { color: 'success', foreground: 'successForeground', muted: 'successMuted' },
  destructive: { color: 'destructive', foreground: 'destructiveForeground', muted: 'dangerMuted' },
  privacy: { color: 'privacy', foreground: 'privacyForeground', muted: 'privacyMuted' },
  info: { color: 'info', foreground: 'infoForeground', muted: 'infoMuted' },
  unavailable: { color: 'unavailable', foreground: 'unavailableForeground', muted: 'unavailableMuted' },
};

export const fontFamilies = {
  text: 'Inter',
  display: 'Inter',
  mono: 'Menlo',
};

export const typography = {
  displayLarge: {
    fontSize: 40,
    lineHeight: 46,
    fontWeight: '700' as const,
    letterSpacing: 0,
    fontFamily: fontFamilies.display,
  },
  displayMedium: {
    fontSize: 34,
    lineHeight: 40,
    fontWeight: '700' as const,
    letterSpacing: 0,
    fontFamily: fontFamilies.display,
  },
  displaySmall: {
    fontSize: 30,
    lineHeight: 36,
    fontWeight: '700' as const,
    letterSpacing: 0,
    fontFamily: fontFamilies.display,
  },
  headlineLarge: {
    fontSize: 26,
    lineHeight: 32,
    fontWeight: '700' as const,
    letterSpacing: 0,
    fontFamily: fontFamilies.display,
  },
  headlineMedium: {
    fontSize: 22,
    lineHeight: 28,
    fontWeight: '700' as const,
    letterSpacing: 0,
    fontFamily: fontFamilies.display,
  },
  headlineSmall: {
    fontSize: 20,
    lineHeight: 26,
    fontWeight: '700' as const,
    letterSpacing: 0,
    fontFamily: fontFamilies.display,
  },
  titleLarge: {
    fontSize: 20,
    lineHeight: 26,
    fontWeight: '700' as const,
    letterSpacing: 0,
    fontFamily: fontFamilies.text,
  },
  titleMedium: {
    fontSize: 18,
    lineHeight: 24,
    fontWeight: '700' as const,
    letterSpacing: 0,
    fontFamily: fontFamilies.text,
  },
  titleSmall: {
    fontSize: 16,
    lineHeight: 22,
    fontWeight: '700' as const,
    letterSpacing: 0,
    fontFamily: fontFamilies.text,
  },
  bodyLarge: {
    fontSize: 17,
    lineHeight: 25,
    fontWeight: '400' as const,
    letterSpacing: 0,
    fontFamily: fontFamilies.text,
  },
  bodyMedium: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '400' as const,
    letterSpacing: 0,
    fontFamily: fontFamilies.text,
  },
  bodySmall: {
    fontSize: 14,
    lineHeight: 21,
    fontWeight: '400' as const,
    letterSpacing: 0,
    fontFamily: fontFamilies.text,
  },
  labelLarge: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '700' as const,
    letterSpacing: 0,
    fontFamily: fontFamilies.text,
  },
  labelMedium: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700' as const,
    letterSpacing: 0,
    fontFamily: fontFamilies.text,
  },
  labelSmall: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '700' as const,
    letterSpacing: 0,
    fontFamily: fontFamilies.text,
  },
  titleXL: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '700' as const,
    letterSpacing: 0,
    fontFamily: fontFamilies.display,
  },
  titleL: {
    fontSize: 22,
    lineHeight: 28,
    fontWeight: '700' as const,
    letterSpacing: 0,
    fontFamily: fontFamilies.display,
  },
  titleM: {
    fontSize: 20,
    lineHeight: 26,
    fontWeight: '700' as const,
    letterSpacing: 0,
    fontFamily: fontFamilies.text,
  },
  titleS: {
    fontSize: 16,
    lineHeight: 22,
    fontWeight: '700' as const,
    letterSpacing: 0,
    fontFamily: fontFamilies.text,
  },
  bodyL: {
    fontSize: 17,
    lineHeight: 25,
    fontWeight: '400' as const,
    letterSpacing: 0,
    fontFamily: fontFamilies.text,
  },
  bodyM: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '400' as const,
    letterSpacing: 0,
    fontFamily: fontFamilies.text,
  },
  bodyS: {
    fontSize: 14,
    lineHeight: 21,
    fontWeight: '400' as const,
    letterSpacing: 0,
    fontFamily: fontFamilies.text,
  },
  caption: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '400' as const,
    letterSpacing: 0,
    fontFamily: fontFamilies.text,
  },
  overline: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '700' as const,
    letterSpacing: 0,
    fontFamily: fontFamilies.text,
  },
  button: {
    fontSize: 15,
    lineHeight: 22,
    fontWeight: '700' as const,
    letterSpacing: 0,
    fontFamily: fontFamilies.text,
  },
  label: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '700' as const,
    letterSpacing: 0,
    fontFamily: fontFamilies.text,
  },
};

export const spacing = {
  none: 0,
  xxxs: 4,
  xxs: 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 20,
  xl: 24,
  xxl: 32,
  xxxl: 40,
  huge: 48,
  massive: 64,
  gutter: 16,
  section: 24,
};

export const radii = {
  none: 0,
  xs: 6,
  sm: 10,
  md: 14,
  lg: 20,
  card: 16,
  input: 12,
  button: 14,
  chip: 999,
  sheet: 24,
  map: 16,
  badge: 999,
  round: 999,
};

export const borders = {
  hairline: 1,
  standard: 1,
  emphasized: 2,
  focus: 2,
};

export const touchTargets = {
  minimum: 48,
  comfortable: 48,
  action: 48,
  row: 52,
};

export const layout = {
  screenGutter: spacing.gutter,
  compactGutter: spacing.md,
  maxReadableWidth: 340,
  formFieldHeight: touchTargets.row,
  listRowHeight: touchTargets.row,
  ctaHeight: touchTargets.action,
  sheetHandleWidth: 36,
  sheetHandleHeight: 5,
  bottomDockInset: spacing.md,
};

export const elevation = {
  none: {
    shadowColor: 'rgba(33,21,19,0)',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0,
    shadowRadius: 0,
    elevation: 0,
  },
  card: {
    shadowColor: 'rgba(34,37,31,0.04)',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 1,
    shadowRadius: 8,
    elevation: 1,
  },
  raised: {
    shadowColor: 'rgba(29,21,19,0.10)',
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 1,
    shadowRadius: 14,
    elevation: 3,
  },
  floating: {
    shadowColor: 'rgba(29,21,19,0.14)',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 1,
    shadowRadius: 22,
    elevation: 6,
  },
  sheet: {
    shadowColor: 'rgba(33,21,19,0.18)',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 1,
    shadowRadius: 24,
    elevation: 10,
  },
};

export const shadows = {
  card: elevation.card,
  floating: elevation.floating,
};

export const motion = {
  duration: {
    instant: 0,
    quick: 120,
    base: 180,
    deliberate: 240,
    sheet: 320,
  },
  easing: {
    standard: 'cubic-bezier(0.2, 0, 0, 1)',
    emphasized: 'cubic-bezier(0.2, 0, 0, 1)',
    exit: 'cubic-bezier(0.4, 0, 1, 1)',
  },
};

export const layers = {
  base: 0,
  raised: 10,
  header: 20,
  footer: 30,
  sheet: 40,
  dialog: 50,
  toast: 60,
  quickExit: 70,
};

export const feedback = {
  opacity: {
    pressed: 0.86,
    disabled: 0.42,
    subtleDisabled: 0.58,
  },
  overlay: {
    pressed: 'rgba(33,21,19,0.08)',
    selected: 'rgba(113,59,93,0.12)',
    danger: 'rgba(169,49,58,0.10)',
  },
};

export const focus = {
  ringWidth: borders.focus,
  ringOffset: 2,
  color: 'focusRing' as const,
};

export const accessibility = {
  minTouchTarget: touchTargets.minimum,
  preferredTouchTarget: touchTargets.comfortable,
  contrast: {
    bodyText: 4.5,
    largeText: 3,
    nonText: 3,
  },
  dynamicType: {
    minimumScale: 1,
    expectedContentSize: 'extraLarge',
    allowFontScaling: true,
  },
  focusOrder: 'top-to-bottom-left-to-right',
};

export const safeRideTokens = {
  palette,
  colors: themeColors,
  semanticStates,
  fontFamilies,
  typography,
  spacing,
  radii,
  borders,
  touchTargets,
  layout,
  elevation,
  shadows,
  motion,
  layers,
  feedback,
  focus,
  accessibility,
};

export type TypographyStyle = typeof typography;
export type SafeRideTokens = typeof safeRideTokens;
