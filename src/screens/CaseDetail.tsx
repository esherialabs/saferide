import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Alert,
  Linking,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { Ionicons } from '@expo/vector-icons';
import {
  RouteProp,
  useFocusEffect,
  useNavigation,
  useRoute,
} from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';

import Button from '../components/ui/Button';
import Screen from '../components/ui/Screen';
import Textarea from '../components/ui/Textarea';
import { Card, CardContent } from '../components/ui/Card';
import { useOnline } from '../context/OnlineProvider';
import { resetReportStackToRoute } from '../navigation/reportNavigation';
import { RootStackParamList } from '../navigation/routes';
import { useTheme } from '../theme/SimpleThemeProvider';
import { borders, radii, spacing, typography } from '../theme/tokens';
import { PathwayType } from '../types/pathways';
import { useToast } from '../components/ui/Toast';
import {
  CaseAttachment,
  CaseEvent,
  CaseRecord,
  createAttachmentDownloadUrl,
  fetchCaseDetail,
} from '../services/caseService';
import {
  CaseAdditionalInfoEntry,
  addCaseAdditionalInfo,
  getCaseAdditionalInfo,
} from '../services/caseAdditionalInfoService';
import { confirmCenter } from '../utils/confirmCenter';
import { PROTECTED_CASE_EXPORT_UNAVAILABLE_MESSAGE } from '../utils/caseTimelineExport';
import { draftStorage } from '../utils/draftStorage';
import { shareLocalFile } from '../utils/fileShare';
import type { DraftData } from '../utils/draftStorage';
import { offlineSyncManager, type SyncQueueItem } from '../utils/offlineSync';
import {
  buildDraftTimelineItems,
  buildLocalCaseRecordFromDraft,
  deriveDraftDisplayState,
  deriveRemoteDisplayState,
  getCasePresentation,
  type CaseTimelineModel,
} from '../utils/casePresentation';
import {
  buildCaseDetailSource,
  describeStatusChange,
  getStatusLabel,
  isAnonymousMapCaseRecord,
  normalizeCaseSummaryPayload,
  type CaseLocationPayload,
  type CaseSummaryPayload,
  type DraftMedia,
} from '../utils/caseDetailDisplay';
import { buildReferralCaseSupportDetails } from '../utils/supportDiscovery';
import { buildReferralContactUrl, CHANNEL_LABELS } from '../utils/referralSupport';
import { devPrivacyError, devPrivacyWarn, getPrivacySafeErrorReason, getPrivacySafeHttpStatus } from '../utils/privacyLog';
import { PARTNER_SHARING_COPY } from '../i18n/partnerSharingCopy';
import {
  PartnerSharingConsentUnknownError,
  stopAllPartnerSharing,
  stopPartnerSharing,
} from '../services/partnerSharingService';
import { describePartnerCaseEvent, summarizePartnerSharing } from '../utils/partnerSharing';
import { startForegroundCaseRefresh } from '../utils/foregroundCaseRefresh';

type CaseDetailRouteProp = RouteProp<RootStackParamList, 'CaseDetail'>;
type CaseDetailNavigationProp = NativeStackNavigationProp<RootStackParamList>;

type TimelineItem = {
  id: string;
  type: string;
  title: string;
  body: string;
  time: string;
  chips?: string[];
  actions?: { label: string; onClick: () => void }[];
  isKeyEvent?: boolean;
};


type TimelineItemWithDate = TimelineItem & { timestamp: Date };


const PATHWAY_LABELS: Record<PathwayType, string> = {
  'save-private': 'Save privately',
  'anonymous-map': 'Map update record',
  referral: 'Referral',
  escalate: 'Escalate for action',
};

const EVENT_TITLE_MAP: Record<string, string> = {
  submission: 'Case submitted',
  status_change: 'Status updated',
  evidence_uploaded: 'Evidence uploaded',
  note: 'Case note',
  additional_info: 'Additional info',
  deletion_requested: 'Deletion request recorded',
  action_required: 'Needs attention',
};

function formatDateTime(date: Date): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

function formatSummaryDateTime(datetime?: CaseSummaryPayload['datetime']): string | null {
  if (!datetime) return null;
  const { date, time, accuracy } = datetime;
  const label = [date, time].filter(Boolean).join(' • ');
  if (!label) return null;
  if (accuracy && accuracy !== 'exact') {
    return `${label} (${accuracy})`;
  }
  return label;
}

function formatAttachmentSize(size?: number | null): string {
  if (!size || size <= 0) return 'Unknown size';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = size;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function isAppOwnedFile(uri: string): boolean {
  return Boolean(
    (FileSystem.documentDirectory && uri.startsWith(FileSystem.documentDirectory)) ||
    (FileSystem.cacheDirectory && uri.startsWith(FileSystem.cacheDirectory)),
  );
}

export function getAttachmentAvailability(attachment: CaseAttachment): { available: boolean; label: string } {
  if (attachment.status === 'hash_mismatch') return { available: false, label: 'Blocked — checksum mismatch' };
  if (attachment.status !== 'uploaded') return { available: false, label: 'Upload not verified' };
  if (attachment.antivirusStatus === 'rejected' || attachment.quarantineStatus === 'rejected') {
    return { available: false, label: 'Blocked — safety scan rejected' };
  }
  if (attachment.antivirusStatus !== 'clean' || attachment.quarantineStatus !== 'released') {
    return { available: false, label: 'Quarantined — safety scan pending' };
  }
  return { available: true, label: 'Verified and available' };
}

function getPathwayLabel(pathway: PathwayType | string | null | undefined): string {
  if (!pathway) return 'Pathway not specified';
  if (PATHWAY_LABELS[pathway as PathwayType]) {
    return PATHWAY_LABELS[pathway as PathwayType];
  }
  return pathway
    .toString()
    .split(/[_-]/)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function getAdditionalInfoStatusLabel(status: CaseAdditionalInfoEntry['status']): string {
  switch (status) {
    case 'sent':
      return 'Sent';
    case 'queued':
      return 'Queued';
    case 'failed':
      return 'Failed';
    case 'saved_local':
    default:
      return 'Saved locally';
  }
}

function getAdditionalInfoRemoteLabel(state: CaseAdditionalInfoEntry['remoteState']): string | null {
  switch (state) {
    case 'unavailable':
      return 'Provider send unavailable';
    case 'queued':
      return 'Queued to send';
    case 'sent':
      return 'Sent to provider';
    case 'failed':
      return 'Send failed';
    case 'not_attempted':
    default:
      return null;
  }
}

function buildCaseHash(id: string): string {
  return id.replace(/-/g, '').slice(-8).toUpperCase();
}

function isRemoteCaseId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function capitalize(value: string): string {
  return value
    .split(/[_-]/)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function getTimelineIcon(type: string): keyof typeof Ionicons.glyphMap {
  switch (type) {
    case 'created':
      return 'add-circle-outline';
    case 'submission':
    case 'sent':
      return 'send-outline';
    case 'status_change':
      return 'shield-checkmark-outline';
    case 'partner_routed':
      return 'people-outline';
    case 'evidence':
    case 'evidence_uploaded':
      return 'mic-outline';
    case 'tags':
      return 'pricetag-outline';
    case 'consent':
      return 'checkmark-done-outline';
    case 'acknowledged':
      return 'mail-unread-outline';
    case 'action-required':
    case 'action_required':
    case 'needs_attention':
    case 'failed_sync':
      return 'alert-circle-outline';
    case 'note':
    case 'additional_info':
      return 'document-text-outline';
    case 'closed':
      return 'flag-outline';
    case 'deletion_requested':
      return 'trash-outline';
    case 'queued':
      return 'cloud-upload-outline';
    case 'redaction':
      return 'eye-off-outline';
    default:
      return 'information-circle-outline';
  }
}

function buildTimelineItems(
  caseRecord: CaseRecord,
  events: CaseEvent[],
  summary: CaseSummaryPayload,
  attachments: CaseAttachment[],
  additionalInfo: CaseAdditionalInfoEntry[] = [],
): TimelineItem[] {
  const isAnonymousMapRecord = isAnonymousMapCaseRecord(caseRecord.pathway, summary);
  const mediaCount = isAnonymousMapRecord
    ? 0
    : typeof summary.mediaCount === 'number' ? summary.mediaCount : attachments.length;

  const baseChips: string[] = [];
  baseChips.push(`Pathway: ${getPathwayLabel(summary.pathway ?? caseRecord.pathway)}`);
  if (mediaCount) {
    baseChips.push(`Media: ${mediaCount}`);
  }
  baseChips.push(getStatusLabel(caseRecord.status));

  const items: TimelineItemWithDate[] = [
    {
      id: 'case-created',
      type: 'created',
      title: 'Case created',
      body: isAnonymousMapRecord
        ? 'Map update record created through the signed-in case service.'
        : typeof summary.incidentDescription === 'string' && summary.incidentDescription.length > 0
          ? summary.incidentDescription
          : 'Case captured and stored in SafeRide.',
      time: formatDateTime(caseRecord.createdAt),
      chips: baseChips.filter(Boolean),
      isKeyEvent: true,
      timestamp: caseRecord.createdAt,
    },
  ];

  additionalInfo.forEach(entry => {
    const chips = [getAdditionalInfoStatusLabel(entry.status)];
    const remoteLabel = getAdditionalInfoRemoteLabel(entry.remoteState);
    if (remoteLabel) {
      chips.push(remoteLabel);
    }
    if (entry.networkState === 'offline') {
      chips.push('Saved while offline');
    }

    items.push({
      id: entry.id,
      type: 'additional_info',
      title:
        entry.status === 'sent'
          ? 'Additional info sent'
          : entry.status === 'queued'
          ? 'Additional info queued'
          : entry.status === 'failed'
          ? 'Additional info failed'
          : 'Additional info saved',
      body: entry.body,
      time: formatDateTime(entry.createdAt),
      chips,
      isKeyEvent: entry.status === 'sent',
      timestamp: entry.createdAt,
    });
  });

  events.forEach(event => {
    // HURIA's events: routing (with the reference) and its status changes, in plain language.
    const partnerEntry = describePartnerCaseEvent(event);
    if (partnerEntry) {
      items.push({
        id: event.id,
        type: event.eventType,
        title: partnerEntry.title,
        body: partnerEntry.reference
          ? `${partnerEntry.body} ${PARTNER_SHARING_COPY.timeline.callHint}`
          : partnerEntry.body,
        time: formatDateTime(event.createdAt),
        chips: partnerEntry.reference ? [`Reference ${partnerEntry.reference}`] : [],
        isKeyEvent: true,
        timestamp: event.createdAt,
      });
      return;
    }

    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const chips: string[] = [];
    let body = '';
    let isKeyEvent = false;
    const title = EVENT_TITLE_MAP[event.eventType] ?? capitalize(event.eventType);

    switch (event.eventType) {
      case 'submission': {
        const pathwayLabel = getPathwayLabel(
          (payload.pathway as PathwayType | undefined) ??
            summary.pathway ??
            caseRecord.pathway,
        );
        body = `Case submitted via ${pathwayLabel}.`;
        if (mediaCount) {
          chips.push(`Media: ${mediaCount}`);
        }
        chips.push(getStatusLabel(caseRecord.status));
        isKeyEvent = true;
        break;
      }
      case 'status_change': {
        const change = describeStatusChange(payload, caseRecord.status);
        body = change.body;
        chips.push(change.label);
        isKeyEvent = true;
        break;
      }
      case 'evidence_uploaded': {
        const count =
          (payload.count as number | undefined) ??
          (payload.items as unknown[] | undefined)?.length ??
          1;
        body = `${count} evidence item${count === 1 ? '' : 's'} uploaded.`;
        chips.push(`Media: ${count}`);
        break;
      }
      case 'note': {
        body =
          typeof payload.message === 'string'
            ? payload.message
            : 'A note was added to this case.';
        break;
      }
      case 'deletion_requested': {
        const requestedAt = typeof payload.requestedAt === 'string' ? payload.requestedAt : null;
        body = 'Deletion request recorded for manual review. SafeRide has not physically deleted submitted case data from this request.';
        chips.push('Manual review');
        chips.push('No automatic erasure');
        if (requestedAt) {
          chips.push(`Requested ${formatDateTime(new Date(requestedAt))}`);
        }
        isKeyEvent = true;
        break;
      }
      default: {
        body =
          typeof payload.message === 'string'
            ? payload.message
            : 'An update was recorded for this case.';
      }
    }

    items.push({
      id: event.id,
      type: event.eventType,
      title,
      body,
      time: formatDateTime(event.createdAt),
      chips: chips.filter(Boolean),
      isKeyEvent,
      timestamp: event.createdAt,
    });
  });

  items.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  return items.map(({ timestamp, ...rest }) => rest);
}

export default function CaseDetailScreen() {
  const navigation = useNavigation<CaseDetailNavigationProp>();
  const route = useRoute<CaseDetailRouteProp>();
  const toast = useToast();
  const { colors } = useTheme();
  const { isOnline, queueSize, syncNow, syncStatus, syncMessage } = useOnline();

  const { caseId } = route.params;

  const [caseRecord, setCaseRecord] = useState<CaseRecord | null>(null);
  const [attachments, setAttachments] = useState<CaseAttachment[]>([]);
  const [events, setEvents] = useState<CaseEvent[]>([]);
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [downloadingAttachmentId, setDownloadingAttachmentId] = useState<string | null>(null);
  const [localDraft, setLocalDraft] = useState<DraftData | null>(null);
  const [queueItems, setQueueItems] = useState<SyncQueueItem[]>([]);
  const [additionalInfoEntries, setAdditionalInfoEntries] = useState<CaseAdditionalInfoEntry[]>([]);
  const [isAddInfoFormOpen, setIsAddInfoFormOpen] = useState(false);
  const [addInfoBody, setAddInfoBody] = useState('');
  const [addInfoError, setAddInfoError] = useState<string | null>(null);
  const [isSavingAddInfo, setIsSavingAddInfo] = useState(false);
  const [isStoppingPartnerSharing, setIsStoppingPartnerSharing] = useState(false);

  useEffect(() => {
    if (route.params.openAddInfo) {
      setIsAddInfoFormOpen(true);
    }
  }, [route.params.openAddInfo]);

  const assignDetail = useCallback(
    (detail: { caseRecord: CaseRecord | null; attachments: CaseAttachment[]; events: CaseEvent[] }) => {
      setCaseRecord(detail.caseRecord);
      setAttachments(detail.attachments);
      setEvents(detail.events);
      setExpandedItems(new Set());
    },
    [],
  );

  useFocusEffect(
    useCallback(() => {
      let isActive = true;

      getCaseAdditionalInfo(caseId)
        .then(entries => {
          if (isActive) {
            setAdditionalInfoEntries(entries);
          }
        })
        .catch(error => {
          if (!isActive) return;
          devPrivacyWarn('case additional info hydration failed', {
            reason: getPrivacySafeErrorReason(error),
          });
        });

      return () => {
        isActive = false;
      };
    }, [caseId]),
  );

  useFocusEffect(
    useCallback(() => {
      let isActive = true;
      setIsLoading(true);
      setFetchError(null);
      setQueueItems(offlineSyncManager.getSyncQueueItems());

      if (!isRemoteCaseId(caseId)) {
        draftStorage.getDraft(caseId)
          .then(draft => {
            if (!isActive) return;
            if (!draft) {
              assignDetail({ caseRecord: null, attachments: [], events: [] });
              setLocalDraft(null);
              setFetchError('This local draft is no longer on this device.');
              return;
            }

            setLocalDraft(draft);
            assignDetail({
              caseRecord: buildLocalCaseRecordFromDraft(draft),
              attachments: [],
              events: [],
            });
          })
          .catch(error => {
            if (!isActive) return;
            devPrivacyError('local case detail load failed', {
              reason: getPrivacySafeErrorReason(error),
            });
            setFetchError('Local case details are unavailable. Please try again.');
          })
          .finally(() => {
            if (isActive) {
              setIsLoading(false);
            }
          });

        return () => {
          isActive = false;
        };
      }

      fetchCaseDetail(caseId)
        .then(detail => {
          if (!isActive) return;
          assignDetail(detail);
        })
        .catch(error => {
          if (!isActive) return;
          devPrivacyError('case detail load failed', {
            reason: getPrivacySafeErrorReason(error),
            status: getPrivacySafeHttpStatus(error),
          });
          const message = 'Case details are unavailable. Local drafts are still visible from Case Tracker.';
          setFetchError(message);
          toast.show({ title: 'Unable to load case', message, variant: 'error' });
        })
        .finally(() => {
          if (isActive) {
            setIsLoading(false);
          }
        });

      return () => {
        isActive = false;
      };
    }, [assignDetail, caseId, toast]),
  );

  useEffect(() => {
    let isMounted = true;

    async function hydrateLocalDraft() {
      if (!caseRecord?.draftId) {
        if (isMounted) {
          setLocalDraft(null);
        }
        return;
      }

      try {
        const draft = await draftStorage.getDraft(caseRecord.draftId);
        if (isMounted) {
          setLocalDraft(draft);
        }
      } catch (error) {
        devPrivacyWarn('case local draft hydration failed', {
          reason: getPrivacySafeErrorReason(error),
        });
        if (isMounted) {
          setLocalDraft(null);
        }
      }
    }

    hydrateLocalDraft();

    return () => {
      isMounted = false;
    };
  }, [caseRecord?.draftId, caseRecord?.id]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    setFetchError(null);
    setQueueItems(offlineSyncManager.getSyncQueueItems());
    try {
      if (!isRemoteCaseId(caseId)) {
        const draft = await draftStorage.getDraft(caseId);
        if (!draft) {
          assignDetail({ caseRecord: null, attachments: [], events: [] });
          setLocalDraft(null);
          setFetchError('This local draft is no longer on this device.');
          return;
        }
        setLocalDraft(draft);
        assignDetail({ caseRecord: buildLocalCaseRecordFromDraft(draft), attachments: [], events: [] });
        return;
      }

      const detail = await fetchCaseDetail(caseId);
      assignDetail(detail);
    } catch (error) {
      devPrivacyError('case detail refresh failed', {
        reason: getPrivacySafeErrorReason(error),
        status: getPrivacySafeHttpStatus(error),
      });
      const message = isRemoteCaseId(caseId)
        ? 'Case details are unavailable. Please try again.'
        : 'Local case details are unavailable. Please try again.';
      setFetchError(message);
      toast.show({ title: 'Refresh failed', message, variant: 'error' });
    } finally {
      setQueueItems(offlineSyncManager.getSyncQueueItems());
      setRefreshing(false);
    }
  }, [assignDetail, caseId, toast]);

  useFocusEffect(useCallback(() => {
    if (!isRemoteCaseId(caseId) || !isOnline) return;
    const polling = startForegroundCaseRefresh({
      active: () => AppState.currentState === 'active',
      fetch: () => fetchCaseDetail(caseId),
      apply: detail => {
        // Preserve an expanded timeline and unsaved local notes during a background refresh.
        setCaseRecord(detail.caseRecord); setAttachments(detail.attachments); setEvents(detail.events);
        setFetchError(null);
      },
      unavailable: () => setFetchError('Case updates are unavailable. The details shown may be out of date; reconnect or refresh before relying on the status.'),
    });
    const listener = AppState.addEventListener('change', state => { if (state === 'active') void polling.refresh(); });
    return () => { listener.remove(); polling.stop(); };
  }, [caseId, isOnline]));

  const toggleItemExpanded = useCallback((itemId: string) => {
    setExpandedItems(current => {
      const next = new Set(current);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  }, []);

  const handleExport = useCallback(() => {
    toast.show({
      title: 'Export unavailable',
      message: PROTECTED_CASE_EXPORT_UNAVAILABLE_MESSAGE,
      variant: 'info',
    });
  }, [toast]);

  const handleRedact = useCallback(() => {
    toast.show({
      title: 'Redaction unavailable',
      message: 'A reviewed redaction editor is not available in this build. Evidence privacy requests are shown as status only.',
      variant: 'info',
    });
  }, [toast]);

  const isLocalCaseDetail = Boolean(
    localDraft && caseRecord?.id === localDraft.id && !isRemoteCaseId(caseRecord.id),
  );

  const canAddAdditionalInfo = Boolean(
    caseRecord && !isLocalCaseDetail && ['submitted', 'in_review', 'referred'].includes(caseRecord.status),
  );
  const canEditLocalCase = Boolean(isLocalCaseDetail && localDraft);
  const canCloseLocalCase = Boolean(canEditLocalCase && localDraft?.status !== 'closed');

  const handleEditLocalCase = useCallback(() => {
    if (!localDraft || !isLocalCaseDetail) {
      toast.show({
        title: 'Edit unavailable',
        message: 'Only local records can be edited on this device.',
        variant: 'info',
      });
      return;
    }

    resetReportStackToRoute(navigation, 'WhatHappened', {
      draftId: localDraft.id,
      editCompleted: true,
    });
  }, [isLocalCaseDetail, localDraft, navigation, toast]);

  const handleCloseLocalCase = useCallback(async () => {
    if (!localDraft || !isLocalCaseDetail) {
      toast.show({
        title: 'Close unavailable',
        message: 'Only local records can be closed on this device.',
        variant: 'info',
      });
      return;
    }

    if (localDraft.status === 'closed') {
      toast.show({
        title: 'Already closed',
        message: 'This local record is already in Closed.',
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
      // Patch only the status; the persisted draft may be newer than the
      // snapshot this screen loaded.
      const closedDraft = await draftStorage.saveDraft({
        id: localDraft.id,
        status: 'closed',
      });
      try {
        await offlineSyncManager.removeQueueItemsForDraft(localDraft.id);
      } catch (queueError) {
        devPrivacyWarn('local case detail close queue cleanup failed', {
          reason: getPrivacySafeErrorReason(queueError),
        });
      }
      setLocalDraft(closedDraft);
      assignDetail({
        caseRecord: buildLocalCaseRecordFromDraft(closedDraft),
        attachments: [],
        events: [],
      });
      toast.show({
        title: 'Case closed',
        message: 'The local record moved to Closed.',
        variant: 'success',
      });
    } catch (error) {
      devPrivacyWarn('local case close failed', { reason: getPrivacySafeErrorReason(error) });
      toast.show({ title: 'Close failed', message: 'Please try again.', variant: 'error' });
    }
  }, [assignDetail, isLocalCaseDetail, localDraft, toast]);

  const handleOpenAddInfo = useCallback(() => {
    if (!caseRecord || !canAddAdditionalInfo) {
      toast.show({
        title: 'Add info unavailable',
        message: 'Additional information can only be saved for submitted, in-review, or referred cases.',
        variant: 'error',
      });
      return;
    }

    setAddInfoError(null);
    setIsAddInfoFormOpen(true);
  }, [canAddAdditionalInfo, caseRecord, toast]);

  const handleSaveAdditionalInfo = useCallback(async () => {
    if (!caseRecord || !canAddAdditionalInfo) {
      setAddInfoError('This case cannot accept additional information.');
      return;
    }

    try {
      setIsSavingAddInfo(true);
      setAddInfoError(null);
      const result = await addCaseAdditionalInfo({
        caseId: caseRecord.id,
        draftId: caseRecord.draftId,
        body: addInfoBody,
        source: 'case_detail',
        networkState: isOnline ? 'online' : 'offline',
      });

      setAdditionalInfoEntries(current =>
        [result.entry, ...current.filter(entry => entry.id !== result.entry.id)]
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      );
      setAddInfoBody('');
      setIsAddInfoFormOpen(false);
      toast.show({
        title: 'Info saved locally',
        message: result.userMessage,
        variant: 'info',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Additional information could not be saved.';
      setAddInfoError(message);
      toast.show({ title: 'Save failed', message, variant: 'error' });
    } finally {
      setIsSavingAddInfo(false);
    }
  }, [addInfoBody, canAddAdditionalInfo, caseRecord, isOnline, toast]);

  const handleOpenAttachment = useCallback(
    async (attachment: CaseAttachment) => {
      if (!caseRecord) {
        toast.show({
          title: 'Unavailable',
          message: 'Case details are still loading.',
          variant: 'error',
        });
        return;
      }

      try {
        setDownloadingAttachmentId(attachment.id);

        const signedUrl = await createAttachmentDownloadUrl({
          caseId: caseRecord.id,
          attachment,
        });

        const baseDir = FileSystem.cacheDirectory ?? FileSystem.documentDirectory ?? '';
        if (!baseDir) {
          throw new Error('Device storage unavailable for downloads.');
        }
        const targetDir = `${baseDir}saferide-evidence`;
        try {
          await FileSystem.makeDirectoryAsync(targetDir, { intermediates: true });
        } catch (dirError) {
          // Ignore "directory exists" errors
        }

        const rawName =
          (attachment.metadata?.displayName as string | undefined) ??
          `evidence-${attachment.id}`;
        const sanitizedName = rawName.replace(/[^a-zA-Z0-9._-]/g, '_');
        const localUri = `${targetDir}/${sanitizedName}`;

        const download = await FileSystem.downloadAsync(signedUrl, localUri);

        await shareLocalFile(download.uri, sanitizedName);
      } catch (error) {
        devPrivacyError('attachment download failed', {
          reason: getPrivacySafeErrorReason(error),
        });
        toast.show({
          title: 'Download failed',
          message: 'Could not open attachment. Please try again.',
          variant: 'error',
        });
      } finally {
        setDownloadingAttachmentId(null);
      }
    },
    [caseRecord?.id, toast],
  );

  const handleOpenLocalAttachment = useCallback(
    async (media: DraftMedia) => {
      const attachmentKey = `local-${media.id}`;
      try {
        setDownloadingAttachmentId(attachmentKey);
        const info = await FileSystem.getInfoAsync(media.uri);
        if (!info.exists) {
          toast.show({
            title: 'File missing',
            message: 'This evidence could not be found on your device.',
            variant: 'error',
          });
          return;
        }

        await shareLocalFile(media.uri, media.fileName ?? 'evidence');
      } catch (error) {
        devPrivacyError('local attachment open failed', {
          reason: getPrivacySafeErrorReason(error),
        });
        toast.show({
          title: 'Unable to open evidence',
          message: 'Please try again.',
          variant: 'error',
        });
      } finally {
        setDownloadingAttachmentId(current => (current === attachmentKey ? null : current));
      }
    },
    [toast],
  );

  const handleDelete = useCallback(async () => {
    if (isLocalCaseDetail && localDraft) {
      const actionId = await confirmCenter.request({
        title: localDraft.status === 'closed' ? 'Delete closed local case?' : 'Delete local case?',
        message: 'This removes the local record, queued actions, and app-managed evidence files from this device. Files previously shared or stored outside SafeRide are not deleted.',
        actions: [
          { id: 'cancel', label: 'Cancel', role: 'cancel' },
          { id: 'delete', label: 'Delete', role: 'destructive' },
        ],
      });

      if (actionId !== 'delete') {
        return;
      }

      try {
        await offlineSyncManager.removeQueueItemsForDraft(localDraft.id);
        for (const media of localDraft.mediaFiles ?? []) {
          if (media.uri && isAppOwnedFile(media.uri)) {
            await FileSystem.deleteAsync(media.uri, { idempotent: true });
          }
        }
        await draftStorage.deleteDraft(localDraft.id);
      } catch (error) {
        devPrivacyError('local case deletion failed', { reason: getPrivacySafeErrorReason(error) });
        toast.show({
          title: 'Local deletion incomplete',
          message: 'SafeRide kept the local record so you can retry after app-managed file cleanup succeeds.',
          variant: 'error',
        });
        return;
      }
      toast.show({
        title: localDraft.currentStep === 'completed' ? 'Local case deleted' : 'Draft deleted',
        message: 'The local record was removed from this device.',
        variant: 'warning',
      });
      navigation.goBack();
      return;
    }

    toast.show({
      title: 'Submitted-data deletion unavailable',
      message: 'Remote deletion intake stays disabled until identity verification, legal scope, and the 30-day response process are approved. Local deletion is still available in Privacy & Data.',
      variant: 'info',
    });
  }, [isLocalCaseDetail, localDraft, navigation, toast]);

  const summary = useMemo<CaseSummaryPayload>(() => {
    return normalizeCaseSummaryPayload(caseRecord?.summary);
  }, [caseRecord]);

  const partnerSummary = useMemo(
    () => summarizePartnerSharing({ events, sharing: localDraft?.partnerSharing }),
    [events, localDraft?.partnerSharing],
  );

  // After a reinstall this phone cannot link the report to its consent, so
  // the survivor can still stop HURIA's access by withdrawing every HURIA consent.
  const handleStopAllPartnerSharing = useCallback(async () => {
    const copy = PARTNER_SHARING_COPY.caseDetail;
    const actionId = await confirmCenter.request({
      title: copy.stopAllConfirmTitle,
      message: copy.stopAllConfirmBody,
      actions: [
        { id: 'cancel', label: copy.stopCancel, role: 'cancel' },
        { id: 'stop', label: copy.stopAllConfirmAction, role: 'destructive' },
      ],
    });
    if (actionId !== 'stop') return;

    setIsStoppingPartnerSharing(true);
    try {
      const withdrawn = await stopAllPartnerSharing();
      if (caseRecord?.draftId) setLocalDraft(await draftStorage.getDraft(caseRecord.draftId));
      toast.show({
        title: copy.stopDoneTitle,
        message: withdrawn > 0 ? copy.stopAllDoneBody : copy.stopAllNoneBody,
        variant: withdrawn > 0 ? 'success' : 'info',
      });
    } catch (error) {
      devPrivacyWarn('stop all partner sharing failed', {
        reason: getPrivacySafeErrorReason(error),
        status: getPrivacySafeHttpStatus(error),
      });
      toast.show({ title: copy.stopPendingTitle, message: copy.stopPendingBody, variant: 'warning' });
    } finally {
      setIsStoppingPartnerSharing(false);
    }
  }, [caseRecord?.draftId, toast]);

  const handleStopPartnerSharing = useCallback(async () => {
    const copy = PARTNER_SHARING_COPY.caseDetail;
    if (!localDraft) {
      await handleStopAllPartnerSharing();
      return;
    }
    const actionId = await confirmCenter.request({
      title: copy.stopConfirmTitle,
      message: copy.stopConfirmBody,
      actions: [
        { id: 'cancel', label: copy.stopCancel, role: 'cancel' },
        { id: 'stop', label: copy.stopConfirmAction, role: 'destructive' },
      ],
    });
    if (actionId !== 'stop') return;

    setIsStoppingPartnerSharing(true);
    try {
      await stopPartnerSharing(localDraft);
      setLocalDraft(await draftStorage.getDraft(localDraft.id));
      toast.show({ title: copy.stopDoneTitle, message: copy.stopDoneBody, variant: 'success' });
    } catch (error) {
      if (error instanceof PartnerSharingConsentUnknownError) {
        toast.show({ title: copy.stopPendingTitle, message: copy.stopUnavailableBody, variant: 'info' });
        await handleStopAllPartnerSharing();
      } else {
        devPrivacyWarn('stop partner sharing failed', {
          reason: getPrivacySafeErrorReason(error),
          status: getPrivacySafeHttpStatus(error),
        });
        toast.show({ title: copy.stopPendingTitle, message: copy.stopPendingBody, variant: 'warning' });
      }
    } finally {
      setIsStoppingPartnerSharing(false);
    }
  }, [handleStopAllPartnerSharing, localDraft, toast]);

  const handleReviewPartnerSharing = useCallback(() => {
    if (!localDraft) return;
    resetReportStackToRoute(navigation, 'ConsentGate', { draftId: localDraft.id, editCompleted: true });
  }, [localDraft, navigation]);

  const detailSource = useMemo(() => buildCaseDetailSource({
    casePathway: caseRecord?.pathway,
    summary,
    localDraft,
    attachments,
  }), [attachments, caseRecord?.pathway, localDraft, summary]);

  const tags = useMemo(() => {
    if (detailSource.isAnonymousMapRecord) {
      return detailSource.anonymousMapCategories;
    }

    const fromSummary = Array.isArray(summary.tags)
      ? summary.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
      : [];
    const fromDraft = Array.isArray(localDraft?.selectedTags)
      ? (localDraft.selectedTags as string[]).filter(tag => typeof tag === 'string' && tag.trim().length > 0)
      : [];
    const fromAccepted = Array.isArray(localDraft?.acceptedSuggestions)
      ? (localDraft.acceptedSuggestions as string[]).filter(tag => typeof tag === 'string' && tag.trim().length > 0)
      : [];

    const combined = [...fromSummary, ...fromDraft, ...fromAccepted];
    return Array.from(new Set(combined));
  }, [detailSource, summary.tags, localDraft?.selectedTags, localDraft?.acceptedSuggestions]);

  const statusPresentation = useMemo(() => {
    if (!caseRecord) return getCasePresentation('unknown');
    if (localDraft && caseRecord.id === localDraft.id && !isRemoteCaseId(caseRecord.id)) {
      return getCasePresentation(deriveDraftDisplayState(localDraft, queueItems, syncStatus));
    }
    return getCasePresentation(deriveRemoteDisplayState(caseRecord, events));
  }, [caseRecord, events, localDraft, queueItems, syncStatus]);

  const statusColor = useMemo(() => {
    switch (statusPresentation.tone) {
      case 'success':
        return colors.success;
      case 'warning':
        return colors.warning;
      case 'destructive':
        return colors.destructive;
      case 'info':
        return colors.primary;
      case 'muted':
      default:
        return colors.mutedForeground;
    }
  }, [colors, statusPresentation.tone]);

  const timelineItems = useMemo(() => {
    if (!caseRecord) return [];
    if (localDraft && caseRecord.id === localDraft.id && !isRemoteCaseId(caseRecord.id)) {
      return buildDraftTimelineItems(localDraft, queueItems, syncStatus).map((item: CaseTimelineModel): TimelineItem => ({
        id: item.id,
        type: item.type,
        title: item.title,
        body: item.body,
        time: formatDateTime(item.at),
        chips: item.chips,
        isKeyEvent: item.isKeyEvent,
      }));
    }
    return buildTimelineItems(caseRecord, events, summary, attachments, additionalInfoEntries);
  }, [additionalInfoEntries, attachments, caseRecord, events, localDraft, queueItems, summary, syncStatus]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: { flex: 1 },
        loadingContainer: {
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
        },
        loadingText: {
          marginTop: 12,
          fontSize: 14,
          color: colors.mutedForeground,
        },
        banner: {
          paddingHorizontal: 16,
          paddingVertical: 12,
          backgroundColor: colors.muted,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
        },
        bannerText: { fontSize: 14, color: colors.mutedForeground },
        content: { flex: 1, padding: 16 },
        summaryCard: { marginBottom: 16 },
        actionRow: {
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: 12,
        },
        actionButton: {
          // Full width when two labels cannot share one line.
          flexBasis: 160,
          flexGrow: 1,
        },
        factList: {
          borderColor: colors.divider,
          borderRadius: radii.md,
          borderWidth: borders.hairline,
          marginBottom: spacing.sm,
          marginTop: spacing.sm,
          paddingHorizontal: spacing.sm,
        },
        factRow: {
          alignItems: 'center',
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: spacing.xs,
          minHeight: 44,
          paddingVertical: spacing.xs,
        },
        factDivider: {
          borderTopColor: colors.divider,
          borderTopWidth: borders.hairline,
        },
        factLabel: {
          ...typography.bodySmall,
          color: colors.textSecondary,
          flexShrink: 0,
        },
        factValue: {
          ...typography.labelMedium,
          color: colors.foreground,
          // Shares the row while it fits; drops under the label with large text.
          flexBasis: 120,
          flexGrow: 1,
          textAlign: 'right',
        },
        titleRow: {
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'flex-start',
          gap: spacing.xs,
          justifyContent: 'space-between',
          marginBottom: 12,
        },
        title: {
          fontSize: 24,
          lineHeight: 30,
          fontWeight: '600',
          color: colors.foreground,
          // The status badge drops below the title when both cannot fit.
          flexBasis: 180,
          flexGrow: 1,
          flexShrink: 1,
        },
        statusBadge: {
          paddingHorizontal: 8,
          paddingVertical: 4,
          borderRadius: 12,
          borderWidth: 1,
        },
        statusText: { fontSize: 12, fontWeight: '500' },
        tagContainer: {
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: 6,
          marginBottom: 12,
        },
        tag: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8, backgroundColor: colors.secondary },
        tagText: { fontSize: 10, color: colors.secondaryForeground },
        hashText: { fontSize: 12, color: colors.foreground, fontFamily: 'Courier', flexShrink: 1 },
        detailsCard: { marginBottom: 16 },
        sectionHeader: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
        },
        sectionTitle: { fontSize: 20, lineHeight: 26, fontWeight: '600', color: colors.foreground },
        detailGroup: { marginBottom: 16 },
        detailLabel: { fontSize: 13, fontWeight: '600', color: colors.mutedForeground, marginBottom: 4 },
        detailValue: { fontSize: 16, color: colors.foreground, lineHeight: 24 },
        detailMeta: { fontSize: 12, color: colors.mutedForeground, marginTop: 4 },
        detailMetaLabel: { fontSize: 12, color: colors.mutedForeground, fontWeight: '600', marginBottom: 2 },
        detailTagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
        detailTag: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8, backgroundColor: colors.secondary },
        detailTagText: { fontSize: 10, color: colors.secondaryForeground },
        detailFollowUp: { marginTop: 8 },
        attachmentCard: { marginBottom: 16 },
        attachmentHeader: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
        },
        attachmentTitle: { fontSize: 16, fontWeight: '600', color: colors.foreground },
        attachmentRow: {
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: 8,
          padding: 12,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
        },
        attachmentRowDisabled: { opacity: 0.6 },
        attachmentInfo: { flex: 1, marginRight: 12 },
        attachmentAction: { justifyContent: 'center', alignItems: 'center' },
        attachmentName: { fontSize: 14, fontWeight: '500', color: colors.foreground },
        attachmentMeta: { fontSize: 12, color: colors.mutedForeground, marginTop: 4 },
        noticeText: {
          fontSize: 12,
          color: colors.mutedForeground,
          marginBottom: 12,
          backgroundColor: colors.muted + '20',
          padding: 10,
          borderRadius: 8,
        },
        timelineContainer: { gap: 16, marginTop: 24 },
        timelineSectionTitle: { fontSize: 16, fontWeight: '600', color: colors.foreground, marginBottom: 8 },
        timelineItem: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
        timelineDot: {
          width: 20,
          height: 20,
          borderRadius: 10,
          borderWidth: 2,
          alignItems: 'center',
          justifyContent: 'center',
          marginTop: 8,
        },
        timelineContent: { flex: 1 },
        timelineCard: { borderLeftWidth: 4, borderLeftColor: 'transparent' },
        timelineHeader: {
          flexDirection: 'row',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          marginBottom: 8,
        },
        timelineIconTitle: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
        timelineTitle: { fontSize: 16, fontWeight: '600', color: colors.foreground },
        timelineTime: { fontSize: 12, color: colors.mutedForeground },
        timelineBody: { fontSize: 14, color: colors.mutedForeground, lineHeight: 20, marginTop: 4 },
        showMoreButton: { color: colors.primary, fontWeight: '500' },
        timelineChipsContainer: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
        timelineChip: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8, backgroundColor: colors.secondary },
        timelineChipText: { fontSize: 10, color: colors.secondaryForeground },
        timelineActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
        footer: { alignItems: 'center', paddingVertical: 24, gap: 16 },
        footerText: { fontSize: 14, color: colors.mutedForeground, textAlign: 'center' },
        errorBanner: {
          marginBottom: 16,
          padding: 12,
          borderRadius: 12,
          backgroundColor: colors.destructive + '12',
          borderWidth: 1,
          borderColor: colors.destructive + '24',
        },
        errorText: { color: colors.destructive, fontSize: 13 },
        emptyState: { padding: 24, alignItems: 'center', gap: 12 },
        emptyText: { fontSize: 14, color: colors.mutedForeground, textAlign: 'center' },
        localInfoItem: {
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: 8,
          padding: 12,
          marginTop: 8,
          backgroundColor: colors.background,
        },
        localInfoBody: { fontSize: 14, color: colors.foreground, lineHeight: 20 },
        localInfoMeta: { fontSize: 12, color: colors.mutedForeground, marginTop: 6 },
        formActions: { flexDirection: 'row', gap: 12, marginTop: 4 },
      }),
    [colors],
  );

  if (isLoading) {
    return (
      <Screen>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.loadingText}>Loading case details…</Text>
        </View>
      </Screen>
    );
  }

  if (!caseRecord) {
    return (
      <Screen>
        <View style={styles.emptyState}>
          <Ionicons name="alert-circle-outline" size={32} color={colors.mutedForeground} />
          <Text style={styles.emptyText}>We couldn&apos;t find that case.</Text>
          <Button title="Go back" onPress={() => navigation.goBack()} style={{ alignSelf: 'center' }} />
        </View>
      </Screen>
    );
  }

  const isAnonymousMapRecord = detailSource.isAnonymousMapRecord;
  const localDraftFallbackAllowed = detailSource.localDraftFallbackAllowed;
  const anonymousMapSignal = detailSource.anonymousMapSignal;
  const localMediaFiles = detailSource.localMediaFiles;

  const summaryLocation = detailSource.summaryLocation;
  const mergedLocation = summaryLocation ?? (localDraftFallbackAllowed ? localDraft?.location ?? null : null);

  const locationLabel =
    mergedLocation?.description || mergedLocation?.address || mergedLocation?.type || 'Location not provided';

  const summaryDatetime = detailSource.summaryDatetime;
  const mergedDatetime = summaryDatetime ?? (localDraftFallbackAllowed ? localDraft?.datetime ?? null : null);

  const caseDateTime =
    formatSummaryDateTime(mergedDatetime ?? undefined) ?? formatDateTime(caseRecord.createdAt);

  const mediaCount = detailSource.mediaCount;

  const pathwayLabel = getPathwayLabel(summary.pathway ?? caseRecord.pathway);
  const caseHash = buildCaseHash(caseRecord.id);
  const statusLabel = statusPresentation.label;
  const impactLevelLabel = isAnonymousMapRecord
    ? null
    : typeof summary.impactLevel === 'string' && summary.impactLevel
      ? summary.impactLevel
      : localDraftFallbackAllowed && typeof localDraft?.impactLevel === 'string'
        ? localDraft.impactLevel
        : null;

  const incidentNarrative = isAnonymousMapRecord
    ? null
    : typeof summary.incidentDescription === 'string' && summary.incidentDescription.trim().length > 0
      ? summary.incidentDescription.trim()
      : localDraftFallbackAllowed && typeof localDraft?.incidentDescription === 'string' && localDraft.incidentDescription.trim().length > 0
        ? localDraft.incidentDescription.trim()
        : null;

  const impactSummaryText = isAnonymousMapRecord
    ? null
    : typeof summary.impactSummary === 'string' && summary.impactSummary.trim().length > 0
      ? summary.impactSummary.trim()
      : localDraftFallbackAllowed && typeof localDraft?.impactSummary === 'string' && localDraft.impactSummary.trim().length > 0
        ? localDraft.impactSummary.trim()
        : null;

  const patternsList = isAnonymousMapRecord
    ? detailSource.anonymousMapCategories
    : Array.isArray(summary.patterns)
      ? summary.patterns.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : localDraftFallbackAllowed && Array.isArray(localDraft?.patterns)
        ? (localDraft.patterns as string[]).filter(value => typeof value === 'string' && value.trim().length > 0)
        : [];

  const witnessIncluded = isAnonymousMapRecord
    ? null
    : typeof summary.witnesses === 'boolean'
      ? summary.witnesses
      : localDraftFallbackAllowed && typeof localDraft?.witnesses === 'boolean'
        ? localDraft.witnesses
        : null;

  const witnessDetails = isAnonymousMapRecord
    ? null
    : typeof summary.witnessDetails === 'string' && summary.witnessDetails.trim().length > 0
      ? summary.witnessDetails.trim()
      : localDraftFallbackAllowed && typeof localDraft?.witnessDetails === 'string' && localDraft.witnessDetails.trim().length > 0
        ? localDraft.witnessDetails.trim()
        : null;

  const durationValue = isAnonymousMapRecord
    ? anonymousMapSignal?.duration ?? null
    : typeof summary.duration === 'string' && summary.duration
      ? summary.duration
      : localDraftFallbackAllowed && typeof localDraft?.duration === 'string'
        ? localDraft.duration
        : null;

  const followUpAnswers = isAnonymousMapRecord
    ? null
    : (summary.followUpAnswers as Record<string, string> | null | undefined) ??
      (localDraftFallbackAllowed ? localDraft?.followUpAnswers ?? null : null);

  const followUpEntries = followUpAnswers
    ? Object.entries(followUpAnswers).filter(
        ([, value]) => typeof value === 'string' && value.trim().length > 0,
      )
    : [];

  const textEvidence = isAnonymousMapRecord
    ? null
    : typeof summary.textEvidence === 'string' && summary.textEvidence.trim().length > 0
      ? summary.textEvidence.trim()
      : localDraftFallbackAllowed && typeof localDraft?.textEvidence === 'string' && localDraft.textEvidence.trim().length > 0
        ? localDraft.textEvidence.trim()
        : null;

  const ongoingFlag = isAnonymousMapRecord
    ? anonymousMapSignal?.isOngoing ?? null
    : typeof summary.isOngoing === 'boolean'
      ? summary.isOngoing
      : localDraftFallbackAllowed && typeof localDraft?.isOngoing === 'boolean'
        ? localDraft.isOngoing
        : null;

  const immediateHelpFlag = isAnonymousMapRecord
    ? null
    : typeof summary.immediateHelp === 'boolean'
      ? summary.immediateHelp
      : localDraftFallbackAllowed && typeof localDraft?.immediateHelp === 'boolean'
        ? localDraft.immediateHelp
        : null;

  const referralSelection = isAnonymousMapRecord
    ? null
    : summary.referralSelection && typeof summary.referralSelection === 'object'
      ? summary.referralSelection
      : localDraftFallbackAllowed ? localDraft?.referralSelection ?? null : null;
  const supportContextDetails = referralSelection
    ? buildReferralCaseSupportDetails(referralSelection)
    : [];
  const fallbackProviderLabel = isAnonymousMapRecord
    ? null
    : referralSelection?.providerName ??
      (typeof summary.selectedProvider === 'string' && summary.selectedProvider.trim().length > 0
        ? summary.selectedProvider
        : localDraftFallbackAllowed ? localDraft?.selectedProvider ?? null : null);
  const fallbackChannelLabel = isAnonymousMapRecord
    ? null
    : referralSelection?.selectedChannel ??
      (typeof summary.selectedChannel === 'string'
        ? summary.selectedChannel
        : localDraftFallbackAllowed ? localDraft?.selectedChannel ?? null : null);
  const shouldShowSupportContext = !isAnonymousMapRecord && Boolean(referralSelection || fallbackProviderLabel || immediateHelpFlag);
  const referralListingIsCurrent = !referralSelection?.listingExpiresAt || (
    Number.isFinite(Date.parse(referralSelection.listingExpiresAt)) &&
    Date.parse(referralSelection.listingExpiresAt) > Date.now()
  );
  const referralContactUrl = referralSelection?.selectedChannel && referralListingIsCurrent
    ? buildReferralContactUrl(referralSelection.selectedChannel, referralSelection.phone)
    : null;

  const confirmReferralContact = () => {
    if (!referralSelection?.selectedChannel || !referralContactUrl) return;
    Alert.alert(
      `Open ${CHANNEL_LABELS[referralSelection.selectedChannel]}?`,
      'SafeRide will open another app using only the saved provider number. No report details or evidence are added, and provider receipt is not confirmed.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Open',
          onPress: () => {
            void Linking.canOpenURL(referralContactUrl)
              .then(supported => supported ? Linking.openURL(referralContactUrl) : Promise.reject(new Error('unsupported')))
              .catch(() => toast.show({
                title: 'Could not open contact app',
                message: 'Use another current provider contact method.',
                variant: 'error',
              }));
          },
        },
      ],
    );
  };

  const showAttachmentSyncNotice = detailSource.showAttachmentSyncNotice;

  const handleDownloadReport = async () => {
    toast.show({
      title: 'PDF export unavailable',
      message: PROTECTED_CASE_EXPORT_UNAVAILABLE_MESSAGE,
      variant: 'info',
    });
  };

  return (
    <Screen>
      <View style={styles.container}>
        {!isOnline && (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>
              Working offline. Notes and local records stay saved on this device.
            </Text>
          </View>
        )}

        {queueSize > 0 && (
          <View
            style={[
              styles.banner,
              {
                backgroundColor: colors.secondary + '20',
                borderBottomColor: colors.secondary + '40',
              },
            ]}
          >
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={styles.bannerText}>{syncMessage ?? `${queueSize} optional online sync item(s) saved on this device.`}</Text>
              <Button
                title={syncStatus === 'syncing' ? 'Syncing…' : 'Sync now'}
                variant="ghost"
                size="sm"
                onPress={() => syncNow()}
                disabled={syncStatus === 'syncing'}
              />
            </View>
          </View>
        )}

        <ScrollView
          style={styles.content}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.primary} />
          }
        >
          {fetchError && (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>{fetchError}</Text>
            </View>
          )}

          <Card variant="elevated" style={styles.summaryCard}>
            <CardContent>
              <View style={styles.titleRow}>
                <Text style={styles.title}>
                  {isAnonymousMapRecord
                    ? `Map update record - ${formatDateTime(caseRecord.createdAt)}`
                    : summary.incidentDescription && summary.incidentDescription.trim().length > 0
                      ? summary.incidentDescription.trim()
                      : `Case - ${formatDateTime(caseRecord.createdAt)}`}
                </Text>
                <View
                  style={[
                    styles.statusBadge,
                    {
                      backgroundColor: statusColor + '20',
                      borderColor: statusColor + '40',
                    },
                  ]}
                >
                  <Text style={[styles.statusText, { color: statusColor }]}>{statusLabel}</Text>
                </View>
              </View>

              <Text style={styles.noticeText}>
                {statusPresentation.description} Next action: {statusPresentation.nextActionDescription}
              </Text>

              <View style={styles.factList}>
                {[
                  { key: 'pathway', icon: 'git-branch-outline' as const, label: 'Pathway', value: pathwayLabel },
                  { key: 'media', icon: 'images-outline' as const, label: 'Media', value: mediaCount > 0 ? `${mediaCount} item(s)` : 'None' },
                  { key: 'captured', icon: 'calendar-outline' as const, label: 'Captured', value: caseDateTime },
                  { key: 'location', icon: 'location-outline' as const, label: 'Location', value: locationLabel },
                  { key: 'updated', icon: 'time-outline' as const, label: 'Last updated', value: formatDateTime(caseRecord.updatedAt) },
                  ...(witnessIncluded !== null
                    ? [{ key: 'witness', icon: 'people-outline' as const, label: 'Witness information', value: witnessIncluded ? 'Included' : 'Not provided' }]
                    : []),
                ].map((fact, index) => (
                  <View
                    key={fact.key}
                    style={[styles.factRow, index > 0 && styles.factDivider]}
                    accessible
                    accessibilityLabel={`${fact.label}: ${fact.value}`}
                  >
                    <Ionicons name={fact.icon} size={16} color={colors.mutedForeground} />
                    <Text style={styles.factLabel}>{fact.label}</Text>
                    <Text style={styles.factValue}>{fact.value}</Text>
                  </View>
                ))}
                <View
                  style={[styles.factRow, styles.factDivider]}
                  accessible
                  accessibilityLabel={`Case reference: ${caseHash}`}
                >
                  <Ionicons name="finger-print-outline" size={16} color={colors.mutedForeground} />
                  <Text style={styles.factLabel}>Case reference</Text>
                  <Text style={[styles.factValue, styles.hashText]}>{caseHash}</Text>
                </View>
              </View>

              {tags.length > 0 && (
                <View style={styles.tagContainer}>
                  {tags.map(tag => (
                    <View key={tag as string} style={styles.tag}>
                      <Text style={styles.tagText}>{tag}</Text>
                    </View>
                  ))}
                </View>
              )}

              <View style={styles.actionRow}>
                <Button
                  title="Export record"
                  onPress={handleExport}
                  variant="outline"
                  style={styles.actionButton}
                />
                {canEditLocalCase ? (
                  <Button
                    title="Edit"
                    onPress={handleEditLocalCase}
                    variant="outline"
                    style={styles.actionButton}
                  />
                ) : (
                  <Button
                    title="Add info"
                    onPress={handleOpenAddInfo}
                    variant="outline"
                    style={styles.actionButton}
                    disabled={!canAddAdditionalInfo}
                  />
                )}
              </View>

              <View style={[styles.actionRow, { marginTop: 12 }]}>
                {canCloseLocalCase ? (
                  <Button
                    title="Close"
                    onPress={() => void handleCloseLocalCase()}
                    variant="ghost"
                    style={styles.actionButton}
                  />
                ) : (
                  <Button title="Redaction panel" onPress={handleRedact} variant="ghost" style={styles.actionButton} />
                )}
                <Button
                  title={
                    isLocalCaseDetail
                      ? 'Delete local'
                      : 'Remote deletion unavailable'
                  }
                  onPress={handleDelete}
                  variant="destructive"
                  style={styles.actionButton}
                />
              </View>
          </CardContent>
        </Card>

          {partnerSummary ? (
            <Card variant="elevated" style={styles.detailsCard}>
              <CardContent>
                <View style={styles.sectionHeader}>
                  <Text style={styles.sectionTitle}>{PARTNER_SHARING_COPY.caseDetail.cardTitle}</Text>
                </View>
                <View style={styles.factList}>
                  {[
                    { key: 'status', label: PARTNER_SHARING_COPY.caseDetail.statusLabel, value: partnerSummary.label },
                    ...(partnerSummary.reference
                      ? [{ key: 'reference', label: PARTNER_SHARING_COPY.caseDetail.referenceLabel, value: partnerSummary.reference }]
                      : []),
                    ...(partnerSummary.stopSharing === 'available' || partnerSummary.callbackShared
                      ? [{
                          key: 'callback',
                          label: PARTNER_SHARING_COPY.caseDetail.callbackLabel,
                          value: partnerSummary.callbackShared
                            ? PARTNER_SHARING_COPY.caseDetail.callbackShared
                            : PARTNER_SHARING_COPY.caseDetail.callbackNotShared,
                        }]
                      : []),
                  ].map((fact, index) => (
                    <View
                      key={fact.key}
                      style={[styles.factRow, index > 0 && styles.factDivider]}
                      accessible
                      accessibilityLabel={`${fact.label}: ${fact.value}`}
                    >
                      <Text style={styles.factLabel}>{fact.label}</Text>
                      <Text style={styles.factValue}>{fact.value}</Text>
                    </View>
                  ))}
                </View>
                {partnerSummary.reference && partnerSummary.state !== 'withdrawn' ? (
                  <Text style={styles.noticeText}>{PARTNER_SHARING_COPY.timeline.callHint}</Text>
                ) : null}
                {partnerSummary.attentionMessage ? (
                  <>
                    <Text style={styles.noticeText}>{partnerSummary.attentionMessage}</Text>
                    {localDraft ? (
                      <Button
                        title={PARTNER_SHARING_COPY.caseDetail.reviewSharing}
                        variant="outline"
                        onPress={handleReviewPartnerSharing}
                        style={{ marginTop: 12 }}
                      />
                    ) : null}
                  </>
                ) : null}
                {partnerSummary.stopSharing === 'available' ? (
                  <Button
                    title={PARTNER_SHARING_COPY.caseDetail.stopButton}
                    variant="destructive"
                    onPress={() => void handleStopPartnerSharing()}
                    loading={isStoppingPartnerSharing}
                    disabled={isStoppingPartnerSharing}
                    style={{ marginTop: 12 }}
                  />
                ) : partnerSummary.stopSharing === 'all_reports' ? (
                  <>
                    <Text style={styles.noticeText}>{PARTNER_SHARING_COPY.caseDetail.stopUnavailableBody}</Text>
                    <Button
                      title={PARTNER_SHARING_COPY.caseDetail.stopAllButton}
                      variant="destructive"
                      onPress={() => void handleStopAllPartnerSharing()}
                      loading={isStoppingPartnerSharing}
                      disabled={isStoppingPartnerSharing}
                      style={{ marginTop: 12 }}
                    />
                  </>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          {canAddAdditionalInfo && (
            <Card variant="elevated" style={styles.detailsCard}>
              <CardContent>
                <View style={styles.sectionHeader}>
                  <Text style={styles.sectionTitle}>Additional information</Text>
                  {!isAddInfoFormOpen && (
                    <Button title="Add" onPress={handleOpenAddInfo} variant="ghost" size="sm" />
                  )}
                </View>

                <Text style={styles.noticeText}>
                  Updates saved here stay on this device and appear in the timeline. Sending them to a provider is unavailable until a reviewed case update API exists.
                </Text>

                {isAddInfoFormOpen && (
                  <View style={styles.detailGroup}>
                    <Textarea
                      label="Information to add"
                      value={addInfoBody}
                      onChangeText={value => {
                        setAddInfoBody(value);
                        if (addInfoError) setAddInfoError(null);
                      }}
                      placeholder="Add a new detail, correction, or follow-up note."
                      rows={5}
                      error={addInfoError ?? undefined}
                      helperText="Saved locally to this case timeline."
                      disabled={isSavingAddInfo}
                    />
                    <View style={styles.formActions}>
                      <Button
                        title="Cancel"
                        onPress={() => {
                          setIsAddInfoFormOpen(false);
                          setAddInfoError(null);
                        }}
                        variant="ghost"
                        style={{ flex: 1 }}
                        disabled={isSavingAddInfo}
                      />
                      <Button
                        title="Save info"
                        onPress={handleSaveAdditionalInfo}
                        style={{ flex: 1 }}
                        loading={isSavingAddInfo}
                        disabled={isSavingAddInfo || addInfoBody.trim().length === 0}
                      />
                    </View>
                  </View>
                )}

                {additionalInfoEntries.length > 0 ? (
                  <View style={styles.detailGroup}>
                    <Text style={styles.detailLabel}>Saved updates</Text>
                    {additionalInfoEntries.slice(0, 3).map(entry => (
                      <View key={entry.id} style={styles.localInfoItem}>
                        <Text style={styles.localInfoBody}>{entry.body}</Text>
                        <Text style={styles.localInfoMeta}>
                          {getAdditionalInfoStatusLabel(entry.status)} • {formatDateTime(entry.createdAt)}
                        </Text>
                      </View>
                    ))}
                  </View>
                ) : (
                  <Text style={styles.attachmentMeta}>No additional information saved yet.</Text>
                )}
              </CardContent>
            </Card>
          )}

          {shouldShowSupportContext && (
            <Card variant="elevated" style={styles.detailsCard}>
              <CardContent>
                <View style={styles.sectionHeader}>
                  <Text style={styles.sectionTitle}>Support context</Text>
                  <Button title="Tips & rights" onPress={() => navigation.navigate('TipsRights')} variant="ghost" size="sm" />
                </View>

                {referralSelection ? (
                  <View style={styles.detailGroup}>
                    <Text style={styles.detailLabel}>Referral provider</Text>
                    {supportContextDetails.map(detail => (
                      <Text key={detail} style={styles.detailMeta}>{detail}</Text>
                    ))}
                    {referralContactUrl && referralSelection.selectedChannel ? (
                      <Button
                        title={`Open ${CHANNEL_LABELS[referralSelection.selectedChannel]}`}
                        onPress={confirmReferralContact}
                        variant="outline"
                        size="sm"
                      />
                    ) : null}
                  </View>
                ) : fallbackProviderLabel ? (
                  <View style={styles.detailGroup}>
                    <Text style={styles.detailLabel}>Referral provider</Text>
                    <Text style={styles.detailValue}>{fallbackProviderLabel}</Text>
                    {fallbackChannelLabel ? (
                      <Text style={styles.detailMeta}>Channel: {fallbackChannelLabel}</Text>
                    ) : null}
                    <Text style={styles.detailMeta}>Provider receipt is not confirmed from this case view.</Text>
                  </View>
                ) : null}

                {immediateHelpFlag ? (
                  <Text style={styles.noticeText}>
                    Immediate help was marked during reporting. Review current support contacts or tips if the situation has changed.
                  </Text>
                ) : null}

                <Text style={styles.noticeText}>
                  Support context is saved for review only. It does not confirm that a provider, lawyer, advocate, or emergency service received this case.
                </Text>
              </CardContent>
            </Card>
          )}
          <Card variant="elevated" style={styles.detailsCard}>
            <CardContent>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>{isAnonymousMapRecord ? 'Map update record' : 'Report details'}</Text>
                <TouchableOpacity
                  onPress={handleDownloadReport}
                  accessibilityRole="button"
                  accessibilityLabel="PDF export unavailable"
                >
                  <Ionicons name="download-outline" size={20} color={colors.primary} />
                </TouchableOpacity>
              </View>

              {isAnonymousMapRecord && (
                <>
                  <View style={styles.detailGroup}>
                    <Text style={styles.detailLabel}>Remote record scope</Text>
                    <Text style={styles.detailValue}>
                      Submitted through the signed-in case service and linked to this account and saved draft ID.
                    </Text>
                    <Text style={styles.detailMeta}>
                      This release does not publish or update a live route-safety map.
                    </Text>
                  </View>

                  <View style={styles.detailGroup}>
                    <Text style={styles.detailLabel}>What was sent</Text>
                    <Text style={styles.detailValue}>
                      Saved location, incident time when provided, duration/ongoing status when provided, and raw category/tag values.
                    </Text>
                    <Text style={styles.detailMeta}>
                      Evidence files, statement text, and incident narrative were not sent for this pathway.
                    </Text>
                  </View>
                </>
              )}

              {!isAnonymousMapRecord && (
                <View style={styles.detailGroup}>
                  <Text style={styles.detailLabel}>What happened</Text>
                  <Text style={styles.detailValue}>
                    {incidentNarrative ?? 'No description provided.'}
                  </Text>
                </View>
              )}

              {impactSummaryText && (
                <View style={styles.detailGroup}>
                  <Text style={styles.detailLabel}>Impact</Text>
                  <Text style={styles.detailValue}>{impactSummaryText}</Text>
                </View>
              )}

              {impactLevelLabel && (
                <View style={styles.detailGroup}>
                  <Text style={styles.detailLabel}>Impact level</Text>
                  <Text style={styles.detailValue}>{capitalize(impactLevelLabel)}</Text>
                </View>
              )}

              {patternsList.length > 0 && (
                <View style={styles.detailGroup}>
                  <Text style={styles.detailLabel}>{isAnonymousMapRecord ? 'Category tags sent' : 'Pattern tags'}</Text>
                  <View style={styles.detailTagRow}>
                    {patternsList.map(pattern => (
                      <View key={pattern} style={styles.detailTag}>
                        <Text style={styles.detailTagText}>{pattern}</Text>
                      </View>
                    ))}
                  </View>
                </View>
              )}

              <View style={styles.detailGroup}>
                <Text style={styles.detailLabel}>{isAnonymousMapRecord ? 'Saved location sent' : 'Where it happened'}</Text>
                <Text style={styles.detailValue}>{locationLabel}</Text>
                {mergedLocation?.type && (
                  <Text style={styles.detailMeta}>Context: {capitalize(mergedLocation.type)}</Text>
                )}
                {mergedLocation?.coordinates &&
                  typeof mergedLocation.coordinates.latitude === 'number' &&
                  typeof mergedLocation.coordinates.longitude === 'number' && (
                    <Text style={styles.detailMeta}>
                      Saved coordinates: {mergedLocation.coordinates.latitude.toFixed(4)},{' '}
                      {mergedLocation.coordinates.longitude.toFixed(4)}
                    </Text>
                  )}
              </View>

              <View style={styles.detailGroup}>
                <Text style={styles.detailLabel}>{isAnonymousMapRecord ? 'Incident time sent' : 'When it happened'}</Text>
                <Text style={styles.detailValue}>{caseDateTime}</Text>
                {mergedDatetime?.accuracy && mergedDatetime.accuracy !== 'exact' && (
                  <Text style={styles.detailMeta}>Reported accuracy: {capitalize(mergedDatetime.accuracy)}</Text>
                )}
                {durationValue && <Text style={styles.detailMeta}>Duration: {capitalize(durationValue)}</Text>}
                {ongoingFlag !== null && (
                  <Text style={styles.detailMeta}>
                    {ongoingFlag ? 'Incident marked as ongoing or repeated.' : 'Incident marked as a single event.'}
                  </Text>
                )}
              </View>

              {witnessIncluded !== null && (
                <View style={styles.detailGroup}>
                  <Text style={styles.detailLabel}>Witnesses</Text>
                  <Text style={styles.detailValue}>
                    {witnessIncluded ? 'Witness information provided.' : 'No witnesses recorded.'}
                  </Text>
                  {witnessDetails && <Text style={styles.detailMeta}>{witnessDetails}</Text>}
                </View>
              )}

              {textEvidence && (
                <View style={styles.detailGroup}>
                  <Text style={styles.detailLabel}>Additional notes</Text>
                  <Text style={styles.detailValue}>{textEvidence}</Text>
                </View>
              )}

              {followUpEntries.length > 0 && (
                <View style={styles.detailGroup}>
                  <Text style={styles.detailLabel}>Follow-up answers</Text>
                  {followUpEntries.map(([question, answer]) => (
                    <View key={question} style={styles.detailFollowUp}>
                      <Text style={styles.detailMetaLabel}>{capitalize(question)}</Text>
                      <Text style={styles.detailValue}>{answer}</Text>
                    </View>
                  ))}
                </View>
              )}

              {immediateHelpFlag !== null && (
                <View style={styles.detailGroup}>
                  <Text style={styles.detailLabel}>Immediate help</Text>
                  <Text style={styles.detailValue}>
                    {immediateHelpFlag
                      ? 'You asked for urgent assistance when filing this report.'
                      : 'No emergency assistance was requested.'}
                  </Text>
                </View>
              )}
            </CardContent>
          </Card>

          <Card variant="elevated" style={styles.attachmentCard}>
            <CardContent>
              <View style={styles.attachmentHeader}>
                <Text style={styles.attachmentTitle}>Evidence attachments</Text>
                <Ionicons name="folder-outline" size={20} color={colors.mutedForeground} />
              </View>
              {isAnonymousMapRecord ? (
                <Text style={styles.attachmentMeta}>
                  No evidence files were uploaded for this map update record. Local draft evidence, if any, stays on this device and is not shown as synced for this case.
                </Text>
              ) : (
                <>
                  {showAttachmentSyncNotice && (
                    <Text style={styles.noticeText}>
                      Evidence records are saved, but attachments are not currently available to download.
                      {isOnline ? ' Try refreshing to load attachments.' : ' Reconnect to view or share evidence.'}
                    </Text>
                  )}
                  {attachments.length > 0
                ? attachments.map((attachment, index) => {
                    const fileName =
                      (attachment.metadata?.displayName as string | undefined) ??
                      `Evidence ${index + 1}`;
                    const isDownloading = downloadingAttachmentId === attachment.id;
                    const availability = getAttachmentAvailability(attachment);
                    return (
                      <TouchableOpacity
                        key={attachment.id}
                        style={[
                          styles.attachmentRow,
                          isDownloading && styles.attachmentRowDisabled,
                        ]}
                        onPress={() => handleOpenAttachment(attachment)}
                        disabled={isDownloading || !availability.available}
                      >
                        <View style={styles.attachmentInfo}>
                          <Text style={styles.attachmentName}>{fileName}</Text>
                          <Text style={styles.attachmentMeta}>
                            {attachment.mimeType ?? 'Unknown type'} • {formatAttachmentSize(attachment.sizeBytes)}
                          </Text>
                          <Text style={styles.attachmentMeta}>
                            Uploaded {formatDateTime(attachment.createdAt)}
                          </Text>
                          <Text style={styles.attachmentMeta}>{availability.label}</Text>
                        </View>
                        <View style={styles.attachmentAction}>
                          {isDownloading ? (
                            <ActivityIndicator size="small" color={colors.primary} />
                          ) : (
                            <Ionicons
                              name={availability.available ? 'download-outline' : 'lock-closed-outline'}
                              size={18}
                              color={availability.available ? colors.primary : colors.mutedForeground}
                            />
                          )}
                        </View>
                      </TouchableOpacity>
                    );
                  })
                : localMediaFiles.length > 0
                ? localMediaFiles.map(media => {
                    const localAttachmentId = `local-${media.id}`;
                    const isOpening = downloadingAttachmentId === localAttachmentId;
                    return (
                      <TouchableOpacity
                        key={localAttachmentId}
                        style={[
                          styles.attachmentRow,
                          isOpening && styles.attachmentRowDisabled,
                        ]}
                        onPress={() => handleOpenLocalAttachment(media)}
                        disabled={isOpening}
                      >
                        <View style={styles.attachmentInfo}>
                          <Text style={styles.attachmentName}>{media.fileName ?? 'Evidence file'}</Text>
                          <Text style={styles.attachmentMeta}>
                            {media.mimeType ?? media.type} • {formatAttachmentSize(media.size)}
                          </Text>
                          {media.timestamp && (
                            <Text style={styles.attachmentMeta}>
                              Captured{' '}
                              {formatDateTime(
                                media.timestamp instanceof Date ? media.timestamp : new Date(media.timestamp),
                              )}
                            </Text>
                          )}
                        </View>
                        <View style={styles.attachmentAction}>
                          {isOpening ? (
                            <ActivityIndicator size="small" color={colors.primary} />
                          ) : (
                            <Ionicons name="open-outline" size={18} color={colors.primary} />
                          )}
                        </View>
                      </TouchableOpacity>
                    );
                  })
                : (
                  <Text style={styles.attachmentMeta}>No evidence has been uploaded for this case.</Text>
                )}
                </>
              )}
            </CardContent>
          </Card>

          <View style={styles.timelineContainer}>
            <Text style={styles.timelineSectionTitle}>Timeline</Text>
            {timelineItems.length === 0 ? (
              <Text style={styles.attachmentMeta}>
                No events recorded yet. Updates will appear here as they happen.
              </Text>
            ) : (
              timelineItems.map(item => {
                const isExpanded = expandedItems.has(item.id);
                const bodyText = item.body || 'No additional details available.';
                const shouldTruncate = bodyText.length > 160;

                return (
                  <View key={item.id} style={styles.timelineItem}>
                    <View
                      style={[
                        styles.timelineDot,
                        {
                          borderColor: item.isKeyEvent ? colors.primary : colors.border,
                        },
                      ]}
                    >
                      {item.isKeyEvent && <Ionicons name="checkmark" size={10} color={colors.primary} />}
                    </View>

                    <Card variant="outlined" style={[styles.timelineContent, styles.timelineCard]}>
                      <CardContent>
                        <View style={styles.timelineHeader}>
                          <View style={styles.timelineIconTitle}>
                            <Ionicons
                              name={getTimelineIcon(item.type)}
                              size={16}
                              color={colors.mutedForeground}
                            />
                            <Text style={styles.timelineTitle}>{item.title}</Text>
                          </View>
                          <Text style={styles.timelineTime}>{item.time}</Text>
                        </View>

                        <Text style={styles.timelineBody}>
                          {shouldTruncate && !isExpanded
                            ? `${bodyText.substring(0, 160)}…`
                            : bodyText}
                          {shouldTruncate && (
                            <Text
                              style={styles.showMoreButton}
                              onPress={() => toggleItemExpanded(item.id)}
                            >
                              {isExpanded ? ' Show less' : ' Show more'}
                            </Text>
                          )}
                        </Text>

                        {item.chips && item.chips.length > 0 && (
                          <View style={styles.timelineChipsContainer}>
                            {item.chips.map(chip => (
                              <View key={chip} style={styles.timelineChip}>
                                <Text style={styles.timelineChipText}>{chip}</Text>
                              </View>
                            ))}
                          </View>
                        )}

                        {item.actions && item.actions.length > 0 && (
                          <View style={styles.timelineActions}>
                            {item.actions.map(action => (
                              <Button
                                key={action.label}
                                title={action.label}
                                onPress={action.onClick}
                                variant="ghost"
                                size="sm"
                              />
                            ))}
                          </View>
                        )}
                      </CardContent>
                    </Card>
                  </View>
                );
              })
            )}
          </View>

          <View style={styles.footer}>
            <Text style={styles.footerText}>
              Privacy controls show what can be removed locally and what requires a reviewed request.
            </Text>
            <Button
              title="Privacy & retention settings"
              onPress={() => navigation.navigate('PrivacyData')}
              variant="ghost"
              size="sm"
            />
          </View>
        </ScrollView>
      </View>
    </Screen>
  );
}
