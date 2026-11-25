import React, { useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useTheme } from '../../theme/SimpleThemeProvider';
import { Ionicons } from '@expo/vector-icons';
import { spacing, radii, typography, fontFamilies } from '../../theme/tokens';

export interface AlertProps {
  children: React.ReactNode;
  variant?: 'default' | 'destructive' | 'success' | 'warning' | 'info';
  size?: 'sm' | 'md' | 'lg';
  dismissible?: boolean;
  onDismiss?: () => void;
  autoDismissMs?: number;
  icon?: React.ReactNode;
  showIcon?: boolean;
  /** Accessible name for the dismiss control; defaults to "Close notice". */
  dismissLabel?: string;
  style?: any;
}

export interface AlertTitleProps {
  children: React.ReactNode;
  style?: any;
}

export interface AlertDescriptionProps {
  children: React.ReactNode;
  style?: any;
}

const getDefaultIcon = (variant: string) => {
  switch (variant) {
    case 'destructive':
      return 'alert-circle';
    case 'success':
      return 'checkmark-circle';
    case 'warning':
      return 'warning';
    case 'info':
      return 'information-circle';
    default:
      return 'alert-circle-outline';
  }
};

export function Alert({ 
  children, 
  variant = 'default', 
  size = 'md',
  dismissible = false,
  onDismiss,
  autoDismissMs,
  icon,
  showIcon = true,
  dismissLabel = 'Close notice',
  style 
}: AlertProps) {
  const { colors } = useTheme();

  useEffect(() => {
    if (!dismissible || !onDismiss || !autoDismissMs || autoDismissMs <= 0) {
      return undefined;
    }

    const timeout = setTimeout(onDismiss, autoDismissMs);
    return () => clearTimeout(timeout);
  }, [autoDismissMs, dismissible, onDismiss]);

  const getVariantStyles = () => {
    switch (variant) {
      case 'destructive':
        return {
          backgroundColor: colors.dangerMuted,
          borderColor: colors.destructive,
          iconColor: colors.destructive,
        };
      case 'success':
        return {
          backgroundColor: colors.successMuted,
          borderColor: colors.success,
          iconColor: colors.success,
        };
      case 'warning':
        return {
          backgroundColor: colors.warningMuted,
          borderColor: colors.warning,
          iconColor: colors.warning,
        };
      case 'info':
        return {
          backgroundColor: colors.infoMuted,
          borderColor: colors.info,
          iconColor: colors.info,
        };
      default:
        return {
          backgroundColor: colors.muted,
          borderColor: colors.border,
          iconColor: colors.mutedForeground,
        };
    }
  };

  const getSizeStyles = () => {
    switch (size) {
      case 'sm':
        return {
          padding: spacing.sm,
          borderRadius: radii.badge,
          gap: spacing.xs,
        };
      case 'lg':
        return {
          padding: spacing.lg,
          borderRadius: radii.card,
          gap: spacing.md,
        };
      default:
        return {
          padding: spacing.sm,
          borderRadius: radii.card,
          gap: spacing.xs,
        };
    }
  };

  const variantStyles = getVariantStyles();
  const sizeStyles = getSizeStyles();

  const styles = StyleSheet.create({
    container: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      borderWidth: 1,
      ...sizeStyles,
      backgroundColor: variantStyles.backgroundColor,
      borderColor: variantStyles.borderColor,
    },
    iconContainer: {
      marginRight: sizeStyles.gap,
      marginTop: 2, // Slight offset to align with text
    },
    content: {
      flex: 1,
    },
    dismissButton: {
      marginLeft: sizeStyles.gap,
      marginTop: 2,
      padding: 4,
    },
  });

  const iconSize = size === 'sm' ? 16 : size === 'lg' ? 24 : 20;
  const defaultIconName = getDefaultIcon(variant);

  return (
    <View style={[styles.container, style]}>
      {showIcon && (
        <View style={styles.iconContainer}>
          {icon || (
            <Ionicons
              name={defaultIconName as any}
              size={iconSize}
              color={variantStyles.iconColor}
            />
          )}
        </View>
      )}
      
      <View style={styles.content}>
        {children}
      </View>
      
      {dismissible && onDismiss && (
        <TouchableOpacity
          style={styles.dismissButton}
          onPress={onDismiss}
          hitSlop={12}
          accessibilityLabel={dismissLabel}
          accessibilityRole="button"
        >
          <Ionicons
            name="close"
            size={iconSize}
            color={colors.mutedForeground}
          />
        </TouchableOpacity>
      )}
    </View>
  );
}

export function AlertTitle({ children, style }: AlertTitleProps) {
  const { colors } = useTheme();
  
  return (
    <Text style={[{
      ...typography.bodyM,
      fontWeight: '600',
      fontFamily: fontFamilies.text,
      color: colors.foreground,
      marginBottom: spacing.xs / 2,
    }, style]}>
      {children}
    </Text>
  );
}

export function AlertDescription({ children, style }: AlertDescriptionProps) {
  const { colors } = useTheme();
  
  return (
    <Text style={[{
      ...typography.bodyS,
      color: colors.textSecondary,
      fontFamily: fontFamilies.text,
    }, style]}>
      {children}
    </Text>
  );
}

// Utility components for common patterns
export function SuccessAlert({ children, ...props }: Omit<AlertProps, 'variant'>) {
  return (
    <Alert variant="success" {...props}>
      {children}
    </Alert>
  );
}

export function ErrorAlert({ children, ...props }: Omit<AlertProps, 'variant'>) {
  return (
    <Alert variant="destructive" {...props}>
      {children}
    </Alert>
  );
}

export function WarningAlert({ children, ...props }: Omit<AlertProps, 'variant'>) {
  return (
    <Alert variant="warning" {...props}>
      {children}
    </Alert>
  );
}

export function InfoAlert({ children, ...props }: Omit<AlertProps, 'variant'>) {
  return (
    <Alert variant="info" {...props}>
      {children}
    </Alert>
  );
}
