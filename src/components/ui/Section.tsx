import React from 'react';
import { StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { useTheme } from '../../theme/SimpleThemeProvider';
import { borders, radii, spacing, typography } from '../../theme/tokens';
import { StatePill } from './Badge';
import { type ComponentTone, getTonePalette } from './componentStyles';

export interface SectionHeaderProps {
  title?: string;
  description?: string;
  eyebrow?: string;
  action?: React.ReactNode;
  tone?: ComponentTone;
  style?: StyleProp<ViewStyle>;
}

export function SectionHeader({
  title,
  description,
  eyebrow,
  action,
  tone = 'neutral',
  style,
}: SectionHeaderProps) {
  const { colors } = useTheme();
  const tonePalette = getTonePalette(colors, tone);

  if (!eyebrow && !title && !description && !action) {
    return null;
  }

  return (
    <View style={[styles.header, style]}>
      <View style={styles.headerText}>
        {eyebrow ? (
          <Text style={[styles.eyebrow, { color: tonePalette.color }]}>{eyebrow}</Text>
        ) : null}
        {title ? (
          <Text accessibilityRole="header" style={[styles.title, { color: colors.foreground }]}>
            {title}
          </Text>
        ) : null}
        {description ? (
          <Text style={[styles.description, { color: colors.textSecondary }]}>{description}</Text>
        ) : null}
      </View>
      {action ? <View style={styles.action}>{action}</View> : null}
    </View>
  );
}

export interface SectionProps extends SectionHeaderProps {
  children: React.ReactNode;
  variant?: 'plain' | 'surface' | 'outlined';
  contentStyle?: StyleProp<ViewStyle>;
}

export function Section({
  children,
  title,
  description,
  eyebrow,
  action,
  variant = 'plain',
  tone = 'neutral',
  style,
  contentStyle,
}: SectionProps) {
  const { colors } = useTheme();
  const framed = variant !== 'plain';

  return (
    <View
      style={[
        styles.section,
        framed
          ? {
              backgroundColor: variant === 'surface' ? colors.surface : 'transparent',
              borderColor: variant === 'outlined' ? colors.divider : 'transparent',
              borderWidth: variant === 'outlined' ? borders.standard : 0,
              borderRadius: radii.card,
              padding: spacing.md,
            }
          : null,
        style,
      ]}
    >
      <SectionHeader title={title} description={description} eyebrow={eyebrow} action={action} tone={tone} />
      <View style={contentStyle}>{children}</View>
    </View>
  );
}

export interface FormSectionProps {
  children: React.ReactNode;
  title: string;
  description?: string;
  footer?: React.ReactNode;
  errorMessage?: string;
  required?: boolean;
  tone?: ComponentTone;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
}

export function FormSection({
  children,
  title,
  description,
  footer,
  errorMessage,
  required = false,
  tone = 'neutral',
  style,
  contentStyle,
}: FormSectionProps) {
  const { colors } = useTheme();
  const tonePalette = getTonePalette(colors, errorMessage ? 'destructive' : tone);

  return (
    <View
      style={[
        styles.formSection,
        {
          backgroundColor: colors.surface,
          borderColor: tonePalette.border,
        },
        style,
      ]}
    >
      <SectionHeader
        title={title}
        description={description}
        tone={errorMessage ? 'destructive' : tone}
        action={required ? <StatePill label="Required" tone="warning" size="sm" /> : undefined}
      />
      <View style={[styles.formContent, contentStyle]}>{children}</View>
      {errorMessage ? (
        <Text accessibilityRole="alert" style={[styles.errorText, { color: colors.destructive }]}>
          {errorMessage}
        </Text>
      ) : null}
      {footer ? <View style={styles.formFooter}>{footer}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: spacing.sm,
  },
  header: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'space-between',
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  eyebrow: {
    ...typography.caption,
    fontWeight: '700',
    marginBottom: spacing.xxs,
    textTransform: 'uppercase',
  },
  title: {
    ...typography.titleMedium,
  },
  description: {
    ...typography.bodyS,
    marginTop: spacing.xxs,
  },
  action: {
    flexShrink: 0,
  },
  formSection: {
    borderRadius: radii.card,
    borderWidth: borders.standard,
    gap: spacing.md,
    padding: spacing.lg,
  },
  formContent: {
    gap: spacing.sm,
  },
  errorText: {
    ...typography.caption,
    fontWeight: '700',
  },
  formFooter: {
    borderTopWidth: borders.hairline,
    gap: spacing.xs,
    paddingTop: spacing.sm,
  },
});
