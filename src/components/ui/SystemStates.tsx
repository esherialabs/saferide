import React from 'react';
import {
  ActivityIndicator,
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
import Button from './Button';
import { type ComponentTone, getTonePalette } from './componentStyles';

export interface EmptyStateProps {
  title: string;
  message?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  actionLabel?: string;
  onAction?: () => void;
  secondaryAction?: React.ReactNode;
  tone?: ComponentTone;
  style?: StyleProp<ViewStyle>;
}

export function EmptyState({
  title,
  message,
  icon = 'document-text-outline',
  actionLabel,
  onAction,
  secondaryAction,
  tone = 'neutral',
  style,
}: EmptyStateProps) {
  const { colors } = useTheme();
  const tonePalette = getTonePalette(colors, tone);
  return (
    <View style={[styles.state, style]}>
      <View
        style={[
          styles.stateIcon,
          { backgroundColor: tonePalette.muted, borderColor: tonePalette.border },
        ]}
      >
        <Ionicons name={icon} size={24} color={tonePalette.color} />
      </View>
      <Text accessibilityRole="header" style={[styles.stateTitle, { color: colors.foreground }]}>
        {title}
      </Text>
      {message ? <Text style={[styles.stateMessage, { color: colors.textSecondary }]}>{message}</Text> : null}
      {(actionLabel && onAction) || secondaryAction ? (
        <View style={styles.stateActions}>
          {actionLabel && onAction ? <Button title={actionLabel} onPress={onAction} size="sm" /> : null}
          {secondaryAction}
        </View>
      ) : null}
    </View>
  );
}

export interface ErrorStateProps {
  title?: string;
  message: string;
  retryLabel?: string;
  onRetry?: () => void;
  details?: string;
  style?: StyleProp<ViewStyle>;
}

export function ErrorState({
  title = 'Something went wrong',
  message,
  retryLabel = 'Try again',
  onRetry,
  details,
  style,
}: ErrorStateProps) {
  return (
    <EmptyState
      title={title}
      message={details ? `${message}\n${details}` : message}
      icon="alert-circle-outline"
      actionLabel={onRetry ? retryLabel : undefined}
      onAction={onRetry}
      tone="destructive"
      style={style}
    />
  );
}

export interface LoadingStateProps {
  title?: string;
  message?: string;
  tone?: ComponentTone;
  style?: StyleProp<ViewStyle>;
}

export function LoadingState({
  title = 'Loading',
  message,
  tone = 'primary',
  style,
}: LoadingStateProps) {
  const { colors } = useTheme();
  const tonePalette = getTonePalette(colors, tone);

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={message ? `${title}. ${message}` : title}
      style={[styles.state, style]}
    >
      <View style={[styles.stateIcon, { backgroundColor: tonePalette.muted, borderColor: tonePalette.border }]}>
        <ActivityIndicator color={tonePalette.color} />
      </View>
      <Text accessibilityRole="header" style={[styles.stateTitle, { color: colors.foreground }]}>
        {title}
      </Text>
      {message ? <Text style={[styles.stateMessage, { color: colors.textSecondary }]}>{message}</Text> : null}
    </View>
  );
}

export interface UnavailableStateProps {
  title?: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  style?: StyleProp<ViewStyle>;
}

export function UnavailableState({
  title = 'Unavailable',
  message,
  actionLabel,
  onAction,
  style,
}: UnavailableStateProps) {
  return (
    <EmptyState
      title={title}
      message={message}
      icon="remove-circle-outline"
      actionLabel={actionLabel}
      onAction={onAction}
      tone="unavailable"
      style={style}
    />
  );
}

export interface StatusBannerProps {
  title: string;
  message?: string;
  tone?: ComponentTone;
  icon?: keyof typeof Ionicons.glyphMap;
  actionLabel?: string;
  onAction?: () => void;
  onPress?: () => void;
  compact?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

export function StatusBanner({
  title,
  message,
  tone = 'info',
  icon,
  actionLabel,
  onAction,
  onPress,
  compact = false,
  accessibilityLabel,
  style,
}: StatusBannerProps) {
  const { colors } = useTheme();
  const tonePalette = getTonePalette(colors, tone);
  const isInteractive = Boolean(onPress);

  return (
    <Pressable
      onPress={onPress}
      disabled={!isInteractive}
      accessibilityRole={isInteractive ? 'button' : 'text'}
      accessibilityLabel={accessibilityLabel ?? (message ? `${title}. ${message}` : title)}
      style={({ pressed }) => [
        styles.statusBanner,
        {
          backgroundColor: tonePalette.muted,
          borderColor: tonePalette.border,
          paddingVertical: compact ? spacing.xs : spacing.sm,
        },
        pressed && isInteractive ? { opacity: feedback.opacity.pressed } : null,
        style,
      ]}
    >
      <View style={[styles.statusIcon, { backgroundColor: colors.surface, borderColor: tonePalette.border }]}>
        <Ionicons name={icon ?? 'information-circle-outline'} size={18} color={tonePalette.color} />
      </View>
      <View style={styles.statusText}>
        <Text style={[styles.statusTitle, { color: colors.foreground }]}>{title}</Text>
        {message && !compact ? <Text style={[styles.statusMessage, { color: colors.textSecondary }]}>{message}</Text> : null}
      </View>
      {actionLabel && onAction ? (
        <Button title={actionLabel} onPress={onAction} variant="outline" size="sm" />
      ) : null}
    </Pressable>
  );
}

export interface OfflineBannerProps {
  title?: string;
  message?: string;
  queuedCount?: number;
  onPress?: () => void;
  onDismiss?: () => void;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function OfflineBanner({
  title = 'Offline mode',
  message = 'Drafts and evidence stay on this device. Remote actions will wait.',
  queuedCount,
  onPress,
  onDismiss,
  compact = false,
  style,
}: OfflineBannerProps) {
  const { colors } = useTheme();

  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : 'text'}
      accessibilityLabel={`${title}. ${message}`}
      style={[
        styles.banner,
        {
          backgroundColor: colors.offlineMuted,
          borderColor: colors.border,
          paddingVertical: compact ? spacing.xxs : spacing.xs,
        },
        style,
      ]}
    >
      <Ionicons name="cloud-offline-outline" size={18} color={colors.offline} style={styles.bannerIcon} />
      <View style={styles.bannerText}>
        <Text style={[styles.bannerTitle, { color: colors.foreground }]}>{title}</Text>
        {!compact ? <Text style={[styles.bannerMessage, { color: colors.textSecondary }]}>{message}</Text> : null}
      </View>
      {queuedCount !== undefined ? (
        <View style={[styles.queuePill, { backgroundColor: colors.surface }]}>
          <Text style={[styles.queueText, { color: colors.offline }]}>{queuedCount}</Text>
        </View>
      ) : null}
      {onDismiss ? (
        <Pressable
          accessibilityLabel="Dismiss banner"
          accessibilityRole="button"
          onPress={(event) => {
            event.stopPropagation();
            onDismiss();
          }}
          style={styles.bannerDismiss}
        >
          <Ionicons name="close" size={18} color={colors.textSecondary} />
        </Pressable>
      ) : null}
    </Pressable>
  );
}

export interface SafetyActionProps {
  title: string;
  description?: string;
  icon: keyof typeof Ionicons.glyphMap;
  onPress?: () => void;
  tone?: ComponentTone;
  disabled?: boolean;
  statusLabel?: string;
  trailing?: React.ReactNode;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
}

export function SafetyAction({
  title,
  description,
  icon,
  onPress,
  tone = 'safety',
  disabled = false,
  statusLabel,
  trailing,
  accessibilityLabel,
  accessibilityHint,
  style,
}: SafetyActionProps) {
  const { colors } = useTheme();
  const tonePalette = getTonePalette(colors, tone);
  const isDisabled = disabled || !onPress;
  const [isFocused, setIsFocused] = React.useState(false);
  const defaultAccessibilityLabel = [
    title,
    description,
    statusLabel,
    isDisabled ? 'Unavailable' : null,
  ].filter(Boolean).join('. ');

  return (
    <Pressable
      onPress={onPress}
      onFocus={() => setIsFocused(true)}
      onBlur={() => setIsFocused(false)}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? defaultAccessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: isDisabled }}
      style={({ pressed }) => [
        styles.safetyAction,
        {
          backgroundColor: colors.surface,
          borderColor: isFocused ? colors.focusRing : tonePalette.border,
          borderWidth: isFocused ? borders.focus : borders.standard,
          opacity: isDisabled ? 0.58 : 1,
        },
        pressed && !isDisabled ? { backgroundColor: tonePalette.muted } : null,
        style,
      ]}
    >
      <View style={[styles.actionIcon, { backgroundColor: tonePalette.muted }]}>
        <Ionicons name={icon} size={22} color={tonePalette.color} />
      </View>
      <View style={styles.actionText}>
        <Text style={[styles.actionTitle, { color: colors.foreground }]}>
          {title}
        </Text>
        {description ? (
          <Text style={[styles.actionDescription, { color: colors.textSecondary }]}>
            {description}
          </Text>
        ) : null}
        {statusLabel ? (
          <Text style={[styles.actionStatus, { color: tonePalette.color }]}>
            {statusLabel}
          </Text>
        ) : null}
      </View>
      {trailing ?? (!isDisabled ? <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} /> : null)}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  state: {
    alignItems: 'center',
    gap: spacing.xs,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.lg,
  },
  stateIcon: {
    alignItems: 'center',
    borderRadius: radii.round,
    borderWidth: borders.standard,
    height: 48,
    justifyContent: 'center',
    width: 48,
  },
  stateTitle: {
    ...typography.titleS,
    textAlign: 'center',
  },
  stateMessage: {
    ...typography.bodyS,
    textAlign: 'center',
  },
  stateActions: {
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  statusBanner: {
    alignItems: 'flex-start',
    borderRadius: radii.sm,
    borderWidth: borders.standard,
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  statusIcon: {
    alignItems: 'center',
    borderRadius: radii.badge,
    borderWidth: borders.standard,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  statusText: {
    flex: 1,
    minWidth: 0,
  },
  statusTitle: {
    ...typography.bodyS,
    fontWeight: '700',
  },
  statusMessage: {
    ...typography.caption,
    marginTop: spacing.xxs,
  },
  banner: {
    alignItems: 'flex-start',
    borderRadius: radii.sm,
    borderWidth: borders.hairline,
    flexDirection: 'row',
    gap: spacing.xs,
    paddingLeft: spacing.sm,
    paddingRight: spacing.xs,
  },
  bannerIcon: {
    marginTop: 2,
  },
  bannerText: {
    flex: 1,
    minWidth: 0,
  },
  bannerTitle: {
    ...typography.bodyS,
    fontWeight: '700',
  },
  bannerMessage: {
    ...typography.caption,
    marginTop: 2,
  },
  queuePill: {
    alignItems: 'center',
    borderRadius: radii.round,
    justifyContent: 'center',
    minHeight: 28,
    minWidth: 28,
    paddingHorizontal: spacing.xs,
  },
  queueText: {
    ...typography.caption,
    fontWeight: '700',
  },
  bannerDismiss: {
    alignItems: 'center',
    borderRadius: radii.round,
    height: touchTargets.minimum,
    justifyContent: 'center',
    marginLeft: spacing.xxs,
    width: touchTargets.minimum,
  },
  safetyAction: {
    alignItems: 'center',
    borderRadius: radii.card,
    borderWidth: borders.standard,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: touchTargets.action,
    padding: spacing.md,
  },
  actionIcon: {
    alignItems: 'center',
    borderRadius: radii.round,
    height: touchTargets.minimum,
    justifyContent: 'center',
    width: touchTargets.minimum,
  },
  actionText: {
    flex: 1,
    minWidth: 0,
  },
  actionTitle: {
    ...typography.bodyM,
    fontWeight: '700',
  },
  actionDescription: {
    ...typography.bodyS,
    marginTop: spacing.xxs,
  },
  actionStatus: {
    ...typography.caption,
    fontWeight: '700',
    marginTop: spacing.xs,
  },
});
