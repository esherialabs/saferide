import React from 'react';
import {
  AccessibilityInfo,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '../../theme/SimpleThemeProvider';
import { borders, radii, spacing, typography } from '../../theme/tokens';
import { IconButton } from './IconButton';

export type EmergencyCallOption = {
  key: string;
  /** Number as dialled and shown, e.g. "1195". */
  number: string;
  /** Who answers, e.g. "GBV helpline". */
  label: string;
  tone: 'support' | 'critical';
  onPress: () => void;
};

export interface EmergencyHelpSheetProps {
  visible: boolean;
  onClose: () => void;
  title: string;
  message: string;
  calls: EmergencyCallOption[];
  /** Present only when the calculator decoy can be unlocked. */
  onQuickExit?: () => void;
  footnote?: string;
}

/**
 * Immediate-help chooser: one large tile per number, Quick Exit as its own
 * full-width action, and a plain close. Each choice closes the sheet first,
 * then runs, so the dialer never opens under a modal.
 */
export function EmergencyHelpSheet({
  visible,
  onClose,
  title,
  message,
  calls,
  onQuickExit,
  footnote,
}: EmergencyHelpSheetProps) {
  const { colors, mode } = useTheme();
  const { width, height, fontScale } = useWindowDimensions();
  const stacked = width < 350 || fontScale >= 1.3;
  const [reduceMotion, setReduceMotion] = React.useState(false);

  React.useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then(enabled => { if (mounted) setReduceMotion(enabled); })
      .catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => { mounted = false; subscription.remove(); };
  }, []);

  if (!visible) return null;

  const run = (action: () => void) => {
    onClose();
    setTimeout(action, 100);
  };

  const toneColors = (tone: EmergencyCallOption['tone']) => tone === 'critical'
    ? { fill: colors.criticalMuted, border: colors.critical, accent: colors.critical }
    : { fill: colors.supportMuted, border: colors.support, accent: colors.support };

  return (
    <Modal
      visible={visible}
      transparent
      animationType={reduceMotion ? 'none' : 'slide'}
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={[styles.overlay, { backgroundColor: colors.scrim }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close immediate help" />
        <SafeAreaView
          edges={['bottom']}
          accessibilityViewIsModal
          style={[styles.sheet, { backgroundColor: colors.surface, maxHeight: height * 0.9 }]}
        >
          <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
            <View style={styles.headerRow}>
              <View style={[styles.headerIcon, { backgroundColor: colors.criticalMuted }]}>
                <Ionicons name="warning" size={22} color={colors.critical} />
              </View>
              <Text accessibilityRole="header" style={[styles.title, { color: colors.foreground }]}>{title}</Text>
              <IconButton
                icon="close"
                variant="ghost"
                accessibilityLabel="Close immediate help"
                onPress={onClose}
              />
            </View>
            <Text style={[styles.message, { color: colors.textSecondary }]}>{message}</Text>

            <View style={[styles.callGrid, stacked && styles.callGridStacked]}>
              {calls.map(call => {
                const tone = toneColors(call.tone);
                return (
                  <Pressable
                    key={call.key}
                    accessibilityRole="button"
                    accessibilityLabel={`Call ${call.number}, ${call.label}`}
                    onPress={() => run(call.onPress)}
                    style={({ pressed }) => [
                      styles.callTile,
                      stacked ? styles.callTileStacked : styles.callTileSideBySide,
                      {
                        backgroundColor: tone.fill,
                        borderColor: tone.border,
                        opacity: pressed ? 0.85 : 1,
                      },
                    ]}
                  >
                    <View style={[styles.callIcon, { backgroundColor: tone.accent }]}>
                      <Ionicons name="call" size={18} color={mode === 'dark' ? colors.background : colors.textInverse} />
                    </View>
                    <View style={stacked ? styles.callCopyStacked : styles.callCopy}>
                      <Text style={[styles.callNumber, { color: colors.foreground }]}>{call.number}</Text>
                      <Text style={[styles.callLabel, { color: colors.foreground }, stacked ? styles.callLabelStacked : null]}>
                        {call.label}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>

            {onQuickExit ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Quick Exit"
                accessibilityHint="Switches SafeRide to the calculator screen"
                onPress={() => run(onQuickExit)}
                style={({ pressed }) => [
                  styles.quickExit,
                  { borderColor: colors.border, backgroundColor: pressed ? colors.surfaceAlt : colors.surface },
                ]}
              >
                <Ionicons name="calculator-outline" size={20} color={colors.foreground} />
                <View style={styles.quickExitCopy}>
                  <Text style={[styles.quickExitTitle, { color: colors.foreground }]}>Quick Exit</Text>
                  <Text style={[styles.quickExitText, { color: colors.textSecondary }]}>Switch to the calculator screen</Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
              </Pressable>
            ) : null}

            {footnote ? (
              <Text style={[styles.footnote, { color: colors.textSecondary }]}>{footnote}</Text>
            ) : null}

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              onPress={onClose}
              style={({ pressed }) => [styles.cancel, { backgroundColor: pressed ? colors.surfaceAlt : 'transparent' }]}
            >
              <Text style={[styles.cancelText, { color: colors.foreground }]}>Cancel</Text>
            </Pressable>
          </ScrollView>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: radii.sheet,
    borderTopRightRadius: radii.sheet,
    overflow: 'hidden',
  },
  content: {
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  headerIcon: {
    alignItems: 'center',
    borderRadius: radii.round,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  title: {
    ...typography.titleLarge,
    flex: 1,
  },
  message: {
    ...typography.bodyMedium,
  },
  callGrid: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  callGridStacked: {
    flexDirection: 'column',
  },
  callTile: {
    alignItems: 'center',
    borderRadius: radii.card,
    borderWidth: borders.emphasized,
    gap: spacing.xs,
    minHeight: 112,
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.sm,
  },
  callTileSideBySide: {
    flex: 1,
  },
  callTileStacked: {
    // No flex here: a zero basis would stop the row growing with large text.
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'flex-start',
    minHeight: 64,
    paddingHorizontal: spacing.sm,
  },
  callIcon: {
    alignItems: 'center',
    borderRadius: radii.round,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  callCopy: {
    alignItems: 'center',
  },
  callCopyStacked: {
    flex: 1,
  },
  callNumber: {
    ...typography.headlineSmall,
  },
  callLabel: {
    ...typography.labelMedium,
    textAlign: 'center',
  },
  callLabelStacked: {
    textAlign: 'left',
  },
  quickExit: {
    alignItems: 'center',
    borderRadius: radii.card,
    borderWidth: borders.hairline,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 56,
    paddingHorizontal: spacing.sm,
  },
  quickExitCopy: {
    flex: 1,
  },
  quickExitTitle: {
    ...typography.labelLarge,
  },
  quickExitText: {
    ...typography.bodySmall,
  },
  footnote: {
    ...typography.caption,
    textAlign: 'center',
  },
  cancel: {
    alignItems: 'center',
    borderRadius: radii.button,
    justifyContent: 'center',
    minHeight: 48,
  },
  cancelText: {
    ...typography.labelLarge,
  },
});
