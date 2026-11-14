import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
  TextInput,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';

import AppLogo from '../components/AppLogo';
import { BrandBar } from '../components/BrandWordmark';
import { SafetyIllustration } from '../components/ui/SafetyIllustration';
import Button from '../components/ui/Button';
import { useTheme } from '../theme/SimpleThemeProvider';
import { useAuth } from '../context/AuthProvider';
import { useToast } from '../components/ui/Toast';
import { borders, radii, spacing, typography } from '../theme/tokens';
import { getAuthErrorMessage } from '../lib/auth/authErrors';

type AuthMode = 'sign-in' | 'sign-up';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_RESET_UNAVAILABLE_MESSAGE =
  'Password reset is not available in this build yet. Create a new account or contact support if you cannot sign in.';

interface FormErrors {
  email?: string;
  password?: string;
  confirmPassword?: string;
}

type TopAuthNotice = {
  title: string;
  message: string;
  variant: 'error' | 'warning' | 'info';
};

export default function AuthScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { colors, colorScheme } = useTheme();
  const toast = useToast();
  const {
    signInWithPassword,
    signUpWithPassword,
    signInAnonymously,
    isLocalGuest,
    isLoading,
    isAuthenticatingWithLink,
    linkError,
    clearLinkError,
  } = useAuth();

  const [mode, setMode] = useState<AuthMode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fullName, setFullName] = useState('');

  const [formErrors, setFormErrors] = useState<FormErrors>({});
  const [formErrorMessage, setFormErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [resetMessage, setResetMessage] = useState<string | null>(null);
  const [isAnonymousSigningIn, setIsAnonymousSigningIn] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [topNotice, setTopNotice] = useState<TopAuthNotice | null>(null);

  const isSignUp = mode === 'sign-up';
  const sanitizedEmail = email.trim().toLowerCase();

  useEffect(() => {
    const requestedAction = route.params?.action;
    if (requestedAction === 'sign-up') {
      setMode('sign-up');
    } else if (requestedAction === 'sign-in') {
      setMode('sign-in');
    }
  }, [route.params?.action]);

  useEffect(() => {
    if (!topNotice) return undefined;
    const timer = setTimeout(() => setTopNotice(null), 5200);
    return () => clearTimeout(timer);
  }, [topNotice]);

  const showTopNotice = useCallback((notice: TopAuthNotice) => {
    setTopNotice(notice);
  }, []);

  const resetFieldError = (field: keyof FormErrors) => {
    setFormErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  const validateForm = (): boolean => {
    const nextErrors: FormErrors = {};

    if (!EMAIL_REGEX.test(sanitizedEmail)) {
      nextErrors.email = 'Enter a valid email address to continue.';
    }

    if (password.length < 8) {
      nextErrors.password = 'Password must be at least 8 characters.';
    }

    if (isSignUp) {
      if (password !== confirmPassword) {
        nextErrors.confirmPassword = 'Passwords do not match.';
      }
    }

    setFormErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const handleModeChange = (nextMode: AuthMode) => {
    if (mode === nextMode) return;
    setMode(nextMode);
    setFormErrors({});
    setFormErrorMessage(null);
    setResetMessage(null);
    setTopNotice(null);
  };

  const handlePasswordAuth = async () => {
    setFormErrorMessage(null);
    if (!validateForm()) return;

    setIsSubmitting(true);
    try {
      if (isSignUp) {
        const result = await signUpWithPassword({
          email: sanitizedEmail,
          password,
          fullName: fullName.trim() || undefined,
        });
        if (result.requiresEmailConfirmation) {
          toast.show({
            title: 'Confirmation required',
            message: 'Check your email for a confirmation link to activate your account.',
            variant: 'info',
          });
        } else {
          toast.show({
            title: 'Account ready',
            message: 'You are signed in and ready to continue.',
            variant: 'success',
          });
        }
      } else {
        await signInWithPassword({
          email: sanitizedEmail,
          password,
        });
        toast.show({
          title: 'Signed in',
          message: 'Welcome back to SafeRide.',
          variant: 'success',
        });
      }
    } catch (error) {
      const message = getAuthErrorMessage(error);
      setFormErrorMessage(message);
      showTopNotice({
        title: isSignUp ? 'Account could not be created' : 'Sign-in needs attention',
        message,
        variant: 'error',
      });
      toast.show({
        title: 'Authentication failed',
        message,
        variant: 'error',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handlePasswordReset = async () => {
    resetFieldError('email');
    setResetMessage(null);

    if (!EMAIL_REGEX.test(sanitizedEmail)) {
      setFormErrors((prev) => ({ ...prev, email: 'Enter a valid email to reset your password.' }));
      return;
    }

    setResetMessage(PASSWORD_RESET_UNAVAILABLE_MESSAGE);
    showTopNotice({
      title: 'Password reset unavailable',
      message: PASSWORD_RESET_UNAVAILABLE_MESSAGE,
      variant: 'warning',
    });
    toast.show({
      title: 'Password reset unavailable',
      message: PASSWORD_RESET_UNAVAILABLE_MESSAGE,
      variant: 'warning',
    });
  };

  const handleAnonymousSignIn = async () => {
    setFormErrorMessage(null);
    setIsAnonymousSigningIn(true);
    try {
      const result = await signInAnonymously();
      toast.show({
        title: 'No-account session',
        message:
          result === 'owned-auth'
            ? 'You are now using SafeRide without creating an email or phone account.'
            : 'You are in local-only mode. Optional online services can be connected later.',
        variant: result === 'owned-auth' ? 'success' : 'warning',
      });
    } catch (error) {
      const message = getAuthErrorMessage(error);
      setFormErrorMessage(message);
      showTopNotice({
        title: 'No-account session unavailable',
        message,
        variant: 'error',
      });
      toast.show({
        title: 'No-account sign-in failed',
        message,
        variant: 'error',
      });
    } finally {
      setIsAnonymousSigningIn(false);
    }
  };

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
      <BrandBar><AppLogo width={168} height={40} inverted={colorScheme === 'dark'} animated={false} /></BrandBar>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
          <View style={styles.column}>
            <View style={{ alignItems: 'center', marginBottom: spacing.xs }}><SafetyIllustration kind="privacy" size={80} responsive /></View>
            {topNotice ? (
              <View
                style={[
                  styles.topNotice,
                  topNotice.variant === 'error'
                    ? { borderColor: colors.destructive + '44', backgroundColor: colors.destructive + '14' }
                    : topNotice.variant === 'warning'
                      ? { borderColor: colors.warning + '44', backgroundColor: colors.warning + '18' }
                      : { borderColor: colors.primary + '40', backgroundColor: colors.primary + '12' },
                ]}
                accessibilityRole="alert"
              >
                <View pointerEvents="none" style={[
                  styles.cardAccentLeft,
                  {
                    backgroundColor: topNotice.variant === 'error'
                      ? colors.destructive
                      : topNotice.variant === 'warning'
                        ? colors.warning
                        : colors.primary,
                  },
                ]} />
                <View style={styles.topNoticeCopy}>
                  <Text style={[
                    styles.topNoticeTitle,
                    {
                      color: topNotice.variant === 'error'
                        ? colors.destructive
                        : topNotice.variant === 'warning'
                          ? colors.warning
                          : colors.primary,
                    },
                  ]}>
                    {topNotice.title}
                  </Text>
                  <Text style={[styles.topNoticeMessage, { color: colors.foreground }]}>{topNotice.message}</Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Dismiss alert"
                  onPress={() => setTopNotice(null)}
                  style={styles.topNoticeClose}
                >
                  <Ionicons name="close" size={18} color={colors.textSecondary} />
                </Pressable>
              </View>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Back to emergency numbers"
              onPress={() => navigation.navigate('Landing')}
              style={styles.landingLink}
            >
              <Ionicons name="chevron-back" size={18} color={colors.primary} />
              <Text style={[styles.landingLinkText, { color: colors.primary }]}>Emergency numbers</Text>
            </Pressable>
            <View style={styles.header}>
              <Text style={[styles.bigTitle, { color: colors.foreground }]}>
                {isSignUp ? 'Create your account' : 'Sign in'}
              </Text>
            </View>

            {isAuthenticatingWithLink ? (
              <View
                style={[styles.linkStatus, { backgroundColor: colors.accent + '22', borderColor: colors.accent + '55' }]}
              >
                <ActivityIndicator size="small" color={colors.accent} />
                <Text style={[styles.linkStatusText, { color: colors.foreground }]}>Processing secure link...</Text>
              </View>
            ) : null}

            {linkError ? (
              <View
                style={[styles.alert, { borderColor: colors.destructive + '40', backgroundColor: colors.destructive + '15' }]}
              >
                <Text style={[styles.alertTitle, { color: colors.destructive }]}>Link expired</Text>
                <Text style={[styles.alertMessage, { color: colors.destructive }]}>{linkError}</Text>
                <Button variant="link" title="Dismiss" onPress={clearLinkError} size="sm" />
              </View>
            ) : null}

            <View
              style={[styles.formBlock, { backgroundColor: colors.surface, borderColor: colors.divider }]}
            >
              {isSignUp ? (
                <>
                  <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Full name</Text>
                  <TextInput
                    value={fullName}
                    onChangeText={(value) => {
                      setFullName(value);
                    }}
                    placeholder=" "
                    placeholderTextColor={colors.textTertiary}
                    autoCapitalize="words"
                    returnKeyType="next"
                    style={[styles.underlineInput, { borderBottomColor: colors.border, color: colors.foreground }]}
                  />
                </>
              ) : null}

              <Text style={[styles.fieldLabel, { color: colors.textSecondary, marginTop: isSignUp ? spacing.xl : 0 }]}>Email</Text>
              <TextInput
                value={email}
                onChangeText={(value) => {
                  if (linkError) clearLinkError();
                  setEmail(value);
                  resetFieldError('email');
                }}
                placeholder=" "
                placeholderTextColor={colors.textTertiary}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                textContentType="emailAddress"
                returnKeyType="next"
                style={[styles.underlineInput, { borderBottomColor: colors.border, color: colors.foreground }]}
              />
              {formErrors.email ? (
                <Text style={[styles.helperError, { color: colors.destructive }]}>{formErrors.email}</Text>
              ) : null}

              <Text style={[styles.fieldLabel, { color: colors.textSecondary, marginTop: spacing.xl }]}>Password</Text>
              <View>
                <TextInput
                  value={password}
                  onChangeText={(value) => {
                    setPassword(value);
                    resetFieldError('password');
                  }}
                  placeholder=" "
                  placeholderTextColor={colors.textTertiary}
                  secureTextEntry={!showPassword}
                  textContentType="password"
                  autoCapitalize="none"
                  returnKeyType={isSignUp ? 'next' : 'done'}
                  style={[styles.underlineInput, { borderBottomColor: colors.border, color: colors.foreground, paddingRight: 40 }]}
                />
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setShowPassword((state) => !state)}
                  style={styles.eye}
                >
                  <Ionicons name={showPassword ? 'eye' : 'eye-outline'} size={22} color={colors.textSecondary} />
                </Pressable>
              </View>
              {formErrors.password ? (
                <Text style={[styles.helperError, { color: colors.destructive }]}>{formErrors.password}</Text>
              ) : null}

              {isSignUp ? (
                <>
                  <Text style={[styles.fieldLabel, { color: colors.textSecondary, marginTop: spacing.xl }]}>Confirm password</Text>
                  <TextInput
                    value={confirmPassword}
                    onChangeText={(value) => {
                      setConfirmPassword(value);
                      resetFieldError('confirmPassword');
                    }}
                    placeholder=" "
                    placeholderTextColor={colors.textTertiary}
                    secureTextEntry={!showPassword}
                    textContentType="password"
                    autoCapitalize="none"
                    returnKeyType="done"
                    style={[styles.underlineInput, { borderBottomColor: colors.border, color: colors.foreground }]}
                  />
                  {formErrors.confirmPassword ? (
                    <Text style={[styles.helperError, { color: colors.destructive }]}>{formErrors.confirmPassword}</Text>
                  ) : null}
                </>
              ) : null}

              {!isSignUp ? (
                <View style={{ marginTop: 16, marginBottom: 8 }}>
                  <Button
                    variant="link"
                    title="Forgot password?"
                    onPress={handlePasswordReset}
                    size="sm"
                  />
                </View>
              ) : null}

              {formErrorMessage ? (
                <Text style={[styles.formError, { color: colors.destructive }]}>{formErrorMessage}</Text>
              ) : null}

              <Button
                title={isSignUp ? 'Create account' : 'Sign In'}
                onPress={handlePasswordAuth}
                fullWidth
                loading={isSubmitting || isLoading}
                disabled={isSubmitting || isLoading}
                style={styles.primaryPill}
              />

              {resetMessage && !isSignUp ? (
                <Text style={[styles.infoText, { color: colors.mutedForeground }]}>{resetMessage}</Text>
              ) : null}
            </View>

            {!isSignUp ? (
              <View style={styles.anonymousBlock}>
                <Text style={[styles.anonymousCopy, { color: colors.textSecondary }]}>
                  Need to capture evidence without creating an account?
                </Text>
                <Button
                  title="Continue without an account"
                  variant="outline"
                  onPress={handleAnonymousSignIn}
                  disabled={isAnonymousSigningIn || isSubmitting || isLoading}
                  loading={isAnonymousSigningIn}
                  fullWidth
                />
              </View>
            ) : null}

            <View style={styles.toggleRow}>
              {isSignUp ? (
                <Pressable onPress={() => handleModeChange('sign-in')}>
                  <Text style={[styles.toggleText, { color: colors.foreground }]}>Already have an account? Sign in</Text>
                </Pressable>
              ) : (
                <Pressable onPress={() => handleModeChange('sign-up')}>
                  <Text style={[styles.toggleText, { color: colors.foreground }]}>Create account</Text>
                </Pressable>
              )}
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
  backgroundImage: {
    ...StyleSheet.absoluteFill,
    height: '100%',
    overflow: 'hidden',
    width: '100%',
  },
  backgroundImageAsset: {
    height: '100%',
    width: '100%',
  },
  overlay: {
    ...StyleSheet.absoluteFill,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xxl,
  },
  column: {
    flex: 1,
    justifyContent: 'center',
    maxWidth: 560,
    width: '100%',
    alignSelf: 'center',
  },
  landingLink: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    flexDirection: 'row',
    gap: spacing.xxs,
    minHeight: 48,
    marginBottom: spacing.sm,
  },
  landingLinkText: {
    ...typography.label,
  },
  topNotice: {
    alignItems: 'flex-start',
    borderRadius: radii.card,
    borderWidth: borders.standard,
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.md,
    minHeight: 64,
    overflow: 'hidden',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    position: 'relative',
  },
  topNoticeCopy: {
    flex: 1,
    minWidth: 0,
  },
  topNoticeTitle: {
    ...typography.label,
    marginBottom: spacing.xxxs,
  },
  topNoticeMessage: {
    ...typography.bodySmall,
  },
  topNoticeClose: {
    alignItems: 'center',
    height: 48,
    justifyContent: 'center',
    marginRight: -spacing.xs,
    marginTop: -spacing.xs,
    width: 48,
  },
  header: {
    alignItems: 'flex-start',
    marginBottom: spacing.xl,
  },
  bigTitle: {
    ...typography.titleXL,
  },
  linkStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: borders.standard,
    borderRadius: radii.card,
    overflow: 'hidden',
    padding: spacing.sm,
    marginBottom: spacing.md,
    position: 'relative',
  },
  linkStatusText: {
    fontSize: 14,
    fontWeight: '500',
  },
  alert: {
    borderWidth: borders.standard,
    borderRadius: radii.card,
    padding: spacing.md,
    gap: spacing.xs,
    marginBottom: spacing.md,
    overflow: 'hidden',
    position: 'relative',
  },
  alertTitle: {
    fontWeight: '700',
    fontSize: 15,
  },
  alertMessage: {
    fontSize: 13,
    lineHeight: 18,
  },
  formBlock: {
    borderRadius: radii.card,
    padding: spacing.md,
    borderWidth: borders.hairline,
    overflow: 'hidden',
    position: 'relative',
  },
  cardAccentLeft: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    top: 0,
    width: 4,
  },
  fieldLabel: {
    ...typography.label,
    marginBottom: spacing.xxs,
  },
  underlineInput: {
    height: 44,
    borderBottomWidth: 1,
    ...typography.bodyM,
  },
  eye: {
    position: 'absolute',
    right: 0,
    top: 10,
    height: 24,
    width: 40,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  formError: {
    fontSize: 13,
    fontWeight: '500',
    marginTop: 8,
  },
  helperError: {
    marginTop: spacing.xs,
    fontSize: 12,
  },
  primaryPill: {
    marginTop: spacing.md,
    height: 52,
    borderRadius: radii.button,
  },
  anonymousBlock: {
    marginTop: spacing.xl,
    gap: spacing.sm,
  },
  anonymousCopy: {
    fontSize: 14,
    textAlign: 'center',
  },
  toggleRow: {
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  toggleText: {
    fontSize: 16,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
  infoText: {
    marginTop: 8,
    fontSize: 12,
  },
});
