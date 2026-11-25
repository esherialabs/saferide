import React from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../theme/SimpleThemeProvider';
import { useAppReset } from '../../utils/appReset';
import { notificationCenter } from '../../utils/notificationCenter';

type ToastVariant = 'default' | 'success' | 'error' | 'warning' | 'info';

interface ToastItem {
  id: string;
  title?: string;
  message?: string;
  variant?: ToastVariant;
  duration?: number; // ms
}

interface ToastContextValue {
  show: (toast: Omit<ToastItem, 'id'>) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const show = useCallback((toast: Omit<ToastItem, 'id'>) => {
    const id = Math.random().toString(36).slice(2);
    const item: ToastItem = {
      id,
      variant: toast.variant || 'default',
      duration: toast.duration ?? 2500,
      title: toast.title,
      message: toast.message,
    };
    setToasts((prev) => [item, ...prev].slice(0, 4));
    // auto-dismiss
    timers.current[id] = setTimeout(() => dismiss(id), item.duration);
    return id;
  }, []);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current[id];
    if (timer) {
      clearTimeout(timer);
      delete timers.current[id];
    }
  }, []);

  const clear = useCallback(() => {
    Object.values(timers.current).forEach(clearTimeout);
    timers.current = {};
    setToasts([]);
  }, []);

  const value = useMemo(() => ({ show, dismiss, clear }), [show, dismiss, clear]);
  useAppReset(clear);

  useEffect(() => {
    notificationCenter.setHandler((payload) => {
      show({
        title: payload.title,
        message: payload.message,
        variant: payload.variant,
      });
    });

    return () => notificationCenter.clearHandler();
  }, [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <View
        pointerEvents="box-none"
        style={[styles.container, { bottom: Math.max(96, insets.bottom + 88) }]}
      >
        {toasts.map((toast) => (
          <ToastCard key={toast.id} toast={toast} onClose={() => dismiss(toast.id)} colors={colors} />
        ))}
      </View>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

function ToastCard({ toast, onClose, colors }: { toast: ToastItem; onClose: () => void; colors: any }) {
  const opacity = useRef(new Animated.Value(0)).current;

  React.useEffect(() => {
    Animated.timing(opacity, { toValue: 1, duration: 180, easing: Easing.out(Easing.ease), useNativeDriver: true }).start(
    );
    return () => {
      Animated.timing(opacity, { toValue: 0, duration: 120, useNativeDriver: true }).start();
    };
  }, [opacity]);

  const variantColors = getVariantColors(toast.variant || 'default', colors);

  return (
    <Animated.View style={[styles.toast, { backgroundColor: variantColors.bg, borderColor: variantColors.border, opacity }]}> 
      <View style={styles.content}>
        {toast.title ? <Text style={[styles.title, { color: variantColors.fg }]}>{toast.title}</Text> : null}
        {toast.message ? <Text style={[styles.message, { color: variantColors.muted }]}>{toast.message}</Text> : null}
      </View>
      <TouchableOpacity
        accessibilityLabel="Dismiss notification"
        accessibilityRole="button"
        hitSlop={10}
        onPress={onClose}
        style={styles.close}
      >
        <Ionicons name="close" size={18} color={variantColors.fg} />
      </TouchableOpacity>
    </Animated.View>
  );
}

function getVariantColors(variant: ToastVariant, colors: any) {
  switch (variant) {
    case 'success':
      return { bg: colors.successMuted, border: colors.success, fg: colors.foreground, muted: colors.textSecondary };
    case 'error':
      return { bg: colors.dangerMuted, border: colors.destructive, fg: colors.foreground, muted: colors.textSecondary };
    case 'warning':
      return { bg: colors.warningMuted, border: colors.warning, fg: colors.foreground, muted: colors.textSecondary };
    case 'info':
      return { bg: colors.infoMuted, border: colors.info, fg: colors.foreground, muted: colors.textSecondary };
    default:
      // Opaque surfaces keep toast text readable over scrolling content.
      return { bg: colors.surface, border: colors.border, fg: colors.foreground, muted: colors.textSecondary };
  }
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 0,
    right: 0,
    paddingHorizontal: 16,
    gap: 8,
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    shadowColor: 'rgba(29,21,19,0.16)',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 1,
    shadowRadius: 12,
    elevation: 4,
  },
  content: { flex: 1 },
  title: { fontWeight: '600', fontSize: 14 },
  message: { fontSize: 12, marginTop: 2 },
  close: {
    alignItems: 'center',
    borderRadius: 14,
    height: 28,
    justifyContent: 'center',
    marginLeft: 8,
    width: 28,
  },
});
