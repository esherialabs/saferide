import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, ViewStyle } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import PagerView, { PagerViewHandle } from '../utils/pagerViewShim';
import Screen from '../components/ui/Screen';
import Button from '../components/ui/Button';
import { useTheme } from '../theme/SimpleThemeProvider';
import { RootStackParamList } from '../navigation/routes';
import AppLogo from '../components/AppLogo';
import { BrandBar } from '../components/BrandWordmark';
import { useOnboarding } from '../context/OnboardingProvider';
import { spacing, typography, fontFamilies, radii } from '../theme/tokens';
import { devPrivacyWarn, getPrivacySafeErrorReason } from '../utils/privacyLog';
import { SafetyIllustration, type SafetyIllustrationKind } from '../components/ui/SafetyIllustration';
import { Ionicons } from '@expo/vector-icons';

type OnboardingNavigationProp = NativeStackNavigationProp<RootStackParamList, 'Onboarding'>;

const BUTTON_HEIGHT = 56;
const BUTTON_RADIUS = BUTTON_HEIGHT / 2;


const onboardingData = [
  {
    title: 'Welcome to SafeRide',
    description: 'Your personal safety companion for public transport and beyond. Document incidents, access support, and stay informed.',
    emoji: '🚌',
    features: ['Discreet incident recording', 'Safety notes and reminders', 'Kenya support contacts'],
    highlight: 'privacy-first',
  },
  {
    title: 'Privacy & Security First',
    description: 'Drafts stay on your device until you choose a consent step. Sensitive settings use protected device storage where available.',
    emoji: '🔐',
    features: ['Local draft storage', 'Consent before sharing', 'No tracking or analytics'],
    highlight: 'security',
  },
  {
    title: 'Stealth Mode Protection',
    description: 'Use supported foreground triggers like shake or secret taps while SafeRide is open.',
    emoji: '🤫',
    features: ['Foreground shake trigger', 'Secret tap pattern', 'Honest platform limits'],
    highlight: 'stealth',
  },
  {
    title: 'Evidence & Documentation',
    description: 'Collect photos, audio, and witness details with clear status for local evidence and privacy requests.',
    emoji: '📋',
    features: ['Privacy requests saved', 'Upload status shown', 'Processing limits labeled'],
    highlight: 'evidence',
  },
  {
    title: 'Legal Support Network',
    description: 'Review Kenya support options, legal-aid information, and referral contacts.',
    emoji: '⚖️',
    features: ['1195 and provider catalog', 'Legal-aid information', 'Consent-gated referral'],
    highlight: 'support',
  },
];

export default function OnboardingScreen() {
  const navigation = useNavigation<OnboardingNavigationProp>();
  const { colors, colorScheme } = useTheme();
  const { markStepComplete, state: onboardingState } = useOnboarding();
  const [currentPage, setCurrentPage] = useState(0);
  const pagerRef = useRef<PagerViewHandle | null>(null);

  const basePageStyles: ViewStyle = {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
  };

  const styles = StyleSheet.create({
    container: {
      flex: 1,
    },
    pagerView: {
      flex: 1,
      zIndex: 2,
    },
    page: basePageStyles,
    backgroundImage: {
      ...StyleSheet.absoluteFill,
      zIndex: 0,
    },
    backgroundScrim: {
      ...StyleSheet.absoluteFill,
      zIndex: 1,
    },
    contentPanel: {
      alignItems: 'stretch',
      backgroundColor: colors.background,
      borderColor: colors.divider,
      borderRadius: radii.card,
      borderWidth: 0,
      maxWidth: 560,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.lg,
      width: '100%',
    },
    brandContainer: {
      alignItems: 'flex-start',
      marginBottom: spacing.md,
    },
    logoContainer: {
      width: 120,
      height: 120,
      borderRadius: 60,
      backgroundColor: colors.primaryMuted,
      justifyContent: 'center',
      alignItems: 'center',
      marginBottom: spacing.xl,
      borderWidth: 3,
      borderColor: colors.divider,
    },
    emoji: {
      fontSize: 60,
    },
    title: {
      ...typography.displaySmall,
      color: colors.foreground,
      textAlign: 'left',
      letterSpacing: -0.6,
      marginBottom: spacing.sm,
    },
    description: {
      ...typography.bodyMedium,
      color: colors.textSecondary,
      textAlign: 'left',
      marginBottom: spacing.xl,
      lineHeight: 24,
    },
    featuresContainer: {
      width: '100%',
      paddingHorizontal: 0,
    },
    featureItem: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      marginBottom: spacing.sm,
      paddingVertical: spacing.xs,
    },
    featureIcon: {
      width: 20,
      height: 20,
      borderRadius: 10,
      backgroundColor: colors.primaryMuted,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: spacing.sm,
    },
    featureText: {
      ...typography.bodyMedium,
      color: colors.foreground,
      flex: 1,
    },
    tagline: {
      ...typography.bodyS,
      color: colors.textSecondary,
      marginTop: spacing.xs,
      fontStyle: 'italic',
      fontFamily: fontFamilies.text,
    },
    footer: {
      paddingHorizontal: spacing.xl,
      paddingTop: spacing.sm,
      paddingBottom: spacing.md,
    },
    progressRow: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.sm,
      paddingLeft: spacing.xl,
      paddingRight: spacing.sm,
    },
    progressTrack: {
      flex: 1,
      flexDirection: 'row',
      gap: spacing.xxs,
    },
    progressSegment: {
      borderRadius: radii.round,
      flex: 1,
      height: 4,
    },
    progressLabel: {
      ...typography.labelMedium,
      color: colors.textSecondary,
    },
    buttonContainer: {
      gap: spacing.sm,
    },
    buttonPill: {
      minHeight: BUTTON_HEIGHT,
      borderRadius: radii.button,
      justifyContent: 'center',
    },
  });

  const goToPage = (index: number) => {
    if (index < 0 || index >= onboardingData.length) {
      return;
    }
    setCurrentPage(index);
    if (pagerRef.current?.setPage) {
      pagerRef.current.setPage(index);
    }
  };

  const handleNext = async () => {
    if (currentPage < onboardingData.length - 1) {
      goToPage(currentPage + 1);
    } else {
      try {
        await markStepComplete('Onboarding');
      } catch (error) {
        devPrivacyWarn('onboarding progress persistence failed', {
          reason: getPrivacySafeErrorReason(error),
        });
      } finally {
        navigation.replace('PermissionGate');
      }
    }
  };

  const handleSkip = async () => {
    try {
      await markStepComplete('Onboarding');
    } catch (error) {
      devPrivacyWarn('onboarding skip persistence failed', {
        reason: getPrivacySafeErrorReason(error),
      });
    } finally {
      navigation.replace('PermissionGate');
    }
  };

  useEffect(() => {
    if (!onboardingState.steps.Onboarding) {
      return;
    }

    if (!onboardingState.steps.PermissionGate) {
      navigation.replace('PermissionGate');
      return;
    }

    if (!onboardingState.steps.StealthTriggerSetup) {
      navigation.replace('StealthTriggerSetup');
      return;
    }

    navigation.reset({
      index: 0,
      routes: [{ name: 'MainTabs' }],
    });
  }, [navigation, onboardingState.steps]);

  return (
    <Screen edges={['top', 'bottom']}>
      <BrandBar><AppLogo width={168} height={40} inverted={colorScheme === 'dark'} animated={false} /></BrandBar>
      <View style={styles.progressRow}>
        <View
          style={styles.progressTrack}
          accessible
          accessibilityLabel={`Introduction ${currentPage + 1} of ${onboardingData.length}`}
        >
          {onboardingData.map((_, index) => (
            <View
              key={index}
              style={[
                styles.progressSegment,
                { backgroundColor: index <= currentPage ? colors.primary : colors.divider },
              ]}
            />
          ))}
        </View>
        <Text style={styles.progressLabel} importantForAccessibility="no" accessibilityElementsHidden>
          {currentPage + 1} of {onboardingData.length}
        </Text>
        <Button
          title="Skip"
          onPress={handleSkip}
          variant="ghost"
          size="sm"
        />
      </View>
      <View style={styles.container}>
        <PagerView
          ref={pagerRef}
          style={styles.pagerView}
          initialPage={0}
          onPageSelected={(e) => setCurrentPage(e.nativeEvent.position)}
        >
          {onboardingData.map((item, index) => {
            const isFirstSlide = index === 0;
            return (
              <View key={index} style={{ flex: 1 }}>
                <ScrollView contentContainerStyle={[styles.page, { flexGrow: 1, flex: undefined, paddingVertical: spacing.md }]} showsVerticalScrollIndicator={false}>
                <View style={styles.contentPanel}>
                  <View style={{ alignItems: 'center', marginBottom: spacing.sm }}>
                    <SafetyIllustration size={136} kind={(['journey', 'privacy', 'privacy', 'evidence', 'support'] as SafetyIllustrationKind[])[index]} />
                  </View>
                  {isFirstSlide ? (
                    <View style={styles.brandContainer}>
                      <Text style={styles.tagline}>Your Safety Companion</Text>
                    </View>
                  ) : null}

                  <Text accessibilityRole="header" style={styles.title}>{item.title}</Text>
                  <Text style={styles.description}>{item.description}</Text>

                  <View style={styles.featuresContainer}>
                    {item.features.map((feature, featureIndex) => (
                      <View key={featureIndex} style={styles.featureItem}>
                        <View style={styles.featureIcon}>
                          <Ionicons name="checkmark" size={15} color={colors.primary} />
                        </View>
                        <Text style={styles.featureText}>{feature}</Text>
                      </View>
                    ))}
                  </View>
                </View>
                </ScrollView>
              </View>
            );
          })}
        </PagerView>

        <View style={styles.footer}>
          <View style={styles.buttonContainer}>
            <Button
              title={currentPage === onboardingData.length - 1 ? 'Start Using SafeRide' : 'Continue'}
              onPress={handleNext}
              fullWidth
              style={styles.buttonPill}
            />
          </View>
        </View>
      </View>
    </Screen>
  );
}
