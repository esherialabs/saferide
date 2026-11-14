import React, { useMemo } from 'react';
import {
  TouchableOpacity,
  Text,
  ActivityIndicator,
  View,
  StyleProp,
  ViewStyle,
  TextStyle,
  StyleSheet,
} from 'react-native';
import { useTheme } from '../../theme/SimpleThemeProvider';
import { radii, typography, spacing } from '../../theme/tokens';

export interface ButtonProps {
  title?: string;
  onPress?: () => void;
  variant?: 'default' | 'primary' | 'secondary' | 'outline' | 'destructive' | 'ghost' | 'link';
  size?: 'icon' | 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  disabled?: boolean;
  loading?: boolean;
  fullWidth?: boolean;
  icon?: React.ReactNode;
  iconPosition?: 'left' | 'right';
  children?: React.ReactNode;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

type SizeKey = NonNullable<ButtonProps['size']>;

const SIZE_MAP: Record<SizeKey, {
  height: number;
  paddingHorizontal: number;
  radius: number;
  fontSize: number;
}> = {
  icon: { height: 48, paddingHorizontal: 0, radius: radii.button, fontSize: typography.button.fontSize },
  xs: { height: 48, paddingHorizontal: spacing.md, radius: radii.chip, fontSize: typography.bodyS.fontSize },
  sm: { height: 48, paddingHorizontal: spacing.md, radius: radii.button, fontSize: typography.bodyS.fontSize },
  md: { height: 48, paddingHorizontal: spacing.lg, radius: radii.button, fontSize: typography.button.fontSize },
  lg: { height: 52, paddingHorizontal: spacing.lg, radius: radii.button, fontSize: typography.button.fontSize },
  xl: { height: 56, paddingHorizontal: spacing.xl, radius: radii.button, fontSize: typography.button.fontSize },
};

const styles = StyleSheet.create({
  wrapper: {
    overflow: 'hidden',
  },
  inner: {
    flexGrow: 1,
    paddingVertical: spacing.xs,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
  },
  fullWidth: {
    width: '100%',
    alignSelf: 'stretch',
  },
  iconOnly: {
    justifyContent: 'center',
  },
});

export default function Button({
  title,
  onPress,
  variant = 'primary',
  size = 'md',
  disabled = false,
  loading = false,
  fullWidth = false,
  icon,
  iconPosition = 'left',
  children,
  accessibilityLabel,
  accessibilityHint,
  style,
  testID,
}: ButtonProps) {
  const { colors } = useTheme();
  const resolvedVariant = variant === 'default' ? 'primary' : variant;
  const handlePress = onPress ?? (() => {});
  const sizeConfig = SIZE_MAP[size];

  const wrapperArray: Array<StyleProp<ViewStyle>> = [
    styles.wrapper,
    {
      borderRadius: sizeConfig.radius,
      minHeight: sizeConfig.height,
      maxWidth: '100%',
      opacity: disabled ? 0.7 : 1,
    },
    fullWidth ? styles.fullWidth : { alignSelf: 'flex-start' },
  ];

  if (size === 'icon' && !title && !children) {
    wrapperArray.push({ width: sizeConfig.height });
  }

  if (style) {
    wrapperArray.push(style);
  }

  const wrapperStyle: StyleProp<ViewStyle> = wrapperArray;

  const innerBaseStyle: ViewStyle = {
    paddingHorizontal: sizeConfig.paddingHorizontal,
    borderRadius: sizeConfig.radius,
  };

  const labelStyle: TextStyle = useMemo(() => {
    const base: TextStyle = {
      ...typography.button,
      fontSize: sizeConfig.fontSize,
      color: colors.foreground,
      textAlign: 'center',
      flexShrink: 1,
    };

    if (resolvedVariant === 'link') {
      return {
        ...base,
        color: disabled ? colors.textTertiary : colors.primary,
        textDecorationLine: 'underline',
      };
    }

    if (resolvedVariant === 'ghost') {
      return {
        ...base,
        color: disabled ? colors.textTertiary : colors.primary,
        fontWeight: '600',
      };
    }

    if (resolvedVariant === 'secondary') {
      return {
        ...base,
        color: disabled ? colors.textTertiary : colors.textPrimary,
        fontWeight: '600',
      };
    }

    if (resolvedVariant === 'outline') {
      return {
        ...base,
        color: disabled ? colors.textTertiary : colors.textPrimary,
        fontWeight: '600',
      };
    }

    if (resolvedVariant === 'destructive') {
      return {
        ...base,
        color: colors.destructiveForeground,
        fontWeight: '600',
      };
    }

    // primary
    return {
      ...base,
      color: disabled ? colors.textSecondary : colors.primaryForeground,
    };
  }, [colors, disabled, resolvedVariant, sizeConfig.fontSize]);

  const renderContent = () => {
    if (icon && !children) {
      return (
        <View style={styles.content}>
          {iconPosition === 'left' && (
            <View style={{ marginRight: title ? spacing.xs : 0 }}>
              {icon}
            </View>
          )}
          {title && (
            <Text style={labelStyle}>
              {title}
            </Text>
          )}
          {iconPosition === 'right' && (
            <View style={{ marginLeft: title ? spacing.xs : 0 }}>
              {icon}
            </View>
          )}
        </View>
      );
    }

    if (children) {
      return React.Children.map(children, (child, index) => {
        if (typeof child === 'string' || typeof child === 'number') {
          return (
            <Text
              key={`button_text_${index}`}
              style={labelStyle}
            >
              {child}
            </Text>
          );
        }
        return child;
      });
    }

    return (
      <Text style={labelStyle}>
        {title}
      </Text>
    );
  };

  const renderInner = (contentNode: React.ReactNode) => {
    if (resolvedVariant === 'primary') {
      return (
        <View
          style={[
            styles.inner,
            innerBaseStyle,
            {
              backgroundColor: disabled ? colors.surfaceAlt : colors.primary,
              borderColor: disabled ? colors.border : colors.primary,
              borderWidth: 1,
            },
          ]}
        >
          {contentNode}
        </View>
      );
    }

    if (resolvedVariant === 'destructive') {
      return (
        <View
          style={[
            styles.inner,
            innerBaseStyle,
            {
              backgroundColor: disabled ? colors.dangerMuted : colors.destructive,
            },
          ]}
        >
          {contentNode}
        </View>
      );
    }

    if (resolvedVariant === 'secondary') {
      return (
        <View
          style={[
            styles.inner,
            innerBaseStyle,
            {
              backgroundColor: colors.surface,
              borderWidth: 1,
              borderColor: colors.divider,
            },
          ]}
        >
          {contentNode}
        </View>
      );
    }

    if (resolvedVariant === 'outline') {
      return (
        <View
          style={[
            styles.inner,
            innerBaseStyle,
            {
              backgroundColor: 'transparent',
              borderWidth: 1,
              borderColor: disabled ? colors.divider : colors.textSecondary,
            },
          ]}
        >
          {contentNode}
        </View>
      );
    }

    if (resolvedVariant === 'ghost') {
      return (
        <View
          style={[
            styles.inner,
            innerBaseStyle,
            {
              backgroundColor: 'transparent',
            },
          ]}
        >
          {contentNode}
        </View>
      );
    }

    // link
    return (
      <View
        style={[
          styles.inner,
          innerBaseStyle,
          { backgroundColor: 'transparent', paddingHorizontal: 0 },
        ]}
      >
        {contentNode}
      </View>
    );
  };

  const indicatorColor =
    resolvedVariant === 'primary'
      ? disabled ? colors.textSecondary : colors.primaryForeground
      : resolvedVariant === 'destructive'
      ? colors.destructiveForeground
      : resolvedVariant === 'ghost' || resolvedVariant === 'link'
      ? colors.primary
      : colors.textPrimary;

  return (
    <TouchableOpacity
      style={wrapperStyle}
      onPress={handlePress}
      disabled={disabled || loading}
      accessibilityLabel={accessibilityLabel || title}
      accessibilityHint={accessibilityHint}
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      testID={testID}
    >
      {renderInner(
        loading ? (
          <View style={[styles.content, { alignItems: 'center' }]}>
            <ActivityIndicator size="small" color={indicatorColor} />
            {title ? (
              <Text style={[labelStyle, { marginLeft: spacing.xs }]}>{title}</Text>
            ) : null}
          </View>
        ) : (
          renderContent()
        )
      )}
    </TouchableOpacity>
  );
}
