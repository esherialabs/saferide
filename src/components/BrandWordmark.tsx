import React from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { useTheme } from '../theme/SimpleThemeProvider';
import { spacing } from '../theme/tokens';
import { WordmarkHighlights } from './WordmarkHighlights';

export function BrandWordmark({
  width = 144,
  inverted,
  accessible = true,
  animated = true,
}: {
  width?: number;
  inverted?: boolean;
  accessible?: boolean;
  animated?: boolean;
}) {
  const { colorScheme } = useTheme();
  const useInverted = inverted ?? colorScheme === 'dark';

  if (animated) {
    return <WordmarkHighlights key={String(useInverted)} width={width} inverted={useInverted} accessible={accessible} />;
  }

  return (
    <Image
      source={useInverted ? require('../../assets/logo-inverted.png') : require('../../assets/logo.png')}
      resizeMode="contain"
      style={{ width, height: width * (263 / 1200) }}
      accessible={accessible}
      accessibilityLabel={accessible ? 'SafeRide logo' : undefined}
      accessibilityIgnoresInvertColors
    />
  );
}

export function BrandBar({ children }: { children?: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.bar, { backgroundColor: colors.canvas }]}>
      {children ?? <BrandWordmark width={140} />}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    alignItems: 'flex-start',
    justifyContent: 'center',
    minHeight: 52,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
});
