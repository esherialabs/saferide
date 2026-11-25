import React from 'react';
import {
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import Button from './Button';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { useTheme } from '../../theme/SimpleThemeProvider';
import { borders, radii, spacing, touchTargets, typography } from '../../theme/tokens';

export interface InfoModalProps {
  visible: boolean;
  title: string;
  description?: string;
  children: React.ReactNode;
  onClose: () => void;
  closeLabel?: string;
}

export interface InfoModalSectionProps {
  title?: string;
  children: React.ReactNode;
}

export interface InfoModalBulletProps {
  children: React.ReactNode;
}

export function InfoModal({
  visible,
  title,
  description,
  children,
  onClose,
  closeLabel = 'Cancel',
}: InfoModalProps) {
  const { colors } = useTheme();
  const reducedMotion = useReducedMotion();

  const styles = StyleSheet.create({
    overlay: {
      alignItems: 'center',
      backgroundColor: colors.scrim,
      flex: 1,
      justifyContent: 'center',
      padding: spacing.md,
    },
    panel: {
      backgroundColor: colors.surface,
      borderRadius: radii.sheet,
      maxHeight: '88%',
      maxWidth: 440,
      overflow: 'hidden',
      width: '100%',
    },
    closeRow: {
      alignItems: 'flex-end',
      flexShrink: 0,
      paddingHorizontal: spacing.xs,
      paddingTop: spacing.xs,
    },
    closeIcon: {
      alignItems: 'center',
      backgroundColor: colors.surfaceAlt,
      borderRadius: radii.round,
      height: touchTargets.minimum,
      justifyContent: 'center',
      width: touchTargets.minimum,
    },
    header: {
      borderBottomColor: colors.divider,
      borderBottomWidth: borders.hairline,
      paddingBottom: spacing.sm,
      paddingLeft: spacing.md,
      paddingRight: spacing.md,
      paddingTop: spacing.md,
    },
    title: {
      ...typography.titleM,
      color: colors.foreground,
    },
    description: {
      ...typography.bodyS,
      color: colors.textSecondary,
      marginTop: spacing.xs,
    },
    body: {
      gap: spacing.sm,
      padding: spacing.md,
    },
    scroll: {
      flexShrink: 1,
      minHeight: 0,
    },
    footer: {
      borderTopColor: colors.divider,
      borderTopWidth: borders.hairline,
      padding: spacing.md,
      paddingTop: spacing.sm,
    },
  });

  return (
    <Modal visible={visible} transparent animationType={reducedMotion ? 'none' : 'fade'} onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.overlay}>
          <TouchableWithoutFeedback>
            <View accessibilityViewIsModal style={styles.panel}>
              <View style={styles.closeRow}>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Close"
                  onPress={onClose}
                  style={styles.closeIcon}
                >
                  <Ionicons accessible={false} name="close" size={18} color={colors.foreground} />
                </TouchableOpacity>
              </View>
              <ScrollView style={styles.scroll} showsVerticalScrollIndicator keyboardShouldPersistTaps="handled">
                <View style={styles.header}>
                  <Text accessibilityRole="header" style={styles.title}>{title}</Text>
                  {description ? <Text style={styles.description}>{description}</Text> : null}
                </View>
                <View style={styles.body}>{children}</View>
                <View style={styles.footer}>
                  <Button title={closeLabel} variant="outline" onPress={onClose} fullWidth />
                </View>
              </ScrollView>
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

export function InfoModalSection({ title, children }: InfoModalSectionProps) {
  const { colors } = useTheme();

  const styles = StyleSheet.create({
    section: {
      gap: spacing.xs,
    },
    title: {
      ...typography.label,
      color: colors.foreground,
    },
  });

  return (
    <View style={styles.section}>
      {title ? <Text style={styles.title}>{title}</Text> : null}
      {children}
    </View>
  );
}

export function InfoModalBullet({ children }: InfoModalBulletProps) {
  const { colors } = useTheme();

  const styles = StyleSheet.create({
    row: {
      alignItems: 'flex-start',
      flexDirection: 'row',
      gap: spacing.xs,
    },
    dot: {
      backgroundColor: colors.primary,
      borderRadius: radii.round,
      height: 6,
      marginTop: 8,
      width: 6,
    },
    text: {
      ...typography.bodyS,
      color: colors.textSecondary,
      flex: 1,
      lineHeight: 21,
    },
  });

  return (
    <View style={styles.row}>
      <View style={styles.dot} />
      <Text style={styles.text}>{children}</Text>
    </View>
  );
}
