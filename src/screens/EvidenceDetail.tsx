import React, { useEffect, useMemo, useState } from 'react';
import { getReportNavigationStyles } from '../components/report/reportNavigationStyles';
import { View, Text, StyleSheet, ScrollView, Image, Pressable, TouchableOpacity, useWindowDimensions } from 'react-native';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from 'expo-audio';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { ReportWizardProgress } from '../components/report/ReportWizardProgress';
import Screen from '../components/ui/Screen';
import Button from '../components/ui/Button';
import { Card, CardContent } from '../components/ui/Card';
import { ReportStepHeader } from '../components/report/ReportStepHeader';
import { Textarea } from '../components/ui/Textarea';
import { Alert as AlertComponent } from '../components/ui/Alert';
import { Badge } from '../components/ui/Badge';
import { Switch } from '../components/ui/Switch';
import { ActionSheet, InfoModal, InfoModalSection } from '../components/ui';
import { EmptyState, OfflineBanner } from '../components/ui/SystemStates';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme/SimpleThemeProvider';
import { RootStackParamList } from '../navigation/routes';
import { pushReportRoute } from '../navigation/reportNavigation';
import { useReportWizardBack } from '../navigation/reportWizardBack';
import {
  getOptionalReportStepSkipTarget,
  type ReportWizardOptionalSkipTarget,
} from '../navigation/reportPathwayFlow';
import { useToast } from '../components/ui/Toast';
import { useCompletedReportRedirect } from '../hooks/useCompletedReportRedirect';
import { useDraftState } from '../hooks/useDraftState';
import { useReportDraftIdentity } from '../hooks/useReportDraftIdentity';
import { useOnline } from '../context/OnlineProvider';
import { borders, spacing, radii, typography } from '../theme/tokens';
import type {
  EvidencePrivacyProcessingStatus,
  EvidencePrivacySettings,
  EvidencePrivacyStatusMap,
} from '../utils/evidencePrivacyStatus';
import {
  normalizeMediaPrivacyStatuses,
  resolveEvidencePrivacySettingsForDraft,
  SAFE_DEFAULT_EVIDENCE_PRIVACY_SETTINGS,
} from '../utils/evidencePrivacyStatus';
import type { EvidenceVaultCaptureSource } from '../utils/evidenceVaultStatus';
import {
  buildEvidenceVaultItem,
  getEvidenceVaultMediaTypeFromPickerAsset,
  getEvidenceVaultStatusVariant,
  getEvidenceVaultUploadIncludedForDraft,
} from '../utils/evidenceVaultStatus';
import PhotoAnnotationOverlay, { usePhotoAnnotation, AnnotationPoint } from '../components/ui/PhotoAnnotationOverlay';
import { transcribeAudio, TranscriptionError } from '../services/transcriptionService';
import { captureMeasurementEvent } from '../lib/measurement/localEventStore';
import { addPersistentEvidence, reconcileEvidenceDraft, removePersistentEvidence, type EvidenceDraftEdits } from '../utils/evidenceFiles';
import { useAppReset } from '../utils/appReset';
import { draftStorage } from '../utils/draftStorage';

type EvidenceDetailNavigationProp = NativeStackNavigationProp<RootStackParamList, 'EvidenceDetail'>;
type EvidenceDetailRouteProp = RouteProp<RootStackParamList, 'EvidenceDetail'>;

interface MediaFile {
  id: string;
  type: 'photo' | 'audio' | 'video' | 'document';
  uri: string;
  fileName: string;
  size: number;
  timestamp: Date;
  description?: string;
  captureSource?: EvidenceVaultCaptureSource | string;
  isFromStealth?: boolean;
  annotations?: AnnotationPoint[];
  transcript?: string;
  storagePath?: string;
  mimeType?: string;
  uploadedAt?: Date;
  checksum?: string;
  privacyStatus?: EvidencePrivacyStatusMap;
  uploadStatus?: 'pending' | 'uploaded' | 'failed';
  uploadError?: string;
}

interface EvidenceData {
  mediaFiles: MediaFile[];
  textEvidence: string;
  privacySettings: Required<EvidencePrivacySettings>;
  stealthModeActive: boolean;
}

// Off until a draft's saved choice loads: these requests are not processed in
// this build, so switching them on by default only held photos back.
const DEFAULT_EVIDENCE_PRIVACY_SETTINGS: Required<EvidencePrivacySettings> = SAFE_DEFAULT_EVIDENCE_PRIVACY_SETTINGS;

export default function EvidenceDetailScreen() {
  const navigation = useNavigation<EvidenceDetailNavigationProp>();
  const route = useRoute<EvidenceDetailRouteProp>();
  const { colors } = useTheme();
  const toast = useToast();
  const photoAnnotation = usePhotoAnnotation();
  const { width: viewportWidth } = useWindowDimensions();
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recordingRef = React.useRef<typeof audioRecorder | null>(null);
  
  const [evidenceData, setEvidenceState] = useState<EvidenceData>({
    mediaFiles: [],
    textEvidence: '',
    privacySettings: DEFAULT_EVIDENCE_PRIVACY_SETTINGS,
    stealthModeActive: false,
  });
  const evidenceDataRef = React.useRef(evidenceData);
  const setEvidenceData = (update: React.SetStateAction<EvidenceData>) => {
    const next = typeof update === 'function' ? update(evidenceDataRef.current) : update;
    evidenceDataRef.current = next;
    setEvidenceState(next);
  };

  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [transcriptionState, setTranscriptionState] = useState<Record<string, {
    status: 'idle' | 'loading' | 'success' | 'error';
    errorMessage?: string;
  }>>({});
  const [isUploadSheetVisible, setIsUploadSheetVisible] = useState(false);
  const [isPrivacyDetailsVisible, setIsPrivacyDetailsVisible] = useState(false);
  const [activeMediaDetailsId, setActiveMediaDetailsId] = useState<string | null>(null);
  const [isAddingEvidence, setIsAddingEvidence] = useState(false);
  const evidenceGeneration = React.useRef(0);
  const evidenceBusy = React.useRef(false);
  const evidenceFocused = React.useRef(false);
  const evidenceEdits = React.useRef<EvidenceDraftEdits>({});

  const routeDraftId = typeof route.params?.draftId === 'string' && route.params.draftId.trim()
    ? route.params.draftId
    : undefined;
  const {
    draftId: initialDraftId,
    isResolving: isResolvingDraftId,
    error: draftIdError,
  } = useReportDraftIdentity(routeDraftId, { initialStep: 'EvidenceDetail' });
  const isEditingCompleted = route.params?.editCompleted === true;
  const { draftData, updateDraft, saveDraftPatch, isSaving, lastSaved, error } = useDraftState(initialDraftId);
  useCompletedReportRedirect(navigation, draftData, { enabled: !isEditingCompleted });
  const { isOnline } = useOnline();
  const invalidateEvidenceSelection = React.useCallback(() => {
    evidenceGeneration.current += 1;
    evidenceBusy.current = false;
    setIsAddingEvidence(false);
  }, []);
  const applyPersistedEvidence = React.useCallback((draft: NonNullable<typeof draftData>) => {
    const reconciled = reconcileEvidenceDraft(draft, evidenceEdits.current);
    const next = { ...evidenceDataRef.current, ...reconciled,
      stealthModeActive: reconciled.mediaFiles.some(file => file.isFromStealth || file.captureSource === 'stealth_auto') };
    evidenceDataRef.current = next;
    setEvidenceState(next);
    // Update the hook reference before its next blur flush; no second write.
    void updateDraft(reconciled);
    return next;
  }, [updateDraft]);
  const refreshEvidence = React.useCallback(async () => {
    if (!initialDraftId) return null;
    const generation = evidenceGeneration.current;
    const draft = await draftStorage.getDraft(initialDraftId);
    if (!draft || !evidenceFocused.current || evidenceGeneration.current !== generation) return null;
    return applyPersistedEvidence(draft);
  }, [initialDraftId, applyPersistedEvidence]);
  const reportEvidenceSaveError = () => toast.show({ title: 'Evidence save incomplete', message: 'Try again before continuing.', variant: 'error' });
  useFocusEffect(React.useCallback(() => {
    evidenceFocused.current = true;
    void refreshEvidence().catch(() => undefined);
    return () => { evidenceFocused.current = false; invalidateEvidenceSelection(); };
  }, [invalidateEvidenceSelection, refreshEvidence]));
  useAppReset(invalidateEvidenceSelection);
  useEffect(() => draftStorage.subscribe(event => {
    if (event.type === 'clear' || event.type === 'replace' || (event.type === 'delete' && event.draftId === initialDraftId)) {
      invalidateEvidenceSelection();
    }
    if (event.type === 'save' && event.draftId === initialDraftId && evidenceFocused.current) {
      void refreshEvidence().catch(() => undefined);
    }
  }), [initialDraftId, invalidateEvidenceSelection, refreshEvidence]);
  const goBackToWhereWhen = useReportWizardBack(navigation, initialDraftId ? {
    route: 'WhereWhen',
    params: { draftId: initialDraftId, ...(isEditingCompleted ? { editCompleted: true } : {}) },
  } : undefined);

  useEffect(() => {
    if (initialDraftId && !routeDraftId) {
      navigation.setParams({ draftId: initialDraftId });
    }
  }, [initialDraftId, navigation, routeDraftId]);

  useEffect(() => {
    if (draftData) {
      evidenceEdits.current = {};
      setEvidenceData(prev => {
        const privacySettings = resolveEvidencePrivacySettingsForDraft(draftData.privacySettings);
        const mediaFiles = normalizeMediaPrivacyStatuses(draftData.mediaFiles || [], privacySettings) || [];

        return {
          ...prev,
          mediaFiles,
          textEvidence: draftData.textEvidence || '',
          privacySettings,
          stealthModeActive: mediaFiles.some(file => file.isFromStealth || file.captureSource === 'stealth_auto'),
        };
      });
    }
  }, [draftData?.id]);

  const persistEvidenceEdits = async () => {
    if (!initialDraftId) return null;
    const generation = evidenceGeneration.current;
    const edits = evidenceEdits.current;
    if (!Object.keys(edits).length) return refreshEvidence();
    const saved = await draftStorage.updateExistingDraft(initialDraftId, draft => {
      const reconciled = reconcileEvidenceDraft(draft, edits);
      return {
        ...(edits.media || edits.privacySettings ? { mediaFiles: reconciled.mediaFiles } : {}),
        ...(edits.textEvidence !== undefined ? { textEvidence: reconciled.textEvidence } : {}),
        ...(edits.privacySettings ? { privacySettings: reconciled.privacySettings } : {}),
      };
    });
    if (!saved) return null;
    if (evidenceGeneration.current !== generation) return null;
    // Leave any newer edits in place while acknowledging exactly this save.
    const pendingMedia = { ...evidenceEdits.current.media };
    const remaining: EvidenceDraftEdits = { ...evidenceEdits.current, media: pendingMedia };
    for (const [id, fields] of Object.entries(edits.media ?? {})) {
      const pending = { ...pendingMedia[id] };
      for (const key of Object.keys(fields) as Array<keyof typeof fields>) {
        if (pending[key] === fields[key]) delete pending[key];
      }
      if (Object.keys(pending).length) pendingMedia[id] = pending;
      else delete pendingMedia[id];
    }
    if (!Object.keys(pendingMedia).length) delete remaining.media;
    if (remaining.textEvidence === edits.textEvidence) delete remaining.textEvidence;
    if (remaining.privacySettings === edits.privacySettings) delete remaining.privacySettings;
    evidenceEdits.current = remaining;
    return evidenceFocused.current ? applyPersistedEvidence(saved) : null;
  };

  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    if (isRecording) {
      interval = setInterval(() => {
        setRecordingDuration(prev => prev + 1);
      }, 1000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isRecording]);

  const uploadIncluded = useMemo(() => getEvidenceVaultUploadIncludedForDraft(draftData), [
    draftData?.selectedPathway,
    draftData?.includeBrief,
    draftData?.referralSelection?.includeBrief,
  ]);

  const hasEvidenceContent = evidenceData.mediaFiles.length > 0 || evidenceData.textEvidence.trim().length > 0;
  const optionalSkipTarget = !hasEvidenceContent
    ? getOptionalReportStepSkipTarget(draftData, 'EvidenceDetail')
    : undefined;

  const mediaCardWidth = Math.min(280, Math.max(228, viewportWidth - 72));

  const ensureCameraPermission = async () => {
    const current = await ImagePicker.getCameraPermissionsAsync();
    if (current.granted) return true;

    if (current.status === 'denied' && current.canAskAgain === false) {
      toast.show({
        title: 'Camera permission unavailable',
        message: 'You can still add text evidence, documents, or imported media.',
        variant: 'error',
      });
      return false;
    }

    const requested = await ImagePicker.requestCameraPermissionsAsync();
    if (!requested.granted) {
      toast.show({
        title: 'Camera permission not granted',
        message: 'Text evidence and file import remain available.',
        variant: 'error',
      });
      return false;
    }

    return true;
  };

  const ensureMediaLibraryPermission = async () => {
    const current = await ImagePicker.getMediaLibraryPermissionsAsync();
    if (current.granted) return true;

    if (current.status === 'denied' && current.canAskAgain === false) {
      toast.show({
        title: 'Media permission unavailable',
        message: 'You can still write text evidence or attach documents.',
        variant: 'error',
      });
      return false;
    }

    const requested = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!requested.granted) {
      toast.show({
        title: 'Media permission not granted',
        message: 'Text evidence and document upload remain available.',
        variant: 'error',
      });
      return false;
    }

    return true;
  };

  const styles = StyleSheet.create({
    ...getReportNavigationStyles(colors),
    screenRoot: {
      flex: 1,
    },
    scroll: {
      flex: 1,
    },
    contentContainer: {
      paddingHorizontal: 16,
      paddingTop: 16,
      paddingBottom: spacing.md,
      gap: 16,
    },
    sectionBlock: {
      gap: spacing.xs,
    },
    sectionTitle: {
      ...typography.titleMedium,
      color: colors.foreground,
    },
    sectionCaption: {
      ...typography.bodySmall,
      color: colors.textSecondary,
    },
    uploadPanel: {
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderColor: colors.primary,
      borderRadius: radii.card,
      borderStyle: 'dashed',
      borderWidth: borders.emphasized,
      gap: spacing.xs,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.lg,
    },
    uploadPanelPressed: {
      backgroundColor: colors.primaryMuted,
    },
    uploadIcon: {
      alignItems: 'center',
      backgroundColor: colors.primaryMuted,
      borderRadius: radii.round,
      height: 48,
      justifyContent: 'center',
      width: 48,
    },
    uploadTitle: {
      ...typography.titleSmall,
      color: colors.foreground,
      textAlign: 'center',
    },
    uploadCaption: {
      ...typography.bodySmall,
      color: colors.textSecondary,
      textAlign: 'center',
    },
    privacyRow: {
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: radii.card,
      borderWidth: borders.hairline,
      flexDirection: 'row',
      gap: spacing.sm,
      minHeight: 64,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.sm,
    },
    privacyIcon: {
      alignItems: 'center',
      backgroundColor: colors.privacyMuted,
      borderRadius: radii.round,
      height: 40,
      justifyContent: 'center',
      width: 40,
    },
    privacyCopy: {
      flex: 1,
      minWidth: 0,
    },
    privacyTitle: {
      ...typography.titleSmall,
      color: colors.foreground,
    },
    mediaCarousel: {
      gap: 12,
      paddingRight: 4,
    },
    mediaItem: {
      width: mediaCardWidth,
    },
    mediaCompactContent: {
      gap: 10,
    },
    mediaHeader: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 12,
    },
    mediaIcon: {
      width: 44,
      height: 44,
      borderRadius: 22,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.primaryMuted,
    },
    mediaTitleWrap: {
      flex: 1,
      minWidth: 0,
    },
    mediaTitle: {
      fontSize: 16,
      fontWeight: '700',
      color: colors.foreground,
    },
    mediaMeta: {
      marginTop: 2,
      fontSize: 12,
      color: colors.mutedForeground,
      lineHeight: 16,
    },
    mediaThumb: {
      width: '100%',
      height: 112,
      borderRadius: radii.card,
      backgroundColor: colors.surfaceAlt,
      justifyContent: 'center',
      alignItems: 'center',
      overflow: 'hidden',
    },
    mediaThumbImage: {
      height: '100%',
      width: '100%',
    },
    annotationBadge: {
      alignItems: 'center',
      backgroundColor: colors.primary,
      borderRadius: 12,
      flexDirection: 'row',
      gap: 4,
      paddingHorizontal: 6,
      paddingVertical: 2,
      position: 'absolute',
      right: 8,
      top: 8,
    },
    annotationBadgeText: {
      color: colors.primaryForeground,
      fontSize: 10,
      fontWeight: '700',
    },
    compactStatusRow: {
      alignItems: 'center',
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
    },
    recordingIndicator: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.destructive + '20',
      padding: 12,
      borderRadius: 8,
      gap: 8,
    },
    recordingDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: colors.destructive,
    },
    privacyStatusRow: {
      flexDirection: 'row',
      gap: 8,
      alignItems: 'flex-start',
    },
    privacyStatusDescription: {
      flex: 1,
      minWidth: 0,
      fontSize: 12,
      color: colors.mutedForeground,
      lineHeight: 16,
    },
    detailSection: {
      gap: 8,
    },
    noteTextarea: {
      marginBottom: 0,
    },
    mediaActions: {
      flexDirection: 'row',
      gap: 12,
    },
    mediaActionButton: {
      flex: 1,
    },
    switchStack: {
      gap: 12,
    },
    backButton: {
      alignSelf: 'stretch',
      flex: 1,
    },
    nextButton: {
      alignSelf: 'stretch',
      flex: 2,
    },
  });

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const getTranscriptionStatus = (id: string): 'idle' | 'loading' | 'success' | 'error' => {
    if (transcriptionState[id]) {
      return transcriptionState[id].status;
    }
    const hasTranscript = evidenceData.mediaFiles.some(file => file.id === id && file.transcript && file.transcript.length > 0);
    return hasTranscript ? 'success' : 'idle';
  };

  const beginEvidenceSelection = () => {
    if (!initialDraftId || !draftData || evidenceBusy.current) return null;
    evidenceBusy.current = true;
    setIsAddingEvidence(true);
    const generation = evidenceGeneration.current;
    return {
      draftId: initialDraftId,
      isCurrent: () => evidenceGeneration.current === generation,
      finish: () => {
        if (evidenceGeneration.current === generation) {
          evidenceBusy.current = false;
          setIsAddingEvidence(false);
        }
      },
    };
  };

  const addMediaFile = async (
    file: Omit<MediaFile, 'id' | 'timestamp'>,
    selection: NonNullable<ReturnType<typeof beginEvidenceSelection>>,
  ) => {
    const saved = await addPersistentEvidence({ ...selection, media: file });
    if (!saved || !selection.isCurrent()) return false;
    await refreshEvidence();
    return true;
  };

  const updatePrivacySetting = (key: keyof Required<EvidencePrivacySettings>, value: boolean) => {
    setEvidenceData(prev => {
      const privacySettings = { ...prev.privacySettings, [key]: value };
      evidenceEdits.current = { ...evidenceEdits.current, privacySettings };
      const mediaFiles = normalizeMediaPrivacyStatuses(prev.mediaFiles, privacySettings) || [];
      void updateDraft({ mediaFiles, privacySettings });
      return { ...prev, mediaFiles, privacySettings };
    });
    void persistEvidenceEdits().catch(reportEvidenceSaveError);
  };

  const updateMediaDescription = (fileId: string, description: string) => {
    evidenceEdits.current = { ...evidenceEdits.current, media: { ...evidenceEdits.current.media,
      [fileId]: { ...evidenceEdits.current.media?.[fileId], description } } };
    setEvidenceData(prev => {
      const mediaFiles = prev.mediaFiles.map(file =>
        file.id === fileId
          ? { ...file, description }
          : file,
      );
      void updateDraft({ mediaFiles });
      return { ...prev, mediaFiles };
    });
    // Queue notes as they change so Back/Quick Exit cannot lose a field that
    // is intentionally excluded from full-snapshot autosave membership.
    void persistEvidenceEdits().catch(reportEvidenceSaveError);
  };

  const persistTextEvidence = () => {
    void persistEvidenceEdits().catch(reportEvidenceSaveError);
  };

  const navigateToOptionalSkipTarget = (skipTarget: ReportWizardOptionalSkipTarget) => {
    switch (skipTarget.target.route) {
      case 'DraftOverview':
        navigation.navigate('DraftOverview', {
          ...skipTarget.target.params,
          ...(isEditingCompleted ? { editCompleted: true } : {}),
        });
        break;
      case 'WhatHappened':
        pushReportRoute(navigation, 'WhatHappened', {
          ...skipTarget.target.params,
          ...(isEditingCompleted ? { editCompleted: true } : {}),
        });
        break;
      case 'WhereWhen':
        pushReportRoute(navigation, 'WhereWhen', {
          ...skipTarget.target.params,
          ...(isEditingCompleted ? { editCompleted: true } : {}),
        });
        break;
      case 'EvidenceDetail':
        pushReportRoute(navigation, 'EvidenceDetail', {
          ...skipTarget.target.params,
          ...(isEditingCompleted ? { editCompleted: true } : {}),
        });
        break;
      case 'ConsentGate':
        pushReportRoute(navigation, 'ConsentGate', {
          ...skipTarget.target.params,
          ...(isEditingCompleted ? { editCompleted: true } : {}),
        });
        break;
    }
  };

  const handleSkipOptionalSteps = async () => {
    if (evidenceBusy.current || isRecording) return;
    const skipTarget = getOptionalReportStepSkipTarget(draftData, 'EvidenceDetail');
    if (!skipTarget) return;

    const completedSteps = Array.from(new Set([
      ...(draftData?.completedSteps ?? []),
      ...skipTarget.stepsToComplete,
    ]));

    try {
      const current = await persistEvidenceEdits();
      if (!current) return;
      const saved = await saveDraftPatch({
        textEvidence: current.textEvidence,
        privacySettings: current.privacySettings,
        completedSteps,
        currentStep: skipTarget.target.route,
      });

      if (!saved) {
        toast.show({
          title: 'Draft still loading',
          message: 'Wait a moment, then continue.',
          variant: 'warning',
        });
        return;
      }

      toast.show({ title: 'Optional steps skipped', variant: 'info' });
      navigateToOptionalSkipTarget(skipTarget);
    } catch {
      toast.show({
        title: 'Save failed',
        message: 'SafeRide could not save this step yet. Try again before continuing.',
        variant: 'error',
      });
    }
  };

  const handleTranscriptChange = (fileId: string, text: string) => {
    evidenceEdits.current = { ...evidenceEdits.current, media: { ...evidenceEdits.current.media,
      [fileId]: { ...evidenceEdits.current.media?.[fileId], transcript: text } } };
    setEvidenceData(prev => {
      const mediaFiles = prev.mediaFiles.map(file =>
        file.id === fileId
          ? { ...file, transcript: text }
          : file,
      );
      void updateDraft({ mediaFiles });
      return { ...prev, mediaFiles };
    });
    void persistEvidenceEdits().catch(reportEvidenceSaveError);

    setTranscriptionState(prev => ({
      ...prev,
      [fileId]: {
        status: text.length > 0 ? 'success' : 'idle',
      },
    }));
  };

  const handleTranscribeAudio = async (file: MediaFile) => {
    setTranscriptionState(prev => ({
      ...prev,
      [file.id]: { status: 'loading' },
    }));

    try {
      const transcript = await transcribeAudio({
        uri: file.uri,
        fileName: file.fileName,
      });
      evidenceEdits.current = { ...evidenceEdits.current, media: { ...evidenceEdits.current.media,
        [file.id]: { ...evidenceEdits.current.media?.[file.id], transcript } } };

      setEvidenceData(prev => {
        const mediaFiles = prev.mediaFiles.map(item =>
          item.id === file.id
            ? { ...item, transcript }
            : item,
        );
        void updateDraft({ mediaFiles });
        return { ...prev, mediaFiles };
      });
      await persistEvidenceEdits();

      setTranscriptionState(prev => ({
        ...prev,
        [file.id]: { status: 'success' },
      }));

      toast.show({
        title: 'Transcription complete',
        variant: 'success',
      });
    } catch (error) {
      const message =
        error instanceof TranscriptionError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Unable to transcribe audio.';

      setTranscriptionState(prev => ({
        ...prev,
        [file.id]: { status: 'error', errorMessage: message },
      }));

      toast.show({
        title: 'Transcription failed',
        message,
        variant: 'error',
      });
    }
  };

  const removeMediaFile = async (id: string) => {
    if (!initialDraftId || evidenceBusy.current) return;
    evidenceBusy.current = true;
    setIsAddingEvidence(true);
    const generation = evidenceGeneration.current;
    try {
      const removed = await removePersistentEvidence({
        draftId: initialDraftId, mediaId: id, uri: evidenceData.mediaFiles.find(file => file.id === id)?.uri ?? '',
        isCurrent: () => evidenceGeneration.current === generation,
        onSaved: applyPersistedEvidence,
      });
      if (!removed || evidenceGeneration.current !== generation) return;
    } catch {
      toast.show({ title: 'Evidence removal incomplete', message: 'Try again before continuing.', variant: 'error' });
      return;
    } finally {
      if (evidenceGeneration.current === generation) {
        evidenceBusy.current = false;
        setIsAddingEvidence(false);
      }
    }
    if (activeMediaDetailsId === id) {
      setActiveMediaDetailsId(null);
    }
    await refreshEvidence();
    setTranscriptionState(prev => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const takePhoto = async () => {
    if (isRecording) return;
    const selection = beginEvidenceSelection();
    if (!selection) return;
    try {
      const hasPermission = await ensureCameraPermission();
      if (!hasPermission) return;

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: [4, 3],
        quality: 0.8,
      });

      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
        const added = await addMediaFile({
          type: 'photo',
          uri: asset.uri,
          fileName: asset.fileName || 'photo_' + Date.now() + '.jpg',
          size: asset.fileSize || 0,
          captureSource: 'camera',
          mimeType: asset.mimeType,
        }, selection);
        if (added) toast.show({ title: 'Photo added', variant: 'success' });
      }
    } catch (error) {
      if (selection.isCurrent()) toast.show({ title: 'Failed to save photo', variant: 'error' });
    } finally {
      selection.finish();
    }
  };

  const selectFromLibrary = async (captureSource: EvidenceVaultCaptureSource = 'media_library') => {
    if (isRecording) return;
    const selection = beginEvidenceSelection();
    if (!selection) return;
    try {
      const hasPermission = await ensureMediaLibraryPermission();
      if (!hasPermission) return;

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.All,
        allowsMultipleSelection: true,
        quality: 0.8,
      });

      if (!result.canceled) {
        let added = false;
        for (const asset of result.assets) {
          added = await addMediaFile({
            type: getEvidenceVaultMediaTypeFromPickerAsset(asset),
            uri: asset.uri,
            fileName: asset.fileName || 'media_' + Date.now(),
            size: asset.fileSize || 0,
            captureSource,
            mimeType: asset.mimeType,
          }, selection) || added;
        }
        if (added && selection.isCurrent()) toast.show({ title: 'Media added', variant: 'success' });
      }
    } catch (error) {
      if (selection.isCurrent()) toast.show({ title: 'Failed to save media', variant: 'error' });
    } finally {
      selection.finish();
    }
  };

  const startRecording = async () => {
    if (evidenceBusy.current || isRecording) return;
    try {
      const { status } = await requestRecordingPermissionsAsync();
      if (status !== 'granted') {
        toast.show({
          title: 'Audio permission required',
          message: 'You can still add text evidence, photos, or documents.',
          variant: 'error',
        });
        return;
      }

      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });

      await audioRecorder.prepareToRecordAsync();
      audioRecorder.record();

      recordingRef.current = audioRecorder;
      setIsRecording(true);
      setRecordingDuration(0);
    } catch (error) {
      toast.show({ title: 'Failed to start recording', variant: 'error' });
    }
  };

  const stopRecording = async () => {
    const activeRecording = recordingRef.current;
    if (!activeRecording) return;

    const selection = beginEvidenceSelection();
    if (!selection) return;
    try {
      setIsRecording(false);
      await activeRecording.stop();
      const uri = activeRecording.uri;
      
      if (uri) {
        const fileInfo = await FileSystem.getInfoAsync(uri);
        const added = await addMediaFile({
          type: 'audio',
          uri,
          fileName: 'recording_' + Date.now() + '.m4a',
          size: fileInfo.exists ? fileInfo.size || 0 : 0,
          captureSource: 'microphone',
        }, selection);
        if (added) toast.show({ title: 'Recording saved', variant: 'success' });
      }
      
      recordingRef.current = null;
      setRecordingDuration(0);
    } catch (error) {
      if (selection.isCurrent()) toast.show({ title: 'Failed to save recording', variant: 'error' });
    } finally {
      selection.finish();
    }
  };

  const pickDocument = async () => {
    if (isRecording) return;
    const selection = beginEvidenceSelection();
    if (!selection) return;
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: true,
        multiple: true,
      });

      if (!result.canceled) {
        let added = false;
        for (const asset of result.assets) {
          added = await addMediaFile({
            type: 'document',
            uri: asset.uri,
            fileName: asset.name,
            size: asset.size || 0,
            captureSource: 'document_picker',
            mimeType: asset.mimeType,
          }, selection) || added;
        }
        if (added && selection.isCurrent()) toast.show({ title: 'Document(s) added', variant: 'success' });
      }
    } catch (error) {
      if (selection.isCurrent()) toast.show({ title: 'Failed to save document', variant: 'error' });
    } finally {
      selection.finish();
    }
  };

  const toggleRecording = () => {
    if (isRecording) {
      void stopRecording();
    } else {
      void startRecording();
    }
  };

  const handleContinue = async () => {
    if (evidenceBusy.current || isRecording) return;
    if (!initialDraftId) {
      toast.show({
        title: 'Draft still opening',
        message: draftIdError ?? 'Wait a moment, then continue.',
        variant: 'warning',
      });
      return;
    }

    const completedSteps = draftData?.completedSteps ?? [];
    try {
      const current = await persistEvidenceEdits();
      if (!current) return;
      const saved = await saveDraftPatch({
        textEvidence: current.textEvidence,
        privacySettings: current.privacySettings,
        completedSteps: Array.from(new Set([...completedSteps, 'EvidenceDetail'])),
        currentStep: 'ConsentGate',
      });
      if (!saved) {
        toast.show({
          title: 'Draft still loading',
          message: 'Wait a moment, then continue.',
          variant: 'warning',
        });
        return;
      }
      captureMeasurementEvent({
        name: 'step_complete',
        screenId: 'evidence-detail',
        taskId: 'report-flow',
        outcome: 'completed',
      });
      pushReportRoute(navigation, 'ConsentGate', {
        draftId: initialDraftId,
        ...(isEditingCompleted ? { editCompleted: true } : {}),
      });
    } catch {
      captureMeasurementEvent({
        name: 'error_outcome',
        screenId: 'evidence-detail',
        taskId: 'report-flow',
        outcome: 'failed',
        errorCode: 'storage_unavailable',
      });
      toast.show({
        title: 'Save failed',
        message: 'SafeRide could not save this step yet. Try again before continuing.',
        variant: 'error',
      });
    }
  };

  const getMediaIconName = (type: MediaFile['type']) => {
    switch (type) {
      case 'photo':
        return 'image-outline';
      case 'audio':
        return 'mic-outline';
      case 'video':
        return 'videocam-outline';
      case 'document':
      default:
        return 'document-text-outline';
    }
  };

  const getMediaDisplayDetails = (file: MediaFile, index: number) => {
    const transcriptionStatus = getTranscriptionStatus(file.id);
    const transcriptionError = transcriptionState[file.id]?.errorMessage;
    const vaultItem = buildEvidenceVaultItem(file, index, {
      privacySettings: evidenceData.privacySettings,
      uploadIncluded,
      draftStatus: draftData?.status,
      isOnline,
      transcriptionStatus,
      transcriptionError,
    });
    const statusItems = [
      vaultItem.localStatus,
      vaultItem.uploadStatus,
      vaultItem.integrityStatus,
      ...(vaultItem.transcriptionStatus ? [vaultItem.transcriptionStatus] : []),
    ];
    const metadataLine = [vaultItem.sourceLabel, vaultItem.fileSizeLabel, vaultItem.timestampLabel]
      .filter(Boolean)
      .join(' / ');
    const privacyRequestCount = vaultItem.privacyItems.filter(item => item.status !== 'not_requested').length;

    return {
      metadataLine,
      privacyRequestCount,
      statusItems,
      transcriptionError,
      transcriptionStatus,
      vaultItem,
    };
  };

  const renderStatusRow = (
    item: { label: string; status: EvidencePrivacyProcessingStatus; description: string },
    key: string,
  ) => (
    <View key={key} style={styles.privacyStatusRow}>
      <Badge variant={getEvidenceVaultStatusVariant(item.status)} size="sm">
        {item.label}
      </Badge>
      <Text style={styles.privacyStatusDescription}>{item.description}</Text>
    </View>
  );

  const renderMediaItem = (file: MediaFile, index: number) => {
    const {
      metadataLine,
      privacyRequestCount,
      transcriptionStatus,
      vaultItem,
    } = getMediaDisplayDetails(file, index);

    return (
      <Card
        key={file.id}
        style={styles.mediaItem}
        variant="outlined"
        accessibilityLabel={`Evidence item ${index + 1}: ${vaultItem.typeLabel}. ${vaultItem.title}`}
      >
        <CardContent style={styles.mediaCompactContent}>
          <View style={styles.mediaThumb}>
            {file.type === 'photo' ? (
              <TouchableOpacity
                style={{ height: '100%', width: '100%' }}
                onPress={() => photoAnnotation.openAnnotation(file.uri, file.annotations)}
                accessibilityRole="button"
                accessibilityLabel="Open photo annotation tools"
                accessibilityHint="Adds local notes to this photo evidence item"
              >
                <Image source={{ uri: file.uri }} style={styles.mediaThumbImage} resizeMode="cover" />
                {file.annotations && file.annotations.length > 0 ? (
                  <View style={styles.annotationBadge}>
                    <Ionicons name="create" size={12} color={colors.primaryForeground} />
                    <Text style={styles.annotationBadgeText}>{file.annotations.length}</Text>
                  </View>
                ) : null}
              </TouchableOpacity>
            ) : (
              <Ionicons name={getMediaIconName(file.type) as any} size={32} color={colors.primary} />
            )}
          </View>

          <View style={styles.mediaHeader}>
            <View style={styles.mediaIcon}>
              <Ionicons name={getMediaIconName(file.type) as any} size={22} color={colors.primary} />
            </View>
            <View style={styles.mediaTitleWrap}>
              <Text style={styles.mediaTitle}>{vaultItem.title}</Text>
              <Text style={styles.mediaMeta}>{metadataLine}</Text>
            </View>
            <Badge variant={getEvidenceVaultStatusVariant(vaultItem.uploadStatus.status)} size="sm">
              {vaultItem.typeLabel}
            </Badge>
          </View>

          <View style={styles.compactStatusRow}>
            <Badge variant={getEvidenceVaultStatusVariant(vaultItem.localStatus.status)} size="sm">
              {vaultItem.localStatus.label}
            </Badge>
            <Badge variant={getEvidenceVaultStatusVariant(vaultItem.uploadStatus.status)} size="sm">
              {vaultItem.uploadStatus.label}
            </Badge>
            {privacyRequestCount > 0 ? (
              <Badge variant="warning" size="sm">{privacyRequestCount} privacy</Badge>
            ) : null}
            {file.description?.trim() ? <Badge variant="info" size="sm">Notes</Badge> : null}
            {file.type === 'audio' && transcriptionStatus === 'success' ? (
              <Badge variant="success" size="sm">Transcript</Badge>
            ) : null}
          </View>

          <View style={styles.mediaActions}>
            <Button
              title="Details"
              variant="secondary"
              size="sm"
              onPress={() => setActiveMediaDetailsId(file.id)}
              style={styles.mediaActionButton}
              accessibilityLabel={`Open ${vaultItem.typeLabel.toLowerCase()} evidence details`}
            />
          </View>
        </CardContent>
      </Card>
    );
  };

  const activeMediaIndex = activeMediaDetailsId
    ? evidenceData.mediaFiles.findIndex(file => file.id === activeMediaDetailsId)
    : -1;
  const activeMediaFile = activeMediaIndex >= 0 ? evidenceData.mediaFiles[activeMediaIndex] : undefined;
  const activeMediaDetails = activeMediaFile
    ? getMediaDisplayDetails(activeMediaFile, activeMediaIndex)
    : undefined;

  return (
    // BottomTabs already reserves the bottom safe area for the report stack.
    <Screen edges={['top', 'left', 'right']}>
      <View style={styles.screenRoot}>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.contentContainer}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <ReportWizardProgress
            draft={draftData}
            currentStep="EvidenceDetail"
            isSaving={isSaving}
            lastSaved={lastSaved}
            error={error ?? draftIdError}
            showSaveStatus
            onSkipOptionalSteps={optionalSkipTarget && !isAddingEvidence && !isRecording ? handleSkipOptionalSteps : undefined}
            skipOptionalLabel="Skip to review"
            skipOptionalDisabled={isSaving || isRecording}
          />

          {!isOnline && (
            <OfflineBanner
              message="Evidence stays on this device while offline. Network-only sharing waits for consent and connection."
              compact={false}
            />
          )}

          {isRecording && (
            <View style={styles.recordingIndicator}>
              <View style={styles.recordingDot} />
              <Text style={{ color: colors.destructive, fontWeight: '600', flex: 1 }}>
                Recording audio... {formatDuration(recordingDuration)}
              </Text>
              <Button
                title="Stop"
                variant="destructive"
                size="sm"
                onPress={stopRecording}
              />
            </View>
          )}

          {evidenceData.stealthModeActive && (
            <AlertComponent variant="warning">
              <Text style={{ fontWeight: '600', marginBottom: 4 }}>Stealth evidence in this draft</Text>
              <Text>Review auto-saved evidence before sharing. Stealth capture does not mean privacy processing has completed.</Text>
            </AlertComponent>
          )}

          <View>
            <ReportStepHeader
              title="Add evidence"
              helper="Optional. Choose the source first. Permission prompts appear only after you choose one."
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Choose media evidence type"
              accessibilityHint="Opens photo, audio, video, screenshot and document options"
              disabled={isSaving}
              onPress={() => setIsUploadSheetVisible(true)}
              style={({ pressed }) => [styles.uploadPanel, pressed ? styles.uploadPanelPressed : null, isSaving ? { opacity: 0.6 } : null]}
            >
              <View style={styles.uploadIcon}>
                <Ionicons name="cloud-upload-outline" size={24} color={colors.primary} />
              </View>
              <Text style={styles.uploadTitle}>Upload media</Text>
              <Text style={styles.uploadCaption}>Photo, audio, video, screenshot, or document.</Text>
            </Pressable>
          </View>

          <View style={styles.sectionBlock}>
            <Text accessibilityRole="header" style={styles.sectionTitle}>Text evidence</Text>
            <Text style={styles.sectionCaption}>Use this for quotes, descriptions, or context. It is saved as draft text.</Text>
            <Textarea
              placeholder="Describe additional evidence, quotes, or details that support your report."
              value={evidenceData.textEvidence}
              onChangeText={(text) => setEvidenceData(prev => {
                const updated = { ...prev, textEvidence: text };
                evidenceEdits.current = { ...evidenceEdits.current, textEvidence: text };
                updateDraft({ textEvidence: updated.textEvidence });
                return updated;
              })}
              onBlur={persistTextEvidence}
              rows={4}
              helperText="Evidence is optional. Skip this step if adding evidence would increase risk."
            />
          </View>

          <View style={styles.sectionBlock}>
            <Text accessibilityRole="header" style={styles.sectionTitle}>Evidence items ({evidenceData.mediaFiles.length})</Text>
            <Text style={styles.sectionCaption}>Review each item. Details opens status, notes, transcript tools, and removal.</Text>
            {evidenceData.mediaFiles.length > 0 ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.mediaCarousel}
                keyboardShouldPersistTaps="handled"
              >
                {evidenceData.mediaFiles.map(renderMediaItem)}
              </ScrollView>
            ) : (
              <EmptyState
                title="No media evidence added"
                message="You can continue without media evidence, or add text details above."
                icon="folder-open-outline"
                tone="neutral"
              />
            )}
          </View>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open privacy request options"
            accessibilityHint="Choose what SafeRide should note for this draft"
            onPress={() => setIsPrivacyDetailsVisible(true)}
            style={({ pressed }) => [styles.privacyRow, pressed ? { backgroundColor: colors.surfaceAlt } : null]}
          >
            <View style={styles.privacyIcon}>
              <Ionicons name="shield-checkmark-outline" size={20} color={colors.privacy} />
            </View>
            <View style={styles.privacyCopy}>
              <Text style={styles.privacyTitle}>Privacy request</Text>
              <Text style={styles.sectionCaption}>Choose what SafeRide should note for this draft.</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
          </Pressable>
        </ScrollView>

        <View style={styles.navigationDock}>
          <View style={styles.navigationButtons}>
            <Button
              title="Back"
              variant="outline"
              onPress={goBackToWhereWhen}
              style={styles.backButton}
            />
            <Button
              title="Continue"
              icon={<Ionicons name="arrow-forward" size={18} color={colors.primaryForeground} />}
              iconPosition="right"
              onPress={() => {
                void handleContinue();
              }}
              disabled={isSaving || isResolvingDraftId || isAddingEvidence || isRecording}
              loading={isSaving || isResolvingDraftId}
              style={styles.nextButton}
              accessibilityLabel="Continue to review and next step"
            />
          </View>
        </View>
      </View>

      <ActionSheet
        visible={isUploadSheetVisible}
        onClose={() => setIsUploadSheetVisible(false)}
        title="Upload media"
        message="Choose the evidence source. SafeRide asks for permissions only after you choose one."
        cancelText="Cancel"
        actions={[
          {
            title: 'Take photo',
            icon: 'camera-outline',
            disabled: isSaving || isAddingEvidence || isRecording,
            onPress: () => {
              void takePhoto();
            },
          },
          {
            title: 'Choose photo or video',
            icon: 'images-outline',
            disabled: isSaving || isAddingEvidence || isRecording,
            onPress: () => {
              void selectFromLibrary('media_library');
            },
          },
          {
            title: isRecording ? 'Stop audio recording' : 'Record audio',
            icon: 'mic-outline',
            destructive: isRecording,
            disabled: isSaving || isAddingEvidence,
            onPress: toggleRecording,
          },
          {
            title: 'Import screenshot',
            icon: 'phone-portrait-outline',
            disabled: isSaving || isAddingEvidence || isRecording,
            onPress: () => {
              void selectFromLibrary('screenshot_import');
            },
          },
          {
            title: 'Attach document',
            icon: 'document-text-outline',
            disabled: isSaving || isAddingEvidence || isRecording,
            onPress: () => {
              void pickDocument();
            },
          },
        ]}
      />

      <InfoModal
        visible={isPrivacyDetailsVisible}
        title="Privacy request"
        description="Choose the requests to save with this draft. These switches record intent; they do not prove media processing happened in this build."
        onClose={() => setIsPrivacyDetailsVisible(false)}
        closeLabel="Done"
      >
        <InfoModalSection title="Saved requests">
          <View style={styles.switchStack}>
            <Switch
              value={evidenceData.privacySettings.blurFaces}
              onValueChange={(value) => updatePrivacySetting('blurFaces', value)}
              label="Request face blur"
              description="Saved as a request. Photos and videos are not pixel-blurred in this build."
            />
            <Switch
              value={evidenceData.privacySettings.removeMetadata}
              onValueChange={(value) => updatePrivacySetting('removeMetadata', value)}
              label="Request metadata removal"
              description="Saved as a request. Raw files are not stripped before local storage."
            />
            <Switch
              value={evidenceData.privacySettings.encryptFiles}
              onValueChange={(value) => updatePrivacySetting('encryptFiles', value)}
              label="Request file encryption"
              description="Saved as a request. Raw evidence files are not file-encrypted in this Expo build."
            />
          </View>
        </InfoModalSection>
      </InfoModal>

      {activeMediaFile && activeMediaDetails ? (
        <InfoModal
          visible
          title={`${activeMediaDetails.vaultItem.typeLabel} details`}
          description={activeMediaDetails.vaultItem.title}
          onClose={() => setActiveMediaDetailsId(null)}
          closeLabel="Done"
        >
          <InfoModalSection title="Vault status">
            <View style={styles.detailSection}>
              {activeMediaDetails.statusItems.map((item, statusIndex) => renderStatusRow(item, `active-status-${statusIndex}`))}
            </View>
          </InfoModalSection>

          <InfoModalSection title="Privacy processing">
            <View style={styles.detailSection}>
              {activeMediaDetails.vaultItem.privacyItems.map(item => renderStatusRow(item, `active-privacy-${item.feature}`))}
            </View>
          </InfoModalSection>

          {activeMediaFile.type === 'photo' ? (
            <InfoModalSection title="Photo tools">
              <Button
                title="Annotate photo"
                variant="secondary"
                fullWidth
                onPress={() => {
                  setActiveMediaDetailsId(null);
                  photoAnnotation.openAnnotation(activeMediaFile.uri, activeMediaFile.annotations);
                }}
              />
            </InfoModalSection>
          ) : null}

          {activeMediaFile.type === 'audio' ? (
            <InfoModalSection title="Transcript">
              <Button
                title={activeMediaDetails.transcriptionStatus === 'loading'
                  ? 'Transcribing...'
                  : activeMediaFile.transcript
                    ? 'Re-transcribe'
                    : 'Transcribe'}
                variant="secondary"
                fullWidth
                loading={activeMediaDetails.transcriptionStatus === 'loading'}
                disabled={activeMediaDetails.transcriptionStatus === 'loading'}
                onPress={() => handleTranscribeAudio(activeMediaFile)}
                accessibilityLabel="Transcribe audio evidence"
              />
              {(activeMediaFile.transcript || activeMediaDetails.transcriptionStatus !== 'idle') ? (
                <Textarea
                  label="Transcript"
                  placeholder={
                    activeMediaDetails.transcriptionStatus === 'loading'
                      ? 'Transcribing audio...'
                      : 'Transcript will appear here'
                  }
                  value={activeMediaFile.transcript ?? ''}
                  onChangeText={(text) => handleTranscriptChange(activeMediaFile.id, text)}
                  rows={4}
                  disabled={activeMediaDetails.transcriptionStatus === 'loading'}
                  error={
                    activeMediaDetails.transcriptionStatus === 'error'
                      ? activeMediaDetails.transcriptionError ?? 'Transcription failed.'
                      : undefined
                  }
                  helperText={
                    activeMediaDetails.transcriptionStatus !== 'error' && (activeMediaFile.transcript ?? '').length > 0
                      ? 'You can edit the transcript before sharing.'
                      : undefined
                  }
                />
              ) : null}
            </InfoModalSection>
          ) : null}

          <InfoModalSection title="Evidence notes">
            <Textarea
              label="Notes"
              placeholder="Add source, context, or follow-up notes for this item."
              value={activeMediaFile.description ?? ''}
              onChangeText={(text) => updateMediaDescription(activeMediaFile.id, text)}
              onBlur={() => { void persistEvidenceEdits().catch(reportEvidenceSaveError); }}
              rows={3}
              helperText="Notes are saved in the draft. They are not a verified transcript or privacy process."
              containerStyle={styles.noteTextarea}
            />
            <Button
              title="Remove evidence"
              variant="destructive"
              fullWidth
              onPress={() => removeMediaFile(activeMediaFile.id)}
              accessibilityLabel={`Remove ${activeMediaDetails.vaultItem.typeLabel.toLowerCase()} evidence`}
            />
          </InfoModalSection>
        </InfoModal>
      ) : null}

      {/* Photo Annotation Overlay */}
      <PhotoAnnotationOverlay
        visible={photoAnnotation.visible}
        imageUri={photoAnnotation.currentImage || ''}
        annotations={photoAnnotation.annotations}
        onClose={photoAnnotation.closeAnnotation}
        onSave={async (annotations) => {
          // Update the specific media file with annotations
          if (photoAnnotation.currentImage) {
            for (const file of evidenceDataRef.current.mediaFiles) {
              if (file.uri === photoAnnotation.currentImage) evidenceEdits.current = { ...evidenceEdits.current,
                media: { ...evidenceEdits.current.media, [file.id]: { ...evidenceEdits.current.media?.[file.id], annotations } } };
            }
            setEvidenceData(prev => {
              const mediaFiles = prev.mediaFiles.map(file => 
                file.uri === photoAnnotation.currentImage 
                  ? { ...file, annotations }
                  : file
              );
              void updateDraft({ mediaFiles });
              return { ...prev, mediaFiles };
            });
            try {
              const saved = await persistEvidenceEdits();
              if (!saved) return false;
              toast.show({
                title: 'Annotations saved',
                message: `${annotations.length} annotation(s) added`,
                variant: 'success'
              });
            } catch {
              reportEvidenceSaveError();
              return false;
            }
          }
          return true;
        }}
      />
    </Screen>
  );
}
