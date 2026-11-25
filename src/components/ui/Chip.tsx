import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { StyleProp, TextStyle, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/SimpleThemeProvider';
import { radii, spacing, touchTargets, typography } from '../../theme/tokens';

export interface ChipProps {
  label: string;
  selected?: boolean;
  disabled?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  leadingIcon?: keyof typeof Ionicons.glyphMap;
  leadingIconSize?: number;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  accessibilityLabel?: string;
  testID?: string;
}

// Chips look compact; the vertical hit slop keeps a full 48dp touch target.
const CHIP_HEIGHT = 40;
const CHIP_SLOP = (touchTargets.minimum - CHIP_HEIGHT) / 2;
const CHIP_HIT_SLOP = { top: CHIP_SLOP, bottom: CHIP_SLOP, left: 0, right: 0 };
const CHIP_RADIUS = radii.chip;

export function Chip({
  label,
  selected = false,
  disabled = false,
  onPress,
  onLongPress,
  leadingIcon,
  leadingIconSize = 16,
  style,
  textStyle,
  accessibilityLabel,
  testID,
}: ChipProps) {
  const { colors } = useTheme();
  const [isFocused, setIsFocused] = useState(false);

  const isInteractive = Boolean(onPress || onLongPress);
  const handlePress = disabled ? undefined : onPress;
  const handleLongPress = disabled ? undefined : onLongPress;
  const pressableDisabled = disabled || !isInteractive;

  const pressableStyles = ({ pressed }: { pressed: boolean }) => [
    styles.chipBase,
    {
      borderWidth: selected ? 2 : 1,
      borderColor: selected ? colors.chipSelectedBorder : colors.chipBorder,
      backgroundColor: disabled ? colors.chipDisabledBackground : colors.surface,
    },
    disabled && styles.disabled,
    disabled && {
      borderColor: colors.chipDisabledBorder,
    },
    pressed && isInteractive && !disabled && { backgroundColor: colors.chipPressedOverlay },
  ];

  const textStyles = [
    styles.label,
    { color: disabled ? colors.textTertiary : colors.textPrimary },
    textStyle,
  ];

  return (
    <View style={[styles.focusWrapper, style]}>
      {isFocused && (
        <View
          pointerEvents="none"
          style={[
            styles.focusRing,
            { borderColor: colors.focusRing },
          ]}
        />
      )}
      <Pressable
        onPress={handlePress}
        onLongPress={handleLongPress}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
        disabled={pressableDisabled}
        accessibilityRole={isInteractive ? 'button' : 'text'}
        accessibilityState={
          isInteractive ? { disabled, selected } : { selected }
        }
        accessibilityLabel={accessibilityLabel ?? label}
        testID={testID}
        hitSlop={CHIP_HIT_SLOP}
        style={pressableStyles}
      >
        {leadingIcon ? (
          <Ionicons
            name={leadingIcon}
            size={leadingIconSize}
            color={disabled ? colors.textTertiary : colors.textPrimary}
            style={styles.leadingIcon}
          />
        ) : null}
        <Text style={textStyles} numberOfLines={1}>
          {label}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  focusWrapper: {
    position: 'relative',
  },
  focusRing: {
    position: 'absolute',
    top: -2,
    right: -2,
    bottom: -2,
    left: -2,
    borderWidth: 2,
    borderRadius: CHIP_RADIUS + 2,
  },
  chipBase: {
    minHeight: CHIP_HEIGHT,
    borderRadius: CHIP_RADIUS,
    paddingHorizontal: spacing.sm,
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
  label: {
    ...typography.bodyS,
    fontWeight: '600',
  },
  leadingIcon: {
    marginRight: spacing.xs,
  },
  disabled: {
    opacity: 0.58,
  },
});
