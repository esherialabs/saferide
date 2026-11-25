import React, { forwardRef, useState } from 'react';
import {
  TextInput,
  View,
  Text,
  StyleSheet,
  TextInputProps,
} from 'react-native';
import { useTheme } from '../../theme/SimpleThemeProvider';
import { radii, spacing, typography, fontFamilies } from '../../theme/tokens';

export interface TextareaProps extends Omit<TextInputProps, 'style' | 'multiline'> {
  label?: string;
  error?: string;
  helperText?: string;
  variant?: 'default' | 'filled' | 'outlined';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  rows?: number;
  resize?: 'none' | 'vertical' | 'horizontal' | 'both';
  containerStyle?: any;
  inputStyle?: any;
}

export const Textarea = forwardRef<TextInput, TextareaProps>(({
  label,
  error,
  helperText,
  variant = 'default',
  size = 'md',
  disabled = false,
  rows = 4,
  resize = 'vertical',
  containerStyle,
  inputStyle,
  ...props
}, ref) => {
  const { colors } = useTheme();
  const [isFocused, setIsFocused] = useState(false);
  const { onFocus: onFocusProp, onBlur: onBlurProp, ...rest } = props;

  const getSizeStyles = () => {
    const baseLineHeight = typography.bodyM.lineHeight;
    const basePadding = {
      sm: { paddingHorizontal: spacing.xs, paddingVertical: spacing.xxs, fontSize: typography.bodyS.fontSize },
      md: { paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, fontSize: typography.bodyM.fontSize },
      lg: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, fontSize: typography.bodyM.fontSize },
    };

    return {
      ...basePadding[size],
      minHeight: (baseLineHeight * rows) + (basePadding[size].paddingVertical * 2),
      lineHeight: baseLineHeight,
    };
  };

  const getVariantStyles = () => {
    const baseStyle = {
      borderRadius: 8,
      borderWidth: 1,
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
          backgroundColor: colors.surface,
          borderColor: error ? colors.destructive : colors.focusRing,
          borderWidth: 2,
        };
      default:
        return {
          ...baseStyle,
          backgroundColor: colors.surface,
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
      ...getVariantStyles(),
      borderRadius: radii.input,
      paddingHorizontal: spacing.xs,
      paddingVertical: spacing.xxs,
      ...(disabled && {
        backgroundColor: colors.surfaceAlt,
        borderColor: colors.divider,
        opacity: 0.7,
      }),
      ...(isFocused && !error
        ? {
            borderColor: colors.focusRing,
            borderWidth: 2,
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
      color: disabled ? colors.textTertiary : colors.foreground,
      textAlignVertical: 'top',
      ...getSizeStyles(),
      fontFamily: fontFamilies.text,
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
        <TextInput
          ref={ref}
          style={[styles.input, inputStyle]}
          placeholderTextColor={colors.textTertiary}
          editable={!disabled}
          accessibilityLabel={label}
          multiline
          scrollEnabled={resize !== 'none'}
          onFocus={handleFocus}
          onBlur={handleBlur}
          {...rest}
        />
      </View>
      
      {error && <Text style={styles.errorText}>{error}</Text>}
      {!error && helperText && <Text style={styles.helperText}>{helperText}</Text>}
    </View>
  );
});

Textarea.displayName = 'Textarea';

export default Textarea;
