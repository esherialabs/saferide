import React from 'react';
import {
  Pressable,
  StyleProp,
  StyleSheet,
  Text,
  View,
  ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/SimpleThemeProvider';
import { borders, feedback, radii, spacing, touchTargets, typography } from '../../theme/tokens';
import { type ComponentTone, getTonePalette } from './componentStyles';

export interface ListRowProps {
  title: string;
  description?: string;
  meta?: string;
  leading?: React.ReactNode;
  leadingIcon?: keyof typeof Ionicons.glyphMap;
  trailing?: React.ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  selected?: boolean;
  tone?: ComponentTone;
  density?: 'compact' | 'regular' | 'spacious';
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
}

const DENSITY_MIN_HEIGHT: Record<NonNullable<ListRowProps['density']>, number> = {
  compact: touchTargets.row,
  regular: 64,
  spacious: 76,
};

export function ListRow({
  title,
  description,
  meta,
  leading,
  leadingIcon,
  trailing,
  onPress,
  disabled = false,
  selected = false,
  tone = 'neutral',
  density = 'regular',
  accessibilityLabel,
  accessibilityHint,
  style,
}: ListRowProps) {
  const { colors } = useTheme();
  const tonePalette = getTonePalette(colors, tone);
  const interactive = Boolean(onPress);
  const isDisabled = disabled || !interactive;

  const content = (
    <>
      {leading ?? (leadingIcon ? (
        <View
          style={[
            styles.leadingIcon,
            {
              backgroundColor: tonePalette.muted,
              borderColor: tonePalette.border,
            },
          ]}
        >
          <Ionicons name={leadingIcon} size={18} color={tonePalette.color} />
        </View>
      ) : null)}
      <View style={styles.textWrap}>
        <View style={styles.titleLine}>
          <Text style={[styles.title, { color: disabled ? colors.textTertiary : colors.foreground }]}>
            {title}
          </Text>
          {meta ? (
            <Text style={[styles.meta, { color: colors.textSecondary }]}>
              {meta}
            </Text>
          ) : null}
        </View>
        {description ? (
          <Text style={[styles.description, { color: colors.textSecondary }]}>
            {description}
          </Text>
        ) : null}
      </View>
      {trailing ? <View style={styles.trailing}>{trailing}</View> : null}
      {interactive && !trailing ? (
        <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
      ) : null}
    </>
  );

  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      accessibilityRole={interactive ? 'button' : 'text'}
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: disabled || undefined, selected }}
      style={({ pressed }) => [
        styles.row,
        {
          minHeight: DENSITY_MIN_HEIGHT[density],
          backgroundColor: selected ? tonePalette.muted : colors.surface,
          borderColor: selected ? tonePalette.border : colors.divider,
          opacity: disabled ? feedback.opacity.subtleDisabled : 1,
        },
        pressed && interactive && !disabled ? { backgroundColor: colors.surfaceAlt } : null,
        style,
      ]}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    borderRadius: radii.card,
    borderWidth: borders.standard,
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  leadingIcon: {
    alignItems: 'center',
    borderRadius: radii.round,
    borderWidth: borders.standard,
    height: touchTargets.minimum,
    justifyContent: 'center',
    width: touchTargets.minimum,
  },
  textWrap: {
    flex: 1,
    minWidth: 0,
  },
  titleLine: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  title: {
    ...typography.bodyM,
    flex: 1,
    fontWeight: '600',
  },
  meta: {
    ...typography.caption,
    flexShrink: 1,
    maxWidth: 96,
  },
  description: {
    ...typography.bodyS,
    marginTop: spacing.xxs,
  },
  trailing: {
    alignItems: 'flex-end',
    flexShrink: 0,
  },
});
