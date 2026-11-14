import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import Screen from '../components/ui/Screen';
import { Card, CardContent, FeatureHeader } from '../components/ui';
import { useTheme } from '../theme/SimpleThemeProvider';
import { borders, radii, spacing, typography } from '../theme/tokens';

const NEXT_STEPS = [
  { label: 'Start a private report', icon: 'document-text-outline' as const },
  { label: 'Find support contacts', icon: 'people-outline' as const },
  { label: 'Review tips and rights', icon: 'book-outline' as const },
];

export default function FirstRunEmptyScreen() {
  const { colors } = useTheme();

  const styles = StyleSheet.create({
    content: {
      gap: spacing.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.lg,
    },
    cardContent: {
      gap: spacing.sm,
    },
    title: {
      ...typography.titleMedium,
      color: colors.foreground,
    },
    body: {
      ...typography.bodySmall,
      color: colors.textSecondary,
    },
    stepRow: {
      alignItems: 'center',
      backgroundColor: colors.primaryMuted,
      borderColor: colors.divider,
      borderRadius: radii.card,
      borderWidth: borders.hairline,
      flexDirection: 'row',
      gap: spacing.sm,
      minHeight: 48,
      paddingHorizontal: spacing.sm,
    },
    stepIcon: {
      alignItems: 'center',
      backgroundColor: colors.primaryMuted,
      borderRadius: radii.card,
      height: 34,
      justifyContent: 'center',
      width: 34,
    },
    stepLabel: {
      ...typography.labelSmall,
      color: colors.foreground,
      flex: 1,
    },
  });

  return (
    <Screen brandHeader>
      <View style={styles.content}>
        <FeatureHeader
          eyebrow="Ready"
          title="SafeRide is set up"
          description="Use the tabs below to report, find support, review cases, or read guidance."
          icon="shield-checkmark-outline"
          tone="safety"
        />

        <Card variant="elevated">
          <CardContent style={styles.cardContent}>
            <Text style={styles.title}>Suggested first steps</Text>
            <Text style={styles.body}>Start with the path that feels safest. You can close the app and return later.</Text>
            {NEXT_STEPS.map(step => (
              <View key={step.label} style={styles.stepRow}>
                <View style={styles.stepIcon}>
                  <Ionicons name={step.icon} size={17} color={colors.primary} />
                </View>
                <Text style={styles.stepLabel}>{step.label}</Text>
              </View>
            ))}
          </CardContent>
        </Card>
      </View>
    </Screen>
  );
}
