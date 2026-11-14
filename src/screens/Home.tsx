import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Linking,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { CompositeNavigationProp, useFocusEffect, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';

import {
  Button,
  DashboardTemplate,
  InfoModal,
  InfoModalBullet,
  InfoModalSection,
} from '../components/ui';
import { EmergencyHelpSheet } from '../components/ui/EmergencyHelpSheet';
import { SafetyIllustration } from '../components/ui/SafetyIllustration';
import { RootStackParamList, MainTabParamList } from '../navigation/routes';
import { resetReportStackToRoute } from '../navigation/reportNavigation';
import { useStealthMode } from '../hooks/useStealthMode';
import { useToast } from '../components/ui/Toast';
import { useTheme } from '../theme/SimpleThemeProvider';
import { borders, radii, spacing, typography } from '../theme/tokens';
import { draftStorage, type DraftData } from '../utils/draftStorage';
import { getReportWizardProgress, getReportWizardResumeTarget } from '../navigation/reportPathwayFlow';
import { getEditableReportDrafts } from '../utils/reportDraftSelection';
import { getProvidersWithInfo, type CatalogLoadSource, type Provider as CatalogProvider } from '../lib/catalog';
import {
  getDialUrl,
  KENYA_POLICE_EMERGENCY_CONTACT,
  PRIMARY_KENYA_GBV_CONTACT,
} from '../lib/supportResources';
import { buildCatalogStatusLine } from '../utils/supportDiscovery';
import { captureMeasurementEvent } from '../lib/measurement/localEventStore';

type HomeNavigationProp = CompositeNavigationProp<
  BottomTabNavigationProp<MainTabParamList, 'Home'>,
  NativeStackNavigationProp<RootStackParamList>
>;

type DraftStepRoute = 'WhatHappened' | 'WhereWhen' | 'EvidenceDetail';
type HomeInfoTopic = 'report' | 'support' | 'cases' | 'learn' | 'immediate' | 'tips' | 'privacy';

const REPORT_START_STEP: DraftStepRoute = 'WhatHappened';
const HORIZONTAL_PADDING = spacing.md;
const SECTION_GAP = spacing.xs;

type IconName = React.ComponentProps<typeof Ionicons>['name'];

function getGreeting(date = new Date()) {
  const hour = date.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function formatUpdatedAt(value?: Date) {
  if (!value || Number.isNaN(value.getTime())) {
    return 'Saved locally';
  }

  return `Updated ${value.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

export default function HomeScreen() {
  const navigation = useNavigation<HomeNavigationProp>();
  const { quickExit, quickExitAvailable } = useStealthMode();
  const toast = useToast();
  const { colors, mode } = useTheme();
  const { width, fontScale } = useWindowDimensions();
  const [searchQuery, setSearchQuery] = useState('');
  const [latestDraft, setLatestDraft] = useState<DraftData | null>(null);
  const [draftCount, setDraftCount] = useState(0);
  const [activeInfo, setActiveInfo] = useState<HomeInfoTopic | null>(null);
  const [isEmergencySheetVisible, setIsEmergencySheetVisible] = useState(false);
  const [supportProviders, setSupportProviders] = useState<CatalogProvider[]>([]);
  const [supportCatalogSource, setSupportCatalogSource] = useState<CatalogLoadSource>('seed');
  const [supportCatalogLastUpdated, setSupportCatalogLastUpdated] = useState<string | null>(null);
  const [supportCatalogError, setSupportCatalogError] = useState<string | null>(null);
  const [isSupportCatalogLoading, setIsSupportCatalogLoading] = useState(false);

  // The card art appears only where it does not squeeze the title onto two lines.
  const showReportArt = width >= 400 && fontScale < 1.3;
  // Enlarged text keeps whole words: the decorative icon steps aside, then the info control moves below.
  const emergencyWithoutIcon = width < 350 || fontScale >= 1.3;
  const emergencyInfoBelow = fontScale >= 1.6 || (width < 350 && fontScale >= 1.3);

  const loadDrafts = useCallback(async () => {
    const drafts = await draftStorage.getAllDrafts();
    const activeDrafts = getEditableReportDrafts(drafts);

    setDraftCount(activeDrafts.length);
    setLatestDraft(activeDrafts[0] ?? null);
  }, []);

  // Refresh the dashboard when any draft write commits (autosave, sync,
  // another screen), not only on tab focus.
  useEffect(() => draftStorage.subscribe(() => {
    loadDrafts().catch(() => {});
  }), [loadDrafts]);

  useFocusEffect(
    useCallback(() => {
      let isActive = true;

      loadDrafts().catch((error) => {
        console.warn('Failed to load home draft state', error);
        if (isActive) {
          toast.show({ title: 'Draft status unavailable', variant: 'error' });
        }
      });

      setIsSupportCatalogLoading(true);
      getProvidersWithInfo()
        .then(result => {
          if (!isActive) return;
          setSupportProviders(result.items);
          setSupportCatalogSource(result.source);
          setSupportCatalogLastUpdated(result.lastUpdated);
          setSupportCatalogError(result.error ? 'Provider update failed. Saved or bundled listings are shown.' : null);
        })
        .catch(error => {
          console.warn('Failed to load home support catalog', error);
          if (!isActive) return;
          setSupportProviders([]);
          setSupportCatalogSource('seed');
          setSupportCatalogLastUpdated(null);
          setSupportCatalogError('Provider catalog could not be loaded. Immediate contacts remain available.');
        })
        .finally(() => {
          if (isActive) {
            setIsSupportCatalogLoading(false);
          }
        });

      return () => {
        isActive = false;
      };
    }, [loadDrafts, toast]),
  );

  const latestDraftProgress = useMemo(
    () => (latestDraft ? getReportWizardProgress(latestDraft) : null),
    [latestDraft],
  );

  const latestDraftStatus = useMemo(() => {
    if (!latestDraft) {
      return draftCount > 0 ? `${draftCount} drafts in progress` : 'Saved on this device';
    }

    const progress = getReportWizardProgress(latestDraft);
    return `${progress.completedSteps}/${progress.totalSteps} steps - ${formatUpdatedAt(latestDraft.updatedAt)}`;
  }, [draftCount, latestDraft]);

  const supportCatalogStatus = useMemo(() => buildCatalogStatusLine({
    label: 'Providers',
    source: supportCatalogSource,
    lastUpdated: supportCatalogLastUpdated,
    itemCount: supportProviders.length,
    error: supportCatalogError,
  }), [supportCatalogError, supportCatalogLastUpdated, supportCatalogSource, supportProviders.length]);

  const supportProviderPreview = useMemo(() => {
    if (supportProviders.length === 0) {
      return 'No provider listings loaded. Immediate contacts still use the Kenya support catalog.';
    }

    const providerNames = supportProviders.slice(0, 3).map(provider => provider.name).join(' / ');
    return `${providerNames}${supportProviders.length > 3 ? ' / more in provider picker' : ''}`;
  }, [supportProviders]);

  const createDraftAndOpen = useCallback(
    async (routeName: DraftStepRoute) => {
      if (routeName === REPORT_START_STEP) {
        resetReportStackToRoute(navigation, REPORT_START_STEP, undefined);
        return;
      }

      resetReportStackToRoute(navigation, REPORT_START_STEP, undefined);
      toast.show({
        title: 'Start with what happened',
        message: 'SafeRide saves the local draft after the first report step.',
        variant: 'info',
      });
    },
    [navigation, toast],
  );

  const handleContinueDraft = useCallback(() => {
    captureMeasurementEvent({
      name: 'report_start',
      screenId: 'home',
      taskId: 'report-flow',
      outcome: 'started',
    });
    if (!latestDraft) {
      createDraftAndOpen(REPORT_START_STEP);
      return;
    }

    const target = getReportWizardResumeTarget(latestDraft);
    if (target.route === 'DraftOverview') {
      navigation.navigate('Cases');
      return;
    }
    resetReportStackToRoute(navigation, target.route, target.params as any);
  }, [createDraftAndOpen, latestDraft, navigation]);

  const handleAddEvidence = useCallback(() => {
    if (latestDraft) {
      resetReportStackToRoute(navigation, 'EvidenceDetail', { draftId: latestDraft.id });
      return;
    }

    createDraftAndOpen('EvidenceDetail');
  }, [createDraftAndOpen, latestDraft, navigation]);

  const handleOpenProviderSupport = useCallback(async () => {
    const draftId = draftStorage.generateDraftId();
    try {
      await draftStorage.saveDraft({
        id: draftId,
        selectedPathway: 'referral',
        currentStep: 'ReferralPicker',
      });
    } catch (error) {
      console.warn('Failed to initialize provider support draft:', error);
      toast.show({
        title: 'Draft save unavailable',
        message: 'SafeRide could not start a local referral draft on this device.',
        variant: 'error',
      });
      return;
    }

    resetReportStackToRoute(navigation, 'ReferralPicker', { draftId });
  }, [navigation, toast]);

  const dialSupportNumber = useCallback(
    (phoneNumber: string) => {
      Linking.openURL(getDialUrl(phoneNumber, Platform.OS)).catch(() => {
        toast.show({
          title: 'Dial failed',
          message: 'Unable to launch the phone dialer.',
          variant: 'error',
        });
      });
    },
    [toast],
  );

  const handleEmergency = useCallback(() => {
    setIsEmergencySheetVisible(true);
  }, []);

  const handleSearch = useCallback(() => {
    const query = searchQuery.trim().toLowerCase();

    if (!query) {
      toast.show({
        title: 'Search SafeRide',
        message: 'Try report, case, support, tips, or learn.',
        variant: 'info',
      });
      return;
    }

    if (query.includes('case') || query.includes('draft')) {
      navigation.navigate('Cases');
      return;
    }

    if (query.includes('support') || query.includes('help') || query.includes('chat')) {
      navigation.navigate('Support');
      return;
    }

    if (query.includes('tip') || query.includes('right')) {
      navigation.navigate('TipsRights');
      return;
    }

    if (query.includes('learn') || query.includes('video')) {
      navigation.navigate('Learn');
      return;
    }

    if (query.includes('report')) {
      handleContinueDraft();
      return;
    }

    toast.show({
      title: 'No quick match',
      message: 'Use the cards below to open the main journeys.',
      variant: 'info',
    });
  }, [handleContinueDraft, navigation, searchQuery, toast]);

  const isDarkMode = mode === 'dark';
  // Dark mode keeps urgent help unmistakable without a bright salmon slab.
  const emergencyPalette = useMemo(() => (isDarkMode ? {
    background: colors.criticalMuted,
    border: colors.critical,
    foreground: colors.foreground,
    icon: colors.critical,
    iconBackground: 'rgba(0,0,0,0.18)',
    iconBorder: colors.critical,
    divider: colors.critical,
  } : {
    background: colors.critical,
    border: colors.critical,
    foreground: colors.criticalForeground,
    icon: colors.criticalForeground,
    iconBackground: 'rgba(255,255,255,0.14)',
    iconBorder: 'rgba(255,255,255,0.28)',
    divider: 'rgba(255,255,255,0.28)',
  }), [colors, isDarkMode]);

  const closeInfo = useCallback(() => setActiveInfo(null), []);

  const runFromInfo = useCallback((action: () => void) => {
    setActiveInfo(null);
    setTimeout(action, 120);
  }, []);

  return (
    <DashboardTemplate showNetworkStatus edges={['left', 'right']} scrollContentStyle={styles.scrollContent}>
      <View style={styles.intro}>
        <Text accessibilityRole="header" style={[styles.introTitle, { color: colors.foreground }]}>{getGreeting()}</Text>
        <Text style={[styles.introText, { color: colors.textSecondary }]}>Record, find support, or learn at your pace.</Text>
      </View>
      <View style={[styles.searchContainer, { backgroundColor: colors.surface, borderColor: colors.input }]}>
        <Ionicons name="search-outline" size={20} color={colors.textTertiary} />
        <TextInput
          style={[styles.searchInput, { color: colors.foreground }]}
          placeholder="Find reports, cases, tips, or support"
          placeholderTextColor={colors.textTertiary}
          value={searchQuery}
          onChangeText={setSearchQuery}
          onSubmitEditing={handleSearch}
          returnKeyType="search"
        />
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Search SafeRide"
          activeOpacity={0.8}
          style={styles.searchAction}
          onPress={handleSearch}
        >
          <Ionicons name="arrow-forward" size={20} color={colors.foreground} />
        </TouchableOpacity>
      </View>

      <View
        style={[
          styles.emergencyButton,
          emergencyInfoBelow && styles.emergencyStacked,
          {
            backgroundColor: emergencyPalette.background,
            borderColor: emergencyPalette.border,
          },
        ]}
      >
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Open immediate help options"
          activeOpacity={0.9}
          onPress={handleEmergency}
          style={styles.emergencyPrimary}
        >
          {emergencyWithoutIcon ? null : (
            <View style={[styles.emergencyIconShell, { backgroundColor: emergencyPalette.iconBackground, borderColor: emergencyPalette.iconBorder }]}>
              <Ionicons
                name="warning"
                size={22}
                color={emergencyPalette.icon}
              />
            </View>
          )}
          <View style={styles.emergencyCopy}>
            <Text style={[styles.emergencyText, { color: emergencyPalette.foreground }]}>
              Immediate Help
            </Text>
            <Text style={[styles.emergencySubtext, { color: emergencyPalette.foreground }]}>
              Kenya: 1195, 999, 112, or Quick Exit
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={emergencyPalette.foreground} />
        </TouchableOpacity>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="More about immediate help"
          activeOpacity={0.85}
          onPress={() => setActiveInfo('immediate')}
          style={[
            styles.cardInfoButton,
            emergencyInfoBelow
              ? [styles.cardInfoBelow, { borderTopColor: emergencyPalette.divider }]
              : { borderLeftColor: emergencyPalette.divider },
          ]}
        >
          <Ionicons name="information-circle-outline" size={22} color={emergencyPalette.foreground} />
          {emergencyInfoBelow ? <Text style={[styles.cardInfoLabel, { color: emergencyPalette.foreground }]}>More</Text> : null}
        </TouchableOpacity>
      </View>

      <View style={[styles.reportCard, { backgroundColor: colors.primaryMuted }]}>
        <View style={styles.reportTop}>
          <View style={styles.reportCopy}>
            <Text accessibilityRole="header" style={[styles.reportTitle, { color: colors.foreground }]}>
              {latestDraft ? 'Continue your report' : 'Record what happened'}
            </Text>
            <Text style={[styles.reportText, { color: colors.textSecondary }]}>
              {latestDraft
                ? latestDraftStatus
                : 'Four short steps, saved on this phone. Nothing is shared unless you choose.'}
            </Text>
          </View>
          {showReportArt && !latestDraft ? <SafetyIllustration kind="evidence" size={56} /> : null}
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="More about reports"
            activeOpacity={0.85}
            onPress={() => setActiveInfo('report')}
            style={styles.reportInfo}
          >
            <Ionicons name="information-circle-outline" size={22} color={colors.primary} />
          </TouchableOpacity>
        </View>

        {latestDraftProgress ? (
          <View
            style={styles.reportProgress}
            accessible
            accessibilityLabel={`${latestDraftProgress.completedSteps} of ${latestDraftProgress.totalSteps} report steps done`}
          >
            {latestDraftProgress.steps.map(step => (
              <View
                key={step.id}
                style={[
                  styles.reportProgressSegment,
                  {
                    backgroundColor: step.status === 'complete' || step.status === 'skipped'
                      ? colors.primary
                      : colors.surface,
                  },
                ]}
              />
            ))}
          </View>
        ) : null}

        <View style={styles.reportActions}>
          <Button
            title={latestDraft ? 'Continue' : 'Start report'}
            onPress={handleContinueDraft}
            accessibilityLabel={latestDraft ? 'Continue latest draft' : 'Start a report'}
            icon={<Ionicons name="arrow-forward" size={18} color={colors.primaryForeground} />}
            iconPosition="right"
            style={styles.reportPrimary}
          />
          {latestDraft ? (
            <Button
              title="Add evidence"
              variant="outline"
              onPress={handleAddEvidence}
              style={styles.reportSecondary}
            />
          ) : null}
        </View>
      </View>

      <View style={[styles.listCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        {([
          {
            key: 'support',
            title: 'Quick support',
            description: 'Chat and provider options',
            icon: 'chatbubbles-outline',
            iconColor: colors.support,
            iconBackground: colors.supportMuted,
            accessibilityLabel: 'Open support',
            infoLabel: 'More about support',
            onPress: () => navigation.navigate('Support'),
            onInfo: () => setActiveInfo('support'),
          },
          {
            key: 'cases',
            title: 'Case Tracker',
            description: draftCount > 0 ? `${draftCount} ${draftCount === 1 ? 'draft' : 'drafts'} and your submissions` : 'Drafts and submissions',
            icon: 'folder-open-outline',
            iconColor: colors.evidence,
            iconBackground: colors.evidenceMuted,
            accessibilityLabel: 'Open case tracker',
            infoLabel: 'More about case tracking',
            onPress: () => navigation.navigate('Cases'),
            onInfo: () => setActiveInfo('cases'),
          },
          {
            key: 'tips',
            title: 'Tips and rights',
            description: 'PEP/EC, P3, evidence, 1195 and your rights',
            icon: 'book-outline',
            iconColor: colors.primary,
            iconBackground: colors.primaryMuted,
            accessibilityLabel: 'Open tips and rights',
            infoLabel: 'More about tips and rights',
            onPress: () => navigation.navigate('TipsRights'),
            onInfo: () => setActiveInfo('tips'),
          },
          {
            key: 'learn',
            title: 'Learn',
            description: 'Videos and saved guidance',
            icon: 'play-circle-outline',
            iconColor: colors.consent,
            iconBackground: colors.consentMuted,
            accessibilityLabel: 'Open learning videos',
            infoLabel: 'More about learning resources',
            onPress: () => navigation.navigate('Learn'),
            onInfo: () => setActiveInfo('learn'),
          },
        ] as Array<{
          key: string;
          title: string;
          description: string;
          icon: IconName;
          iconColor: string;
          iconBackground: string;
          accessibilityLabel: string;
          infoLabel: string;
          onPress: () => void;
          onInfo: () => void;
        }>).map((row, index) => (
          <View
            key={row.key}
            style={[styles.listRow, index > 0 && { borderTopColor: colors.divider, borderTopWidth: borders.hairline }]}
          >
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={row.accessibilityLabel}
              activeOpacity={0.85}
              onPress={row.onPress}
              style={styles.listPrimary}
            >
              <View style={[styles.listIcon, { backgroundColor: row.iconBackground }]}>
                <Ionicons name={row.icon} size={20} color={row.iconColor} />
              </View>
              <View style={styles.listCopy}>
                <Text style={[styles.listTitle, { color: colors.foreground }]}>{row.title}</Text>
                <Text style={[styles.listText, { color: colors.textSecondary }]}>{row.description}</Text>
              </View>
            </TouchableOpacity>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={row.infoLabel}
              activeOpacity={0.85}
              onPress={row.onInfo}
              style={styles.listInfo}
            >
              <Ionicons name="information-circle-outline" size={22} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
        ))}
      </View>

      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Privacy and consent. Nothing leaves this phone until you choose."
        activeOpacity={0.85}
        onPress={() => setActiveInfo('privacy')}
        style={styles.privacyRow}
      >
        <Ionicons name="lock-closed-outline" size={16} color={colors.privacy} />
        <Text style={[styles.privacyText, { color: colors.textSecondary }]}>
          Nothing leaves this phone until you choose.{' '}
          <Text style={[styles.privacyLink, { color: colors.privacy }]}>How privacy works</Text>
        </Text>
      </TouchableOpacity>

      <InfoModal
        visible={activeInfo === 'immediate'}
        title="Immediate help options"
        description="The card stays simple, while the details remain available when someone needs them."
        onClose={closeInfo}
      >
        <InfoModalSection title="What happens when you tap the card">
          <InfoModalBullet>SafeRide asks before opening the phone dialer.</InfoModalBullet>
          <InfoModalBullet>Options include {PRIMARY_KENYA_GBV_CONTACT.displayPhone}, 999, and 112.</InfoModalBullet>
          <InfoModalBullet>Quick Exit appears only when the calculator decoy can be unlocked.</InfoModalBullet>
        </InfoModalSection>
        <Button title={`Call ${PRIMARY_KENYA_GBV_CONTACT.shortLabel}`} onPress={() => runFromInfo(() => dialSupportNumber(PRIMARY_KENYA_GBV_CONTACT.phoneNumbers[0]))} fullWidth />
      </InfoModal>

      <InfoModal
        visible={activeInfo === 'report'}
        title="Report and draft journey"
        description="Start quickly, then fill in the extra release guidance only when needed."
        onClose={closeInfo}
      >
        <InfoModalSection title="Current draft status">
          <InfoModalBullet>{latestDraftStatus}</InfoModalBullet>
          <InfoModalBullet>Drafts are local first and can be resumed from the latest unfinished step.</InfoModalBullet>
          <InfoModalBullet>Provider, escalation, and map update routes confirm what leaves the device before sending.</InfoModalBullet>
        </InfoModalSection>
        <InfoModalSection title="Extra paths">
          <InfoModalBullet>Add evidence directly when the survivor already has files, audio, or notes.</InfoModalBullet>
          <InfoModalBullet>Continue draft uses the current wizard progress model instead of restarting.</InfoModalBullet>
        </InfoModalSection>
        <Button title="Add evidence to a draft" onPress={() => runFromInfo(handleAddEvidence)} fullWidth />
      </InfoModal>

      <InfoModal
        visible={activeInfo === 'support'}
        title="Support resources"
        description={isSupportCatalogLoading ? 'Loading provider details.' : supportCatalogStatus}
        onClose={closeInfo}
      >
        <InfoModalSection title="Provider preview">
          <InfoModalBullet>{supportProviderPreview}</InfoModalBullet>
          <InfoModalBullet>Referral details stay consent-gated. Nothing is sent from provider listings until review.</InfoModalBullet>
          {supportCatalogError ? <InfoModalBullet>{supportCatalogError}</InfoModalBullet> : null}
        </InfoModalSection>
        <InfoModalSection title="Immediate fallback">
          <InfoModalBullet>{PRIMARY_KENYA_GBV_CONTACT.shortLabel} is available as a centralized Kenya support contact.</InfoModalBullet>
          <InfoModalBullet>Chat and legal-aid information remain available from the Support tab.</InfoModalBullet>
        </InfoModalSection>
        <Button title="Open provider listings" onPress={() => runFromInfo(handleOpenProviderSupport)} fullWidth />
      </InfoModal>

      <InfoModal
        visible={activeInfo === 'cases'}
        title="Cases and submissions"
        description="Case tracking keeps the card compact, then exposes queue and follow-up detail here."
        onClose={closeInfo}
      >
        <InfoModalSection title="What you can review">
          <InfoModalBullet>Drafts in progress, saved local records, and synced cases are visible from Cases.</InfoModalBullet>
          <InfoModalBullet>Optional online sync shows status instead of pretending a send happened.</InfoModalBullet>
          <InfoModalBullet>Submitted cases keep follow-up space for additional information where supported.</InfoModalBullet>
        </InfoModalSection>
      </InfoModal>

      <InfoModal
        visible={activeInfo === 'learn'}
        title="Learning and guidance"
        description="Keep the home grid light while preserving the richer resource content."
        onClose={closeInfo}
      >
        <InfoModalSection title="What is inside">
          <InfoModalBullet>Saved guidance and learning materials are available without crowding the home screen.</InfoModalBullet>
          <InfoModalBullet>Tips and rights remain separate so urgent reporting and support actions stay easy to scan.</InfoModalBullet>
          <InfoModalBullet>Content is written as guidance, not legal, medical, or emergency-response advice.</InfoModalBullet>
        </InfoModalSection>
      </InfoModal>

      <InfoModal
        visible={activeInfo === 'tips'}
        title="Tips and rights"
        description="Fast guidance stays separate from the learning library so urgent next steps are easier to scan."
        onClose={closeInfo}
      >
        <InfoModalSection title="What is inside">
          <InfoModalBullet>Start here highlights care timing, 1195, P3, evidence handling, and rights before the full guide list.</InfoModalBullet>
          <InfoModalBullet>Each guide keeps source links and review labels where available.</InfoModalBullet>
          <InfoModalBullet>This is general information, not legal, medical, counselling, or emergency-response advice.</InfoModalBullet>
        </InfoModalSection>
        <Button title="Open tips and rights" onPress={() => runFromInfo(() => navigation.navigate('TipsRights'))} fullWidth />
      </InfoModal>

      <InfoModal
        visible={activeInfo === 'privacy'}
        title="Privacy and consent"
        description="The previous card structure stays, with the latest release caveats available on demand."
        onClose={closeInfo}
      >
        <InfoModalSection title="Sharing needs consent">
          <InfoModalBullet>Local reports stay on the device until a consent step is chosen.</InfoModalBullet>
          <InfoModalBullet>Provider referral, escalation, and anonymous map update paths show what will leave the device before sending.</InfoModalBullet>
          <InfoModalBullet>Offline or queued routes show sync status rather than hiding uncertainty.</InfoModalBullet>
        </InfoModalSection>
        <InfoModalSection title="Resource caveats">
          <InfoModalBullet>Support listings may come from remote, cached, or bundled catalog data.</InfoModalBullet>
          <InfoModalBullet>Safety and rights content should stay reviewed and Kenya-context aware before release.</InfoModalBullet>
        </InfoModalSection>
      </InfoModal>

      <EmergencyHelpSheet
        visible={isEmergencySheetVisible}
        onClose={() => setIsEmergencySheetVisible(false)}
        title="Immediate help - Kenya"
        message={
          quickExitAvailable
            ? 'Choose a support contact or open the calculator decoy.'
            : 'Choose a support contact. Quick Exit is unavailable until setup is complete.'
        }
        calls={[
          {
            key: 'gbv',
            number: PRIMARY_KENYA_GBV_CONTACT.displayPhone,
            label: 'GBV helpline',
            tone: 'support',
            onPress: () => dialSupportNumber(PRIMARY_KENYA_GBV_CONTACT.phoneNumbers[0]),
          },
          {
            key: '999',
            number: KENYA_POLICE_EMERGENCY_CONTACT.phoneNumbers[0],
            label: 'Police',
            tone: 'critical',
            onPress: () => dialSupportNumber(KENYA_POLICE_EMERGENCY_CONTACT.phoneNumbers[0]),
          },
          {
            key: '112',
            number: KENYA_POLICE_EMERGENCY_CONTACT.phoneNumbers[1],
            label: 'Emergency',
            tone: 'critical',
            onPress: () => dialSupportNumber(KENYA_POLICE_EMERGENCY_CONTACT.phoneNumbers[1]),
          },
        ]}
        onQuickExit={quickExitAvailable ? quickExit : undefined}
        footnote="Your phone dialer opens next. Calls may appear in phone records."
      />
    </DashboardTemplate>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    gap: SECTION_GAP,
    paddingBottom: spacing.lg,
    paddingHorizontal: HORIZONTAL_PADDING,
    paddingTop: spacing.xxs,
  },
  intro: {
    gap: 2,
  },
  introTitle: {
    ...typography.titleLarge,
    letterSpacing: -0.3,
  },
  introText: {
    ...typography.bodySmall,
  },
  searchContainer: {
    alignItems: 'center',
    borderRadius: radii.input,
    borderWidth: borders.hairline,
    flexDirection: 'row',
    minHeight: 48,
    overflow: 'hidden',
    paddingLeft: spacing.sm,
    position: 'relative',
  },
  searchInput: {
    ...typography.bodyMedium,
    flex: 1,
    marginLeft: spacing.xs,
    minHeight: 46,
    minWidth: 0,
    paddingVertical: 0,
  },
  searchAction: {
    alignItems: 'center',
    height: 48,
    justifyContent: 'center',
    width: 48,
  },
  emergencyButton: {
    alignItems: 'stretch',
    borderRadius: radii.card,
    borderWidth: borders.emphasized,
    flexDirection: 'row',
    overflow: 'hidden',
  },
  emergencyPrimary: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 64,
    minWidth: 0,
    paddingLeft: spacing.sm,
    paddingRight: spacing.xs,
    paddingVertical: spacing.sm,
  },
  emergencyIconShell: {
    alignItems: 'center',
    borderRadius: radii.md,
    borderWidth: borders.hairline,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  emergencyCopy: {
    flex: 1,
    minWidth: 0,
  },
  emergencyText: {
    ...typography.titleMedium,
  },
  emergencySubtext: {
    ...typography.bodySmall,
    fontWeight: '600',
    marginTop: 2,
  },
  cardInfoButton: {
    alignItems: 'center',
    borderLeftWidth: borders.hairline,
    justifyContent: 'center',
    minHeight: 48,
    width: 52,
  },
  emergencyStacked: {
    flexDirection: 'column',
  },
  cardInfoBelow: {
    borderLeftWidth: 0,
    borderTopWidth: borders.hairline,
    flexDirection: 'row',
    gap: spacing.xxs,
    width: '100%',
  },
  cardInfoLabel: {
    ...typography.labelMedium,
  },
  reportCard: {
    borderRadius: radii.lg,
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  reportTop: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  reportCopy: {
    flex: 1,
    gap: spacing.xxs,
    minWidth: 0,
  },
  reportTitle: {
    ...typography.titleMedium,
  },
  reportText: {
    ...typography.bodySmall,
  },
  reportProgress: {
    flexDirection: 'row',
    gap: spacing.xxs,
  },
  reportProgressSegment: {
    borderRadius: radii.round,
    flex: 1,
    height: 6,
  },
  reportActions: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  reportPrimary: {
    flexGrow: 1,
  },
  reportSecondary: {
    flexGrow: 1,
  },
  reportInfo: {
    alignItems: 'center',
    height: 48,
    justifyContent: 'center',
    // Sits in the card corner; the 48dp target extends into the padding.
    marginRight: -spacing.xs,
    marginTop: -spacing.xs,
    width: 48,
  },
  listCard: {
    borderRadius: radii.card,
    borderWidth: borders.hairline,
    overflow: 'hidden',
  },
  listRow: {
    alignItems: 'stretch',
    flexDirection: 'row',
  },
  listPrimary: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 56,
    minWidth: 0,
    paddingLeft: spacing.sm,
    paddingVertical: spacing.xxs,
  },
  listIcon: {
    alignItems: 'center',
    borderRadius: radii.round,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  listCopy: {
    flex: 1,
    minWidth: 0,
  },
  listTitle: {
    ...typography.titleSmall,
  },
  listText: {
    ...typography.bodySmall,
    marginTop: 2,
  },
  listInfo: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    width: 52,
  },
  privacyRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: spacing.xs,
  },
  privacyText: {
    ...typography.bodySmall,
    flexShrink: 1,
    textAlign: 'center',
  },
  privacyLink: {
    ...typography.bodySmall,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
});
