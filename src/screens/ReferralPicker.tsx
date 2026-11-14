import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert, Linking } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { ReportWizardProgress } from '../components/report/ReportWizardProgress';
import Screen from '../components/ui/Screen';
import Button from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Alert as AlertComponent } from '../components/ui/Alert';
import { Badge } from '../components/ui/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card';
import { FeatureHeader, type FeatureHeaderStat } from '../components/ui/FeatureHeader';
import { Switch } from '../components/ui/Switch';
import { Chip } from '../components/ui/Chip';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from '../components/ui/Sheet';
import { useTheme } from '../theme/SimpleThemeProvider';
import { RootStackParamList } from '../navigation/routes';
import { useReportWizardBack } from '../navigation/reportWizardBack';
import { useCompletedReportRedirect } from '../hooks/useCompletedReportRedirect';
import { useReportDraftIdentity } from '../hooks/useReportDraftIdentity';
import { draftStorage, type DraftData } from '../utils/draftStorage';
import { useToast } from '../components/ui/Toast';
import {
  getProvidersWithInfo,
  Provider as CatalogProvider,
  refreshProviders,
  type ProviderPackDisplayStatus,
} from '../lib/catalog';
import { useOnline } from '../context/OnlineProvider';
import { REPORT_STEPS_BEFORE_CONSENT } from '../navigation/reportPathwayFlow';
import { borders, radii, spacing, typography } from '../theme/tokens';
import {
  CHANNEL_LABELS,
  buildReferralContactUrl,
  buildProviderCatalogStatus,
  buildReferralDraftUpdate,
  filterReferralProviders,
  formatCatalogTimestamp,
  getAvailableReferralChannels,
  getProviderAvailabilityLabel,
  getProviderCoverageLabel,
  getProviderReviewLabel,
  isProviderContactActionable,
  type ProviderCatalogSource,
  type ProviderFilter,
  type ReferralContactChannel,
} from '../utils/referralSupport';
import { captureMeasurementEvent } from '../lib/measurement/localEventStore';
import { PartnerSharingOptIn } from '../components/report/PartnerSharingOptIn';
import { usePartnerSharingAvailability } from '../hooks/usePartnerSharingAvailability';
import { PARTNER_SHARING_COPY } from '../i18n/partnerSharingCopy';
import {
  buildPartnerSharingChoice,
  getPartnerSharingFormState,
  HURIA_PARTNER_STABLE_ID,
  type PartnerSharingFormState,
} from '../utils/partnerSharing';

type ReferralPickerNavigationProp = NativeStackNavigationProp<RootStackParamList, 'ReferralPicker'>;
type ReferralPickerRouteProp = RouteProp<RootStackParamList, 'ReferralPicker'>;
type Provider = CatalogProvider;

type FilterChip = ProviderFilter & { label: string };

const FILTER_CHIPS: FilterChip[] = [
  { id: 'open', label: 'Open now', active: false },
  { id: 'hotline', label: 'Hotline', active: false },
  { id: 'gbv', label: 'GBV center', active: false },
  { id: 'legal', label: 'Legal aid', active: false },
  { id: 'counselling', label: 'Counselling', active: false },
  { id: 'near', label: 'Near me', active: false },
];

const CHANNELS: ReferralContactChannel[] = ['call', 'whatsapp', 'sms'];

function catalogErrorMessage(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code === 'rollout-disabled') return 'Updates are locked until partner validation and release attestation pass.';
  if (code === 'cached-pack-invalid') return 'A saved update failed checks; a verified fallback was used.';
  if (code === 'remote-pack-rejected' || code === 'version-conflict') return 'The update failed integrity or release checks and was not activated.';
  if (code === 'bundled-integrity-failed') return 'Provider pack integrity failed. Contact actions are unavailable.';
  return 'The provider update is unavailable. Existing verified listings were kept.';
}

function canSaveProviderWithoutChannel(provider: Provider): boolean {
  return provider.contactStatus === 'pending';
}

export default function ReferralPickerScreen() {
  const navigation = useNavigation<ReferralPickerNavigationProp>();
  const route = useRoute<ReferralPickerRouteProp>();
  const { colors } = useTheme();
  const toast = useToast();
  const { isOnline } = useOnline();

  const [searchQuery, setSearchQuery] = useState('');
  const [providers, setProviders] = useState<Provider[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<Provider | null>(null);
  const [selectedChannel, setSelectedChannel] = useState<ReferralContactChannel | null>(null);
  const [includeBrief, setIncludeBrief] = useState(false);
  const [showProviderDetail, setShowProviderDetail] = useState<Provider | null>(null);
  const [filters, setFilters] = useState<FilterChip[]>(FILTER_CHIPS);
  const [fallbackNumber, setFallbackNumber] = useState('');
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [catalogSource, setCatalogSource] = useState<ProviderCatalogSource>('seed');
  const [providerPackStatus, setProviderPackStatus] = useState<ProviderPackDisplayStatus | undefined>();
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [dismissedOfflineNotice, setDismissedOfflineNotice] = useState(false);
  const [isCatalogLoading, setIsCatalogLoading] = useState(true);
  const [draftData, setDraftData] = useState<DraftData | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const partnerAvailability = usePartnerSharingAvailability();
  const [partnerForm, setPartnerForm] = useState<PartnerSharingFormState>(() => getPartnerSharingFormState(null));
  const [partnerPhoneError, setPartnerPhoneError] = useState<string | null>(null);

  const routeDraftId = typeof route.params?.draftId === 'string' && route.params.draftId.trim()
    ? route.params.draftId
    : undefined;
  const {
    draftId,
    isResolving: isResolvingDraftId,
    error: draftIdError,
  } = useReportDraftIdentity(routeDraftId, { initialStep: 'ReferralPicker' });
  const isEditingCompleted = route.params?.editCompleted === true;
  const isContactReady = route.params?.contactReady === true;
  const isOffline = !isOnline;
  useCompletedReportRedirect(navigation, draftData, { enabled: !isEditingCompleted });

  useEffect(() => {
    if (isOnline) {
      setDismissedOfflineNotice(false);
    }
  }, [isOnline]);
  const goBackToPathway = useReportWizardBack(navigation, draftId ? {
    route: 'ConsentGate',
    params: { draftId, ...(isEditingCompleted ? { editCompleted: true } : {}) },
  } : undefined);
  const selectedChannelLabel = selectedChannel
    ? CHANNEL_LABELS[selectedChannel].replace(' message', '')
    : selectedProvider && canSaveProviderWithoutChannel(selectedProvider)
      ? 'Review'
      : 'Need';
  const heroStats = useMemo<FeatureHeaderStat[]>(() => [
    {
      label: 'Provider',
      value: selectedProvider ? 'Set' : 'Need',
      icon: 'business-outline',
    },
    {
      label: 'Channel',
      value: selectedChannelLabel,
      icon: 'chatbubble-ellipses-outline',
    },
    {
      label: 'Catalog',
      value: isCatalogLoading ? 'Loading' : providers.length,
      icon: 'people-outline',
    },
  ], [isCatalogLoading, providers.length, selectedChannelLabel, selectedProvider]);

  useEffect(() => {
    let isMounted = true;

    const loadProviders = async () => {
      try {
        setIsCatalogLoading(true);
        setCatalogError(null);
        const result = await getProvidersWithInfo();
        if (!isMounted) return;
        setProviders(result.items);
        setCatalogSource(result.source);
        setLastUpdated(result.lastUpdated);
        setProviderPackStatus(result.providerPack);
        if (result.error) {
          setCatalogError(catalogErrorMessage(result.error));
        }
      } catch (error) {
        if (!isMounted) return;
        console.warn('Provider catalog load failed.');
        setProviders([]);
        setCatalogSource('seed');
        setLastUpdated(null);
        setProviderPackStatus(undefined);
        setCatalogError('Provider list unavailable.');
        toast.show({ title: 'Failed to load providers', variant: 'error' });
      } finally {
        if (isMounted) {
          setIsCatalogLoading(false);
        }
      }
    };

    loadProviders();

    return () => {
      isMounted = false;
    };
  }, [toast]);

  useEffect(() => {
    let isMounted = true;

    const loadSavedSelection = async () => {
      try {
        if (!draftId || isResolvingDraftId) {
          setDraftData(null);
          return;
        }

        const draft = await draftStorage.getDraft(draftId);
        if (!isMounted || !draft) return;
        setDraftData(draft);

        if (typeof draft.includeBrief === 'boolean') {
          setIncludeBrief(draft.includeBrief);
        }
        if (draft.fallbackNumber) {
          setFallbackNumber(draft.fallbackNumber);
        }
        setPartnerForm(getPartnerSharingFormState(draft.partnerSharing));
        const savedProviderId = draft.referralSelection?.providerId ?? draft.selectedProvider;
        if (savedProviderId && providers.length > 0) {
          const savedProvider = providers.find(provider => provider.id === savedProviderId) ?? null;
          const savedChannel = draft.referralSelection?.selectedChannel ?? draft.selectedChannel ?? null;
          setSelectedProvider(savedProvider);
          setSelectedChannel(
            savedProvider &&
            savedChannel &&
            isProviderContactActionable(savedProvider) &&
            savedProvider.channels[savedChannel] &&
            !(isOffline && savedChannel === 'whatsapp')
              ? savedChannel
              : null,
          );
        }
      } catch (error) {
        console.warn('Failed to load saved referral selection:', error);
      }
    };

    loadSavedSelection();

    return () => {
      isMounted = false;
    };
  }, [draftId, isOffline, isResolvingDraftId, providers]);

  const styles = StyleSheet.create({
    container: {
      flex: 1,
      padding: spacing.md,
    },
    sectionCard: {
      marginBottom: spacing.md,
    },
    sectionCardContent: {
      gap: spacing.sm,
    },
    statusRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    statusText: {
      flex: 1,
      ...typography.caption,
      color: colors.mutedForeground,
    },
    searchContainer: {
      position: 'relative',
    },
    searchField: {
      marginBottom: 0,
    },
    clearIcon: {
      minHeight: 48,
      minWidth: 48,
      alignItems: 'center',
      justifyContent: 'center',
    },
    refreshRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    filtersWrap: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
    },
    filterChipSpacing: {
      marginRight: 0,
      marginBottom: 0,
    },
    providerList: {
      gap: spacing.md,
    },
    providerItem: {
      marginBottom: 0,
    },
    providerCardContent: {
      gap: spacing.sm,
      paddingTop: spacing.md,
    },
    providerHeader: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.sm,
      minHeight: 64,
    },
    providerIcon: {
      alignItems: 'center',
      backgroundColor: colors.supportMuted,
      borderColor: colors.support + '33',
      borderRadius: radii.card,
      borderWidth: borders.hairline,
      height: 44,
      justifyContent: 'center',
      width: 44,
    },
    providerHeaderText: {
      flex: 1,
      minWidth: 0,
    },
    providerName: {
      ...typography.titleSmall,
      color: colors.foreground,
      marginBottom: spacing.xxxs,
    },
    providerDescription: {
      ...typography.bodySmall,
      color: colors.mutedForeground,
    },
    providerMeta: {
      ...typography.caption,
      color: colors.mutedForeground,
      marginTop: spacing.xxxs,
    },
    providerSelectIcon: {
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: 32,
      minWidth: 32,
    },
    badgeRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
    },
    channelSection: {
      gap: spacing.xs,
      paddingTop: spacing.xs,
    },
    channelLabel: {
      ...typography.labelSmall,
      color: colors.foreground,
    },
    channelChips: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
    },
    channelChip: {
      marginRight: 0,
      marginBottom: 0,
    },
    providerActions: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    unavailableText: {
      color: colors.warning,
      ...typography.caption,
      flex: 1,
    },
    channelSummary: {
      ...typography.caption,
      color: colors.mutedForeground,
      flex: 1,
    },
    briefToggle: {
      paddingTop: spacing.sm,
      borderTopWidth: borders.hairline,
      borderTopColor: colors.border,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    briefToggleLabel: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      flex: 1,
    },
    briefLabelText: {
      ...typography.labelMedium,
      color: colors.foreground,
      flex: 1,
    },
    emptyStateContent: {
      alignItems: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.lg,
    },
    emptyStateIcon: {
      marginBottom: spacing.xs,
    },
    emptyStateTitle: {
      ...typography.titleSmall,
      color: colors.foreground,
      textAlign: 'center',
    },
    emptyStateText: {
      ...typography.bodySmall,
      color: colors.mutedForeground,
      textAlign: 'center',
    },
    noticeContent: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm,
      paddingTop: spacing.md,
    },
    consentPreviewText: {
      ...typography.bodySmall,
      color: colors.mutedForeground,
      flex: 1,
    },
    navigationButtons: {
      flexDirection: 'row',
      gap: spacing.sm,
      marginTop: spacing.lg,
      paddingBottom: spacing.xl,
    },
    backButton: {
      flex: 1,
    },
    continueButton: {
      flex: 2,
    },
    sheetScroll: {
      maxHeight: 430,
    },
    detailSection: {
      marginBottom: 16,
    },
    detailHeading: {
      fontSize: 13,
      color: colors.foreground,
      fontWeight: '700',
      marginBottom: 6,
    },
    detailText: {
      fontSize: 14,
      color: colors.mutedForeground,
      lineHeight: 20,
      marginBottom: 4,
    },
    detailLabel: {
      color: colors.foreground,
      fontWeight: '600',
    },
    sourceItem: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 6,
      marginBottom: 4,
    },
  });

  const displayedCatalogStatus = isCatalogLoading
    ? 'Loading listings.'
    : buildProviderCatalogStatus({
        isOnline,
        source: catalogSource,
        lastUpdated,
        providerCount: providers.length,
        providerPack: providerPackStatus,
      });

  const filteredProviders = useMemo(
    () => filterReferralProviders(providers, searchQuery, filters),
    [filters, providers, searchQuery],
  );

  const toggleFilter = (filterId: string) => {
    setFilters(prev => prev.map(filter => (
      filter.id === filterId ? { ...filter, active: !filter.active } : filter
    )));
  };

  const selectProvider = (provider: Provider) => {
    const changingProvider = selectedProvider?.id !== provider.id;
    setSelectedProvider(provider);
    if (changingProvider) {
      setSelectedChannel(null);
    }
    if (!isProviderContactActionable(provider)) {
      setIncludeBrief(false);
    }
    toast.show({ title: 'Provider selected', message: provider.name, variant: 'info' });
  };

  const getChannelIcon = (channel: ReferralContactChannel): keyof typeof Ionicons.glyphMap => {
    switch (channel) {
      case 'call': return 'call';
      case 'whatsapp': return 'logo-whatsapp';
      case 'sms': return 'chatbubble';
    }
  };

  const canUseChannel = (provider: Provider, channel: ReferralContactChannel) => {
    if (!isProviderContactActionable(provider)) return false;
    if (!provider.channels[channel]) return false;
    if (isOffline && channel === 'whatsapp') return false;
    return true;
  };

  const selectChannel = (provider: Provider, channel: ReferralContactChannel) => {
    if (!isProviderContactActionable(provider)) {
      toast.show({ title: 'Contact unavailable', message: 'This listing still needs accountable review.', variant: 'error' });
      return;
    }
    if (!provider.channels[channel]) {
      toast.show({ title: 'Channel unavailable', message: 'This provider does not list that contact method.', variant: 'error' });
      return;
    }
    if (isOffline && channel === 'whatsapp') {
      toast.show({ title: 'Network needed', message: 'WhatsApp needs internet. Choose call or SMS if listed.', variant: 'error' });
      return;
    }
    setSelectedProvider(provider);
    setSelectedChannel(channel);
    toast.show({ title: 'Channel selected', message: CHANNEL_LABELS[channel], variant: 'info' });
  };

  const handleRefresh = async () => {
    if (!isOnline) {
      toast.show({ title: 'Offline', message: 'Provider updates need a connection.', variant: 'info' });
      return;
    }

    try {
      setIsCatalogLoading(true);
      setCatalogError(null);
      const result = await refreshProviders();
      setProviders(result.items);
      setCatalogSource(result.source);
      setLastUpdated(result.lastUpdated);
      setProviderPackStatus(result.providerPack);
      if (result.updated) {
        toast.show({ title: 'Providers updated', variant: 'success' });
      } else {
        const message = catalogErrorMessage(result.error);
        setCatalogError(message);
        toast.show({ title: 'Update not activated', message, variant: 'info' });
      }
    } catch (error) {
      console.warn('Provider catalog refresh failed.');
      setCatalogError('The provider update is unavailable. Existing verified listings were kept.');
      toast.show({ title: 'Update failed', variant: 'error' });
    } finally {
      setIsCatalogLoading(false);
    }
  };

  const renderChannelChip = (channel: ReferralContactChannel, provider: Provider) => {
    const available = provider.channels[channel];
    const disabled = !canUseChannel(provider, channel);
    const isSelected = selectedProvider?.id === provider.id && selectedChannel === channel;
    const unavailableReason = !available
      ? 'not listed for this provider'
      : isOffline && channel === 'whatsapp'
        ? 'requires internet'
        : 'available';

    return (
      <Chip
        key={channel}
        label={CHANNEL_LABELS[channel].replace(' message', '')}
        leadingIcon={getChannelIcon(channel)}
        leadingIconSize={14}
        onPress={disabled ? undefined : () => selectChannel(provider, channel)}
        selected={isSelected}
        disabled={disabled}
        accessibilityLabel={CHANNEL_LABELS[channel] + ', ' + unavailableReason + ' for ' + provider.name}
        style={styles.channelChip}
      />
    );
  };

  const renderProviderCard = (provider: Provider) => {
    const isSelected = selectedProvider?.id === provider.id;
    const coverageLabel = getProviderCoverageLabel(provider);
    const availableChannels = getAvailableReferralChannels(provider);
    const cached = catalogSource === 'cache';
    const servicesLabel = provider.services.slice(0, 2).join(' / ') || provider.type;

    return (
      <Card
        key={provider.id}
        variant="outlined"
        selected={isSelected}
        style={styles.providerItem}
      >
        <CardContent style={styles.providerCardContent}>
          <TouchableOpacity
            activeOpacity={0.82}
            accessibilityRole="button"
            accessibilityState={{ selected: isSelected }}
            accessibilityLabel={`${provider.name}, ${provider.type}`}
            accessibilityHint="Selects this support provider and shows contact channel choices."
            onPress={() => selectProvider(provider)}
            style={styles.providerHeader}
          >
            <View style={styles.providerIcon}>
              <Ionicons
                name={isSelected ? 'checkmark-circle' : 'business-outline'}
                size={20}
                color={colors.support}
              />
            </View>
            <View style={styles.providerHeaderText}>
              <Text style={styles.providerName}>{provider.name}</Text>
              <Text style={styles.providerDescription}>{servicesLabel}</Text>
              {!isSelected && coverageLabel ? (
                <Text style={styles.providerMeta}>{coverageLabel}</Text>
              ) : null}
            </View>
            <View style={styles.providerSelectIcon}>
              <Ionicons
                name={isSelected ? 'checkmark-circle' : 'chevron-forward'}
                size={20}
                color={isSelected ? colors.support : colors.mutedForeground}
              />
            </View>
          </TouchableOpacity>
          <View style={styles.badgeRow}>
            <Badge variant="secondary" size="sm">{provider.type}</Badge>
            <Badge variant={provider.contactStatus === 'verified' ? 'success' : 'warning'} size="sm">
              {provider.contactStatus === 'verified'
                ? 'Contact verified'
                : provider.contactStatus === 'expired'
                  ? 'Expired'
                  : provider.contactStatus === 'revoked'
                    ? 'Revoked'
                    : 'Review pending'}
            </Badge>
            {catalogSource === 'cache' || catalogSource === 'rollback' ? (
              <Badge variant="warning" size="sm">{catalogSource === 'rollback' ? 'Previous verified' : 'Cached'}</Badge>
            ) : null}
          </View>

          {isSelected && availableChannels.length > 0 ? (
            <View style={styles.channelSection}>
              <Text style={styles.channelLabel}>Choose contact channel</Text>
              <View style={styles.channelChips}>
                {CHANNELS.map(channel => renderChannelChip(channel, provider))}
              </View>
            </View>
          ) : null}

          <View style={styles.providerActions}>
            {isSelected && availableChannels.length === 0 ? (
              <Text style={styles.unavailableText}>
                {provider.contactStatus === 'pending'
                  ? 'You can save this provider for review. Calls and messages stay disabled until the listing is verified.'
                  : 'You can save this provider, but no current verified contact action is available.'}
              </Text>
            ) : isSelected ? (
              <Text style={styles.channelSummary}>Phone may be visible.</Text>
            ) : <View style={{ flex: 1 }} />}
            <Button
              title="Details"
              variant="ghost"
              size="sm"
              icon={<Ionicons name="information-circle-outline" size={16} color={colors.primary} />}
              onPress={() => setShowProviderDetail(provider)}
            />
          </View>

          {isSelected && availableChannels.length > 0 && (
            <View style={styles.briefToggle}>
              <View style={styles.briefToggleLabel}>
                <Switch value={includeBrief} onValueChange={setIncludeBrief} />
                <Text style={styles.briefLabelText}>Include support brief</Text>
              </View>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="About support brief"
                onPress={() => Alert.alert(
                  'Support brief',
                  'Shares only the selected incident categories, date accuracy, general location type, and ongoing status when available. It never includes narrative, exact location, evidence, contact details, or the full provider record.'
                )}
              >
                <Ionicons name="information-circle" size={22} color={colors.mutedForeground} />
              </TouchableOpacity>
            </View>
          )}
        </CardContent>
      </Card>
    );
  };

  const renderFallbackContact = () => (
    <Card variant="outlined" style={styles.sectionCard}>
      <CardContent style={styles.emptyStateContent}>
        <Ionicons
          name={providers.length === 0 ? 'cloud-offline-outline' : 'search-outline'}
          size={44}
          color={colors.mutedForeground}
          style={styles.emptyStateIcon}
        />
        <Text style={styles.emptyStateTitle}>
          {providers.length === 0 ? 'Provider list unavailable' : 'No provider matches'}
        </Text>
        <Text style={styles.emptyStateText}>
          Save a fallback number for your notes.
        </Text>
        <Input
          placeholder="Save fallback contact number"
          value={fallbackNumber}
          onChangeText={setFallbackNumber}
          keyboardType="phone-pad"
          style={{ textAlign: 'center', marginTop: 8 }}
        />
      </CardContent>
    </Card>
  );

  const renderLoadingProviders = () => (
    <Card variant="outlined" style={styles.sectionCard}>
      <CardContent style={styles.emptyStateContent}>
        <Ionicons
          name="sync-outline"
          size={40}
          color={colors.mutedForeground}
          style={styles.emptyStateIcon}
        />
        <Text style={styles.emptyStateTitle}>Loading providers</Text>
        <Text style={styles.emptyStateText}>Checking saved listings.</Text>
      </CardContent>
    </Card>
  );

  // A referral can be shared with HURIA when it names HURIA itself. Without a
  // verified phone channel it goes to HURIA's secure dashboard after consent.
  const showPartnerOptIn = Boolean(
    partnerAvailability.routing &&
    selectedProvider?.id === HURIA_PARTNER_STABLE_ID,
  );

  const handleContinue = async () => {
    if (!draftId) {
      toast.show({
        title: 'Local draft unavailable',
        message: draftIdError ?? 'Return to Reports and open this draft again.',
        variant: 'warning',
      });
      return;
    }

    if (!selectedProvider) {
      toast.show({ title: 'Provider required', message: 'Please select a support provider.', variant: 'error' });
      return;
    }

    const providerOnlySelectionAllowed = canSaveProviderWithoutChannel(selectedProvider);
    if (!selectedChannel && !providerOnlySelectionAllowed) {
      toast.show({ title: 'Channel required', message: 'Please select how you want to contact them.', variant: 'error' });
      return;
    }

    if (selectedChannel && !canUseChannel(selectedProvider, selectedChannel)) {
      toast.show({ title: 'Channel unavailable', message: 'Choose a listed contact method before consent.', variant: 'error' });
      setSelectedChannel(null);
      return;
    }

    const partnerChoice = showPartnerOptIn
      ? buildPartnerSharingChoice(draftData?.partnerSharing, partnerForm, partnerAvailability)
      : null;
    if (partnerChoice && !partnerChoice.ok) {
      setPartnerPhoneError(PARTNER_SHARING_COPY.callback.invalidNumber);
      toast.show({ title: PARTNER_SHARING_COPY.callback.invalidNumber, variant: 'error' });
      return;
    }

    // Without a verified channel the only way a referral can be sent is to
    // HURIA's dashboard with sharing on; anything else would queue a send that
    // can never succeed.
    if (!selectedChannel && !(partnerChoice?.ok && partnerChoice.sharing.requested)) {
      toast.show({
        title: 'Turn on sharing with HURIA',
        message: selectedProvider.id === HURIA_PARTNER_STABLE_ID
          ? 'To send this report, turn on sharing with HURIA below.'
          : 'In this pilot, reports can be sent only to HURIA. Choose HURIA and turn on sharing.',
        variant: 'error',
      });
      return;
    }

    try {
      setIsSaving(true);
      const update = buildReferralDraftUpdate({
        draftId,
        provider: selectedProvider,
        selectedChannel,
        includeBrief,
        catalogSource,
        catalogLastUpdated: lastUpdated,
      });
      const trimmedFallback = fallbackNumber.trim();
      if (trimmedFallback) {
        update.fallbackNumber = trimmedFallback;
      }
      if (partnerChoice?.ok) {
        update.partnerSharing = partnerChoice.sharing;
      } else if (selectedProvider.id !== HURIA_PARTNER_STABLE_ID && draftData?.partnerSharing) {
        // The HURIA choice belongs to a referral to HURIA; another provider never receives it.
        update.partnerSharing = undefined;
      }
      await draftStorage.saveDraft(update);
      setDraftData(await draftStorage.getDraft(draftId));

      toast.show({
        title: 'Provider selected',
        message: selectedChannel
          ? selectedProvider.name + ' via ' + CHANNEL_LABELS[selectedChannel]
          : selectedProvider.name + ' saved for review; no contact action was enabled.',
        variant: 'success',
      });
      captureMeasurementEvent({
        name: 'referral_select',
        screenId: 'referral-picker',
        taskId: 'referral-selection',
        outcome: 'completed',
      });
      navigation.navigate('ConsentGate', {
        draftId,
        ...(isEditingCompleted ? { editCompleted: true } : {}),
      });
    } catch (error) {
      console.warn('Referral selection save failed:', error);
      toast.show({ title: 'Save failed', message: 'Please try again.', variant: 'error' });
    } finally {
      setIsSaving(false);
    }
  };

  const openSelectedContact = async () => {
    if (!selectedProvider || !selectedChannel || !canUseChannel(selectedProvider, selectedChannel)) {
      toast.show({ title: 'Contact unavailable', message: 'Choose a current verified contact method.', variant: 'warning' });
      return;
    }
    const url = buildReferralContactUrl(selectedChannel, selectedProvider.phone);
    if (!url) {
      toast.show({ title: 'Contact unavailable', message: 'This listing does not have a usable number for that channel.', variant: 'warning' });
      return;
    }
    try {
      if (!(await Linking.canOpenURL(url))) {
        throw new Error('Selected contact app is unavailable');
      }
      await Linking.openURL(url);
      captureMeasurementEvent({
        name: 'contact_action',
        screenId: 'referral-picker',
        taskId: 'provider-contact',
        outcome: 'completed',
      });
    } catch {
      toast.show({ title: 'Could not open contact app', message: 'Try another listed channel or contact the provider manually.', variant: 'error' });
    }
  };

  const confirmSelectedContact = () => {
    if (!selectedProvider || !selectedChannel) return;
    Alert.alert(
      `Open ${CHANNEL_LABELS[selectedChannel]}?`,
      'SafeRide will open another app using only the provider number. No report details or evidence are added.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Open', onPress: () => void openSelectedContact() },
      ],
    );
  };

  const handleSaveFallback = async () => {
    if (!draftId) {
      toast.show({
        title: 'Local draft unavailable',
        message: draftIdError ?? 'Return to Reports and open this draft again.',
        variant: 'warning',
      });
      return;
    }

    const trimmedNumber = fallbackNumber.trim();
    if (!trimmedNumber) {
      toast.show({ title: 'Number required', message: 'Please enter a hotline or support number.', variant: 'error' });
      return;
    }

    const phoneRegex = /^[\+]?[0-9\-\s\(\)]{3,}$/;
    if (!phoneRegex.test(trimmedNumber)) {
      toast.show({ title: 'Invalid number', message: 'Please enter a valid contact number.', variant: 'error' });
      return;
    }

    try {
      setIsSaving(true);
      await draftStorage.saveDraft({
        id: draftId,
        selectedPathway: 'referral',
        fallbackNumber: trimmedNumber,
        includeBrief,
        completedSteps: REPORT_STEPS_BEFORE_CONSENT,
        currentStep: 'ReferralPicker',
        updatedAt: new Date(),
      });

      setDraftData(await draftStorage.getDraft(draftId));
      toast.show({ title: 'Number saved', message: 'Choose a provider when the catalog is available before consent.', variant: 'success' });
    } catch (error) {
      console.warn('Fallback contact save failed:', error);
      toast.show({ title: 'Save failed', message: 'Please try again.', variant: 'error' });
    } finally {
      setIsSaving(false);
    }
  };

  const renderDetailRow = (label: string, value?: string | string[] | null) => {
    if (!value || (Array.isArray(value) && value.length === 0)) return null;
    const resolvedValue = Array.isArray(value) ? value.join(', ') : value;
    return (
      <Text style={styles.detailText}>
        <Text style={styles.detailLabel}>{label}: </Text>{resolvedValue}
      </Text>
    );
  };

  const renderProviderDetailSheet = () => {
    const provider = showProviderDetail;

    return (
      <Sheet open={Boolean(provider)} onOpenChange={(open) => { if (!open) setShowProviderDetail(null); }}>
        <SheetContent snapPoints={[0.9]} initialSnapPoint={0}>
          {provider ? (
            <>
              <SheetHeader>
                <SheetTitle>{provider.name}</SheetTitle>
                <SheetDescription>{getProviderReviewLabel(provider)}</SheetDescription>
              </SheetHeader>

              <ScrollView style={styles.sheetScroll} showsVerticalScrollIndicator={false}>
                <View style={styles.detailSection}>
                  <Text style={styles.detailHeading}>Service scope</Text>
                  {renderDetailRow('Services', provider.services)}
                  {renderDetailRow('Languages', provider.languages)}
                  {renderDetailRow('Safety phrase', provider.safetyPhrase)}
                </View>

                <View style={styles.detailSection}>
                  <Text style={styles.detailHeading}>Coverage and availability</Text>
                  {renderDetailRow('Location or coverage', getProviderCoverageLabel(provider))}
                  {renderDetailRow('Hours', getProviderAvailabilityLabel(provider))}
                  {renderDetailRow('Eligibility', provider.eligibility)}
                  {renderDetailRow('Phone', provider.phone)}
                  {!provider.phone ? <Text style={styles.detailText}>No verified phone action is available from this listing.</Text> : null}
                </View>

                <View style={styles.detailSection}>
                  <Text style={styles.detailHeading}>Privacy and catalog notes</Text>
                  <Text style={styles.detailText}>Provider may see your phone number if you call or message. Ask the provider what confidentiality rules apply before sharing details.</Text>
                  {renderDetailRow('Review status', provider.metadata?.reviewStatus)}
                  {renderDetailRow('Catalog note', provider.metadata?.notes)}
                  {renderDetailRow('Pack version', provider.packVersion)}
                  {renderDetailRow('Listing expires', provider.expiresAt ? formatCatalogTimestamp(provider.expiresAt) : undefined)}
                  <Text style={styles.detailText}>
                    <Text style={styles.detailLabel}>Catalog source: </Text>
                    {catalogSource === 'cache' ? 'Saved listing' : catalogSource === 'rollback' ? 'Previous verified listing' : catalogSource === 'remote' ? 'Updated catalog' : 'Bundled listing'}
                    {lastUpdated ? ' • ' + formatCatalogTimestamp(lastUpdated) : ''}
                  </Text>
                </View>

                {provider.metadata?.sources?.length ? (
                  <View style={styles.detailSection}>
                    <Text style={styles.detailHeading}>Sources</Text>
                    {provider.metadata.sources.map(source => (
                      <View key={source.title} style={styles.sourceItem}>
                        <Ionicons name="link-outline" size={14} color={colors.mutedForeground} style={{ marginTop: 2 }} />
                        <Text style={styles.detailText}>{source.title}</Text>
                      </View>
                    ))}
                  </View>
                ) : null}
              </ScrollView>

              <SheetFooter>
                {provider.phone && provider.contactStatus === 'verified' ? (
                  <Button
                    title="Call"
                    variant="outline"
                    size="sm"
                    icon={<Ionicons name="call" size={16} color={colors.foreground} />}
                    onPress={() => {
                      captureMeasurementEvent({
                        name: 'contact_action',
                        screenId: 'referral-picker',
                        taskId: 'provider-contact',
                        outcome: 'started',
                      });
                      void Linking.openURL('tel:' + provider.phone?.replace(/\s/g, ''));
                    }}
                  />
                ) : null}
                <Button
                  title={selectedProvider?.id === provider.id ? 'Selected' : 'Select'}
                  size="sm"
                  onPress={() => {
                    selectProvider(provider);
                    setShowProviderDetail(null);
                  }}
                />
              </SheetFooter>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    );
  };

  const hasProviderListings = providers.length > 0;
  const canContinue = Boolean(
    selectedProvider && (
      canSaveProviderWithoutChannel(selectedProvider) ||
      (selectedChannel && canUseChannel(selectedProvider, selectedChannel))
    ),
  );
  const providerListEmpty = !hasProviderListings || filteredProviders.length === 0;
  const showFallbackSave = !isCatalogLoading && providerListEmpty && !canContinue && fallbackNumber.trim().length > 0;

  return (
    <Screen>
      <ScrollView style={styles.container} showsVerticalScrollIndicator={false}>
        <ReportWizardProgress
          draft={draftData}
          currentStep="ReferralPicker"
          isSaving={isSaving}
          lastSaved={draftData?.updatedAt}
          error={draftIdError}
        />

        <FeatureHeader
          eyebrow="Referral"
          title="Get help"
          description=""
          icon="headset-outline"
          tone="support"
          stats={heroStats}
          style={styles.sectionCard}
        />

        {isContactReady && selectedProvider ? (
          <AlertComponent variant="info" style={{ marginBottom: 16 }}>
            <View style={{ gap: 10 }}>
              <Text style={{ color: colors.foreground }}>
                {selectedChannel
                  ? 'Your choice is saved. Opening the contact app does not send your report, evidence, or a provider receipt.'
                  : 'Your provider choice is saved. Contact actions remain unavailable until this listing completes review.'}
              </Text>
              {selectedChannel ? (
                <Button
                  title={`Open ${CHANNEL_LABELS[selectedChannel]}`}
                  onPress={confirmSelectedContact}
                  disabled={!canUseChannel(selectedProvider, selectedChannel)}
                />
              ) : null}
            </View>
          </AlertComponent>
        ) : null}

        {isOffline && !dismissedOfflineNotice ? (
          <AlertComponent
            variant="warning"
            dismissible
            onDismiss={() => setDismissedOfflineNotice(true)}
            icon={<Ionicons name="cloud-offline-outline" size={20} color={colors.warning} />}
            style={{ marginBottom: 16 }}
          >
            <Text style={{ color: colors.foreground }}>{displayedCatalogStatus}</Text>
          </AlertComponent>
        ) : null}

        {catalogError ? (
          <AlertComponent
            variant="info"
            dismissible
            onDismiss={() => setCatalogError(null)}
            style={{ marginBottom: 16 }}
          >
            <Text style={{ color: colors.foreground }}>{catalogError}</Text>
          </AlertComponent>
        ) : null}

        <Card variant="outlined" style={styles.sectionCard}>
          <CardHeader>
            <CardTitle>Find a provider</CardTitle>
          </CardHeader>
          <CardContent style={styles.sectionCardContent}>
            <View style={styles.statusRow}>
              <Text style={styles.statusText}>{displayedCatalogStatus}</Text>
              <Badge
                variant={providerPackStatus?.trust === 'approved' && providerPackStatus.freshness !== 'expired' ? 'success' : 'warning'}
                size="sm"
              >
                {providerPackStatus?.freshness === 'expired'
                  ? 'Expired'
                  : providerPackStatus?.trust === 'approved'
                    ? catalogSource === 'rollback' ? 'Previous verified' : 'Verified pack'
                    : 'Review pending'}
              </Badge>
            </View>

            <View style={styles.searchContainer}>
              <Input
                placeholder="Search provider, service, county, or language"
                value={searchQuery}
                onChangeText={setSearchQuery}
                containerStyle={styles.searchField}
                startAdornment={<Ionicons accessible={false} name="search" size={18} color={colors.mutedForeground} />}
                endAdornment={searchQuery ? (
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel="Clear provider search"
                    onPress={() => setSearchQuery('')}
                    style={styles.clearIcon}
                  >
                    <Ionicons name="close" size={20} color={colors.mutedForeground} />
                  </TouchableOpacity>
                ) : undefined}
              />
            </View>

            <View style={styles.refreshRow}>
            <Button
              variant="outline"
              size="sm"
              onPress={handleRefresh}
              title={isCatalogLoading ? 'Loading' : 'Refresh'}
              loading={isCatalogLoading}
              disabled={!isOnline || isCatalogLoading}
            />
            </View>
            <View style={styles.filtersWrap}>
              {filters.map(filter => (
                <Chip
                  key={filter.id}
                  label={filter.label}
                  selected={filter.active}
                  onPress={() => toggleFilter(filter.id)}
                  style={styles.filterChipSpacing}
                />
              ))}
            </View>
          </CardContent>
        </Card>

        {isCatalogLoading ? (
          renderLoadingProviders()
        ) : providerListEmpty ? (
          renderFallbackContact()
        ) : (
          <View style={styles.providerList}>{filteredProviders.map(renderProviderCard)}</View>
        )}

        {showPartnerOptIn ? (
          <PartnerSharingOptIn
            pathway="referral"
            value={partnerForm}
            onChange={next => {
              setPartnerForm(next);
              setPartnerPhoneError(null);
            }}
            callbackAvailable={partnerAvailability.callback}
            phoneError={partnerPhoneError}
            style={styles.sectionCard}
          />
        ) : null}

        <Card variant="filled" hideAccent style={styles.sectionCard}>
          <CardContent style={styles.noticeContent}>
          <Ionicons name="shield-checkmark-outline" size={18} color={colors.support} />
          <Text style={styles.consentPreviewText}>
            Consent review comes next.
          </Text>
          </CardContent>
        </Card>

        <View style={styles.navigationButtons}>
          <Button
            title="Back"
            variant="outline"
            onPress={goBackToPathway}
            style={styles.backButton}
          />
          <Button
            title={showFallbackSave ? 'Save number' : 'Continue to review'}
            onPress={showFallbackSave ? handleSaveFallback : handleContinue}
            disabled={showFallbackSave
              ? isSaving || isResolvingDraftId || !draftId
              : isSaving || isCatalogLoading || !canContinue || isResolvingDraftId || !draftId}
            loading={isSaving || isResolvingDraftId}
            style={styles.continueButton}
          />
        </View>
      </ScrollView>
      {renderProviderDetailSheet()}
    </Screen>
  );
}
