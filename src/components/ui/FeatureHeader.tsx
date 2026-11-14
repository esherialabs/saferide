import React from 'react';
import { StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '../../theme/SimpleThemeProvider';
import { radii, spacing, typography } from '../../theme/tokens';

type IconName = React.ComponentProps<typeof Ionicons>['name'];
type FeatureTone = 'primary' | 'support' | 'evidence' | 'privacy' | 'safety' | 'critical' | 'consent';

export type FeatureHeaderStat = {
  label: string;
  value: string | number;
  icon?: IconName;
};

export interface FeatureHeaderProps {
  eyebrow?: string;
  title: string;
  description: string;
  icon: IconName;
  tone?: FeatureTone;
  stats?: FeatureHeaderStat[];
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

/**
 * Page title set directly on the canvas: a toned eyebrow, a large title, one
 * supporting line and an optional row of facts. It deliberately has no card,
 * gradient or illustration, so the screen's own content sits right below it.
 */
export function FeatureHeader({
  eyebrow,
  title,
  description,
  icon,
  tone = 'primary',
  stats = [],
  children,
  style,
}: FeatureHeaderProps) {
  const { colors } = useTheme();
  const palette = {
    primary: { color: colors.primary, muted: colors.primaryMuted },
    support: { color: colors.support, muted: colors.supportMuted },
    evidence: { color: colors.evidence, muted: colors.evidenceMuted },
    privacy: { color: colors.privacy, muted: colors.privacyMuted },
    safety: { color: colors.safety, muted: colors.safetyMuted },
    critical: { color: colors.critical, muted: colors.criticalMuted },
    consent: { color: colors.consent, muted: colors.consentMuted },
  }[tone];

  return (
    <View style={[styles.root, style]}>
      <View style={styles.eyebrowRow}>
        <View style={[styles.eyebrowIcon, { backgroundColor: palette.muted }]}>
          <Ionicons accessible={false} name={icon} size={14} color={palette.color} />
        </View>
        {eyebrow ? <Text style={[styles.eyebrow, { color: palette.color }]}>{eyebrow}</Text> : null}
      </View>
      <Text accessibilityRole="header" style={[styles.title, { color: colors.foreground }]}>{title}</Text>
      {description.trim() ? (
        <Text style={[styles.description, { color: colors.textSecondary }]}>{description}</Text>
      ) : null}

      {stats.length > 0 ? (
        <View style={styles.stats}>
          {stats.map((stat) => (
            <View
              key={`${stat.label}-${stat.value}`}
              accessible
              accessibilityLabel={`${stat.label}: ${stat.value}`}
              style={[styles.statItem, { backgroundColor: colors.surfaceAlt }]}
            >
              {stat.icon ? <Ionicons name={stat.icon} size={14} color={palette.color} /> : null}
              {typeof stat.value === 'number' ? (
                <Text style={[styles.statLabel, { color: colors.textSecondary }]}>
                  <Text style={[styles.statValue, { color: colors.foreground }]}>{stat.value}</Text>
                  {` ${stat.label}`}
                </Text>
              ) : (
                <Text style={[styles.statLabel, { color: colors.textSecondary }]}>
                  {`${stat.label} `}
                  <Text style={[styles.statValue, { color: colors.foreground }]}>{stat.value}</Text>
                </Text>
              )}
            </View>
          ))}
        </View>
      ) : null}

      {children ? <View style={styles.children}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    paddingBottom: spacing.xs,
    paddingTop: spacing.xxs,
  },
  eyebrowRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
  },
  eyebrowIcon: {
    alignItems: 'center',
    borderRadius: radii.round,
    height: 24,
    justifyContent: 'center',
    width: 24,
  },
  eyebrow: {
    ...typography.overline,
    flexShrink: 1,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  title: {
    ...typography.headlineMedium,
    letterSpacing: -0.3,
    marginTop: spacing.xs,
  },
  description: {
    ...typography.bodyMedium,
    marginTop: spacing.xxs,
  },
  stats: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  statItem: {
    alignItems: 'center',
    borderRadius: radii.round,
    flexDirection: 'row',
    gap: spacing.xxs,
    maxWidth: '100%',
    minHeight: 28,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xxs,
  },
  statValue: {
    ...typography.labelMedium,
    fontWeight: '700',
  },
  statLabel: {
    ...typography.labelMedium,
    flexShrink: 1,
    fontWeight: '500',
  },
  children: {
    marginTop: spacing.sm,
  },
});
