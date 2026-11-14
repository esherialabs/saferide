import React from 'react';
import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert, RefreshControl, ActivityIndicator, Platform, AppState } from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import Screen from '../components/ui/Screen';
import Button from '../components/ui/Button';
import { Card, CardContent } from '../components/ui/Card';
import { SafetyIllustration } from '../components/ui/SafetyIllustration';
import { FeatureHeader } from '../components/ui/FeatureHeader';
import { Input } from '../components/ui/Input';
import { useTheme } from '../theme/SimpleThemeProvider';
import { RootStackParamList } from '../navigation/routes';
import { useToast } from '../components/ui/Toast';
import { fetchDrafts, deleteDraft as removeDraft } from '../services/draftService';
import { useOnline } from '../context/OnlineProvider';
import { confirmCenter } from '../utils/confirmCenter';
import { fetchCases } from '../services/caseService';
import { draftStorage, type DraftData } from '../utils/draftStorage';
import { getReportWizardResumeTarget } from '../navigation/reportPathwayFlow';
import { resetReportStackToRoute } from '../navigation/reportNavigation';
import type { CaseRecord } from '../services/caseService';
import { borders, elevation, spacing, radii, typography } from '../theme/tokens';
import { offlineSyncManager, type SyncQueueItem } from '../utils/offlineSync';
import {
  buildCaseCollection,
  type CaseListModel,
  type CaseSection,
  type CaseTone,
} from '../utils/casePresentation';

import { devPrivacyWarn, getPrivacySafeErrorReason, getPrivacySafeHttpStatus } from '../utils/privacyLog';
import { startForegroundCaseRefresh } from '../utils/foregroundCaseRefresh';

type CaseTrackerNavigationProp = NativeStackNavigationProp<RootStackParamList>;

type SortKey = 'recent' | 'status' | 'pathway';
const CASE_NOTICE_DURATION_MS = 5000;

export default function CaseTrackerScreen() {
  const navigation = useNavigation<CaseTrackerNavigationProp>();
  const { colors } = useTheme();
  const toast = useToast();
  const [activeTab, setActiveTab] = useState<CaseSection>('drafts');
  const [searchQuery, setSearchQuery] = useState('');
  const { isOnline, queueSize, syncNow, syncStatus, syncMessage } = useOnline();
  const isOffline = !isOnline;
  const [refreshing, setRefreshing] = useState(false);
  const [sortBy, setSortBy] = useState<SortKey>('recent');
  const [storedDrafts, setStoredDrafts] = useState<DraftData[]>([]);
  const [remoteCases, setRemoteCases] = useState<CaseRecord[]>([]);
  const [queueItems, setQueueItems] = useState<SyncQueueItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [remoteFetchError, setRemoteFetchError] = useState<string | null>(null);
  const [draftFetchError, setDraftFetchError] = useState<string | null>(null);
  const lastNoticeKeyRef = useRef<string | null>(null);

  const isRefreshingRef = useRef(false);

  const refreshData = useCallback(
    async (options?: { forceRemote?: boolean }) => {
      isRefreshingRef.current = true;
      if (!options?.forceRemote) {
        setIsLoading(true);
      }

      setQueueItems(offlineSyncManager.getSyncQueueItems());

      try {
        const drafts = await fetchDrafts({ forceRemote: options?.forceRemote });
        setStoredDrafts(drafts);
        setDraftFetchError(null);
      } catch (error) {
        devPrivacyWarn('case tracker draft refresh failed', {
          reason: getPrivacySafeErrorReason(error),
          status: getPrivacySafeHttpStatus(error),
        });
        setDraftFetchError('Local drafts could not be refreshed. Try again before editing a draft.');
        try {
          const localDrafts = await draftStorage.getAllDrafts();
          setStoredDrafts(localDrafts);
        } catch {
          setStoredDrafts([]);
        }
      }

      try {
        const cases = await fetchCases();
        setRemoteCases(cases);
        setRemoteFetchError(null);
      } catch (error) {
        devPrivacyWarn('case tracker remote case refresh failed', {
          reason: getPrivacySafeErrorReason(error),
          status: getPrivacySafeHttpStatus(error),
        });
        setRemoteFetchError('Online cases could not be refreshed. Local drafts and saved records are still shown.');
      } finally {
        setQueueItems(offlineSyncManager.getSyncQueueItems());
        setIsLoading(false);
        isRefreshingRef.current = false;
      }
    },
    [],
  );

  useFocusEffect(
    useCallback(() => {
      refreshData();
    }, [refreshData]),
  );

  useFocusEffect(useCallback(() => {
    if (!isOnline) return;
    const polling = startForegroundCaseRefresh({
      active: () => AppState.currentState === 'active' && !isRefreshingRef.current,
      fetch: fetchCases,
      apply: cases => { setRemoteCases(cases); setRemoteFetchError(null); },
      unavailable: () => setRemoteFetchError('Online case statuses may be out of date. Reconnect or refresh to check the latest updates.'),
    });
    const listener = AppState.addEventListener('change', state => { if (state === 'active') void polling.refresh(); });
    return () => { listener.remove(); polling.stop(); };
  }, [isOnline]));

  // Reload local drafts when any writer commits a change while this screen is
  // mounted. The ref guard prevents our own refresh (which may replace the
  // stored drafts after a remote fetch) from re-triggering itself.
  useEffect(() => draftStorage.subscribe(() => {
    if (isRefreshingRef.current) return;
    refreshData();
  }), [refreshData]);

  const caseCollection = useMemo(
    () => buildCaseCollection(storedDrafts, remoteCases, queueItems, syncStatus),
    [storedDrafts, remoteCases, queueItems, syncStatus],
  );

  const filterList = useCallback(
    (items: CaseListModel[]) => {
      let working = items;
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        working = working.filter(caseItem =>
          caseItem.title.toLowerCase().includes(query) ||
          caseItem.location.toLowerCase().includes(query) ||
          caseItem.tags.some(tag => tag.toLowerCase().includes(query)) ||
          caseItem.caseId?.toLowerCase().includes(query) ||
          caseItem.pathway.toLowerCase().includes(query) ||
          caseItem.presentation.label.toLowerCase().includes(query),
        );
      }

      const list = [...working];
      switch (sortBy) {
        case 'status':
          return list.sort((a, b) => a.presentation.label.localeCompare(b.presentation.label));
        case 'pathway':
          return list.sort((a, b) => a.pathway.localeCompare(b.pathway));
        default:
          return list.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      }
    },
    [searchQuery, sortBy],
  );

  const drafts = useMemo(() => filterList(caseCollection.drafts), [caseCollection.drafts, filterList]);
  const activeCases = useMemo(() => filterList(caseCollection.active), [caseCollection.active, filterList]);
  const closed = useMemo(() => filterList(caseCollection.closed), [caseCollection.closed, filterList]);
  const queueNoticeMessage = syncMessage ?? `${queueSize} optional online sync item(s) saved on this device.`;
  const syncErrorNoticeMessage = syncMessage ?? 'Optional online sync needs attention. Local records remain on this device.';
  const showQueueNotice = queueSize > 0 && syncStatus !== 'error' && !syncMessage;

  useEffect(() => {
    const notice =
      syncStatus === 'error'
        ? {
            key: `sync-error:${syncErrorNoticeMessage}`,
            title: 'Sync needs attention',
            message: syncErrorNoticeMessage,
            variant: 'error' as const,
          }
        : draftFetchError
          ? {
              key: `draft:${draftFetchError}`,
              title: 'Draft refresh failed',
              message: draftFetchError,
              variant: 'error' as const,
            }
          : remoteFetchError
            ? {
                key: `remote:${remoteFetchError}`,
                title: 'Cases shown from this device',
                message: remoteFetchError,
                variant: 'warning' as const,
              }
            : showQueueNotice
              ? {
                  key: `queue:${queueNoticeMessage}`,
                  title: 'Queued locally',
                  message: queueNoticeMessage,
                  variant: 'info' as const,
                }
              : isOffline
                ? {
                    key: 'offline',
                    title: 'Offline mode',
                    message: 'Drafts and saved local cases remain visible on this device.',
                    variant: 'warning' as const,
                  }
                : null;

    if (!notice || lastNoticeKeyRef.current === notice.key) {
      return;
    }

    lastNoticeKeyRef.current = notice.key;
    toast.show({
      title: notice.title,
      message: notice.message,
      variant: notice.variant,
      duration: CASE_NOTICE_DURATION_MS,
    });
  }, [
    draftFetchError,
    isOffline,
    queueNoticeMessage,
    remoteFetchError,
    showQueueNotice,
    syncErrorNoticeMessage,
    syncStatus,
    toast,
  ]);

  const totalResults = drafts.length + activeCases.length + closed.length;
  const getToneColor = useCallback(
    (tone: CaseTone) => {
      switch (tone) {
        case 'success': return colors.success;
        case 'warning': return colors.warning;
        case 'destructive': return colors.destructive;
        case 'info': return colors.primary;
        case 'muted':
        default: return colors.mutedForeground;
      }
    },
    [colors],
  );

  const showExportUnavailable = useCallback(() => {
    toast.show({
      title: 'Export unavailable',
      message: 'Protected case export is not available in this build. You can still review case details in the app.',
      variant: 'info',
    });
  }, [toast]);

  const canAddInfoToCase = (caseItem: CaseListModel) =>
    caseItem.source === 'remote_case' &&
    typeof caseItem.caseId === 'string' &&
    caseItem.caseId.trim().length > 0 &&
    ['submitted', 'provider_pending', 'escalated', 'needs_attention'].includes(caseItem.presentation.state);

  const handleAddInfo = (caseItem: CaseListModel) => {
    if (!canAddInfoToCase(caseItem) || !caseItem.caseId) {
      Alert.alert(
        'Add info unavailable',
        'Additional information can only be saved after a synced case ID exists.',
      );
      return;
    }

    navigation.navigate('CaseDetail', { caseId: caseItem.caseId, openAddInfo: true });
  };

  const isLocalCaseItem = (caseItem: CaseListModel) =>
    caseItem.source !== 'remote_case' && Boolean(caseItem.draftId);

  const handleEditCase = (caseItem: CaseListModel) => {
    if (!isLocalCaseItem(caseItem) || !caseItem.draftId) {
      toast.show({
        title: 'Edit unavailable',
        message: 'Only local records can be edited on this device.',
        variant: 'info',
      });
      return;
    }

    resetReportStackToRoute(navigation, 'WhatHappened', {
      draftId: caseItem.draftId,
      editCompleted: true,
    });
  };

  const handleCloseCase = async (caseItem: CaseListModel) => {
    if (!isLocalCaseItem(caseItem) || !caseItem.draftId) {
      toast.show({
        title: 'Close unavailable',
        message: 'Only local records can be closed on this device.',
        variant: 'info',
      });
      return;
    }

    const actionId = await confirmCenter.request({
      title: 'Close local case?',
      message: 'Move this local record to Closed? It stays saved on this device.',
      actions: [
        { id: 'cancel', label: 'Cancel', role: 'cancel' },
        { id: 'close', label: 'Close case' },
      ],
    });

    if (actionId !== 'close') {
      return;
    }

    try {
      const existingDraft = storedDrafts.find(draft => draft.id === caseItem.draftId)
        ?? await draftStorage.getDraft(caseItem.draftId);

      // Patch only the status; spreading a possibly stale list snapshot here
      // previously overwrote fields other screens saved meanwhile.
      await draftStorage.saveDraft({
        id: caseItem.draftId,
        status: 'closed',
        currentStep: existingDraft?.currentStep ?? 'completed',
      });
      try {
        await offlineSyncManager.removeQueueItemsForDraft(caseItem.draftId);
      } catch (queueError) {
        devPrivacyWarn('local case close queue cleanup failed', {
          reason: getPrivacySafeErrorReason(queueError),
        });
      }
      await refreshData();
      toast.show({
        title: 'Case closed',
        message: 'The local record moved to Closed.',
        variant: 'success',
      });
    } catch (error) {
      devPrivacyWarn('local case close failed', { reason: getPrivacySafeErrorReason(error) });
      toast.show({ title: 'Close failed', message: 'Please try again.', variant: 'error' });
    }
  };

  const startNewDraft = useCallback(async () => {
    resetReportStackToRoute(navigation, 'WhatHappened', undefined);
  }, [navigation]);

  const navigateToDraftResume = useCallback((draftId: string) => {
    const draft = storedDrafts.find(item => item.id === draftId);
    if (!draft) {
      resetReportStackToRoute(navigation, 'WhatHappened', { draftId });
      return;
    }

    const target = getReportWizardResumeTarget(draft);
    if (target.route === 'DraftOverview') {
      navigation.navigate('Cases');
      return;
    }
    resetReportStackToRoute(navigation, target.route, target.params as any);
  }, [navigation, storedDrafts]);

  const handleContinue = (caseItem: CaseListModel) => {
    if (!caseItem.draftId) return;
    navigateToDraftResume(caseItem.draftId);
  };

  const handleView = (caseItem: CaseListModel) => {
    if (caseItem.presentation.state === 'draft' && caseItem.draftId) {
      navigateToDraftResume(caseItem.draftId);
      return;
    }

    navigation.navigate('CaseDetail', { caseId: caseItem.detailId });
  };

  const handleSync = async () => {
    setRefreshing(true);

    try {
      await syncNow();
      await refreshData({ forceRemote: true });
      toast.show({ title: 'Sync checked', message: 'Queued items were processed where possible.', variant: 'success' });
    } catch (error) {
      toast.show({ title: 'Sync failed', message: 'Please try again.', variant: 'error' });
    } finally {
      setQueueItems(offlineSyncManager.getSyncQueueItems());
      setRefreshing(false);
    }
  };

  const handleDeleteAllDrafts = async () => {
    const draftCount = drafts.length;
    if (draftCount === 0) {
      toast.show({ title: 'No drafts', message: 'There are no editable drafts to delete.', variant: 'info' });
      return;
    }

    const actionId = await confirmCenter.request({
      title: 'Delete all drafts',
      message: `Delete ${draftCount} editable draft(s) from this device? Submitted and queued cases are not removed.`,
      actions: [
        { id: 'cancel', label: 'Cancel', role: 'cancel' },
        { id: 'delete', label: 'Delete drafts', role: 'destructive' },
      ],
    });

    if (actionId === 'delete') {
      try {
        await Promise.all(drafts.map(d => d.draftId ? removeDraft(d.draftId) : Promise.resolve()));
        await refreshData();
        toast.show({ title: 'Drafts deleted', message: `${draftCount} draft(s) removed.`, variant: 'warning' });
      } catch (error) {
        toast.show({ title: 'Delete failed', message: 'Could not remove drafts.', variant: 'error' });
      }
    }
  };

  const handleDelete = async (caseItem: CaseListModel) => {
    if (!isLocalCaseItem(caseItem) || !caseItem.draftId) {
      toast.show({
        title: 'Delete unavailable',
        message: 'Only local records can be deleted on this device. Open a synced case to request deletion review.',
        variant: 'info',
      });
      return;
    }

    const actionId = await confirmCenter.request({
      title: caseItem.presentation.state === 'draft' ? 'Delete draft?' : 'Delete local case?',
      message: 'This removes the local record and evidence references from this device.',
      actions: [
        { id: 'cancel', label: 'Cancel', role: 'cancel' },
        { id: 'delete', label: 'Delete', role: 'destructive' },
      ],
    });

    if (actionId !== 'delete') {
      return;
    }

    try {
      await removeDraft(caseItem.draftId);
      await refreshData();
      toast.show({
        title: caseItem.presentation.state === 'draft' ? 'Draft deleted' : 'Local case deleted',
        message: 'The local record was removed from this device.',
        variant: 'warning',
      });
    } catch (e) {
      toast.show({ title: 'Delete failed', message: 'Could not remove the local record.', variant: 'error' });
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await refreshData({ forceRemote: true });
    } finally {
      setQueueItems(offlineSyncManager.getSyncQueueItems());
      setRefreshing(false);
    }
  };

  const renderCaseCard = (caseItem: CaseListModel) => {
    const statusColor = getToneColor(caseItem.presentation.tone);
    const isDraft = caseItem.presentation.state === 'draft';
    const isActive = caseItem.presentation.section === 'active';
    const isClosed = caseItem.presentation.section === 'closed';
    const isLocalCase = isLocalCaseItem(caseItem);
    const canEditCase = isLocalCase && !isClosed;
    const canCloseCase = isLocalCase && !isClosed;
    const canDeleteCase = isLocalCase;
    const draftProgress = isDraft ? caseItem.reportProgress : undefined;
    const sectionIcon: keyof typeof Ionicons.glyphMap = isDraft
      ? 'create-outline'
      : isClosed
        ? 'archive-outline'
        : caseItem.presentation.state === 'failed_sync' || caseItem.presentation.state === 'needs_attention'
          ? 'alert-circle-outline'
          : 'shield-checkmark-outline';
    const metaItems = [
      `Updated ${caseItem.lastUpdate}`,
      caseItem.location,
      caseItem.mediaCount > 0 ? `${caseItem.mediaCount} evidence` : null,
    ].filter(Boolean) as string[];

    return (
      <Card
        key={caseItem.id}
        variant="elevated"
        style={[styles.caseCard, { shadowColor: statusColor }]}
        accentColor={statusColor}
        surfaceStyle={{ borderColor: statusColor + '30' }}
      >
        <CardContent style={styles.caseCardContent}>
          <View style={styles.caseHeaderRow}>
            <View style={[styles.caseIcon, { backgroundColor: statusColor + '16', borderColor: statusColor + '35' }]}>
              <Ionicons name={sectionIcon} size={20} color={statusColor} />
            </View>
            <View style={styles.caseTitleGroup}>
              <Text style={styles.caseTitle} numberOfLines={2}>
                {caseItem.title}
              </Text>
              <Text style={styles.caseDescription} numberOfLines={2}>
                {caseItem.presentation.description}
              </Text>
            </View>
            <View style={[styles.caseStatusPill, {
              backgroundColor: statusColor + '20',
              borderColor: statusColor + '40',
            }]}>
              <Text style={[styles.caseStatusText, { color: statusColor }]}>
                {caseItem.presentation.shortLabel}
              </Text>
            </View>
          </View>

          <View style={styles.caseMetaRow}>
            {metaItems.map((item, index) => (
              <View key={`${item}-${index}`} style={styles.caseMetaChip}>
                <Text style={styles.caseMetaText} numberOfLines={1}>{item}</Text>
              </View>
            ))}
          </View>

          {caseItem.tags.length > 0 && (
            <View style={styles.caseTagRow}>
              {caseItem.tags.slice(0, 3).map((tag, index) => (
                <View key={`${tag}-${index}`} style={styles.caseTag}>
                  <Text style={styles.caseTagText} numberOfLines={1}>
                    {tag.replace(/_/g, ' ')}
                  </Text>
                </View>
              ))}
            </View>
          )}

          {draftProgress ? (
            <View style={[styles.draftProgressPanel, { borderLeftColor: statusColor }]}>
              <View style={styles.draftProgressHeader}>
                <View style={styles.draftProgressTitleRow}>
                  <Ionicons name="list-circle-outline" size={16} color={statusColor} />
                  <Text style={styles.draftProgressTitle}>Report progress</Text>
                </View>
                <Text style={[styles.draftProgressCount, { color: statusColor }]}>
                  {draftProgress.completedSteps}/{draftProgress.totalSteps}
                </Text>
              </View>
              <View style={styles.draftProgressTrack}>
                <View
                  style={[
                    styles.draftProgressFill,
                    { width: `${draftProgress.percentage}%`, backgroundColor: statusColor },
                  ]}
                />
              </View>
              <View style={styles.draftProgressSteps}>
                {draftProgress.steps.map((step, index) => {
                  const isCurrentStep = step.status === 'current';
                  const isDone = step.status === 'complete' || step.status === 'skipped';
                  const stepTone = isCurrentStep || isDone ? statusColor : colors.mutedForeground;
                  const label = step.status === 'skipped'
                    ? 'Skipped'
                    : isDone
                      ? 'Done'
                      : isCurrentStep
                        ? 'Now'
                        : 'Next';

                  return (
                    <View
                      key={step.id}
                      style={[
                        styles.draftProgressStep,
                        isCurrentStep ? { borderColor: statusColor + '55', backgroundColor: statusColor + '10' } : null,
                      ]}
                    >
                      <Text style={[styles.draftProgressStepLabel, { color: stepTone }]} numberOfLines={1}>
                        Step {index + 1}
                      </Text>
                      <Text style={styles.draftProgressStepStatus} numberOfLines={1}>
                        {label}
                      </Text>
                    </View>
                  );
                })}
              </View>
              <Text style={styles.draftProgressCaption} numberOfLines={2}>
                {draftProgress.isComplete
                  ? 'Report steps are complete.'
                  : `Current: ${draftProgress.currentStepLabel ?? draftProgress.nextStepLabel ?? 'Continue report'}`}
              </Text>
            </View>
          ) : null}

          <View style={[styles.nextActionStrip, { backgroundColor: statusColor + '12', borderColor: statusColor + '28' }]}>
            <Ionicons name="arrow-forward-circle-outline" size={18} color={statusColor} />
            <View style={styles.nextActionCopy}>
              <Text style={[styles.nextActionTitle, { color: statusColor }]} numberOfLines={1}>
                {caseItem.presentation.nextActionLabel}
              </Text>
              <Text style={styles.nextActionText} numberOfLines={2}>
                {caseItem.presentation.nextActionDescription}
              </Text>
            </View>
          </View>

          <View style={styles.caseFooterRow}>
            <View style={styles.caseButtonRow}>
              {isDraft && (
                <>
                  <Button
                    title="Continue"
                    onPress={() => handleContinue(caseItem)}
                    size="sm"
                  />
                  <Button
                    title="Close"
                    onPress={() => void handleCloseCase(caseItem)}
                    variant="outline"
                    size="sm"
                  />
                  <TouchableOpacity
                    onPress={() => void handleDelete(caseItem)}
                    style={{ padding: 8 }}
                    accessibilityRole="button"
                    accessibilityLabel="Delete draft"
                  >
                    <Ionicons name="trash-outline" size={16} color={colors.destructive} />
                  </TouchableOpacity>
                </>
              )}

              {isActive && (
                <>
                  <Button
                    title="View"
                    onPress={() => handleView(caseItem)}
                    variant="outline"
                    size="sm"
                  />
                  {canEditCase ? (
                    <Button
                      title="Edit"
                      onPress={() => handleEditCase(caseItem)}
                      variant="outline"
                      size="sm"
                    />
                  ) : null}
                  {canCloseCase ? (
                    <Button
                      title="Close"
                      onPress={() => void handleCloseCase(caseItem)}
                      variant="ghost"
                      size="sm"
                    />
                  ) : null}
                  {!isLocalCase && canAddInfoToCase(caseItem) ? (
                    <Button
                      title="Add info"
                      onPress={() => handleAddInfo(caseItem)}
                      variant="outline"
                      size="sm"
                    />
                  ) : null}
                  {caseItem.presentation.state === 'failed_sync' && (
                    <Button
                      title="Retry sync"
                      onPress={handleSync}
                      variant="outline"
                      size="sm"
                      disabled={syncStatus === 'syncing'}
                    />
                  )}
                  {canDeleteCase ? (
                    <TouchableOpacity
                      onPress={() => void handleDelete(caseItem)}
                      style={{ padding: 8 }}
                      accessibilityRole="button"
                      accessibilityLabel="Delete local case"
                    >
                      <Ionicons name="trash-outline" size={16} color={colors.destructive} />
                    </TouchableOpacity>
                  ) : null}
                </>
              )}

              {isClosed && (
                <>
                  <Button
                    title="View"
                    onPress={() => handleView(caseItem)}
                    variant="outline"
                    size="sm"
                  />
                  <Button
                    title="Export"
                    onPress={showExportUnavailable}
                    variant="ghost"
                    size="sm"
                  />
                  {canDeleteCase ? (
                    <TouchableOpacity
                      onPress={() => void handleDelete(caseItem)}
                      style={{ padding: 8 }}
                      accessibilityRole="button"
                      accessibilityLabel="Delete closed local case"
                    >
                      <Ionicons name="trash-outline" size={16} color={colors.destructive} />
                    </TouchableOpacity>
                  ) : null}
                </>
              )}
            </View>

            <View style={styles.caseIdBlock}>
              {caseItem.caseId && (
                <Text style={styles.caseIdText}>
                  Case ID: {caseItem.caseId}
                </Text>
              )}
              {!caseItem.caseId && caseItem.presentation.section === 'active' && (
                <Text style={styles.caseIdText}>
                  Local only
                </Text>
              )}
            </View>
          </View>
        </CardContent>
      </Card>
    );
  };

  const renderEmptyState = (type: CaseSection) => {
    const emptyStates: Record<CaseSection, { text: string; action: string; onAction: () => void }> = {
      drafts: {
        text: 'No editable drafts. Saved drafts appear here before submission.',
        action: 'Start a report',
        onAction: startNewDraft,
      },
      active: {
        text: 'No queued or submitted cases yet.',
        action: 'Start a report',
        onAction: startNewDraft,
      },
      closed: {
        text: 'No closed cases yet.',
        action: 'View tips',
        onAction: () => navigation.navigate('TipsRights'),
      },
    };

    const state = emptyStates[type];

    return (
      <View style={styles.emptyPanel}>
        <View style={styles.emptyIcon}>
          <Ionicons name="folder-open-outline" size={28} color={colors.primary} />
        </View>
        <Text style={styles.emptyTitle}>
          {type === 'drafts' ? 'No draft work yet' : type === 'active' ? 'No active follow-up' : 'No closed records'}
        </Text>
        <Text style={styles.emptyText}>
          {state.text}
        </Text>
        <Button
          title={state.action}
          onPress={state.onAction}
          variant="outline"
        />
      </View>
    );
  };

  const styles = StyleSheet.create({
    searchPanel: {
      paddingHorizontal: spacing.md,
      paddingTop: spacing.sm,
      gap: spacing.sm,
    },
    searchBox: {
      position: 'relative',
    },
    searchField: {
      marginBottom: 0,
    },
    clearSearchButton: {
      alignItems: 'center',
      height: 48,
      justifyContent: 'center',
      width: 48,
    },
    sortBar: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingTop: spacing.md,
    },
    sortLabel: {
      ...typography.caption,
      color: colors.textSecondary,
      fontWeight: '700',
      textTransform: 'uppercase',
    },
    sortOptions: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
      justifyContent: 'flex-end',
    },
    sortButton: {
      backgroundColor: colors.surface,
      borderColor: colors.divider,
      borderRadius: radii.badge,
      borderWidth: borders.hairline,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
    },
    sortButtonActive: {
      backgroundColor: colors.primaryMuted,
      borderColor: colors.primary + '55',
    },
    sortButtonText: {
      ...typography.caption,
      color: colors.textSecondary,
      fontWeight: '700',
      textTransform: 'capitalize',
    },
    sortButtonTextActive: {
      color: colors.primary,
    },
    tabsContainer: {
      backgroundColor: colors.surfaceAlt,
      borderRadius: radii.round,
      flexDirection: 'row',
      gap: spacing.xxxs,
      marginHorizontal: spacing.md,
      marginTop: spacing.sm,
      padding: spacing.xxxs,
    },
    tab: {
      alignItems: 'center',
      borderRadius: radii.round,
      flex: 1,
      minHeight: 44,
      justifyContent: 'center',
      paddingHorizontal: spacing.xs,
      paddingVertical: spacing.xs,
    },
    activeTab: {
      backgroundColor: colors.primary,
    },
    tabText: {
      ...typography.labelMedium,
      color: colors.textSecondary,
      textAlign: 'center',
    },
    activeTabText: {
      color: colors.primaryForeground,
    },
    caseCard: {
      marginBottom: spacing.sm,
    },
    caseCardContent: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
    },
    caseHeaderRow: {
      alignItems: 'flex-start',
      flexDirection: 'row',
      gap: spacing.sm,
      justifyContent: 'space-between',
      marginBottom: spacing.md,
    },
    caseIcon: {
      alignItems: 'center',
      borderRadius: radii.card,
      borderWidth: borders.hairline,
      height: 42,
      justifyContent: 'center',
      width: 42,
    },
    caseTitleGroup: {
      flex: 1,
      minWidth: 0,
    },
    caseTitle: {
      ...typography.titleSmall,
      color: colors.foreground,
    },
    caseDescription: {
      ...typography.bodySmall,
      color: colors.mutedForeground,
      marginTop: spacing.xxxs,
    },
    caseStatusPill: {
      borderRadius: radii.round,
      borderWidth: borders.hairline,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
    },
    caseStatusText: {
      ...typography.labelSmall,
    },
    caseMetaRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
      marginBottom: spacing.sm,
    },
    caseMetaChip: {
      backgroundColor: colors.muted,
      borderRadius: radii.sm,
      maxWidth: '100%',
      paddingHorizontal: spacing.xs,
      paddingVertical: spacing.xxxs,
    },
    caseMetaText: {
      ...typography.bodySmall,
      color: colors.mutedForeground,
    },
    caseTagRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
      marginBottom: spacing.md,
    },
    caseTag: {
      backgroundColor: colors.background,
      borderColor: colors.border,
      borderRadius: radii.sm,
      borderWidth: borders.hairline,
      maxWidth: 150,
      paddingHorizontal: spacing.xs,
      paddingVertical: spacing.xxxs,
    },
    caseTagText: {
      ...typography.labelSmall,
      color: colors.foreground,
    },
    draftProgressPanel: {
      backgroundColor: colors.surfaceAlt,
      borderColor: colors.divider,
      borderRadius: radii.card,
      borderWidth: borders.hairline,
      borderLeftWidth: borders.emphasized,
      gap: spacing.xs,
      marginBottom: spacing.md,
      padding: spacing.sm,
    },
    draftProgressHeader: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.sm,
      justifyContent: 'space-between',
    },
    draftProgressTitleRow: {
      alignItems: 'center',
      flexDirection: 'row',
      flex: 1,
      gap: spacing.xs,
      minWidth: 0,
    },
    draftProgressTitle: {
      ...typography.labelSmall,
      color: colors.foreground,
    },
    draftProgressCount: {
      ...typography.labelSmall,
      flexShrink: 0,
    },
    draftProgressTrack: {
      backgroundColor: colors.background,
      borderRadius: radii.round,
      height: 6,
      overflow: 'hidden',
    },
    draftProgressFill: {
      borderRadius: radii.round,
      height: '100%',
    },
    draftProgressSteps: {
      flexDirection: 'row',
      gap: spacing.xs,
    },
    draftProgressStep: {
      alignItems: 'center',
      backgroundColor: colors.background,
      borderColor: colors.divider,
      borderRadius: radii.sm,
      borderWidth: borders.hairline,
      flex: 1,
      minHeight: 42,
      minWidth: 0,
      paddingHorizontal: spacing.xxxs,
      paddingVertical: spacing.xs,
    },
    draftProgressStepLabel: {
      ...typography.caption,
      fontWeight: '700',
      textAlign: 'center',
    },
    draftProgressStepStatus: {
      ...typography.caption,
      color: colors.textSecondary,
      textAlign: 'center',
    },
    draftProgressCaption: {
      ...typography.bodySmall,
      color: colors.textSecondary,
    },
    nextActionStrip: {
      alignItems: 'flex-start',
      borderRadius: radii.card,
      borderWidth: borders.hairline,
      flexDirection: 'row',
      gap: spacing.xs,
      marginBottom: spacing.md,
      padding: spacing.sm,
    },
    nextActionCopy: {
      flex: 1,
      minWidth: 0,
    },
    nextActionTitle: {
      ...typography.labelSmall,
    },
    nextActionText: {
      ...typography.bodySmall,
      color: colors.textSecondary,
      marginTop: spacing.xxxs,
    },
    caseFooterRow: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.sm,
      justifyContent: 'space-between',
    },
    caseButtonRow: {
      flex: 1,
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
    },
    caseIdBlock: {
      alignItems: 'flex-end',
      flexShrink: 1,
    },
    caseIdText: {
      ...typography.caption,
      color: colors.mutedForeground,
      textAlign: 'right',
    },
    emptyPanel: {
      alignItems: 'center',
      gap: spacing.xs,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xl,
    },
    emptyIcon: {
      alignItems: 'center',
      backgroundColor: colors.primaryMuted,
      borderRadius: radii.card,
      height: 56,
      justifyContent: 'center',
      width: 56,
    },
    emptyTitle: {
      ...typography.headlineSmall,
      color: colors.foreground,
      textAlign: 'center',
    },
    emptyText: {
      ...typography.bodySmall,
      color: colors.textSecondary,
      maxWidth: 280,
      textAlign: 'center',
    },
  });

  const searchPanel = (
    <View style={styles.searchPanel}>
      <FeatureHeader eyebrow="Your records" title="Cases & drafts" description="Review saved drafts, follow case updates, and return when you are ready." icon="folder-open-outline" tone="evidence" />
      <View style={styles.searchBox}>
        <Input
          placeholder="Search cases, locations, tags..."
          value={searchQuery}
          onChangeText={setSearchQuery}
          containerStyle={styles.searchField}
          startAdornment={<Ionicons accessible={false} name="search" size={18} color={colors.textSecondary} />}
          endAdornment={searchQuery ? (
            <TouchableOpacity
              onPress={() => setSearchQuery('')}
              style={styles.clearSearchButton}
              accessibilityRole="button"
              accessibilityLabel="Clear case search"
            >
              <Ionicons name="close" size={18} color={colors.textSecondary} />
            </TouchableOpacity>
          ) : undefined}
        />
      </View>
    </View>
  );

  if (isLoading) {
    return (
      <Screen edges={['left', 'right']}>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={{ marginTop: 16, color: colors.mutedForeground }}>Loading your cases...</Text>
        </View>
      </Screen>
    );
  }

  if (drafts.length === 0 && activeCases.length === 0 && closed.length === 0) {
    return (
      <Screen edges={['left', 'right']}>
        <ScrollView contentContainerStyle={{ flexGrow: 1 }}>
        {searchPanel}
        <View style={{ flex: 1, paddingHorizontal: spacing.md, paddingBottom: spacing.md }}>
          <View style={styles.emptyPanel}>
            <SafetyIllustration kind="evidence" size={88} />
            <Text style={styles.emptyTitle}>No cases yet</Text>
            <Text style={styles.emptyText}>
              Saved drafts, local records, and synced cases will appear here with clear next steps.
            </Text>
            <Button title="Start a report" onPress={startNewDraft} />
          </View>
        </View>
        </ScrollView>
      </Screen>
    );
  }

  return (
    <Screen edges={['left', 'right']}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: spacing.md }}
        refreshControl={Platform.OS === 'web' ? undefined : (
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} colors={[colors.primary]} tintColor={colors.primary} />
        )}
      >
      {searchPanel}
      <View style={styles.sortBar}>
        <Text style={styles.sortLabel}>Sort by</Text>
        <View style={styles.sortOptions}>
          {(['recent', 'status', 'pathway'] as const).map(key => (
            <TouchableOpacity
              key={key}
              onPress={() => setSortBy(key)}
              style={[styles.sortButton, sortBy === key && styles.sortButtonActive]}
              hitSlop={{ top: 8, bottom: 8, left: 2, right: 2 }}
              accessibilityRole="button"
              accessibilityState={{ selected: sortBy === key }}
            >
              <Text style={[styles.sortButtonText, sortBy === key && styles.sortButtonTextActive]}>
                {key}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <View style={styles.tabsContainer} accessibilityRole="tablist">
        {[
          { key: 'drafts' as const, label: `Drafts ${drafts.length}` },
          { key: 'active' as const, label: `Active ${activeCases.length}` },
          { key: 'closed' as const, label: `Closed ${closed.length}` },
        ].map((tab) => (
          <TouchableOpacity
            key={tab.key}
            style={[styles.tab, activeTab === tab.key && styles.activeTab]}
            onPress={() => setActiveTab(tab.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: activeTab === tab.key }}
          >
            <Text style={[styles.tabText, activeTab === tab.key && styles.activeTabText]}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={{ padding: spacing.md }}>
        {activeTab === 'drafts' && (
          drafts.length > 0 ? (
            <View style={{ gap: 12 }}>
              {drafts.map(renderCaseCard)}
              <Button title="Delete all drafts" onPress={handleDeleteAllDrafts} variant="ghost" />
            </View>
          ) : (
            renderEmptyState('drafts')
          )
        )}

        {activeTab === 'active' && (
          activeCases.length > 0 ? (
            <View style={{ gap: 12 }}>
              {activeCases.map(renderCaseCard)}
            </View>
          ) : (
            renderEmptyState('active')
          )
        )}

        {activeTab === 'closed' && (
          closed.length > 0 ? (
            <View style={{ gap: 12 }}>
              {closed.map(renderCaseCard)}
              <Button title="Export unavailable" onPress={showExportUnavailable} variant="ghost" />
            </View>
          ) : (
            renderEmptyState('closed')
          )
        )}

        {searchQuery && (
          <View style={{ marginTop: 16, alignItems: 'center' }}>
            <Text style={{ color: colors.mutedForeground, fontSize: 14 }}>
              {totalResults} result(s) for "{searchQuery}"
            </Text>
          </View>
        )}
      </View>
      </ScrollView>
    </Screen>
  );
}
