import React from 'react';
import { Pressable, StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '../../theme/SimpleThemeProvider';
import { borders, feedback, radii, spacing, typography } from '../../theme/tokens';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

export interface ChoiceCardProps {
  title: string;
  description?: string;
  icon?: IconName;
  selected: boolean;
  /** `radio` for one-of-many, `checkbox` for any-of-many. */
  kind?: 'radio' | 'checkbox';
  onPress?: () => void;
  disabled?: boolean;
  /** Short status shown under the title, e.g. "Unavailable — pending review". */
  meta?: string;
  /** Extra content inside the card, such as an action button. */
  children?: React.ReactNode;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * Outlined option row: icon, title and description, with a radio or checkbox
 * mark on the right. Selection is a 2dp primary outline plus a tonal fill, so
 * it never depends on colour alone.
 */
export function ChoiceCard({
  title,
  description,
  icon,
  selected,
  kind = 'radio',
  onPress,
  disabled = false,
  meta,
  children,
  accessibilityLabel,
  accessibilityHint,
  testID,
  style,
}: ChoiceCardProps) {
  const { colors } = useTheme();
  const interactive = Boolean(onPress) && !disabled;

  const mark = kind === 'checkbox' ? (
    <View
      style={[
        styles.checkbox,
        { borderColor: selected ? colors.primary : colors.input },
        selected ? { backgroundColor: colors.primary } : null,
      ]}
    >
      {selected ? <Ionicons name="checkmark" size={16} color={colors.primaryForeground} /> : null}
    </View>
  ) : (
    <View style={[styles.radio, { borderColor: selected ? colors.primary : colors.input }]}>
      {selected ? <View style={[styles.radioDot, { backgroundColor: colors.primary }]} /> : null}
    </View>
  );

  const body = (
    <>
      <View style={styles.row}>
        {icon ? (
          <View style={[styles.icon, { backgroundColor: selected ? colors.surface : colors.surfaceAlt }]}>
            <Ionicons name={icon} size={20} color={selected ? colors.primary : colors.textSecondary} />
          </View>
        ) : null}
        <View style={styles.copy}>
          <Text
            // A container card has no radio role, so its title carries the state.
            accessibilityLabel={!onPress ? `${title}${selected ? ', selected' : ''}` : undefined}
            style={[styles.title, { color: disabled ? colors.textSecondary : colors.foreground }]}
          >
            {title}
          </Text>
          {meta ? <Text style={[styles.meta, { color: colors.textSecondary }]}>{meta}</Text> : null}
          {description ? (
            <Text style={[styles.description, { color: colors.textSecondary }]}>{description}</Text>
          ) : null}
        </View>
        {mark}
      </View>
      {children ? <View style={styles.children}>{children}</View> : null}
    </>
  );

  const surface = [
    styles.card,
    {
      backgroundColor: selected ? colors.primaryMuted : colors.surface,
      borderColor: selected ? colors.primary : colors.border,
      opacity: disabled ? feedback.opacity.subtleDisabled : 1,
    },
    selected ? styles.cardSelected : null,
  ];

  if (!onPress) {
    // Without its own action (e.g. "Use current location" with an inner
    // button) the card is only a container, so its controls stay reachable.
    return (
      <View testID={testID} style={[...surface, style]}>
        {body}
      </View>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      disabled={!interactive}
      testID={testID}
      accessibilityRole={kind}
      accessibilityState={{ checked: selected, disabled: disabled || undefined }}
      accessibilityLabel={accessibilityLabel ?? (description ? `${title}. ${description}` : title)}
      accessibilityHint={accessibilityHint}
      style={({ pressed }) => [
        ...surface,
        pressed && interactive && !selected ? { backgroundColor: colors.surfaceAlt } : null,
        style,
      ]}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radii.card,
    borderWidth: borders.hairline,
    minHeight: 56,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  cardSelected: {
    borderWidth: borders.emphasized,
    // Keep the content still when the outline thickens.
    paddingHorizontal: spacing.sm - 1,
    paddingVertical: spacing.sm - 1,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  icon: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderRadius: radii.round,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  copy: {
    flex: 1,
    gap: 2,
    minWidth: 0,
  },
  title: {
    ...typography.labelLarge,
  },
  meta: {
    ...typography.labelSmall,
  },
  description: {
    ...typography.bodySmall,
  },
  radio: {
    alignItems: 'center',
    borderRadius: radii.round,
    borderWidth: borders.emphasized,
    height: 24,
    justifyContent: 'center',
    width: 24,
  },
  radioDot: {
    borderRadius: radii.round,
    height: 12,
    width: 12,
  },
  checkbox: {
    alignItems: 'center',
    borderRadius: 6,
    borderWidth: borders.emphasized,
    height: 24,
    justifyContent: 'center',
    width: 24,
  },
  children: {
    marginTop: spacing.sm,
  },
});
