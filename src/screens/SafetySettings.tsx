import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Screen from '../components/ui/Screen';
import Button from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { FeatureHeader, type FeatureHeaderStat } from '../components/ui/FeatureHeader';
import { Switch } from '../components/ui/Switch';
import { Badge } from '../components/ui/Badge';
import { Separator } from '../components/ui/Separator';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '../components/ui/Sheet';
import { Input } from '../components/ui/Input';
import { Label } from '../components/ui/Label';
import { Checkbox } from '../components/ui/Checkbox';
import { useTheme } from '../theme/SimpleThemeProvider';
import { useToast } from '../components/ui/Toast';
import { RootStackParamList, SCREEN_NAMES } from '../navigation/routes';
import { resetToCalculatorDecoyIfUnlockable } from '../navigation/quickExitNavigation';
import { useOnboarding, type StealthSettings, type StealthTrigger } from '../context/OnboardingProvider';
import { Storage } from '../lib/storage';
import {
  DecoyPinManager,
  decoyPinUtils,
  type DecoyPinExitAuthStatus,
  type DecoyPinStorageStatus,
} from '../utils/decoyPin';
import {
  DEFAULT_QUICK_EXIT_CONFIG,
  QuickExitManager,
  quickExitUtils,
  type QuickExitConfig,
} from '../utils/quickExit';
import {
  getStealthTriggerCapabilities,
  getStealthTriggerCapability,
  resolveStealthTrigger,
} from '../utils/stealthCapabilities';
import * as StealthHaptics from '../utils/stealthHaptics';
import { borders, radii, spacing, typography } from '../theme/tokens';

type SafetyNavigationProp = NativeStackNavigationProp<RootStackParamList>;

interface PINSheetProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (pin: string, requireToExit: boolean) => Promise<void>;
  title: string;
  exitAuthStatus: DecoyPinExitAuthStatus | null;
}

const SUPPORTED_TRIGGER_ORDER: StealthTrigger[] = ['shake', 'tap'];

const PINSheet: React.FC<PINSheetProps> = ({ isOpen, onOpenChange, onSave, title, exitAuthStatus }) => {
  const [step, setStep] = useState(1);
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [requireToExit, setRequireToExit] = useState(false);
  const [error, setError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const { colors } = useTheme();
  const exitAuthAvailable = !!exitAuthStatus?.available;

  useEffect(() => {
    if (!exitAuthAvailable) {
      setRequireToExit(false);
    }
  }, [exitAuthAvailable]);

  const reset = () => {
    setStep(1);
    setPin('');
    setConfirmPin('');
    setRequireToExit(false);
    setError('');
    setIsSaving(false);
  };

  const handlePinInput = (value: string) => {
    if (value.length <= 8 && /^\d*$/.test(value)) {
      setPin(value);
      setError('');

      if (value.length >= 4 && !decoyPinUtils.isValidPin(value)) {
        setError('Choose a less obvious 4-8 digit PIN.');
      }
    }
  };

  const handleConfirmInput = (value: string) => {
    if (value.length <= 8 && /^\d*$/.test(value)) {
      setConfirmPin(value);
      if (value !== pin && value.length === pin.length) {
        setError("PINs don't match.");
      } else {
        setError('');
      }
    }
  };

  const handleNext = () => {
    if (!decoyPinUtils.isValidPin(pin)) {
      setError('Choose a less obvious 4-8 digit PIN.');
      return;
    }

    setStep(2);
    setError('');
  };

  const handleSave = async () => {
    if (pin !== confirmPin || !decoyPinUtils.isValidPin(pin)) {
      setError("PINs don't match.");
      return;
    }

    setIsSaving(true);
    try {
      await onSave(pin, requireToExit);
      reset();
      onOpenChange(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not save this PIN.');
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    reset();
    onOpenChange(false);
  };

  return (
    <Sheet open={isOpen} onOpenChange={(open) => {
      if (!open) reset();
      onOpenChange(open);
    }}>
      <SheetContent style={{ minHeight: '80%' }}>
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>
            {step === 1 ? 'Enter a 4-8 digit PIN' : 'Confirm PIN'}
          </SheetDescription>
        </SheetHeader>

        <View style={{ paddingTop: 24, gap: 24 }}>
          {step === 1 ? (
            <View style={{ gap: 16 }}>
              <View style={{ gap: 8 }}>
                <Label>Enter a 4-8 digit PIN</Label>
                <Input
                  secureTextEntry
                  value={pin}
                  onChangeText={handlePinInput}
                  placeholder="••••"
                  style={{
                    textAlign: 'center',
                    fontSize: 24,
                    letterSpacing: 8,
                  }}
                  maxLength={8}
                  keyboardType="numeric"
                />
                <Text style={{ fontSize: 12, color: colors.mutedForeground, textAlign: 'center' }}>
                  {pin.length}/8 digits
                </Text>
              </View>

              {error ? (
                <Text style={{ fontSize: 14, color: colors.destructive }}>{error}</Text>
              ) : null}

              <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end' }}>
                <Button variant="outline" onPress={handleCancel} title="Cancel" />
                <Button
                  onPress={handleNext}
                  disabled={!decoyPinUtils.isValidPin(pin)}
                  title="Next"
                />
              </View>
            </View>
          ) : (
            <View style={{ gap: 16 }}>
              <View style={{ gap: 8 }}>
                <Label>Confirm PIN</Label>
                <Input
                  secureTextEntry
                  value={confirmPin}
                  onChangeText={handleConfirmInput}
                  placeholder="••••"
                  style={{
                    textAlign: 'center',
                    fontSize: 24,
                    letterSpacing: 8,
                  }}
                  maxLength={8}
                  keyboardType="numeric"
                />
              </View>

              {error ? (
                <Text style={{ fontSize: 14, color: colors.destructive }}>{error}</Text>
              ) : null}

              <View style={{ gap: 8 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Checkbox
                    checked={requireToExit && exitAuthAvailable}
                    disabled={!exitAuthAvailable}
                    onCheckedChange={(checked) => setRequireToExit(exitAuthAvailable && (checked as boolean))}
                  />
                  <Label style={{ fontSize: 14 }}>
                    Require device authentication to leave calculator mode
                  </Label>
                </View>
                <Text style={{ fontSize: 12, color: colors.mutedForeground }}>
                  {exitAuthStatus?.message ?? 'Checking device authentication support...'}
                </Text>
              </View>

              <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end' }}>
                <Button variant="outline" onPress={() => setStep(1)} title="Back" disabled={isSaving} />
                <Button
                  onPress={handleSave}
                  disabled={pin !== confirmPin || !decoyPinUtils.isValidPin(pin) || isSaving || (requireToExit && !exitAuthAvailable)}
                  loading={isSaving}
                  title="Save"
                />
              </View>
            </View>
          )}
        </View>
      </SheetContent>
    </Sheet>
  );
};

export default function SafetySettings() {
  const navigation = useNavigation<SafetyNavigationProp>();
  const { colors } = useTheme();
  const toast = useToast();
  const { saveStealthSettings } = useOnboarding();
  const [isLoading, setIsLoading] = useState(true);
  const [stealthSettings, setStealthSettings] = useState<StealthSettings>({
    trigger: resolveStealthTrigger('shake'),
    enableVibration: true,
    enableAutoRecord: true,
  });
  // The Test trigger preview reads the live setting before each delayed cue.
  const hapticFeedbackRef = useRef(stealthSettings.enableVibration);
  hapticFeedbackRef.current = stealthSettings.enableVibration;
  useEffect(() => () => StealthHaptics.cancel(), []);
  const [decoyPinSet, setDecoyPinSet] = useState(false);
  const [decoyStorageStatus, setDecoyStorageStatus] = useState<DecoyPinStorageStatus | null>(null);
  const [decoyExitAuthStatus, setDecoyExitAuthStatus] = useState<DecoyPinExitAuthStatus | null>(null);
  const [calculatorUnlockable, setCalculatorUnlockable] = useState(false);
  const [quickExitConfig, setQuickExitConfig] = useState<QuickExitConfig>(DEFAULT_QUICK_EXIT_CONFIG);
  const [showDecoyPinSheet, setShowDecoyPinSheet] = useState(false);

  const decoyPinManager = useMemo(() => DecoyPinManager.getInstance(), []);
  const quickExitManager = useMemo(() => QuickExitManager.getInstance(), []);
  const stealthCapabilities = useMemo(() => getStealthTriggerCapabilities(), []);
  const selectedStealthCapability = getStealthTriggerCapability(stealthSettings.trigger);
  const quickExitCapabilities = quickExitUtils.getCapabilities();
  const quickExitUnlockable = calculatorUnlockable && !!decoyStorageStatus?.secure;
  const heroStats = useMemo<FeatureHeaderStat[]>(() => [
    { label: 'Trigger', value: selectedStealthCapability.label, icon: 'radio-outline' },
    { label: 'Decoy PIN', value: decoyPinSet ? 'Set' : 'Needed', icon: 'calculator-outline' },
    { label: 'Quick-Exit', value: quickExitConfig.enabled ? 'On' : 'Off', icon: 'phone-portrait-outline' },
  ], [decoyPinSet, quickExitConfig.enabled, selectedStealthCapability.label]);

  const loadSettings = useCallback(async () => {
    setIsLoading(true);
    try {
      const [settings, hasPin, storageStatus, exitAuthStatus, canUnlockCalculator] = await Promise.all([
        Storage.getSettings(),
        decoyPinManager.hasPinConfigured(),
        decoyPinManager.getStorageStatus(),
        decoyPinManager.getExitAuthStatus(),
        decoyPinManager.canUnlockCalculator(),
      ]);
      await quickExitManager.rehydrateFromStorage();

      if (!canUnlockCalculator && quickExitManager.getConfig().enabled) {
        await quickExitManager.setEnabled(false);
      }

      setStealthSettings({
        trigger: resolveStealthTrigger(settings.stealthTrigger),
        enableVibration: settings.stealthHapticsEnabled,
        enableAutoRecord: settings.stealthAutoRecordEnabled,
      });
      setDecoyPinSet(hasPin);
      setDecoyStorageStatus(storageStatus);
      setDecoyExitAuthStatus(exitAuthStatus);
      setCalculatorUnlockable(canUnlockCalculator);
      setQuickExitConfig(quickExitManager.getConfig());
    } catch {
      toast.show({ title: 'Safety settings unavailable', variant: 'error' });
    } finally {
      setIsLoading(false);
    }
  }, [decoyPinManager, quickExitManager, toast]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const persistStealthSettings = async (nextSettings: StealthSettings) => {
    const normalizedSettings = {
      ...nextSettings,
      trigger: resolveStealthTrigger(nextSettings.trigger),
    };
    setStealthSettings(normalizedSettings);
    await saveStealthSettings(normalizedSettings);
  };

  const handleHapticFeedbackChange = (enabled: boolean) => {
    if (!enabled) StealthHaptics.cancel();
    void persistStealthSettings({ ...stealthSettings, enableVibration: enabled });
  };

  const handleTestStealth = () => {
    // Plays the real cues: trigger buzz, the recording heartbeat after 1 s, the stop buzz after 2.5 s.
    void StealthHaptics.previewCues(() => hapticFeedbackRef.current);
    toast.show({
      title: 'Foreground trigger ready',
      message: `${selectedStealthCapability.label} works while SafeRide is open.`,
      variant: 'info',
    });
  };

  const handleQuickExitEnabledChange = async (enabled: boolean) => {
    const canUnlockCalculator = await decoyPinManager.canUnlockCalculator();

    if (enabled && !canUnlockCalculator) {
      await quickExitManager.setEnabled(false);
      setQuickExitConfig(quickExitManager.getConfig());
      setCalculatorUnlockable(false);
      toast.show({
        title: decoyPinSet ? 'Calculator unlock unavailable' : 'Set a Decoy PIN first',
        message: decoyPinSet
          ? 'Quick-Exit stays off until calculator exit authentication is available or the Decoy PIN is changed.'
          : 'Quick-Exit stays off until the calculator can return to SafeRide.',
        variant: 'warning',
      });
      return;
    }

    await quickExitManager.setEnabled(enabled);
    setQuickExitConfig(quickExitManager.getConfig());
    toast.show({
      title: enabled ? 'Quick-Exit gesture enabled' : 'Quick-Exit gesture disabled',
      message: enabled ? 'Use a two-finger swipe down while SafeRide is open.' : undefined,
      variant: enabled ? 'success' : 'info',
    });
  };

  const handleTestQuickExit = async () => {
    const didReset = await resetToCalculatorDecoyIfUnlockable(navigation, () => decoyPinManager.canUnlockCalculator());

    if (!didReset) {
      setCalculatorUnlockable(false);
      toast.show({
        title: decoyPinSet ? 'Calculator unlock unavailable' : 'Set a Decoy PIN first',
        message: decoyPinSet
          ? 'The calculator decoy is disabled until exit authentication is available or the Decoy PIN is changed.'
          : 'The calculator decoy is disabled until it has a return PIN.',
        variant: 'warning',
      });
      return;
    }

    await quickExitManager.testQuickExit();
  };

  const handleDecoyPinSave = async (pin: string, requireToExit: boolean) => {
    await decoyPinManager.setPinConfig(pin, requireToExit);
    setDecoyPinSet(true);
    setDecoyStorageStatus(await decoyPinManager.getStorageStatus());
    setDecoyExitAuthStatus(await decoyPinManager.getExitAuthStatus());
    setCalculatorUnlockable(await decoyPinManager.canUnlockCalculator());
    toast.show({ title: 'Decoy PIN set', variant: 'success' });
  };

  const handleDisableDecoy = async () => {
    await decoyPinManager.clearPinConfig();
    await quickExitManager.setEnabled(false);
    setDecoyPinSet(false);
    setCalculatorUnlockable(false);
    setQuickExitConfig(quickExitManager.getConfig());
    toast.show({ title: 'Decoy disabled', variant: 'warning' });
  };

  const styles = StyleSheet.create({
    content: {
      padding: spacing.md,
      gap: spacing.md,
    },
    card: {
      borderColor: colors.divider,
      borderRadius: radii.card,
      borderWidth: borders.hairline,
      padding: spacing.md,
      shadowColor: colors.safety,
    },
    cardHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      marginBottom: spacing.xs,
    },
    cardTitle: {
      ...typography.titleMedium,
      color: colors.foreground,
    },
    cardDescription: {
      ...typography.bodySmall,
      color: colors.mutedForeground,
      marginBottom: spacing.md,
      lineHeight: 20,
    },
    cardContent: {
      gap: spacing.md,
    },
    switchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
    },
    switchCopy: {
      flex: 1,
      gap: 4,
    },
    rowTitle: {
      ...typography.labelMedium,
      color: colors.foreground,
    },
    rowDescription: {
      ...typography.bodySmall,
      color: colors.mutedForeground,
      lineHeight: 21,
    },
    badgeContainer: {
      flexDirection: 'row',
      gap: 8,
      flexWrap: 'wrap',
    },
    actionButtons: {
      flexDirection: 'row',
      gap: 8,
      flexWrap: 'wrap',
    },
    triggerButton: {
      flex: 1,
      minWidth: 120,
    },
    footer: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      paddingVertical: 16,
    },
    footerText: {
      ...typography.bodySmall,
      color: colors.mutedForeground,
      textAlign: 'center',
      flex: 1,
    },
    loading: {
      padding: 24,
      alignItems: 'center',
      gap: 12,
    },
  });

  if (isLoading) {
    return (
      <Screen>
        <View style={styles.loading}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.rowDescription}>Loading safety settings</Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView style={{ flex: 1 }}>
        <View style={styles.content}>
          <FeatureHeader
            eyebrow="Safety controls"
            title="Safety Settings"
            description="Configure foreground safety gestures, calculator decoy access, and the limits of this Expo build in one place."
            icon="shield-checkmark-outline"
            tone="safety"
            stats={heroStats}
          />

          <Card variant="elevated" style={styles.card}>
            <View style={styles.cardHeader}>
              <Ionicons name="radio" size={20} color={colors.foreground} />
              <Text style={styles.cardTitle}>Stealth capture</Text>
            </View>
            <Text style={styles.cardDescription}>
              Supported triggers start audio while SafeRide is open. Once started, recording can continue in the background where the phone allows it. Video evidence still uses the Evidence screen.
            </Text>
            <View style={styles.cardContent}>
              <View style={styles.badgeContainer}>
                <Badge variant="warning">{selectedStealthCapability.label}</Badge>
                <Badge variant="secondary">Audio saves to draft</Badge>
              </View>

              <View style={styles.actionButtons}>
                {SUPPORTED_TRIGGER_ORDER.map((trigger) => {
                  const capability = stealthCapabilities[trigger];
                  return (
                    <Button
                      key={trigger}
                      variant={stealthSettings.trigger === trigger ? 'default' : 'outline'}
                      onPress={() => persistStealthSettings({ ...stealthSettings, trigger })}
                      disabled={!capability.supported}
                      style={styles.triggerButton}
                      title={capability.label}
                    />
                  );
                })}
              </View>

              <View style={styles.switchRow}>
                <View style={styles.switchCopy}>
                  <Text style={styles.rowTitle}>Auto-start recording</Text>
                  <Text style={styles.rowDescription}>Begin audio capture after a supported app-open trigger and microphone permission.</Text>
                </View>
                <Switch
                  value={stealthSettings.enableAutoRecord}
                  onValueChange={(enabled) => persistStealthSettings({ ...stealthSettings, enableAutoRecord: enabled })}
                />
              </View>

              <Separator />

              <View style={styles.switchRow}>
                <View style={styles.switchCopy}>
                  <Text style={styles.rowTitle}>Haptic feedback</Text>
                  <Text style={styles.rowDescription}>
                    Vibrate when SafeRide handles a supported trigger, and buzz twice every 30 seconds while recording.
                  </Text>
                </View>
                <Switch
                  value={stealthSettings.enableVibration}
                  onValueChange={handleHapticFeedbackChange}
                />
              </View>

              <Button
                variant="default"
                onPress={handleTestStealth}
                title="Test trigger"
              />
            </View>
          </Card>

          <Card variant="elevated" style={styles.card}>
            <View style={styles.cardHeader}>
              <Ionicons name="calculator" size={20} color={colors.foreground} />
              <Text style={styles.cardTitle}>Decoy PIN</Text>
            </View>
            <Text style={styles.cardDescription}>
              Opens a calculator screen. Type your Decoy PIN in the calculator, then press = to return to SafeRide.
            </Text>
            <View style={styles.cardContent}>
              <View style={styles.badgeContainer}>
                <Badge variant={decoyStorageStatus?.secure ? 'success' : 'secondary'}>
                  {decoyStorageStatus?.secure ? 'Secure storage' : 'Unavailable'}
                </Badge>
                {decoyPinSet ? <Badge>PIN set</Badge> : null}
                {decoyPinSet && !quickExitUnlockable ? <Badge variant="secondary">Quick-Exit gated</Badge> : null}
              </View>

              {decoyStorageStatus?.secure ? (
                !decoyPinSet ? (
                  <Button
                    variant="default"
                    onPress={() => setShowDecoyPinSheet(true)}
                    title="Create Decoy PIN"
                  />
                ) : (
                  <View style={{ gap: 12 }}>
                    <View style={styles.actionButtons}>
                      <Button
                        variant="outline"
                        onPress={() => setShowDecoyPinSheet(true)}
                        style={{ flex: 1 }}
                        title="Change PIN"
                      />
                      <Button
                        variant="outline"
                        onPress={handleDisableDecoy}
                        style={{ flex: 1 }}
                        title="Disable"
                      />
                    </View>
                    <Text style={styles.rowDescription}>
                      Use a PIN that is different from your device PIN. SafeRide cannot recover it.
                    </Text>
                  </View>
                )
              ) : (
                <Text style={styles.rowDescription}>
                  {decoyStorageStatus?.message ?? 'Secure storage is not available on this platform.'}
                </Text>
              )}
            </View>
          </Card>

          <Card variant="elevated" style={styles.card}>
            <View style={styles.cardHeader}>
              <Ionicons name="phone-portrait" size={20} color={colors.foreground} />
              <Text style={styles.cardTitle}>Quick-Exit gesture</Text>
            </View>
            <Text style={styles.cardDescription}>
              Quick-Exit resets SafeRide to the calculator decoy after a Decoy PIN is set. It does not close the app, lock the phone, or clear the OS app switcher.
            </Text>
            <View style={styles.cardContent}>
              <View style={styles.switchRow}>
                <View style={styles.switchCopy}>
                  <Text style={styles.rowTitle}>Two-finger swipe down</Text>
                  <Text style={styles.rowDescription}>
                    {quickExitUnlockable
                      ? quickExitCapabilities.summary
                      : decoyPinSet
                        ? 'Calculator exit authentication is unavailable. Change the Decoy PIN or enable device authentication before using Quick-Exit.'
                        : 'Set a Decoy PIN first so the calculator can return to SafeRide.'}
                  </Text>
                </View>
                <Switch
                  value={quickExitConfig.enabled}
                  disabled={!quickExitCapabilities.gestureAvailable || !quickExitUnlockable}
                  onValueChange={handleQuickExitEnabledChange}
                />
              </View>

              <Button
                variant="default"
                onPress={handleTestQuickExit}
                title="Open Calculator Now"
                disabled={!quickExitUnlockable}
              />
            </View>
          </Card>

          <Card variant="elevated" style={styles.card}>
            <Text style={[styles.cardTitle, { marginBottom: 16 }]}>Native-only protections</Text>
            <View style={styles.cardContent}>
              <Switch
                value={false}
                disabled
                onValueChange={() => {}}
                label="Mask app in app switcher"
                description="Requires native Android/iOS screen security code that is not present in this Expo build."
              />

              <Separator />

              <Switch
                value={false}
                disabled
                onValueChange={() => {}}
                label="Require app PIN to open"
                description="Requires a real app-unlock gate. Decoy PIN is available only for the calculator flow."
              />

              <Separator />

              <Button
                variant="link"
                style={{ alignSelf: 'flex-start' }}
                onPress={() => navigation.navigate(SCREEN_NAMES.PRIVACY_DATA)}
                title="Privacy & data settings"
              />

              <Separator />

              <Button
                variant="link"
                style={{ alignSelf: 'flex-start' }}
                onPress={() => navigation.navigate(SCREEN_NAMES.LANGUAGE_ACCESSIBILITY)}
                title="Language & accessibility"
              />
            </View>
          </Card>

          <View style={styles.footer}>
            <Ionicons name="shield-checkmark" size={16} color={colors.mutedForeground} />
            <Text style={styles.footerText}>
              Safety controls are local. Platform-native protections are shown only when this build can support them.
            </Text>
          </View>
        </View>
      </ScrollView>

      <PINSheet
        isOpen={showDecoyPinSheet}
        onOpenChange={setShowDecoyPinSheet}
        onSave={handleDecoyPinSave}
        title={decoyPinSet ? 'Change Decoy PIN' : 'Set Decoy PIN'}
        exitAuthStatus={decoyExitAuthStatus}
      />
    </Screen>
  );
}
