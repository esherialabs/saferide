import React, { useCallback, useMemo, useRef, useState } from 'react';
import { getReportNavigationStyles } from '../components/report/reportNavigationStyles';
import { View, Text, StyleSheet, ScrollView, Alert, TouchableOpacity } from 'react-native';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';

import { ReportWizardProgress } from '../components/report/ReportWizardProgress';
import Screen from '../components/ui/Screen';
import Button from '../components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/Card';
import { ChoiceCard } from '../components/ui/ChoiceCard';
import { ReportStepHeader } from '../components/report/ReportStepHeader';
import { Alert as AlertComponent } from '../components/ui/Alert';
import { Badge } from '../components/ui/Badge';
import { Chip } from '../components/ui/Chip';
import { Checkbox } from '../components/ui/Checkbox';
import { useTheme } from '../theme/SimpleThemeProvider';
import { RootStackParamList } from '../navigation/routes';
import { useReportWizardBack } from '../navigation/reportWizardBack';
import { exitCompletedReportToCases, navigateToMainTab, navigateToReportRoute, resetReportStackToRoute, resetReportToWorkspace } from '../navigation/reportNavigation';
import type { PathwayType } from '../types/pathways';
import { useToast } from '../components/ui/Toast';
import { useReportDraftIdentity } from '../hooks/useReportDraftIdentity';
import { useCompletedReportRedirect } from '../hooks/useCompletedReportRedirect';
import { draftStorage, type DraftData } from '../utils/draftStorage';
import { getLatestEditableReportDraft } from '../utils/reportDraftSelection';
import { offlineSyncManager } from '../utils/offlineSync';
import { useOnline } from '../context/OnlineProvider';
import {
  getSubmittedReportSteps,
  getReportWizardResumeTarget,
  isFinalReportDraftState,
  REPORT_STEPS_BEFORE_CONSENT,
} from '../navigation/reportPathwayFlow';
import { getProvidersLocalOnly, Provider } from '../lib/catalog';
import {
  buildConsentSummary,
  ConsentChecklistItem,
  ConsentEditAction,
  ConsentEditRoute,
  ConsentKeyPoint,
  ConsentSummaryModel,
} from '../utils/consentSummary';
import {
  devPrivacyError,
  devPrivacyInfo,
  devPrivacyWarn,
  getPrivacySafeErrorReason,
} from '../utils/privacyLog';
import { borders, elevation, radii, spacing, typography } from '../theme/tokens';
import {
  recordPathwayConsent,
  resolveAnonymousAggregateConsent,
  type ConsentLedgerEntry,
} from '../utils/consentLedger';
import { getMobileRsiSignalDecision } from '../config/rsi/rsiSignalConfig';
import { submitApprovedAnonymousSignals } from '../services/rsiSignalService';
import {
  captureMeasurementEvent,
  captureReportCompletion,
} from '../lib/measurement/localEventStore';
import { usePartnerSharingAvailability } from '../hooks/usePartnerSharingAvailability';
import { isCaseSubmissionEnabled } from '../config/runtime/caseSubmissionGate';
import { CASE_SUBMISSION_COPY } from '../i18n/caseSubmissionCopy';
import { authClient } from '../lib/auth/authClient';
import { confirmCenter } from '../utils/confirmCenter';
import {
  buildCaseSubmissionToast,
  planCaseSubmission,
  type CaseSubmissionPlan,
} from '../utils/caseSubmissionFlow';
import { formatPartnerCopy, PARTNER_SHARING_COPY } from '../i18n/partnerSharingCopy';
import { buildHuriaPacket } from '../utils/huriaPacket';
import {
  buildPartnerCallbackParagraphs,
  buildPartnerConsentParagraphs,
  buildPartnerSharingChoice,
  formatKenyanMobileForDisplay,
  getPartnerSharingFormState,
  getRequestedPartnerSharing,
  withPartnerConsentAgreement,
  type PartnerSharingDraft,
} from '../utils/partnerSharing';

type ConsentGateNavigationProp = NativeStackNavigationProp<RootStackParamList, 'ConsentGate'>;
type ConsentGateRouteProp = RouteProp<RootStackParamList, 'ConsentGate'>;

type PathwayChoice = {
  type: PathwayType;
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  blurb: string;
};

// Compact, one-line-per-option pathway chooser. Kept intentionally lean so the
// review page stays short; the full pathway detail lives in the live summary
// below and (for referral/escalate) in their dedicated detail screens.
const PATHWAY_CHOICES: PathwayChoice[] = [
  {
    type: 'save-private',
    icon: 'shield-checkmark-outline',
    title: 'Save privately',
    blurb: 'Keep it on this phone only. Nothing is sent.',
  },
  {
    type: 'anonymous-map',
    icon: 'map-outline',
    title: 'Add to safety map',
    blurb: 'Prepare a map record. Sharing stays off unless approved privacy controls are active.',
  },
  {
    type: 'referral',
    icon: 'headset-outline',
    title: 'Get help (referral)',
    blurb: 'Choose a provider. Contact actions appear only for reviewed listings.',
  },
  {
    type: 'escalate',
    icon: 'send-outline',
    title: 'Escalate for action',
    blurb: 'Save a packet for online action.',
  },
];

const REVIEW_EDIT_ACTIONS: ConsentEditAction[] = [
  { id: 'incident', label: 'Edit incident details', route: 'WhatHappened' },
  { id: 'location-time', label: 'Edit time or location', route: 'WhereWhen' },
  { id: 'evidence', label: 'Edit evidence', route: 'EvidenceDetail' },
];

function mergeEditActions(primary: ConsentEditAction[], secondary: ConsentEditAction[]): ConsentEditAction[] {
  const seenRoutes = new Set<ConsentEditRoute>();
  return [...primary, ...secondary].filter(action => {
    if (seenRoutes.has(action.route)) return false;
    seenRoutes.add(action.route);
    return true;
  });
}

function draftHasReferralDetails(draft: DraftData | null): boolean {
  if (!draft) return false;
  const hasProvider = Boolean(draft.referralSelection?.providerId ?? draft.selectedProvider);
  const hasChannel = Boolean(draft.referralSelection?.selectedChannel ?? draft.selectedChannel);
  const providerOnlySelectionAllowed = Boolean(
    draft.referralSelection?.contactStatus === 'pending',
  );
  return hasProvider && (hasChannel || providerOnlySelectionAllowed);
}

function draftHasEscalationDetails(draft: DraftData | null): boolean {
  return Boolean(draft?.escalationData);
}

function collectDraftTags(draft: DraftData | null): string[] {
  if (!draft) return [];
  const set = new Set<string>();
  (draft.selectedTags ?? []).forEach(tag => set.add(tag));
  (draft.acceptedSuggestions ?? []).forEach(tag => set.add(tag));
  (draft.customTags ?? []).forEach(tag => set.add(tag));
  return Array.from(set);
}

function formatTagLabel(tag: string): string {
  return tag.replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
}

function normalizeStoredPathway(value: unknown): PathwayType | null {
  return value === 'save-private' ||
    value === 'anonymous-map' ||
    value === 'referral' ||
    value === 'escalate'
    ? value
    : null;
}

/** True when this phone holds a SafeRide API session (a local guest has none). */
async function hasOwnedApiSession(): Promise<boolean> {
  try {
    const { data, error } = await authClient.getSession();
    return !error && Boolean(data.session?.access_token);
  } catch {
    return false;
  }
}

export default function ConsentGateScreen() {
  const navigation = useNavigation<ConsentGateNavigationProp>();
  const route = useRoute<ConsentGateRouteProp>();
  const { colors } = useTheme();
  const toast = useToast();

  const [consentChecked, setConsentChecked] = useState(false);
  const [partnerConsentChecked, setPartnerConsentChecked] = useState(false);
  const [callbackConsentChecked, setCallbackConsentChecked] = useState(false);
  const partnerAvailability = usePartnerSharingAvailability();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { isOnline, enqueueSubmit } = useOnline();
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [consentSummary, setConsentSummary] = useState<ConsentSummaryModel | null>(null);
  const [isConsentDataLoaded, setIsConsentDataLoaded] = useState(false);
  const [draftData, setDraftData] = useState<DraftData | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [showLoadNotice, setShowLoadNotice] = useState(true);
  const [isStartingFreshDraft, setIsStartingFreshDraft] = useState(false);
  const redirectedCompletedDraftRef = useRef<string | null>(null);

  const routeDraftId = typeof route.params?.draftId === 'string' && route.params.draftId.trim()
    ? route.params.draftId
    : undefined;
  const {
    draftId,
    isResolving: isResolvingDraftId,
    error: draftIdError,
  } = useReportDraftIdentity(routeDraftId, { initialStep: 'ConsentGate' });
  const routePathway = route.params?.pathway;
  const isEditingCompleted = route.params?.editCompleted === true;
  useCompletedReportRedirect(navigation, draftData, { enabled: !isEditingCompleted && !isSubmitting });
  const goBackToEvidence = useReportWizardBack(navigation, draftId ? {
    route: 'EvidenceDetail',
    params: { draftId, ...(isEditingCompleted ? { editCompleted: true } : {}) },
  } : undefined);
  const [pathway, setPathway] = useState<PathwayType | null>(routePathway ?? null);
  const [showKeyPoints, setShowKeyPoints] = useState(false);

  const styles = StyleSheet.create({
    ...getReportNavigationStyles(colors),
    screenRoot: {
      flex: 1,
    },
    container: {
      flex: 1,
      paddingHorizontal: spacing.md,
      paddingTop: spacing.md,
    },
    scrollContent: {
      paddingBottom: spacing.md,
    },
    sectionTitle: {
      ...typography.titleSmall,
      color: colors.foreground,
      marginBottom: spacing.xs,
      marginTop: spacing.md,
    },
    pathwaySection: {
      marginBottom: spacing.md,
    },
    pathwayList: {
      gap: spacing.xs,
    },
    sectionCard: {
      marginBottom: spacing.md,
    },
    sectionCardContent: {
      gap: spacing.sm,
    },
    compactCardContent: {
      gap: spacing.xs,
      paddingTop: spacing.md,
    },
    choosePrompt: {
      ...typography.bodySmall,
      color: colors.mutedForeground,
    },
    previousStepButton: {
      alignItems: 'center',
      alignSelf: 'flex-start',
      borderColor: colors.divider,
      borderRadius: radii.button,
      borderWidth: borders.hairline,
      flexDirection: 'row',
      gap: spacing.xs,
      marginBottom: spacing.md,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
    },
    previousStepText: {
      ...typography.labelSmall,
      color: colors.foreground,
    },
    detailCallout: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      padding: spacing.md,
      borderRadius: radii.card,
      borderWidth: borders.hairline,
      borderColor: colors.primary + '40',
      backgroundColor: colors.primary + '10',
      marginBottom: spacing.md,
    },
    detailActionRow: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.sm,
    },
    detailActionText: {
      ...typography.bodySmall,
      color: colors.foreground,
      flex: 1,
    },
    tagsRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    tagChipsWrap: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
      marginTop: 4,
    },
    checklistItem: {
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      paddingVertical: spacing.sm,
    },
    checklistHeader: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm,
    },
    checklistContent: {
      flex: 1,
    },
    checklistLabel: {
      ...typography.label,
      color: colors.foreground,
      marginBottom: spacing.xxxs,
    },
    checklistValue: {
      ...typography.bodySmall,
      color: colors.mutedForeground,
    },
    detailsButton: {
      alignSelf: 'flex-start',
      marginTop: 8,
    },
    detailsContent: {
      marginTop: spacing.sm,
      padding: spacing.sm,
      backgroundColor: colors.surfaceAlt,
      borderColor: colors.divider,
      borderRadius: radii.card,
      borderWidth: borders.hairline,
      overflow: 'hidden',
      position: 'relative',
    },
    disclosureToggle: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    redactionChip: {
      marginRight: 8,
      marginBottom: 8,
    },
    consentSection: {
      marginTop: spacing.lg,
      marginBottom: spacing.md,
    },
    consentContainer: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      padding: spacing.md,
      borderWidth: borders.standard,
      borderColor: consentChecked ? colors.primary : colors.border,
      borderRadius: radii.card,
      gap: spacing.sm,
      backgroundColor: colors.surface,
      overflow: 'hidden',
      position: 'relative',
      ...elevation.card,
    },
    consentText: {
      ...typography.bodySmall,
      color: colors.foreground,
      flex: 1,
    },
    validationError: {
      marginBottom: spacing.md,
      padding: spacing.sm,
      backgroundColor: colors.destructive + '10',
      borderWidth: borders.hairline,
      borderColor: colors.destructive + '30',
      borderRadius: radii.card,
    },
    cancelButton: {
      alignSelf: 'stretch',
      flex: 1,
    },
    confirmButton: {
      alignSelf: 'stretch',
      flex: 2,
    },
    editGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
      marginBottom: spacing.xs,
    },
    editButton: {
      alignSelf: 'flex-start',
    },
    noticeTitleRow: {
      alignItems: 'flex-start',
      flexDirection: 'row',
      gap: spacing.sm,
      justifyContent: 'space-between',
    },
    noticeTitleContent: {
      flex: 1,
    },
    noticeDismissButton: {
      alignItems: 'center',
      borderRadius: 18,
      height: 36,
      justifyContent: 'center',
      width: 36,
    },
  });

  const selectedTags = useMemo(() => collectDraftTags(draftData), [draftData]);
  const needsReferralDetails = pathway === 'referral' && !draftHasReferralDetails(draftData);
  const needsEscalationDetails = pathway === 'escalate' && !draftHasEscalationDetails(draftData);
  const needsPathwayDetails = needsReferralDetails || needsEscalationDetails;

  const navigateToDraftTarget = useCallback((target: ReturnType<typeof getReportWizardResumeTarget>) => {
    if (target.route === 'DraftOverview') {
      navigateToReportRoute(navigation, 'ReportHome', undefined);
      return;
    }

    resetReportStackToRoute(navigation, target.route, {
      ...target.params,
      ...(isEditingCompleted ? { editCompleted: true } : {}),
    } as any);
  }, [isEditingCompleted, navigation]);

  const recoverMissingConsentDraft = useCallback(async () => {
    const latestDraft = getLatestEditableReportDraft(await draftStorage.getAllDrafts());

    if (latestDraft) {
      toast.show({
        title: 'Opened saved draft',
        message: 'SafeRide opened the latest report saved on this phone.',
        variant: 'info',
      });
      navigateToDraftTarget(getReportWizardResumeTarget(latestDraft));
      return;
    }

    setLoadFailed(true);
    setShowLoadNotice(true);
    toast.show({
      title: 'No local draft found',
      message: 'Start a report again so SafeRide can save it on this phone first.',
      variant: 'warning',
    });
  }, [draftId, isEditingCompleted, navigateToDraftTarget, navigation, toast]);

  const loadConsentData = useCallback(async () => {
    if (isResolvingDraftId) {
      setIsConsentDataLoaded(false);
      setLoadFailed(false);
      setShowLoadNotice(false);
      setDraftData(null);
      setConsentChecked(false);
      setExpandedItems(new Set());
      setConsentSummary(null);
      return;
    }

    try {
      setIsConsentDataLoaded(false);
      setLoadFailed(false);
      setShowLoadNotice(true);
      if (!draftId) {
        setDraftData(null);
        setConsentChecked(false);
        setExpandedItems(new Set());
        setConsentSummary(null);
        setPathway(null);
        setLoadFailed(true);
        return;
      }

      // Read the local draft directly: local storage holds the freshest copy
      // (every wizard step writes locally first), so consent reviews exactly
      // what will be saved rather than a possibly-stale synced server copy.
      const draft = await draftStorage.getDraft(draftId);
      if (!navigation.isFocused()) return;
      if (!draft) {
        setDraftData(null);
        setConsentChecked(false);
        setExpandedItems(new Set());
        setConsentSummary(null);
        setPathway(null);
        await recoverMissingConsentDraft();
        return;
      }

      setDraftData(draft);
      setLoadFailed(false);

      if (!isEditingCompleted && isFinalReportDraftState(draft)) {
        setConsentSummary(null);
        if (draft && redirectedCompletedDraftRef.current !== draft.id) {
          redirectedCompletedDraftRef.current = draft.id;
          toast.show({
            title: 'Report already completed',
            message: 'Open it from Cases to review the saved record.',
            variant: 'info',
          });
        }
        return;
      }

      const storedPathway = normalizeStoredPathway(draft?.selectedPathway);
      const activePathway = pathway ?? storedPathway;
      if (!pathway && storedPathway) {
        setPathway(storedPathway);
      }

      // No pathway chosen yet: show only the chooser, no summary.
      if (!activePathway) {
        setConsentSummary(null);
        return;
      }

      let catalogProvider: Provider | undefined;
      const providerId = draft?.referralSelection?.providerId ?? draft?.selectedProvider;
      if (activePathway === 'referral' && providerId) {
        try {
          const providers = await getProvidersLocalOnly();
          catalogProvider = providers.find((provider: Provider) => provider.id === providerId);
        } catch (error) {
          devPrivacyWarn('consent provider lookup failed', {
            reason: getPrivacySafeErrorReason(error),
          });
        }
      }

      setConsentSummary(buildConsentSummary({
        draft,
        pathway: activePathway,
        isOnline,
        catalogProvider,
        anonymousSignalSharing: (() => {
          const decision = getMobileRsiSignalDecision();
          return {
            enabled: decision.enabled,
            consentVersion: decision.enabled ? decision.config.consentVersion : null,
          };
        })(),
      }));
    } catch (error) {
      devPrivacyError('consent summary load failed', {
        reason: getPrivacySafeErrorReason(error),
      });
      setDraftData(null);
      setLoadFailed(true);
      setConsentChecked(false);
      setExpandedItems(new Set());
      setConsentSummary(null);
      setPathway(null);
      setShowLoadNotice(true);
    } finally {
      setIsConsentDataLoaded(true);
    }
  }, [draftId, isEditingCompleted, isResolvingDraftId, pathway, isOnline, navigation, recoverMissingConsentDraft, toast]);

  // Loads on mount, on pathway/online change, and whenever the screen refocuses
  // (e.g. returning from the referral/escalation/tags detail screens) so the
  // summary and validation reflect the just-entered details.
  useFocusEffect(
    useCallback(() => {
      captureMeasurementEvent({
        name: 'consent_review',
        screenId: 'consent-gate',
        taskId: 'consent-review',
        outcome: 'started',
      });
      loadConsentData();
    }, [loadConsentData]),
  );

  const handleSelectPathway = async (next: PathwayType) => {
    if (isResolvingDraftId || !isConsentDataLoaded) {
      toast.show({
        title: 'Report still opening',
        message: 'Wait a moment, then choose what happens next.',
        variant: 'info',
      });
      return;
    }

    if (!draftId) {
      toast.show({
        title: 'Draft still opening',
        message: draftIdError ?? 'Wait a moment, then try again.',
        variant: 'warning',
      });
      return;
    }

    if (loadFailed) {
      toast.show({
        title: 'Open the report editor first',
        message: 'SafeRide needs the local report details before choosing what happens next.',
        variant: 'error',
      });
      return;
    }

    if (next === pathway) return;
    const previousPathway = pathway;
    setConsentChecked(false);
    setPartnerConsentChecked(false);
    setCallbackConsentChecked(false);
    setExpandedItems(new Set());

    try {
      await draftStorage.saveDraft({
        id: draftId,
        selectedPathway: next,
        completedSteps: REPORT_STEPS_BEFORE_CONSENT,
        currentStep: 'ConsentGate',
        updatedAt: new Date(),
      });
      const saved = await draftStorage.getDraft(draftId);
      if (!saved) {
        throw new Error('Local draft missing after pathway save');
      }
      setDraftData(saved);
      setLoadFailed(false);
      setPathway(next);
    } catch (error) {
      devPrivacyWarn('pathway persist failed', { reason: getPrivacySafeErrorReason(error) });
      setPathway(previousPathway);
      toast.show({
        title: 'Save failed',
        message: 'SafeRide could not save that choice yet. Try again.',
        variant: 'error',
      });
      return;
    }
  };

  const navigateAfterConsent = (selectedPathway: PathwayType, submissionPlan: CaseSubmissionPlan = 'stay_on_phone') => {
    if (selectedPathway === 'escalate' && submissionPlan === 'queue' && draftId) {
      // Queued to send: show its status (read from the local draft as it syncs).
      resetReportToWorkspace(navigation);
      navigation.navigate('EscalationConfirmation', {
        isOffline: !isOnline,
        caseId: draftId,
        contactMethod: draftData?.escalationData?.contactPreference === 'alias' ? 'Alias' : 'No contact',
        draftId,
      });
      return;
    }
    switch (selectedPathway) {
      case 'referral':
        resetReportToWorkspace(navigation);
        if (draftId) {
          navigation.navigate('ReferralPicker', {
            draftId,
            editCompleted: true,
            contactReady: true,
          });
        } else {
          navigateToMainTab(navigation, 'Support');
        }
        return;
      case 'escalate':
        exitCompletedReportToCases(navigation);
        return;
      case 'save-private':
      case 'anonymous-map':
      default:
        resetReportToWorkspace(navigation);
        navigateToMainTab(navigation, 'Home');
    }
  };

  const handleReturnToReportWorkspace = () => {
    resetReportToWorkspace(navigation);
  };

  const handleStartFreshDraft = async () => {
    if (isStartingFreshDraft) return;

    const nextDraftId = draftId ?? draftStorage.generateDraftId();
    try {
      setIsStartingFreshDraft(true);
      await draftStorage.saveDraft({
        id: nextDraftId,
        currentStep: 'WhatHappened',
        completedSteps: [],
      });
      resetReportStackToRoute(navigation, 'WhatHappened', {
        draftId: nextDraftId,
        ...(isEditingCompleted ? { editCompleted: true } : {}),
      });
    } catch (error) {
      devPrivacyWarn('missing draft recovery creation failed', {
        reason: getPrivacySafeErrorReason(error),
      });
      toast.show({
        title: 'Draft save unavailable',
        message: 'Return to the report workspace and try again.',
        variant: 'error',
      });
    } finally {
      setIsStartingFreshDraft(false);
    }
  };

  const toggleItemExpansion = (key: string) => {
    const newExpanded = new Set(expandedItems);
    if (newExpanded.has(key)) {
      newExpanded.delete(key);
    } else {
      newExpanded.add(key);
    }
    setExpandedItems(newExpanded);
  };

  const navigateToEditRoute = (routeName: ConsentEditRoute) => {
    if (!draftId) {
      handleReturnToReportWorkspace();
      return;
    }

    if (loadFailed && routeName !== 'ConsentGate') {
      handleReturnToReportWorkspace();
      return;
    }

    switch (routeName) {
      case 'ConsentGate':
        setPathway(null);
        setConsentChecked(false);
        setExpandedItems(new Set());
        setConsentSummary(null);
        break;
      case 'WhatHappened':
        navigation.navigate('WhatHappened', { draftId, ...(isEditingCompleted ? { editCompleted: true } : {}) });
        break;
      case 'WhereWhen':
        navigation.navigate('WhereWhen', { draftId, ...(isEditingCompleted ? { editCompleted: true } : {}) });
        break;
      case 'EvidenceDetail':
        navigation.navigate('EvidenceDetail', { draftId, ...(isEditingCompleted ? { editCompleted: true } : {}) });
        break;
      case 'ReferralPicker':
        navigation.navigate('ReferralPicker', { draftId, ...(isEditingCompleted ? { editCompleted: true } : {}) });
        break;
      case 'EscalationForm':
        navigation.navigate('EscalationForm', { draftId, ...(isEditingCompleted ? { editCompleted: true } : {}) });
        break;
    }
  };

  const renderExpandableRow = (
    item: ConsentChecklistItem | ConsentKeyPoint,
    key: string,
  ) => {
    const hasDetails = Boolean(item.details?.length);
    return (
      <View key={key} style={styles.checklistItem}>
        <View style={styles.checklistHeader}>
          <Ionicons
            name={item.icon as any}
            size={20}
            color={colors.mutedForeground}
            style={{ marginTop: 2 }}
          />
          <View style={styles.checklistContent}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={styles.checklistLabel}>{item.label}</Text>
              {hasDetails && (
                <TouchableOpacity
                  onPress={() => toggleItemExpansion(key)}
                  style={styles.detailsButton}
                  accessibilityRole="button"
                  accessibilityLabel={`${expandedItems.has(key) ? 'Hide' : 'Show'} details for ${item.label}`}
                  accessibilityHint="Expands or collapses the additional consent information"
                  accessibilityState={{ expanded: expandedItems.has(key) }}
                >
                  <Text style={{ color: colors.primary, fontSize: 12 }}>
                    {expandedItems.has(key) ? 'Hide details' : 'View details'}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
            <Text style={styles.checklistValue}>{item.value}</Text>
            {hasDetails && expandedItems.has(key) && (
              <View style={styles.detailsContent}>
                <Text style={{ fontSize: 12, color: colors.mutedForeground, lineHeight: 16 }}>
                  {item.details!.join('\n')}
                </Text>
              </View>
            )}
          </View>
        </View>
      </View>
    );
  };

  const renderPathwayChooser = () => (
    <View style={styles.pathwaySection}>
      <ReportStepHeader
        title="Choose what happens next"
        helper="Nothing leaves this phone until you choose and confirm."
      />
      <View
        style={styles.pathwayList}
        accessibilityRole="radiogroup"
        accessibilityLabel="Choose one report pathway"
      >
        {PATHWAY_CHOICES.map(choice => {
          const selected = pathway === choice.type;
          const disabled = isResolvingDraftId || !isConsentDataLoaded || !draftId || loadFailed;
          return (
            <ChoiceCard
              key={choice.type}
              title={choice.title}
              description={choice.blurb}
              icon={choice.icon}
              selected={selected}
              disabled={disabled}
              onPress={() => {
                void handleSelectPathway(choice.type);
              }}
              accessibilityLabel={`${choice.title}. ${choice.blurb}`}
              accessibilityHint={selected ? 'Selected pathway' : 'Selects this pathway and updates the consent summary'}
            />
          );
        })}
      </View>
    </View>
  );

  const renderMissingDraftRecovery = () => (
    <Card variant="outlined" style={styles.sectionCard}>
      <CardHeader>
        <View style={styles.noticeTitleRow}>
          <View style={styles.noticeTitleContent}>
            <CardTitle>Review needs local details</CardTitle>
            <CardDescription>
              SafeRide could not read the report details for this review route on this phone. Nothing was uploaded.
            </CardDescription>
          </View>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Dismiss draft notice"
            onPress={() => setShowLoadNotice(false)}
            style={styles.noticeDismissButton}
          >
            <Ionicons name="close" size={20} color={colors.mutedForeground} />
          </TouchableOpacity>
        </View>
      </CardHeader>
      <CardContent style={styles.sectionCardContent}>
        <Text style={styles.checklistValue}>
          Open the report workspace to continue a saved draft, or reopen the editor so SafeRide can save a local draft before review.
        </Text>
        <View style={styles.navigationButtons}>
          <Button
            title="Report workspace"
            variant="outline"
            onPress={handleReturnToReportWorkspace}
            style={styles.cancelButton}
          />
          <Button
            title="Reopen editor"
            onPress={() => {
              void handleStartFreshDraft();
            }}
            loading={isStartingFreshDraft}
            style={styles.confirmButton}
          />
        </View>
        <Button
          title="Check again"
          variant="ghost"
          onPress={loadConsentData}
          fullWidth
        />
      </CardContent>
    </Card>
  );

  const renderDetailCallout = () => {
    if (!needsPathwayDetails) return null;
    const isReferral = needsReferralDetails;
    return (
      <Card variant="outlined" style={styles.sectionCard}>
        <CardHeader>
          <CardTitle>{isReferral ? 'Choose provider first' : 'Add escalation details first'}</CardTitle>
          <CardDescription>
            {isReferral
              ? 'Pick the support provider and contact channel before consent appears.'
              : 'Review redaction and contact preference before consent appears.'}
          </CardDescription>
        </CardHeader>
        <CardContent style={styles.sectionCardContent}>
          <View style={styles.detailActionRow}>
            <Ionicons
              name={isReferral ? 'headset-outline' : 'send-outline'}
              size={20}
              color={colors.primary}
            />
            <Text style={styles.detailActionText}>
              {isReferral
                ? 'SafeRide will bring you back here to review exactly what is saved.'
                : 'SafeRide will bring you back here for the final consent check.'}
            </Text>
          </View>
          <Button
            title={isReferral ? 'Choose provider' : 'Add escalation details'}
            size="sm"
            fullWidth
            onPress={() => navigateToEditRoute(isReferral ? 'ReferralPicker' : 'EscalationForm')}
          />
        </CardContent>
      </Card>
    );
  };

  const renderPreviousStepAction = () => (
    <TouchableOpacity
      style={styles.previousStepButton}
      onPress={goBackToEvidence}
      accessibilityRole="button"
      accessibilityLabel="Back to evidence"
    >
      <Ionicons name="arrow-back-circle-outline" size={17} color={colors.foreground} />
      <Text style={styles.previousStepText}>Back to evidence</Text>
    </TouchableOpacity>
  );

  const renderTagsRow = () => (
    <Card variant="filled" hideAccent style={styles.sectionCard}>
      <CardContent style={styles.compactCardContent}>
      <View style={styles.tagsRow}>
        <Text style={[styles.checklistLabel, { flex: 1 }]}>Context tags (optional)</Text>
      </View>
      {selectedTags.length > 0 ? (
        <View style={styles.tagChipsWrap}>
          {selectedTags.map(tag => (
            <Chip key={tag} label={formatTagLabel(tag)} />
          ))}
        </View>
      ) : (
        <Text style={styles.checklistValue}>None added. Tags only help organize the draft.</Text>
      )}
      </CardContent>
    </Card>
  );

  const renderRedactionChips = () => {
    if (!consentSummary?.redactionChips?.length) return null;

    return (
      <Card variant="outlined" style={styles.sectionCard}>
        <CardHeader>
          <CardTitle>Privacy and redaction status</CardTitle>
        </CardHeader>
        <CardContent style={styles.sectionCardContent}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginBottom: 12 }}>
          {consentSummary.redactionChips.map((chip) => (
            <Chip key={chip} label={chip} style={styles.redactionChip} />
          ))}
        </View>
        {consentSummary.redactionAction && (
          <Button
            title={consentSummary.redactionAction.label}
            variant="ghost"
            size="sm"
            onPress={() => navigateToEditRoute(consentSummary.redactionAction!.route)}
          />
        )}
        </CardContent>
      </Card>
    );
  };

  const renderEditActions = (actions: ConsentEditAction[], title = 'Change before confirming') => {
    if (!actions.length) return null;

    return (
      <Card variant="outlined" hideAccent style={styles.sectionCard}>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent style={styles.sectionCardContent}>
        <View style={styles.editGrid}>
          {actions.map(action => (
            <Button
              key={action.id}
              title={action.label}
              variant="outline"
              size="sm"
              style={styles.editButton}
              onPress={() => navigateToEditRoute(action.route)}
            />
          ))}
        </View>
        </CardContent>
      </Card>
    );
  };

  const saveConsentCheckpoint = async (
    selectedPathway: PathwayType,
    consentRecord: ConsentLedgerEntry,
    finalized = true,
  ): Promise<DraftData> => {
    if (!draftId) {
      throw new Error('Local draft id missing at consent checkpoint');
    }

    await draftStorage.saveDraft({
      id: draftId,
      status: 'draft',
      selectedPathway: selectedPathway,
      completedSteps: finalized ? getSubmittedReportSteps(selectedPathway) : REPORT_STEPS_BEFORE_CONSENT,
      currentStep: finalized ? 'completed' : 'ConsentGate',
      caseSubmissionError: undefined,
      pathwayConsent: {
        recordId: consentRecord.id,
        purpose: 'pathway_submission',
        version: 'pathway-consent.v1',
        pathway: selectedPathway,
        grantedAt: consentRecord.grantedAt,
      },
      updatedAt: new Date(),
    });

    if (finalized) {
      try {
        await offlineSyncManager.removeSubmitQueueItemsForDraft(draftId);
      } catch (error) {
        devPrivacyWarn('legacy submit queue cleanup failed', { reason: getPrivacySafeErrorReason(error) });
      }
    }

    const saved = await draftStorage.getDraft(draftId);
    if (!saved) {
      throw new Error('Draft not found after consent checkpoint');
    }

    setDraftData(saved);
    return saved;
  };

  // HURIA sharing chosen in the escalation or referral step, for this pathway.
  const requestedPartnerSharing = draftData && pathway ? getRequestedPartnerSharing(draftData, pathway) : null;
  const partnerReviewActive = Boolean(requestedPartnerSharing && partnerAvailability.routing);
  const partnerCallbackReview = Boolean(
    partnerReviewActive && partnerAvailability.callback && requestedPartnerSharing?.callback?.requested,
  );
  const partnerConsentMissing = partnerReviewActive &&
    (!partnerConsentChecked || (partnerCallbackReview && !callbackConsentChecked));

  // The separate HURIA consent: recorded only when ticked; a choice the
  // server no longer offers is turned off so the report goes to SafeRide only.
  const resolvePartnerSharingForConfirm = (): { ok: true; sharing: PartnerSharingDraft | null } | { ok: false } => {
    if (!requestedPartnerSharing) return { ok: true, sharing: null };
    if (!partnerReviewActive) {
      return { ok: true, sharing: { partnerStableId: requestedPartnerSharing.partnerStableId, requested: false } };
    }
    const rebuilt = buildPartnerSharingChoice(
      requestedPartnerSharing,
      getPartnerSharingFormState(requestedPartnerSharing),
      partnerAvailability,
    );
    if (!rebuilt.ok) return { ok: false };
    return { ok: true, sharing: withPartnerConsentAgreement(rebuilt.sharing, pathway === 'referral' ? 'referral' : 'escalate') };
  };

  const handleDeclinePartnerSharing = async () => {
    if (!draftId || !requestedPartnerSharing) return;
    try {
      await draftStorage.saveDraft({
        id: draftId,
        partnerSharing: { partnerStableId: requestedPartnerSharing.partnerStableId, requested: false },
        updatedAt: new Date(),
      });
      const saved = await draftStorage.getDraft(draftId);
      if (saved) setDraftData(saved);
      setPartnerConsentChecked(false);
      setCallbackConsentChecked(false);
      toast.show({
        title: PARTNER_SHARING_COPY.review.turnedOffToastTitle,
        message: PARTNER_SHARING_COPY.review.turnedOffToastBody,
        variant: 'info',
      });
    } catch (error) {
      devPrivacyWarn('partner sharing opt-out save failed', { reason: getPrivacySafeErrorReason(error) });
      toast.show({ title: 'Save failed', message: 'SafeRide could not save that choice yet. Try again.', variant: 'error' });
    }
  };

  const handleConfirm = async () => {
    if (isSubmitting) {
      return;
    }

    if (!draftId) {
      toast.show({
        title: 'Draft still opening',
        message: draftIdError ?? 'Wait a moment, then try again.',
        variant: 'warning',
      });
      return;
    }

    if (!pathway) {
      toast.show({ title: 'Choose a pathway', message: 'Pick how you want to proceed first.', variant: 'error' });
      return;
    }

    if (!consentSummary) {
      toast.show({ title: 'Still loading', message: 'Please wait for the consent summary.', variant: 'error' });
      return;
    }

    if (!consentSummary.validation.valid) {
      toast.show({ title: 'Review needed', message: consentSummary.validation.message, variant: 'error' });
      return;
    }

    if (!consentChecked) {
      toast.show({ title: 'Consent required', message: 'Please check the consent box to continue.', variant: 'error' });
      return;
    }

    if (partnerConsentMissing) {
      toast.show({
        title: PARTNER_SHARING_COPY.review.consentRequiredTitle,
        message: PARTNER_SHARING_COPY.review.consentRequiredBody,
        variant: 'error',
      });
      return;
    }
    const partnerResolution = resolvePartnerSharingForConfirm();
    if (!partnerResolution.ok) {
      toast.show({
        title: PARTNER_SHARING_COPY.review.consentRequiredTitle,
        message: PARTNER_SHARING_COPY.review.callbackInvalidBody,
        variant: 'error',
      });
      return;
    }
    const partnerSharingChosen = partnerResolution.sharing?.requested === true;

    // A referral with no contact channel can only be sent to HURIA's dashboard
    // with sharing on; queueing it otherwise fails on every retry.
    const referralChannel = draftData?.referralSelection?.selectedChannel ?? draftData?.selectedChannel;
    if (pathway === 'referral' && !referralChannel && !partnerSharingChosen) {
      toast.show({
        title: 'Turn on sharing with HURIA',
        message: 'In this pilot, a support referral is sent only to HURIA with sharing on. Go back and turn it on.',
        variant: 'error',
      });
      return;
    }

    const selectedPathway = pathway;
    let externalSignalAccepted = false;

    try {
      setIsSubmitting(true);
      devPrivacyInfo('consent confirmation started', { pathway: selectedPathway, online: isOnline });

      if (partnerResolution.sharing) {
        await draftStorage.saveDraft({ id: draftId, partnerSharing: partnerResolution.sharing, updatedAt: new Date() });
      }
      const consentRecord = await recordPathwayConsent({ pathway: selectedPathway });
      const rsiDecision = selectedPathway === 'anonymous-map' ? getMobileRsiSignalDecision() : null;
      let savedDraft = await saveConsentCheckpoint(selectedPathway, consentRecord, !rsiDecision?.enabled);
      let acceptedSignalCount = 0;
      if (rsiDecision?.enabled) {
        try {
          if (!rsiDecision.config.consentVersion) {
            throw new Error('Anonymous aggregate consent version is unavailable.');
          }
          const aggregateConsent = await resolveAnonymousAggregateConsent({
            checkpoint: savedDraft.anonymousAggregateConsent,
            version: rsiDecision.config.consentVersion,
          });
          await draftStorage.saveDraft({
            id: savedDraft.id,
            anonymousAggregateConsent: aggregateConsent,
            updatedAt: new Date(),
          });
          savedDraft = (await draftStorage.getDraft(savedDraft.id)) ?? savedDraft;
          const result = await submitApprovedAnonymousSignals({
            draft: savedDraft,
            aggregateConsent,
          });
          externalSignalAccepted = true;
          acceptedSignalCount = result.count;
          await saveConsentCheckpoint(selectedPathway, consentRecord, true);
        } catch (error) {
          if (externalSignalAccepted) throw error;
          toast.show({
            title: 'Saved locally; signal not shared',
            message: getPrivacySafeErrorReason(error) || 'Review the connection and consent status, then try again.',
            variant: 'warning',
          });
          return;
        }
      }

      // Referral and escalation reports leave the phone only while the server
      // switch is on and the survivor has a SafeRide session; otherwise they
      // stay here exactly as before, and the wording says so.
      let submissionPlan: CaseSubmissionPlan = 'stay_on_phone';
      if (selectedPathway === 'referral' || selectedPathway === 'escalate') {
        const submissionEnabled = isCaseSubmissionEnabled();
        submissionPlan = planCaseSubmission({
          pathway: selectedPathway,
          submissionEnabled,
          hasOwnedSession: submissionEnabled ? await hasOwnedApiSession() : false,
        });
        if (submissionPlan === 'needs_sign_in') {
          await confirmCenter.request({
            title: CASE_SUBMISSION_COPY.signInTitle,
            message: `${CASE_SUBMISSION_COPY.signInBody}\n\n${CASE_SUBMISSION_COPY.signInHint}`,
            actions: [{ id: 'keep', label: CASE_SUBMISSION_COPY.signInKeep }],
          });
        } else if (submissionPlan === 'queue') {
          const queued = await enqueueSubmit({ draftId, pathway: selectedPathway });
          if (queued !== 'queued') submissionPlan = 'stay_on_phone';
        }
      }

      switch (selectedPathway) {
        case 'save-private':
          toast.show({
            title: 'Saved privately',
            message: 'Your report stays local on this device.',
            variant: 'success',
          });
          break;
        case 'anonymous-map':
          if (rsiDecision?.enabled) {
            toast.show({
              title: 'Minimized map signal shared',
              message: `${acceptedSignalCount} controlled signal${acceptedSignalCount === 1 ? '' : 's'} accepted. The full report and exact location stayed off the aggregate API.`,
              variant: 'success',
            });
          } else {
            toast.show({
              title: 'Map record saved',
              message: 'Saved locally. No live map or API upload runs from this step.',
              variant: 'success',
            });
          }
          break;
        case 'referral': {
          const referralChannel = savedDraft.referralSelection?.selectedChannel ?? savedDraft.selectedChannel;
          toast.show({
            title: buildCaseSubmissionToast({
              pathway: 'referral',
              plan: submissionPlan,
              isOnline,
              partnerSharingChosen,
            }).title,
            message: referralChannel
              ? isOnline
                ? 'Provider and channel are saved. Choose the contact action on the next screen.'
                : 'Provider and channel are saved. Calls and SMS can still open from the next screen.'
              : 'Provider information is saved. Contact actions remain unavailable until this listing completes review.',
            variant: 'success',
          });
          break;
        }
        case 'escalate':
          toast.show(buildCaseSubmissionToast({
            pathway: 'escalate',
            plan: submissionPlan,
            isOnline,
            partnerSharingChosen,
          }));
          break;
      }

      captureReportCompletion();
      navigateAfterConsent(selectedPathway, submissionPlan);
    } catch (error) {
      captureMeasurementEvent({
        name: 'error_outcome',
        screenId: 'consent-gate',
        taskId: 'report-flow',
        outcome: 'failed',
        errorCode: 'submit_failed',
      });
      const reason = getPrivacySafeErrorReason(error);
      devPrivacyError('consent confirmation failed', { reason });
      toast.show({
        title: externalSignalAccepted ? 'Signal accepted; local completion needs review' : 'Save failed',
        message: reason || 'Please try again.',
        variant: 'error',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancel = () => {
    Alert.alert(
      'Cancel confirmation?',
      'Your progress will stay saved as a draft. You can continue later from Cases.',
      [
        { text: 'Continue here', style: 'cancel' },
        {
          text: 'Save & exit',
          onPress: () => navigateToMainTab(navigation, 'Home'),
        },
      ],
    );
  };

  const validation = consentSummary?.validation;
  const hasValidationError = isConsentDataLoaded && validation && !validation.valid;
  const hasMissingDraftFailure = isConsentDataLoaded && loadFailed;
  const showMissingDraftRecovery = hasMissingDraftFailure && showLoadNotice;
  const showSummary = Boolean(pathway) && Boolean(consentSummary) && !needsPathwayDetails;
  const confirmDisabled =
    isSubmitting ||
    isResolvingDraftId ||
    !draftId ||
    loadFailed ||
    !pathway ||
    needsPathwayDetails ||
    !consentChecked ||
    partnerConsentMissing ||
    Boolean(hasValidationError) ||
    !isConsentDataLoaded;

  const partnerParagraphStyle = {
    ...typography.bodyS,
    color: colors.foreground,
    lineHeight: 20,
    marginBottom: spacing.sm,
  };

  const renderPartnerReview = (sharing: PartnerSharingDraft) => {
    const level = draftData?.escalationData?.redactionLevel ?? 'light';
    const redactionLabel = level.charAt(0).toUpperCase() + level.slice(1);
    const phone = sharing.callback?.phoneNumber ? formatKenyanMobileForDisplay(sharing.callback.phoneNumber) : null;
    const packet = draftData ? buildHuriaPacket(draftData, { pathway: pathway === 'referral' ? 'referral' : 'escalate' }) : null;
    const fields = packet ? [
      ['Contact preference', packet.contact.label],
      ['When', packet.content.timeRange], ['Place in words', packet.content.location],
      ['What happened', packet.content.incidentDescription], ['Statement', packet.content.statement],
      ['Impact', packet.content.impactSummary], ['Witness details', packet.content.witnessDetails],
      ['Tags', packet.content.tags.join(', ')], ['Patterns', packet.content.patterns.join(', ')],
      ['Vehicle details', packet.content.transportIdentifiers.join(', ')],
    ].filter((entry): entry is [string, string] => Boolean(entry[1])) : [];
    return (
      <Card variant="elevated" style={{ marginBottom: spacing.md }}>
        <CardHeader>
          <CardTitle>{PARTNER_SHARING_COPY.review.cardTitle}</CardTitle>
        </CardHeader>
        <CardContent>
          {buildPartnerConsentParagraphs({
            pathway: pathway === 'referral' ? 'referral' : 'escalate',
            redactionLabel,
          }).map(paragraph => (
            <Text key={paragraph} style={partnerParagraphStyle}>{paragraph}</Text>
          ))}
          {packet ? <View style={{ marginBottom: spacing.md }} accessibilityLabel="HURIA packet preview">
            <Text style={[partnerParagraphStyle, { fontWeight: '600' }]}>Report packet HURIA will see</Text>
            {fields.map(([label, value]) => <View key={label} style={{ marginBottom: spacing.sm }}>
              <Text style={[partnerParagraphStyle, { fontWeight: '600', marginBottom: 2 }]}>{label}</Text>
              <Text style={partnerParagraphStyle}>{value}</Text>
            </View>)}
            <Text style={[partnerParagraphStyle, { fontWeight: '600' }]}>Evidence list and text only</Text>
            {packet.evidenceManifest.length ? packet.evidenceManifest.map((item, index) => <View key={`${item.type}-${index}`}>
              <Text style={partnerParagraphStyle}>{item.label}</Text>
              {item.description ? <Text style={partnerParagraphStyle}>{item.description}</Text> : null}
              {item.transcript ? <Text style={partnerParagraphStyle}>{item.transcript}</Text> : null}
            </View>) : <Text style={partnerParagraphStyle}>No evidence descriptions or transcripts included.</Text>}
            <Text style={partnerParagraphStyle}>Evidence files and exact map coordinates are not shared with HURIA.</Text>
          </View> : null}
          <Checkbox
            checked={partnerConsentChecked}
            onCheckedChange={checked => setPartnerConsentChecked(checked === true)}
            label={PARTNER_SHARING_COPY.review.consentCheckbox}
            accessibilityLabel={PARTNER_SHARING_COPY.review.consentCheckbox}
            accessibilityHint="Required to share this report with HURIA"
          />
          {partnerCallbackReview && phone ? (
            <View style={{ marginTop: spacing.md }}>
              <Text style={[partnerParagraphStyle, { fontWeight: '600' }]}>
                {`${PARTNER_SHARING_COPY.review.callbackNumberLabel}: ${phone}`}
              </Text>
              {buildPartnerCallbackParagraphs().map(paragraph => (
                <Text key={paragraph} style={partnerParagraphStyle}>{paragraph}</Text>
              ))}
              <Checkbox
                checked={callbackConsentChecked}
                onCheckedChange={checked => setCallbackConsentChecked(checked === true)}
                label={formatPartnerCopy(PARTNER_SHARING_COPY.review.callbackCheckbox, { phone })}
                accessibilityLabel={formatPartnerCopy(PARTNER_SHARING_COPY.review.callbackCheckbox, { phone })}
                accessibilityHint="Required to share your callback number with HURIA"
              />
            </View>
          ) : null}
          <Button
            title={PARTNER_SHARING_COPY.review.turnOff}
            variant="ghost"
            onPress={() => void handleDeclinePartnerSharing()}
            style={{ marginTop: spacing.sm }}
          />
        </CardContent>
      </Card>
    );
  };

  return (
    // BottomTabs already reserves the bottom safe area for the report stack.
    <Screen edges={['top', 'left', 'right']}>
      <View style={styles.screenRoot}>
        <ScrollView
          style={styles.container}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <ReportWizardProgress
            draft={draftData}
            currentStep="ConsentGate"
            isSaving={isSubmitting}
            lastSaved={draftData?.updatedAt}
            error={draftIdError}
          />

          {showMissingDraftRecovery ? renderMissingDraftRecovery() : null}

          {!hasMissingDraftFailure && renderPreviousStepAction()}
          {!hasMissingDraftFailure && renderPathwayChooser()}
          {!hasMissingDraftFailure && renderDetailCallout()}

          {!hasMissingDraftFailure && !pathway && (
            <>
              <Card variant="filled" hideAccent style={styles.sectionCard}>
                <CardContent style={styles.compactCardContent}>
                  <Text style={styles.choosePrompt}>
                    Pick an option above to see what stays on this phone and what is saved.
                  </Text>
                </CardContent>
              </Card>
              {renderEditActions(REVIEW_EDIT_ACTIONS, 'Edit previous report steps')}
            </>
          )}

          {!hasMissingDraftFailure && pathway && !showSummary ? (
            renderEditActions(REVIEW_EDIT_ACTIONS, 'Edit previous report steps')
          ) : null}

          {!hasMissingDraftFailure && showSummary && consentSummary && (
            <>
              <Text style={styles.sectionTitle}>{consentSummary.checklistTitle}</Text>
              <Card variant="elevated" style={{ marginBottom: spacing.sm }}>
                <CardContent>
                  {consentSummary.checklistItems.map((item, index) => (
                    renderExpandableRow(item, `checklist-${index}`)
                  ))}
                </CardContent>
              </Card>

              {renderTagsRow()}

              <Card
                variant="filled"
                hideAccent
                onPress={() => setShowKeyPoints(prev => !prev)}
                accessibilityLabel="How this pathway works"
                accessibilityHint="Expands or collapses the pathway details"
                accessibilityState={{ expanded: showKeyPoints }}
                style={styles.sectionCard}
              >
                <CardContent style={styles.compactCardContent}>
                  <View style={styles.disclosureToggle}>
                    <Text style={[styles.checklistLabel]}>How this pathway works</Text>
                    <Ionicons
                      name={showKeyPoints ? 'chevron-up' : 'chevron-down'}
                      size={18}
                      color={colors.mutedForeground}
                    />
                  </View>
                </CardContent>
              </Card>
              {showKeyPoints && (
                <Card variant="elevated" style={{ marginBottom: spacing.md }}>
                  <CardContent>
                    {consentSummary.keyPoints.map((item, index) => (
                      renderExpandableRow(item, `key-${index}`)
                    ))}
                  </CardContent>
                </Card>
              )}

              {renderRedactionChips()}
              {renderEditActions(mergeEditActions(REVIEW_EDIT_ACTIONS, consentSummary.editActions))}

              <AlertComponent variant="warning" style={{ marginBottom: 24 }}>
                <View>
                  <Text style={{ color: colors.foreground, fontWeight: '600', marginBottom: 4 }}>
                    {consentSummary.retentionNoticeTitle}
                  </Text>
                  <Text style={{ color: colors.foreground, fontSize: 14, lineHeight: 20 }}>
                    {consentSummary.retentionNotice}
                  </Text>
                </View>
              </AlertComponent>

              {partnerReviewActive && requestedPartnerSharing ? renderPartnerReview(requestedPartnerSharing) : null}
              {requestedPartnerSharing && !partnerReviewActive ? (
                <AlertComponent variant="info" style={{ marginBottom: 16 }}>
                  <Text style={{ color: colors.foreground }}>{PARTNER_SHARING_COPY.review.unavailableNotice}</Text>
                </AlertComponent>
              ) : null}

              {hasValidationError && validation && !validation.valid && (
                <View style={styles.validationError}>
                  <Text style={{ color: colors.destructive, fontSize: 14, marginBottom: 8 }}>
                    {validation.message}
                  </Text>
                  <Button
                    title={validation.actionLabel}
                    variant="outline"
                    onPress={() => navigateToEditRoute(validation.actionRoute)}
                  />
                </View>
              )}

              <View style={styles.consentSection}>
                <View style={styles.consentContainer}>
                  <Checkbox
                    checked={consentChecked}
                    onCheckedChange={(checked) => setConsentChecked(checked === true)}
                    label={consentSummary.consentStatement}
                    accessibilityLabel={consentSummary.consentStatement}
                    accessibilityHint="Required before confirming this pathway"
                    style={{ flex: 1 }}
                  />
                </View>
              </View>
            </>
          )}

          {consentSummary?.offlineBadge && consentChecked && showSummary && !hasMissingDraftFailure && (
            <View style={{ alignItems: 'center', marginBottom: 24 }}>
              <Badge variant="secondary">
                <Text style={{ fontSize: 12 }}>{consentSummary.offlineBadge}</Text>
              </Badge>
            </View>
          )}
        </ScrollView>

        {pathway && showSummary && !hasMissingDraftFailure && (
          <View style={styles.navigationDock}>
            <View style={styles.navigationButtons}>
              <Button
                title="Cancel"
                variant="outline"
                onPress={handleCancel}
                style={styles.cancelButton}
              />
              <Button
                title={consentSummary?.primaryButtonLabel ?? 'Confirm'}
                onPress={handleConfirm}
                disabled={confirmDisabled}
                loading={isSubmitting}
                style={styles.confirmButton}
              />
            </View>
          </View>
        )}
      </View>
    </Screen>
  );
}
