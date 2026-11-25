import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  Animated,
  AccessibilityInfo,
  ScrollView,
  Dimensions,
  SafeAreaView,
  TouchableWithoutFeedback,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/SimpleThemeProvider';
import { radii, feedback, touchTargets, typography } from '../../theme/tokens';

const { height: screenHeight } = Dimensions.get('window');

export interface ActionSheetAction {
  title: string;
  onPress: () => void;
  icon?: keyof typeof Ionicons.glyphMap;
  destructive?: boolean;
  disabled?: boolean;
}

export interface ActionSheetProps {
  visible: boolean;
  onClose: () => void;
  actions: ActionSheetAction[];
  title?: string;
  message?: string;
  cancelText?: string;
}

export function ActionSheet({
  visible,
  onClose,
  actions,
  title,
  message,
  cancelText = 'Cancel',
}: ActionSheetProps) {
  const { colors } = useTheme();
  const [slideAnim] = React.useState(new Animated.Value(screenHeight));
  const [reduceMotion, setReduceMotion] = React.useState(false);

  React.useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled().then(enabled => {
      if (mounted) setReduceMotion(enabled);
    }).catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => { mounted = false; subscription.remove(); };
  }, []);

  React.useEffect(() => {
    if (reduceMotion) {
      slideAnim.stopAnimation();
      slideAnim.setValue(visible ? 0 : screenHeight);
      return;
    }
    if (visible) {
      Animated.spring(slideAnim, {
        toValue: 0,
        useNativeDriver: true,
        tension: 100,
        friction: 8,
      }).start();
    } else {
      Animated.timing(slideAnim, {
        toValue: screenHeight,
        duration: 250,
        useNativeDriver: true,
      }).start();
    }
  }, [visible, slideAnim, reduceMotion]);

  const handleActionPress = (action: ActionSheetAction) => {
    if (!action.disabled) {
      onClose();
      // Small delay to allow modal to close smoothly
      setTimeout(() => {
        action.onPress();
      }, 100);
    }
  };

  const styles = StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: colors.scrim,
      justifyContent: 'flex-end',
    },
    container: {
      backgroundColor: colors.surface,
      borderTopLeftRadius: radii.sheet,
      borderTopRightRadius: radii.sheet,
      paddingBottom: 20,
      maxHeight: screenHeight * 0.8,
    },
    header: {
      paddingHorizontal: 16,
      paddingTop: 4,
      paddingBottom: 8,
    },
    title: {
      ...typography.titleLarge,
      color: colors.foreground,
      marginBottom: 4,
    },
    message: {
      ...typography.bodySmall,
      color: colors.textSecondary,
    },
    actionsContainer: {
      paddingTop: 4,
    },
    actionButton: {
      minHeight: touchTargets.row,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.divider,
    },
    actionIcon: {
      alignItems: 'center',
      backgroundColor: colors.surfaceAlt,
      borderRadius: radii.round,
      height: 36,
      justifyContent: 'center',
      marginRight: 12,
      width: 36,
    },
    actionText: {
      flex: 1,
      fontSize: 16,
      fontWeight: '500',
    },
    actionTextNormal: {
      color: colors.foreground,
    },
    actionTextDestructive: {
      color: colors.destructive,
    },
    actionTextDisabled: {
      color: colors.mutedForeground,
    },
    actionButtonDisabled: {
      opacity: 0.5,
    },
    cancelSection: {
      marginTop: 8,
      paddingHorizontal: 16,
    },
    cancelButton: {
      alignItems: 'center',
      backgroundColor: colors.surfaceAlt,
      borderRadius: radii.button,
      flexDirection: 'row',
      justifyContent: 'center',
      minHeight: touchTargets.action,
      paddingHorizontal: 20,
    },
    cancelText: {
      fontSize: 16,
      fontWeight: '600',
      color: colors.foreground,
    },
    handle: {
      width: 36,
      height: 4,
      backgroundColor: colors.muted,
      borderRadius: 2,
      alignSelf: 'center',
      marginTop: 8,
      marginBottom: 12,
    },
  });

  if (!visible) {
    return null;
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType={reduceMotion ? 'none' : 'fade'}
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.overlay}>
          <TouchableWithoutFeedback>
            <Animated.View
              accessibilityViewIsModal
              style={[
                styles.container,
                {
                  transform: [{ translateY: slideAnim }],
                },
              ]}
            >
              <SafeAreaView style={{ maxHeight: screenHeight * 0.8 }}>
                <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
                <View style={styles.handle} />
                
                {(title || message) && (
                  <View style={styles.header}>
                    {title && <Text accessibilityRole="header" style={styles.title}>{title}</Text>}
                    {message && <Text style={styles.message}>{message}</Text>}
                  </View>
                )}

                <View style={styles.actionsContainer}>
                  {actions.map((action, index) => (
                    <TouchableOpacity
                      key={index}
                      style={[
                        styles.actionButton,
                        action.disabled && styles.actionButtonDisabled,
                        index === actions.length - 1 && { borderBottomWidth: 0 },
                      ]}
                      onPress={() => handleActionPress(action)}
                      disabled={action.disabled}
                      activeOpacity={action.disabled ? 1 : feedback.opacity.pressed}
                      accessibilityRole="button"
                      accessibilityLabel={action.title}
                      accessibilityState={{ disabled: action.disabled }}
                    >
                      {action.icon ? (
                        <View style={styles.actionIcon}>
                          <Ionicons
                            name={action.icon}
                            size={20}
                            color={
                              action.disabled
                                ? colors.mutedForeground
                                : action.destructive
                                ? colors.destructive
                                : colors.foreground
                            }
                          />
                        </View>
                      ) : null}
                      <Text
                        style={[
                          styles.actionText,
                          action.destructive
                            ? styles.actionTextDestructive
                            : action.disabled
                            ? styles.actionTextDisabled
                            : styles.actionTextNormal,
                        ]}
                      >
                        {action.title}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <View style={styles.cancelSection}>
                  <TouchableOpacity style={styles.cancelButton} onPress={onClose} accessibilityRole="button" accessibilityLabel={cancelText}>
                    <Text style={styles.cancelText}>{cancelText}</Text>
                  </TouchableOpacity>
                </View>
                </ScrollView>
              </SafeAreaView>
            </Animated.View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

// Export default for convenience
export default ActionSheet;
