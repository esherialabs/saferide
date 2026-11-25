import React, { useCallback, useState } from 'react';
import {
  Alert,
  Image,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useNavigation } from '@react-navigation/native';

import { Button, InfoModal, InfoModalBullet, InfoModalSection } from '../components/ui';
import { useAuth } from '../context/AuthProvider';
import { RootStackParamList } from '../navigation/routes';
import { useTheme } from '../theme/SimpleThemeProvider';
import { borders, radii, spacing, touchTargets, typography } from '../theme/tokens';
import {
  getDialUrl,
  KENYA_POLICE_EMERGENCY_CONTACT,
  KENYA_SUPPORT_RESOURCES,
  PRIMARY_KENYA_GBV_CONTACT,
  type SupportContact,
} from '../lib/supportResources';
import { useToast } from '../components/ui/Toast';
import { BrandBar } from '../components/BrandWordmark';

type LandingNavigationProp = NativeStackNavigationProp<RootStackParamList, 'Landing'>;

type HelpCard = {
  id: string;
  title: string;
  meta: string;
  contact: SupportContact;
  tone: 'support' | 'critical' | 'safety';
  icon: React.ComponentProps<typeof Ionicons>['name'];
};

const HELP_CARDS: HelpCard[] = [
  {
    id: 'police',
    title: 'Emergency',
    meta: 'Police or urgent danger',
    contact: KENYA_POLICE_EMERGENCY_CONTACT,
    tone: 'critical',
    icon: 'warning-outline',
  },
  {
    id: 'gbv',
    title: 'GBV support',
    meta: 'Confidential help and referrals',
    contact: PRIMARY_KENYA_GBV_CONTACT,
    tone: 'support',
    icon: 'heart-outline',
  },
  {
    id: 'child',
    title: 'Child protection',
    meta: 'For children or child safety',
    contact: KENYA_SUPPORT_RESOURCES.childHelpline,
    tone: 'safety',
    icon: 'happy-outline',
  },
];

export default function LandingScreen() {
  const navigation = useNavigation<LandingNavigationProp>();
  const { colors } = useTheme();
  const { width, fontScale } = useWindowDimensions();
  // Narrow screens and large text put the call button under each contact.
  const stackHelpRows = width < 350 || fontScale >= 1.3;
  const toast = useToast();
  const { signInAnonymously, isLoading } = useAuth();
  const [activeHelp, setActiveHelp] = useState<SupportContact | null>(null);
  const [isGuestStarting, setIsGuestStarting] = useState(false);

  const confirmDial = useCallback(
    (contact: SupportContact, phoneNumber = contact.phoneNumbers[0]) => {
      Alert.alert(
        `Call ${contact.displayPhone}`,
        `SafeRide will open your phone dialer for ${contact.shortLabel}.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Open dialer',
            onPress: () => {
              Linking.openURL(getDialUrl(phoneNumber, Platform.OS)).catch(() => {
                toast.show({
                  title: 'Dial failed',
                  message: 'Unable to launch the phone dialer.',
                  variant: 'error',
                });
              });
            },
          },
        ],
      );
    },
    [toast],
  );

  const handleGuest = useCallback(async () => {
    setIsGuestStarting(true);
    try {
      const result = await signInAnonymously();
      toast.show({
        title: 'No-account session',
        message:
          result === 'owned-auth'
            ? 'You can continue without creating an email or phone account.'
            : 'You are in local-only mode. Optional online services can be connected later.',
        variant: result === 'owned-auth' ? 'success' : 'warning',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not start a no-account session.';
      toast.show({
        title: 'No-account sign-in failed',
        message,
        variant: 'error',
      });
    } finally {
      setIsGuestStarting(false);
    }
  }, [signInAnonymously, toast]);

  const styles = StyleSheet.create({
    safeArea: {
      backgroundColor: colors.canvas,
      flex: 1,
    },
    scrollContent: {
      flexGrow: 1,
      paddingBottom: spacing.xl,
    },
    heroPhoto: {
      aspectRatio: 1408 / 768,
      backgroundColor: colors.surfaceAlt,
      width: '100%',
    },
    heroImage: {
      ...StyleSheet.absoluteFill,
      height: '100%',
      width: '100%',
    },
    sheet: {
      backgroundColor: colors.canvas,
      borderTopLeftRadius: radii.sheet,
      borderTopRightRadius: radii.sheet,
      gap: spacing.lg,
      marginTop: -radii.sheet,
      paddingHorizontal: spacing.md,
      paddingTop: spacing.lg,
    },
    welcome: {
      gap: spacing.xs,
    },
    eyebrow: {
      ...typography.overline,
      color: colors.primary,
      letterSpacing: 0.6,
      textTransform: 'uppercase',
    },
    title: {
      ...typography.headlineLarge,
      color: colors.foreground,
      letterSpacing: -0.4,
    },
    subtitle: {
      ...typography.bodyMedium,
      color: colors.textSecondary,
    },
    authActions: {
      gap: spacing.xs,
      marginTop: spacing.xs,
    },
    secondaryActions: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
    },
    secondaryAction: {
      flexBasis: 140,
      flexGrow: 1,
    },
    helpSection: {
      gap: spacing.xs,
    },
    sectionTitle: {
      ...typography.titleMedium,
      color: colors.foreground,
    },
    sectionSubtitle: {
      ...typography.bodySmall,
      color: colors.textSecondary,
    },
    helpList: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: radii.card,
      borderWidth: borders.hairline,
      marginTop: spacing.xxs,
      overflow: 'hidden',
    },
    helpRow: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.sm,
      minHeight: 72,
      paddingLeft: spacing.sm,
      paddingVertical: spacing.sm,
    },
    helpRowStacked: {
      alignItems: 'stretch',
      flexDirection: 'column',
      paddingRight: spacing.sm,
    },
    helpDivider: {
      borderTopColor: colors.divider,
      borderTopWidth: borders.hairline,
    },
    helpHeading: {
      alignItems: 'center',
      flex: 1,
      flexDirection: 'row',
      gap: spacing.sm,
      minWidth: 0,
    },
    helpIcon: {
      alignItems: 'center',
      borderRadius: radii.round,
      height: 40,
      justifyContent: 'center',
      width: 40,
    },
    helpCopy: {
      flex: 1,
      minWidth: 0,
    },
    helpLabel: {
      ...typography.titleSmall,
      color: colors.foreground,
    },
    helpMeta: {
      ...typography.bodySmall,
      color: colors.textSecondary,
      marginTop: 2,
    },
    helpActions: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.xxs,
    },
    callButton: {
      alignItems: 'center',
      borderRadius: radii.round,
      flexDirection: 'row',
      gap: spacing.xxs,
      justifyContent: 'center',
      minHeight: touchTargets.minimum,
      paddingHorizontal: spacing.sm,
    },
    callButtonStacked: {
      flex: 1,
      minHeight: touchTargets.minimum,
    },
    callButtonText: {
      ...typography.labelLarge,
      color: colors.textInverse,
    },
    iconButton: {
      alignItems: 'center',
      height: 48,
      justifyContent: 'center',
      width: 48,
    },
  });

  const toneStyles = {
    support: {
      buttonBackground: colors.support,
      muted: colors.supportMuted,
    },
    critical: {
      buttonBackground: colors.critical,
      muted: colors.criticalMuted,
    },
    safety: {
      buttonBackground: colors.safety,
      muted: colors.safetyMuted,
    },
  };

  return (
    <SafeAreaView edges={['top', 'bottom', 'left', 'right']} style={styles.safeArea}>
      <BrandBar />
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <View style={styles.heroPhoto}>
          <Image
            source={require('../../assets/images/saferide-warm-transit-hero.webp')}
            resizeMode="cover"
            style={styles.heroImage}
            accessible={false}
            accessibilityIgnoresInvertColors
          />
        </View>

        <View style={styles.sheet}>
          <View style={styles.welcome}>
            <Text style={styles.eyebrow}>Private help, your pace - Kenya</Text>
            <Text accessibilityRole="header" style={styles.title}>Start in private</Text>
            <Text style={styles.subtitle}>
              Start without an account. Save details on this phone. Choose support only when you are ready.
            </Text>
            <View style={styles.authActions}>
              <Button
                title="Continue without an account"
                onPress={handleGuest}
                loading={isGuestStarting}
                disabled={isGuestStarting || isLoading}
                size="lg"
                fullWidth
              />
              <View style={styles.secondaryActions}>
                <Button
                  title="Sign in"
                  variant="secondary"
                  onPress={() => navigation.navigate('Auth', { action: 'sign-in' })}
                  style={styles.secondaryAction}
                />
                <Button
                  title="Create account"
                  variant="outline"
                  onPress={() => navigation.navigate('Auth', { action: 'sign-up' })}
                  style={styles.secondaryAction}
                />
              </View>
            </View>
          </View>

          <View style={styles.helpSection}>
            <Text accessibilityRole="header" style={styles.sectionTitle}>Help numbers</Text>
            <Text style={styles.sectionSubtitle}>
              Tap a number only when it is safe. Calls may appear in phone records.
            </Text>
            <View style={styles.helpList}>
              {HELP_CARDS.map((item, index) => {
                const tone = toneStyles[item.tone];
                return (
                  <View
                    key={item.id}
                    style={[styles.helpRow, stackHelpRows && styles.helpRowStacked, index > 0 && styles.helpDivider]}
                  >
                    <View style={styles.helpHeading}>
                      <View style={[styles.helpIcon, { backgroundColor: tone.muted }]}>
                        <Ionicons name={item.icon} size={20} color={tone.buttonBackground} />
                      </View>
                      <View style={styles.helpCopy}>
                        <Text style={styles.helpLabel}>{item.title}</Text>
                        <Text style={styles.helpMeta}>{item.meta}</Text>
                      </View>
                      {stackHelpRows ? (
                        <TouchableOpacity
                          accessibilityRole="button"
                          accessibilityLabel={`Details for ${item.title}`}
                          activeOpacity={0.86}
                          onPress={() => setActiveHelp(item.contact)}
                          style={styles.iconButton}
                        >
                          <Ionicons name="information-circle-outline" size={22} color={colors.textSecondary} />
                        </TouchableOpacity>
                      ) : null}
                    </View>
                    <View style={styles.helpActions}>
                      <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityLabel={`Call ${item.title} at ${item.contact.displayPhone}`}
                        activeOpacity={0.88}
                        onPress={() => confirmDial(item.contact)}
                        style={[
                          styles.callButton,
                          stackHelpRows && styles.callButtonStacked,
                          { backgroundColor: tone.buttonBackground },
                        ]}
                      >
                        <Ionicons name="call" size={16} color={colors.textInverse} />
                        <Text style={styles.callButtonText}>{item.contact.displayPhone}</Text>
                      </TouchableOpacity>
                      {stackHelpRows ? null : (
                        <TouchableOpacity
                          accessibilityRole="button"
                          accessibilityLabel={`Details for ${item.title}`}
                          activeOpacity={0.86}
                          onPress={() => setActiveHelp(item.contact)}
                          style={styles.iconButton}
                        >
                          <Ionicons name="information-circle-outline" size={22} color={colors.textSecondary} />
                        </TouchableOpacity>
                      )}
                    </View>
                  </View>
                );
              })}
            </View>
          </View>
        </View>
      </ScrollView>

      <InfoModal
        visible={Boolean(activeHelp)}
        title={activeHelp?.label ?? 'Support contact'}
        description={activeHelp?.description}
        onClose={() => setActiveHelp(null)}
      >
        {activeHelp ? (
          <>
            <InfoModalSection title="Number">
              <InfoModalBullet>{activeHelp.displayPhone}</InfoModalBullet>
              <InfoModalBullet>Availability: {activeHelp.availability}</InfoModalBullet>
            </InfoModalSection>
            <InfoModalSection title="Before calling">
              <InfoModalBullet>SafeRide opens your device dialer only after you confirm.</InfoModalBullet>
              <InfoModalBullet>Phone calls can appear in device, carrier, or account records.</InfoModalBullet>
            </InfoModalSection>
            <Button title={`Call ${activeHelp.displayPhone}`} onPress={() => confirmDial(activeHelp)} fullWidth />
          </>
        ) : null}
      </InfoModal>
    </SafeAreaView>
  );
}
