import React from 'react';
import { View, StyleSheet, useWindowDimensions } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { useTheme } from '../../theme/SimpleThemeProvider';

export type SafetyIllustrationKind = 'journey' | 'privacy' | 'evidence' | 'support' | 'learn';

/**
 * Original, static artwork. Decorative only; never represents a product status.
 * `responsive` artwork steps aside on narrow screens and enlarged text so content keeps the space.
 */
export function SafetyIllustration({ kind = 'journey', size = 160, responsive = false }: {
  kind?: SafetyIllustrationKind;
  size?: number;
  responsive?: boolean;
}) {
  const { colors, visualStyle } = useTheme();
  const { width, fontScale } = useWindowDimensions();
  if (visualStyle === 'classic') return null;
  if (responsive && (width < 360 || fontScale >= 1.3)) return null;
  return (
    <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" pointerEvents="none" style={styles.art}>
      <Svg width={size} height={size} viewBox="0 0 200 200">
        <Path d="M22 174V92C22 49 56 18 100 18s78 31 78 74v82Z" fill={colors.parchment} />
        <Circle cx="144" cy="52" r="22" fill={colors.primary} opacity={0.24} />
        <Path d="M10 168c34-38 54 36 94 0s49-28 84-4" stroke={colors.support} strokeWidth="3" strokeLinecap="round" fill="none" opacity={0.7} />
        <Path d="M37 179c10-15 23-23 39-26M167 174c-3-21-11-35-21-43" stroke={colors.support} strokeWidth="3" strokeLinecap="round" fill="none" />
        <Path d="M48 166c-12-1-17-8-16-18 12 1 17 8 16 18m8-8c2-12 10-17 20-16-1 12-9 17-20 16m101-3c11-4 15-12 11-22-11 4-15 12-11 22" fill={colors.support} opacity={0.7} />
        {kind === 'journey' || kind === 'privacy' ? <>
          <Path d="m100 51 43 18v37c0 28-19 43-43 55-24-12-43-27-43-55V69Z" fill={colors.surface} stroke={colors.primary} strokeWidth="3" strokeLinejoin="round" />
          <Path d="m80 105 14 14 29-32" stroke={colors.primary} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </> : kind === 'support' ? <>
          <Rect x="49" y="62" width="99" height="72" rx="24" fill={colors.surface} stroke={colors.support} strokeWidth="3" />
          <Path d="m67 130-5 20 29-16" fill={colors.surface} stroke={colors.support} strokeWidth="3" strokeLinejoin="round" />
          <Path d="M99 113c-6-5-19-13-19-22a10 10 0 0 1 19-4 10 10 0 0 1 19 4c0 9-13 17-19 22Z" fill={colors.primary} />
        </> : kind === 'evidence' ? <>
          <Rect x="60" y="49" width="80" height="108" rx="12" fill={colors.surface} stroke={colors.evidence} strokeWidth="3" transform="rotate(-6 100 103)" />
          <Path d="M80 81h36M80 98h40M80 115h24" stroke={colors.evidence} strokeWidth="4" strokeLinecap="round" />
          <Circle cx="135" cy="140" r="22" fill={colors.primary} />
          <Path d="m124 140 7 7 14-15" stroke={colors.primaryForeground} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </> : <>
          <Path d="M100 75c-17-12-32-13-49-7v76c19-7 34-3 49 8 15-11 30-15 49-8V68c-17-6-32-5-49 7Z" fill={colors.surface} stroke={colors.consent} strokeWidth="3" strokeLinejoin="round" />
          <Path d="M100 77v74M65 89l21 5M65 106l21 5M115 94l20-5M115 111l20-5" stroke={colors.consent} strokeWidth="3" strokeLinecap="round" />
        </>}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({ art: { flexShrink: 0, alignItems: 'center', justifyContent: 'center' } });
