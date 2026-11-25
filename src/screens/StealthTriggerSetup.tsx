import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Screen from '../components/ui/Screen';
import Button from '../components/ui/Button';
import { Card, CardContent, CardDescription, CardTitle } from '../components/ui/Card';
import { FeatureHeader, type FeatureHeaderStat } from '../components/ui/FeatureHeader';
import { Badge } from '../components/ui/Badge';
import { Switch } from '../components/ui/Switch';
import { RadioGroup, RadioGroupItem } from '../components/ui/RadioGroup';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme/SimpleThemeProvider';
import { RootStackParamList, SCREEN_NAMES } from '../navigation/routes';
import { StealthSettings, StealthTrigger, useOnboarding } from '../context/OnboardingProvider';
import { borders, spacing, typography } from '../theme/tokens';
import {
  getStealthTriggerCapabilities,
  resolveStealthTrigger,
  type StealthTriggerCapability,
} from '../utils/stealthCapabilities';

const TRIGGER_ORDER: StealthTrigger[] = ['shake', 'tap', 'volume', 'power'];

type StealthNavigationProp = NativeStackNavigationProp<RootStackParamList, 'StealthTriggerSetup'>;

export default function StealthTriggerSetupScreen() {
  const navigation = useNavigation<StealthNavigationProp>();
  const { colors } = useTheme();
  const { state: onboardingState, saveStealthSettings, markStepComplete } = useOnboarding();
  const existingSettings = onboardingState.stealthSettings;
  const triggerCapabilities = useMemo(() => getStealthTriggerCapabilities(), []);
  const existingTrigger = existingSettings?.trigger;
  const initialTrigger = resolveStealthTrigger(existingTrigger ?? 'shake');
  const [selectedTrigger, setSelectedTrigger] = useState<StealthTrigger>(initialTrigger);
  const [enableVibration, setEnableVibration] = useState(existingSettings?.enableVibration ?? true);
  const [enableAutoRecord, setEnableAutoRecord] = useState(existingSettings?.enableAutoRecord ?? true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const styles = StyleSheet.create({
    container: {
      flex: 1,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.lg,
    },
    header: {
      marginBottom: spacing.md,
    },
    title: {
      ...typography.titleXL,
      color: colors.foreground,
      textAlign: 'center',
      marginBottom: spacing.sm,
    },
    subtitle: {
      ...typography.bodyMedium,
      color: colors.textSecondary,
      textAlign: 'center',
    },
    triggerOptions: {
      gap: spacing.sm,
      marginBottom: spacing.lg,
    },
    selectedCard: {
      borderColor: colors.primary,
      borderWidth: borders.focus,
      backgroundColor: colors.primaryMuted,
    },
    disabledCard: {
      opacity: 0.58,
    },
    footer: {
      gap: spacing.sm,
    },
    demoText: {
      ...typography.bodyS,
      color: colors.textSecondary,
      textAlign: 'center',
    },
    badgeRow: {
      flexDirection: 'row',
      gap: spacing.xs,
      flexWrap: 'wrap',
    },
    unavailableSummary: {
      gap: spacing.xs,
    },
    unavailableTitle: {
      ...typography.labelLarge,
      color: colors.foreground,
    },
    unavailableText: {
      ...typography.bodyS,
      color: colors.textSecondary,
    },
  });

  useEffect(() => {
    if (onboardingState.steps.StealthTriggerSetup) {
      navigation.reset({
        index: 0,
        routes: [{ name: SCREEN_NAMES.MAIN_TABS }],
      });
    }
  }, [navigation, onboardingState.steps.StealthTriggerSetup]);

  const triggerOptions = TRIGGER_ORDER.map((trigger) => triggerCapabilities[trigger]);
  const supportedOptions = triggerOptions.filter((option) => option.supported);
  const unavailableOptions = triggerOptions.filter((option) => !option.supported);
  const stealthStats = useMemo<FeatureHeaderStat[]>(() => [
    {
      label: 'Selected',
      value: triggerCapabilities[selectedTrigger].label,
      icon: 'radio-button-on-outline',
    },
    {
      label: 'Available',
      value: supportedOptions.length,
      icon: 'checkmark-circle-outline',
    },
  ], [selectedTrigger, triggerCapabilities, supportedOptions.length]);

  const handleSelectTrigger = (capability: StealthTriggerCapability) => {
    if (!capability.supported) return;
    setSelectedTrigger(capability.trigger);
  };

  const handleContinue = async () => {
    const settings: StealthSettings = {
      trigger: selectedTrigger,
      enableVibration,
      enableAutoRecord,
    };

    setIsSaving(true);
    try {
      await saveStealthSettings(settings);
      await markStepComplete('StealthTriggerSetup');
    } catch (error) {
      console.warn('Failed to persist stealth settings', error);
    } finally {
      setIsSaving(false);
      navigation.reset({
        index: 0,
        routes: [{ name: SCREEN_NAMES.MAIN_TABS }],
      });
    }
  };

  return (
    <Screen scrollable brandHeader>
      <View style={styles.container}>
        <View style={styles.header}>
          <FeatureHeader
            eyebrow="Safety setup"
            title="Stealth capture"
            description="Choose a foreground trigger for quick evidence capture while SafeRide is open."
            icon="finger-print-outline"
            tone="safety"
            stats={stealthStats}
          />
        </View>

        <View style={styles.triggerOptions}>
          <RadioGroup
            value={selectedTrigger}
            onValueChange={(value) => setSelectedTrigger(resolveStealthTrigger(value as StealthTrigger))}
            orientation="vertical"
          >
            {supportedOptions.map((option) => (
              <Card
                key={option.trigger}
                variant="elevated"
                onPress={() => handleSelectTrigger(option)}
                style={[
                  selectedTrigger === option.trigger ? styles.selectedCard : {},
                ]}
              >
                <CardContent>
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start', marginBottom: spacing.sm }}>
                    <View style={{ flex: 1, marginRight: spacing.sm }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', marginBottom: spacing.xs }}>
                        <CardTitle style={{ marginRight: spacing.xs }}>{option.label}</CardTitle>
                        {option.trigger === 'shake' && option.supported ? <Badge variant="primary" size="sm">Recommended</Badge> : null}
                      </View>
                      <CardDescription style={{ marginBottom: spacing.sm }}>{option.description}</CardDescription>
                      <CardDescription style={{ marginBottom: spacing.sm }}>{option.limitation}</CardDescription>
                      <View style={styles.badgeRow}>
                        <Badge variant="warning" size="sm">
                          Foreground only
                        </Badge>
                      </View>
                    </View>
                    <RadioGroupItem
                      value={option.trigger}
                      selected={selectedTrigger === option.trigger}
                      onSelect={() => handleSelectTrigger(option)}
                    />
                  </View>
                </CardContent>
              </Card>
            ))}
          </RadioGroup>

          {unavailableOptions.length > 0 ? (
            <Card variant="filled" hideAccent>
              <CardContent style={styles.unavailableSummary}>
                <Text style={styles.unavailableTitle}>Not offered in this build</Text>
                <Text style={styles.unavailableText}>
                  {unavailableOptions.map((option) => option.label).join(', ')} need native Android modules before they can be safe setup choices.
                </Text>
              </CardContent>
            </Card>
          ) : null}
        </View>

        <Button
          title="Advanced Settings"
          variant="ghost"
          onPress={() => setShowAdvanced(!showAdvanced)}
          style={{ marginBottom: spacing.md }}
          icon={<Ionicons name={showAdvanced ? 'chevron-up' : 'chevron-down'} size={16} color={colors.foreground} />}
          iconPosition="right"
        />

        {showAdvanced && (
          <View style={{ marginBottom: spacing.lg, gap: spacing.md }}>
            <Card variant="elevated">
              <CardContent>
                <Switch
                  value={enableVibration}
                  onValueChange={setEnableVibration}
                  label="Haptic Feedback"
                  description="Vibrate when a supported foreground trigger is handled."
                />
              </CardContent>
            </Card>

            <Card variant="elevated">
              <CardContent>
                <Switch
                  value={enableAutoRecord}
                  onValueChange={setEnableAutoRecord}
                  label="Auto-Start Recording"
                  description="Begin audio recording after a supported foreground trigger and microphone permission."
                />
              </CardContent>
            </Card>
          </View>
        )}

        <View style={styles.footer}>
          <Button
            title="Complete Setup"
            onPress={handleContinue}
            loading={isSaving}
            fullWidth
          />
          <Text style={styles.demoText}>
            Stealth capture works only while SafeRide is open in this Expo build.
          </Text>
        </View>
      </View>
    </Screen>
  );
}
