import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../../theme/SimpleThemeProvider';
import { spacing, typography } from '../../theme/tokens';

type ReportStepHeaderProps = {
  title: string;
  helper?: string;
  /** Small toned label above the title, e.g. "Optional details". */
  eyebrow?: string;
};

/** The question for a report step, set on the canvas right under the progress bar. */
export function ReportStepHeader({ title, helper, eyebrow }: ReportStepHeaderProps) {
  const { colors } = useTheme();
  return (
    <View style={styles.root}>
      {eyebrow ? <Text style={[styles.eyebrow, { color: colors.primary }]}>{eyebrow}</Text> : null}
      <Text accessibilityRole="header" style={[styles.title, { color: colors.foreground }]}>{title}</Text>
      {helper ? <Text style={[styles.helper, { color: colors.textSecondary }]}>{helper}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: spacing.xxs,
    marginBottom: spacing.md,
  },
  eyebrow: {
    ...typography.overline,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  title: {
    ...typography.headlineMedium,
    letterSpacing: -0.3,
  },
  helper: {
    ...typography.bodyMedium,
  },
});
