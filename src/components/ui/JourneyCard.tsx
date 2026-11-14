import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/SimpleThemeProvider';
import { radii, spacing, touchTargets, typography } from '../../theme/tokens';
import { SafetyIllustration } from './SafetyIllustration';

type JourneyTone = 'primary' | 'support' | 'evidence' | 'consent';

export interface JourneyCardProps {
  title: string;
  description: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  tone: JourneyTone;
  accessibilityLabel: string;
  infoLabel: string;
  onPress: () => void;
  onInfoPress: () => void;
  /** Full-width row layout used when tiles stack on narrow screens or enlarged text. */
  row?: boolean;
}

export function JourneyCard({ title, description, icon, tone, accessibilityLabel, infoLabel, onPress, onInfoPress, row = false }: JourneyCardProps) {
  const { colors, visualStyle } = useTheme();
  const accent = colors[tone];
  const background = colors[`${tone}Muted`];
  const artwork = visualStyle === 'warm' ? (
    <SafetyIllustration kind={tone === 'support' ? 'support' : tone === 'evidence' ? 'evidence' : tone === 'consent' ? 'learn' : 'journey'} size={40} />
  ) : (
    <View style={styles.icon}><Ionicons accessible={false} name={icon} size={18} color={accent} /></View>
  );

  if (row) {
    return (
      <View style={[styles.rowCard, { backgroundColor: background, borderColor: colors.border }]}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          onPress={onPress}
          activeOpacity={0.85}
          style={styles.rowPrimary}
        >
          {artwork}
          <View style={styles.rowCopy}>
            <Text style={[styles.rowTitle, { color: colors.foreground }]}>{title}</Text>
            <Text style={[styles.description, { color: colors.textSecondary }]}>{description}</Text>
          </View>
          <Ionicons accessible={false} name="chevron-forward" size={20} color={accent} />
        </TouchableOpacity>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={infoLabel}
          onPress={onInfoPress}
          activeOpacity={0.8}
          style={styles.rowInfo}
        >
          <Ionicons name="information-circle-outline" size={20} color={accent} />
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={[styles.card, { backgroundColor: background, borderColor: colors.border }]}>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        onPress={onPress}
        activeOpacity={0.85}
        style={styles.primary}
      >
        <View style={styles.header}>
          {artwork}
          <View style={[styles.arrow, { backgroundColor: colors.surface }]}><Ionicons accessible={false} name="arrow-forward" size={18} color={accent} /></View>
        </View>
        <Text style={[styles.title, { color: colors.foreground }]}>{title}</Text>
        <Text style={[styles.description, { color: colors.textSecondary }]}>{description}</Text>
      </TouchableOpacity>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={infoLabel}
        onPress={onInfoPress}
        activeOpacity={0.8}
        style={styles.info}
      >
        <Ionicons name="information-circle-outline" size={20} color={accent} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radii.card, borderWidth: 1, flex: 1, minWidth: 0, position: 'relative', overflow: 'hidden' },
  primary: { flex: 1, minHeight: touchTargets.minimum, paddingHorizontal: spacing.sm, paddingTop: spacing.xs, paddingBottom: spacing.sm },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.xxs, minHeight: 44, paddingRight: touchTargets.minimum - spacing.xs },
  icon: { alignItems: 'center', justifyContent: 'center', width: 40, height: 40 },
  title: { ...typography.titleSmall, marginTop: spacing.xxs },
  description: { ...typography.bodySmall, marginTop: 2 },
  arrow: { borderRadius: radii.round, alignItems: 'center', justifyContent: 'center', width: 24, height: 24, flexShrink: 0 },
  info: { alignItems: 'center', justifyContent: 'center', height: touchTargets.minimum, width: touchTargets.minimum, position: 'absolute', right: 0, top: 0 },
  // Content-sized: stacked rows must never inherit the grid tile's flex: 1.
  rowCard: { alignItems: 'stretch', alignSelf: 'stretch', borderRadius: radii.card, borderWidth: 1, flexDirection: 'row', overflow: 'hidden' },
  rowPrimary: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 64, minWidth: 0, paddingLeft: spacing.sm, paddingRight: spacing.xxs, paddingVertical: spacing.xs },
  rowCopy: { flex: 1, minWidth: 0 },
  rowTitle: { ...typography.titleSmall },
  rowInfo: { alignItems: 'center', justifyContent: 'center', minHeight: touchTargets.minimum, width: touchTargets.minimum },
});
