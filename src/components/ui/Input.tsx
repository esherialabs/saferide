import React, { forwardRef, useState } from 'react';
import {
  TextInput,
  View,
  Text,
  StyleSheet,
  TextInputProps,
  StyleProp,
  TextStyle,
  ViewStyle,
} from 'react-native';
import { useTheme } from '../../theme/SimpleThemeProvider';
import { radii, spacing, typography, fontFamilies } from '../../theme/tokens';

export interface InputProps extends TextInputProps {
  label?: string;
  error?: string;
  helperText?: string;
  variant?: 'default' | 'filled' | 'outlined';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  startAdornment?: React.ReactNode;
  endAdornment?: React.ReactNode;
  containerStyle?: StyleProp<ViewStyle>;
  inputStyle?: StyleProp<TextStyle>;
}

export const Input = forwardRef<TextInput, InputProps>(({
  label,
  error,
  helperText,
  variant = 'default',
  size = 'md',
  disabled = false,
  startAdornment,
  endAdornment,
  containerStyle,
  inputStyle,
  style,
  ...props
}, ref) => {
  const { colors } = useTheme();
  const [isFocused, setIsFocused] = useState(false);
  const { onFocus: onFocusProp, onBlur: onBlurProp, ...rest } = props;

  const getSizeStyles = (): {
    height: number;
    paddingHorizontal: number;
    paddingVertical: number;
    fontSize: number;
    lineHeight: number;
  } => {
    switch (size) {
      case 'sm':
        return {
          height: 48,
          paddingHorizontal: spacing.sm,
          paddingVertical: spacing.xs,
          fontSize: typography.bodyS.fontSize,
          lineHeight: typography.bodyS.lineHeight,
        };
      case 'lg':
        return {
          height: 56,
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.sm,
          fontSize: typography.bodyM.fontSize,
          lineHeight: typography.bodyM.lineHeight,
        };
      default:
        return {
          height: 52,
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.xs,
          fontSize: typography.bodyM.fontSize,
          lineHeight: typography.bodyM.lineHeight,
        };
    }
  };

  const sizeStyles = getSizeStyles();
  const inputFontWeight = size === 'sm' ? typography.bodyS.fontWeight : typography.bodyM.fontWeight;

  const getVariantStyles = () => {
    const baseStyle = {
      borderRadius: radii.input,
      borderWidth: 1,
      backgroundColor: colors.surface,
      borderColor: colors.input,
    };

    switch (variant) {
      case 'filled':
        return {
          ...baseStyle,
          backgroundColor: colors.surfaceAlt,
        };
      case 'outlined':
        return {
          ...baseStyle,
          backgroundColor: 'transparent',
          borderColor: error ? colors.destructive : colors.focusRing,
          borderWidth: 2,
        };
      default:
        return {
          ...baseStyle,
          borderColor: colors.input,
        };
    }
  };

  const handleFocus: TextInputProps['onFocus'] = event => {
    setIsFocused(true);
    onFocusProp?.(event);
  };

  const handleBlur: TextInputProps['onBlur'] = event => {
    setIsFocused(false);
    onBlurProp?.(event);
  };

  const styles = StyleSheet.create({
    container: {
      marginBottom: spacing.sm,
    },
    label: {
      ...typography.label,
      color: colors.textSecondary,
      marginBottom: spacing.xs,
    },
    inputContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: sizeStyles.height,
      paddingHorizontal: sizeStyles.paddingHorizontal,
      paddingVertical: sizeStyles.paddingVertical,
      ...getVariantStyles(),
      ...(isFocused && !error
        ? {
            borderColor: colors.focusRing,
            borderWidth: 2,
          }
        : null),
      ...(disabled
        ? {
            backgroundColor: colors.surfaceAlt,
            borderColor: colors.divider,
            opacity: 0.7,
          }
        : null),
      ...(error
        ? {
            borderColor: colors.destructive,
            borderWidth: 2,
          }
        : null),
    },
    input: {
      flex: 1,
      color: disabled ? colors.textTertiary : colors.foreground,
      fontSize: sizeStyles.fontSize,
      lineHeight: sizeStyles.lineHeight,
      fontWeight: inputFontWeight,
      fontFamily: fontFamilies.text,
      paddingVertical: 0, // Remove default padding to control height precisely
    },
    startAdornment: {
      marginRight: spacing.xs,
    },
    endAdornment: {
      // Lets a 48dp trailing control sit close to the field edge.
      marginLeft: spacing.xxs,
      marginRight: -spacing.xs,
    },
    helperText: {
      ...typography.caption,
      marginTop: spacing.xs,
      color: error ? colors.destructive : colors.textSecondary,
    },
    errorText: {
      ...typography.caption,
      marginTop: spacing.xs,
      color: colors.destructive,
    },
  });

  return (
    <View style={[styles.container, containerStyle]}>
      {label && <Text style={styles.label}>{label}</Text>}
      
      <View style={styles.inputContainer}>
        {startAdornment && (
          <View style={styles.startAdornment}>
            {startAdornment}
          </View>
        )}
        
        <TextInput
          ref={ref}
          style={[styles.input, inputStyle, style]}
          placeholderTextColor={colors.textTertiary}
          editable={!disabled}
          accessibilityLabel={label}
          onFocus={handleFocus}
          onBlur={handleBlur}
          {...rest}
        />
        
        {endAdornment && (
          <View style={styles.endAdornment}>
            {endAdornment}
          </View>
        )}
      </View>
      
      {error && <Text style={styles.errorText}>{error}</Text>}
      {!error && helperText && <Text style={styles.helperText}>{helperText}</Text>}
    </View>
  );
});

Input.displayName = 'Input';

export default Input;
