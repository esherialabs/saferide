import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ViewStyle,
  StyleProp,
  Platform,
  type AccessibilityRole,
  type AccessibilityState,
} from 'react-native';
import { useTheme } from '../../theme/SimpleThemeProvider';
import { borders, elevation, radii, spacing, typography } from '../../theme/tokens';

export interface CardProps {
  children: React.ReactNode;
  onPress?: () => void;
  variant?: 'default' | 'elevated' | 'outlined' | 'filled';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  selected?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityRole?: AccessibilityRole;
  accessibilityState?: AccessibilityState;
  style?: StyleProp<ViewStyle>;
  surfaceStyle?: StyleProp<ViewStyle>;
  accentColor?: string;
  accentPosition?: 'left' | 'top';
  hideAccent?: boolean;
}

export interface CardHeaderProps {
  children: React.ReactNode;
  style?: any;
}

export interface CardContentProps {
  children: React.ReactNode;
  style?: any;
}

export interface CardFooterProps {
  children: React.ReactNode;
  style?: any;
}

export interface CardTitleProps {
  children: React.ReactNode;
  variant?: 'default' | 'large' | 'small';
  style?: any;
}

export interface CardDescriptionProps {
  children: React.ReactNode;
  style?: any;
}

export function Card({
  children,
  onPress,
  variant = 'default',
  size = 'md',
  disabled = false,
  selected = false,
  accessibilityLabel,
  accessibilityHint,
  accessibilityRole = 'button',
  accessibilityState,
  style,
  surfaceStyle,
  accentColor,
  accentPosition = 'top',
  hideAccent = false,
}: CardProps) {
  const { colors } = useTheme();

  const sizeRadiusMap: Record<typeof size, number> = {
    sm: radii.xs,
    md: radii.card,
    lg: radii.card,
  };

  const wrapperBaseStyle: ViewStyle = {
    borderRadius: sizeRadiusMap[size],
    backgroundColor: 'transparent',
    overflow: 'visible',
    ...(variant === 'elevated'
      ? elevation.raised
      : variant === 'outlined' || variant === 'filled'
        ? elevation.none
        : elevation.card),
    elevation: Platform.OS === 'android'
      ? variant === 'elevated'
        ? 3
        : variant === 'outlined' || variant === 'filled'
          ? 0
          : 2
      : 0,
  };

  const surfaceBaseStyle: ViewStyle = {
    borderRadius: sizeRadiusMap[size],
    borderWidth: selected ? borders.focus : borders.hairline,
    borderColor: selected ? colors.focusRing : colors.border,
    backgroundColor: colors.surface,
    overflow: 'hidden',
    position: 'relative',
  };

  const surfaceVariantStyles: Record<typeof variant, StyleProp<ViewStyle>[]> = {
    default: [surfaceBaseStyle],
    elevated: [
      surfaceBaseStyle,
      {
        backgroundColor: colors.card,
        borderColor: selected ? colors.focusRing : colors.border,
      },
    ],
    outlined: [
      surfaceBaseStyle,
      {
        backgroundColor: colors.surface,
        borderWidth: selected ? borders.focus : borders.hairline,
        borderColor: selected ? colors.focusRing : colors.divider,
      },
    ],
    filled: [
      surfaceBaseStyle,
      {
        backgroundColor: colors.surfaceAlt,
        borderWidth: selected ? borders.focus : borders.hairline,
        borderColor: selected ? colors.focusRing : colors.divider,
      },
    ],
  };

  const marginKeys = [
    'margin',
    'marginTop',
    'marginBottom',
    'marginLeft',
    'marginRight',
    'marginHorizontal',
    'marginVertical',
    'marginStart',
    'marginEnd',
    'alignSelf',
    'alignItems',
    'justifyContent',
    'flex',
    'flexGrow',
    'flexShrink',
    'flexBasis',
    'width',
    'maxWidth',
    'minWidth',
    'height',
    'maxHeight',
    'minHeight',
    'flexDirection',
    'position',
    'top',
    'left',
    'right',
    'bottom',
    'shadowColor',
    'shadowOffset',
    'shadowOpacity',
    'shadowRadius',
    'zIndex',
    'elevation',
  ] as const;

  const flattenedStyle = style ? (StyleSheet.flatten(style) as Record<string, any>) : undefined;
  const outerOverrides: Record<string, any> = {};
  let innerOverrides: Record<string, any> | undefined = flattenedStyle ? { ...flattenedStyle } : undefined;

  if (innerOverrides) {
    const workingOverrides: Record<string, any> = { ...innerOverrides };

    marginKeys.forEach(key => {
      if (workingOverrides[key] !== undefined) {
        outerOverrides[key] = workingOverrides[key];
        delete workingOverrides[key];
      }
    });

    if (workingOverrides.opacity !== undefined) {
      outerOverrides.opacity = workingOverrides.opacity;
      delete workingOverrides.opacity;
    }

    if (workingOverrides.transform !== undefined) {
      outerOverrides.transform = workingOverrides.transform;
      delete workingOverrides.transform;
    }

    innerOverrides = Object.keys(workingOverrides).length === 0 ? undefined : workingOverrides;
  }

  const wrapperStyle: StyleProp<ViewStyle> = [
    wrapperBaseStyle,
    outerOverrides,
    disabled ? { opacity: 0.6 } : null,
  ];

  const surfaceStyles: Array<StyleProp<ViewStyle>> = [
    ...surfaceVariantStyles[variant],
  ];

  if (innerOverrides) {
    surfaceStyles.push(innerOverrides);
  }

  if (surfaceStyle) {
    surfaceStyles.push(surfaceStyle);
  }

  // Selection is shown by the 2dp outline and the caller's label; the accent bar stays a tone cue only.
  const accentVisible = !hideAccent && variant !== 'filled' && Boolean(accentColor);
  const accentStyle: ViewStyle = accentPosition === 'top'
    ? {
      position: 'absolute',
      left: 0,
      right: 0,
      top: 0,
      height: 3,
      backgroundColor: accentColor ?? colors.primary,
      opacity: disabled ? 0.6 : 1,
    }
    : {
      position: 'absolute',
      bottom: 0,
      left: 0,
      top: 0,
      width: 3,
      backgroundColor: accentColor ?? colors.primary,
      opacity: disabled ? 0.6 : 1,
    };

  const content = (
    <View style={surfaceStyles}>
      {accentVisible ? <View pointerEvents="none" style={accentStyle} /> : null}
      {children}
    </View>
  );

  if (onPress) {
    return (
      <TouchableOpacity
        style={wrapperStyle}
        onPress={onPress}
        disabled={disabled}
        activeOpacity={0.82}
        accessibilityRole={accessibilityRole}
        accessible={true}
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint ?? 'Double tap to open'}
        accessibilityState={{ disabled, selected, ...accessibilityState }}
      >
        {content}
      </TouchableOpacity>
    );
  }

  return <View style={wrapperStyle}>{content}</View>;
}

export function CardHeader({ children, style }: CardHeaderProps) {
  return (
    <View style={[{ paddingHorizontal: spacing.md, paddingTop: spacing.md, paddingBottom: spacing.xs }, style]}>
      {children}
    </View>
  );
}

export function CardContent({ children, style }: CardContentProps) {
  return (
    <View style={[{ paddingHorizontal: spacing.md, paddingVertical: spacing.sm }, style]}>
      {children}
    </View>
  );
}

export function CardFooter({ children, style }: CardFooterProps) {
  return (
    <View style={[{ 
      paddingHorizontal: spacing.md,
      paddingBottom: spacing.md,
      paddingTop: spacing.xs,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    }, style]}>
      {children}
    </View>
  );
}

export function CardTitle({ children, variant = 'default', style }: CardTitleProps) {
  const { colors } = useTheme();
  
  const getVariantStyle = () => {
    switch (variant) {
      case 'large':
        return typography.headlineSmall;
      case 'small':
        return typography.titleSmall;
      default:
        return typography.titleMedium;
    }
  };

  return (
    <Text style={[{
      color: colors.foreground,
      marginBottom: spacing.xs,
    }, getVariantStyle(), style]}>
      {children}
    </Text>
  );
}

export function CardDescription({ children, style }: CardDescriptionProps) {
  const { colors } = useTheme();
  
  return (
    <Text style={[{
      ...typography.bodyS,
      color: colors.textSecondary,
    }, style]}>
      {children}
    </Text>
  );
}
