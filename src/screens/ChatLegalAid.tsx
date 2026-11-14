import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  type AppStateStatus,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { captureMeasurementEvent } from '../lib/measurement/localEventStore';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { InfoModal, InfoModalBullet, InfoModalSection } from '../components/ui';
import { SafetyIllustration } from '../components/ui/SafetyIllustration';
import { useTheme } from '../theme/SimpleThemeProvider';
import { useToast } from '../components/ui/Toast';
import { useLanguage } from '../context/LanguageProvider';
import { useOnline } from '../context/OnlineProvider';
import { useAuth } from '../context/AuthProvider';
import MarkdownText from '../components/MarkdownText';
import ChatErrorHandler, {
  type ChatAttachment,
  type ChatMessage as StoredChatMessage,
} from '../utils/chatErrorHandling';
import {
  listChatMessages,
  sendChatMessage,
  subscribeToChatMessages,
  requestAssistantReply,
  createChatSession,
  deleteChatSession,
  type ChatMessageRow,
  type ChatSession,
} from '../services/chatService';
import { localAssistantConfig } from '../config/localAssistant';
import {
  cancelLocalAssistantPreparation,
  cancelActiveLocalAssistantReply,
  generateLocalAssistantReply,
  getLocalAssistantDescriptor,
  getLocalAssistantSourceLabel,
  getLocalAssistantStatus,
  hydrateLocalAssistantPreparationState,
  isLocalAssistantPreparationCancelledError,
  isLocalAssistantPreparationPausedError,
  isLocalAssistantReplyStoppedError,
  pauseLocalAssistantPreparation,
  prepareLocalAssistant,
  refreshLocalAssistantStatus,
  setLocalAssistantForegroundActive,
  startAutomaticLocalAssistantPreparation,
  subscribeToAssistantState,
} from '../services/localAssistantService';
import {
  createLargeModelDownloadAuthorization,
  getModelDownloadNetworkType,
} from '../lib/localAssistant';
import {
  checkLocalAiRamRequirement,
  getCachedLocalAiDeviceFacts,
  loadLocalAiDeviceFacts,
} from '../lib/localAssistant/pilotDeviceProfile';
import {
  checkAiPilotInterruptions,
  isAiPilotDiagnosticsEnabled,
  recordAiPilotFeedback,
  recordAiPilotRamCheck,
} from '../lib/localAssistant/pilotDiagnostics';
import { categorizeLocalAiFailure, classifyLocalAiFailure } from '../lib/localAssistant/pilotFailureReasons';
import { getLocalAiPilotCopy } from '../i18n/localAiPilotCopy';
import { devPrivacyError, getPrivacySafeErrorReason, getPrivacySafeHttpStatus } from '../utils/privacyLog';
import {
  DEFAULT_LOCAL_CHAT_OWNER_ID,
  createLocalChatSessionRecord,
  deleteLocalChatSessionRecord,
  deleteLocalChatSessionRecordForRemoteSession,
  getLocalChatSessionId,
  isLocalChatSessionId,
  listLocalChatSessionRecords,
  touchLocalChatSessionRecord,
  upsertLocalChatSessionRecord,
  type LocalChatSessionRecord,
} from '../utils/chatLocalSession';
import {
  CHAT_PROVIDER_REFERRAL_AVAILABLE,
  deriveLegalAidChatMode,
  type ChatModeTone,
} from '../utils/chatMode';
import {
  getChatLegalAidCopy,
  type ChatLegalAidCopy,
} from '../i18n/appLanguage';
import {
  findPreviousUserMessage,
  formatRemainingDownloadTime,
  getLastAssistantActionMessageId,
  getLastEditableUserMessageId,
} from '../utils/chatThreadActions';
import {
  elevation,
  radii,
  type ThemeColors,
  typography,
} from '../theme/tokens';

type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: Date;
  attachments?: ChatAttachment[];
  sources?: string[];
  isOffline?: boolean;
  deliveryStatus?: 'queued' | 'local-only' | 'sent' | 'failed';
};

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

type AssistantSourceSummary = {
  icon: IoniconName;
  eyebrow: string;
  title: string;
  detail: string;
  tone: ChatModeTone;
};

const CHAT_REMOTE_SYNC_ENABLED = false;

function confirmAction(
  title: string,
  message: string,
  cancelLabel: string,
  confirmLabel: string,
): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    Alert.alert(
      title,
      message,
      [
        { text: cancelLabel, style: 'cancel', onPress: () => settle(false) },
        { text: confirmLabel, onPress: () => settle(true) },
      ],
      { cancelable: true, onDismiss: () => settle(false) },
    );
  });
}

function formatExactBytes(bytes: number | undefined): string | null {
  if (!bytes || !Number.isSafeInteger(bytes) || bytes <= 0) return null;
  return `${bytes.toLocaleString('en-US')} bytes (${(bytes / (1024 ** 3)).toFixed(2)} GiB)`;
}

function formatProgressBytes(bytes: number | undefined): string | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null;
  return `${(bytes / (1024 ** 3)).toFixed(2)} GiB`;
}

function createLocalChatSession(ownerId: string = DEFAULT_LOCAL_CHAT_OWNER_ID): ChatSession {
  const now = new Date();
  return {
    id: getLocalChatSessionId(ownerId),
    ownerId,
    mode: 'legal-aid-local',
    createdAt: now,
    lastActivity: now,
  };
}

function mapLocalSessionRecordToChatSession(record: LocalChatSessionRecord): ChatSession {
  return {
    id: record.id,
    ownerId: record.ownerId,
    mode: record.mode,
    createdAt: safeParseDate(record.createdAt),
    lastActivity: safeParseDate(record.lastActivity),
  };
}

function createNewLocalChatSession(ownerId: string = DEFAULT_LOCAL_CHAT_OWNER_ID): ChatSession {
  return mapLocalSessionRecordToChatSession(createLocalChatSessionRecord(ownerId));
}

function isLocalChatSession(chatSession: ChatSession | null | undefined): boolean {
  return isLocalChatSessionId(chatSession?.id);
}

function createChatUI(colors: ThemeColors) {
  return {
    colors: {
      backgroundTop: colors.canvas,
      backgroundBottom: colors.canvas,
      canvas: colors.canvas,
      divider: colors.divider,
      textPrimary: colors.textPrimary,
      textSecondary: colors.textSecondary,
      composerTop: colors.surface,
      composerBottom: colors.surfaceAlt,
      composerBorder: colors.border,
      userBubbleBg: colors.primary,
      userBubbleText: colors.primaryForeground,
      assistantBubbleBg: colors.surface,
      badgeFill: colors.primaryMuted,
      ctaAccent: colors.primary,
      disabledFill: colors.surfaceAlt,
      disabledBorder: colors.border,
      iconNeutral: colors.textSecondary,
      supportMuted: colors.supportMuted,
      success: colors.success,
      successMuted: colors.successMuted,
      warning: colors.warning,
      warningMuted: colors.warningMuted,
      offline: colors.offline,
      error: colors.destructive,
    },
    radii: {
      composer: radii.lg,
      bubble: radii.card,
      bubbleTopLeft: radii.card,
      chip: radii.chip,
      badge: radii.badge,
    },
    typography: {
      hero: typography.displayMedium,
      headerTitle: typography.titleMedium,
      message: typography.bodyLarge,
      systemNote: typography.bodyMedium,
      modeLabel: typography.bodyMedium,
      timeline: typography.labelLarge,
      badge: typography.labelSmall,
      meta: typography.bodySmall,
      button: typography.button,
    },
  };
}

function getDateLocale(languageCode?: string | null): string | undefined {
  return languageCode === 'sw' ? 'sw-KE' : undefined;
}

function formatSessionTimestamp(
  date: Date,
  copy: ChatLegalAidCopy,
  languageCode?: string | null,
): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return copy.unknownTime;
  }

  const now = new Date();
  const locale = getDateLocale(languageCode);
  if (now.toDateString() === date.toDateString()) {
    return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  }

  return date.toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function safeParseDate(value: string | null | undefined): Date {
  if (!value) return new Date();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function safeSerializeDate(value: Date): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    return new Date().toISOString();
  }
  return value.toISOString();
}

const CHAT_ATTACHMENT_ROOT = 'saferide-chat-attachments';

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeAttachmentFileName(value: string | null | undefined): string {
  const fallback = `upload_${Date.now()}`;
  const safeName = (value?.trim() || fallback)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 96);
  return safeName || fallback;
}

function normalizeChatAttachments(value: unknown): ChatAttachment[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const attachments = value
    .map(item => {
      if (!isObjectRecord(item)) {
        return null;
      }

      const id = typeof item.id === 'string' ? item.id : '';
      const uri = typeof item.uri === 'string' ? item.uri : '';
      const fileName = typeof item.fileName === 'string' ? item.fileName : '';
      const createdAt = typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString();

      if (!id || !uri || !fileName) {
        return null;
      }

      const attachment: ChatAttachment = {
        id,
        uri,
        fileName,
        createdAt,
        localOnly: item.localOnly === true,
      };

      if (typeof item.mimeType === 'string') {
        attachment.mimeType = item.mimeType;
      }
      if (typeof item.size === 'number' && Number.isFinite(item.size)) {
        attachment.size = item.size;
      }

      return attachment;
    })
    .filter((item): item is ChatAttachment => Boolean(item));

  return attachments.length > 0 ? attachments : undefined;
}

function getAttachmentIcon(attachment: ChatAttachment): IoniconName {
  const mimeType = attachment.mimeType?.toLowerCase() ?? '';
  if (mimeType.startsWith('image/')) return 'image-outline';
  if (mimeType.startsWith('audio/')) return 'mic-outline';
  if (mimeType.startsWith('video/')) return 'videocam-outline';
  if (mimeType.includes('pdf')) return 'document-text-outline';
  return 'document-attach-outline';
}

function formatAttachmentSize(size: number | undefined): string | null {
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) {
    return null;
  }

  if (size < 1024) {
    return `${size} B`;
  }

  const kilobytes = size / 1024;
  if (kilobytes < 1024) {
    return `${kilobytes >= 100 ? kilobytes.toFixed(0) : kilobytes.toFixed(1)} KB`;
  }

  const megabytes = kilobytes / 1024;
  return `${megabytes >= 100 ? megabytes.toFixed(0) : megabytes.toFixed(1)} MB`;
}

function formatAttachmentMeta(attachment: ChatAttachment, copy: ChatLegalAidCopy): string {
  return [
    attachment.mimeType,
    formatAttachmentSize(attachment.size),
    copy.attachmentLocalLabel,
  ].filter(Boolean).join(' - ');
}

async function persistChatAttachment(
  sessionId: string,
  asset: DocumentPicker.DocumentPickerAsset,
  createdAt: Date,
  index: number,
): Promise<ChatAttachment> {
  const fileName = sanitizeAttachmentFileName(asset.name);
  const timestamp = safeSerializeDate(createdAt);
  let uri = asset.uri;
  let size = asset.size;

  if (FileSystem.documentDirectory) {
    const safeSessionId = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
    const targetDir = `${FileSystem.documentDirectory}${CHAT_ATTACHMENT_ROOT}/${safeSessionId}/`;
    await FileSystem.makeDirectoryAsync(targetDir, { intermediates: true });
    const targetUri = `${targetDir}${createdAt.getTime()}_${index}_${fileName}`;
    await FileSystem.copyAsync({ from: asset.uri, to: targetUri });
    uri = targetUri;
  }

  if (typeof size !== 'number' || size <= 0) {
    const info = await FileSystem.getInfoAsync(uri);
    size = info.exists ? info.size ?? 0 : 0;
  }

  return {
    id: `${createdAt.getTime()}-${index}-${fileName}`,
    uri,
    fileName,
    mimeType: asset.mimeType,
    size,
    createdAt: timestamp,
    localOnly: true,
  };
}

function mapRowToMessage(row: ChatMessageRow): Message {
  return {
    id: row.id,
    role: (row.role as 'user' | 'assistant') ?? 'assistant',
    content: row.content,
    createdAt: safeParseDate(row.created_at),
    attachments: normalizeChatAttachments(row.metadata?.attachments),
    sources: Array.isArray(row.metadata?.sources) ? (row.metadata?.sources as string[]) : undefined,
  };
}

function createWelcomeMessage(sessionId: string, copy: ChatLegalAidCopy): Message {
  return {
    id: `${sessionId}-welcome`,
    role: 'assistant',
    content: copy.welcomeMessage,
    createdAt: new Date(),
    sources: [copy.systemNoticeSource],
    isOffline: true,
  };
}

function isWelcomeMessage(message: Message): boolean {
  return message.id.endsWith('-welcome');
}

function mapStoredChatMessage(
  message: StoredChatMessage,
  fallbackUserDeliveryStatus?: Message['deliveryStatus'],
): Message {
  const deliveryStatus = message.deliveryStatus ?? (
    message.role === 'user' ? fallbackUserDeliveryStatus : undefined
  );

  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: safeParseDate(message.timestamp),
    attachments: normalizeChatAttachments(message.attachments),
    sources: message.sources,
    isOffline: message.isOffline ?? Boolean(deliveryStatus),
    deliveryStatus,
  };
}

function mergeUniqueMessages(...messageGroups: Message[][]): Message[] {
  const byId = new Map<string, Message>();

  messageGroups.forEach(group => {
    group.forEach(message => {
      const existingMessage = byId.get(message.id);
      if (
        !existingMessage ||
        message.deliveryStatus === 'local-only' ||
        (message.isOffline && !existingMessage.isOffline)
      ) {
        byId.set(message.id, message);
      }
    });
  });

  const merged = Array.from(byId.values());
  const hasConversation = merged.some(message => !isWelcomeMessage(message));
  const visibleMessages = hasConversation ? merged.filter(message => !isWelcomeMessage(message)) : merged;

  return visibleMessages.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
}

function mergeChatSessions(...sessionGroups: ChatSession[][]): ChatSession[] {
  const byId = new Map<string, ChatSession>();
  sessionGroups.forEach(group => {
    group.forEach(chatSession => {
      const existing = byId.get(chatSession.id);
      if (!existing || chatSession.lastActivity.getTime() > existing.lastActivity.getTime()) {
        byId.set(chatSession.id, chatSession);
      }
    });
  });

  return Array.from(byId.values()).sort((left, right) => (
    right.lastActivity.getTime() - left.lastActivity.getTime()
  ));
}

function withWelcomeFallback(sessionId: string, nextMessages: Message[], copy: ChatLegalAidCopy): Message[] {
  return nextMessages.length > 0 ? nextMessages : [createWelcomeMessage(sessionId, copy)];
}


function getDeliveryStatusLabel(message: Message, copy: ChatLegalAidCopy): string | null {
  switch (message.deliveryStatus) {
    case 'queued':
      return copy.deliveryStatus.queued;
    case 'local-only':
      return copy.deliveryStatus.localOnly;
    case 'failed':
      return copy.deliveryStatus.failed;
    default:
      return message.isOffline ? copy.deliveryStatus.offline : null;
  }
}

function buildAssistantConversation(chatMessages: Message[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  return chatMessages
    .filter(message => !isWelcomeMessage(message) && message.content.trim().length > 0)
    .slice(-20)
    .map(message => ({ role: message.role, content: message.content }));
}

function getAssistantSourceSummary(params: {
  enabled: boolean;
  ready: boolean;
  state: ReturnType<typeof getLocalAssistantStatus>['state'];
  modelDownloaded?: boolean;
  resumable?: boolean;
  progress?: number;
  modelLabel: string;
  stateLabel: string;
  copy: ChatLegalAidCopy;
}): AssistantSourceSummary {
  const sourceCopy = params.copy.assistantSource;

  if (!params.enabled) {
    return {
      icon: 'alert-circle-outline',
      eyebrow: sourceCopy.eyebrow,
      title: sourceCopy.localModelDisabledTitle,
      detail: sourceCopy.localModelDisabledDetail,
      tone: 'neutral',
    };
  }

  if (params.ready) {
    return {
      icon: 'phone-portrait-outline',
      eyebrow: sourceCopy.eyebrow,
      title: params.modelLabel,
      detail: `${params.stateLabel}. ${sourceCopy.readyDetailSuffix}`,
      tone: 'success',
    };
  }

  if (params.state === 'checking') {
    return {
      icon: 'search-outline',
      eyebrow: sourceCopy.eyebrow,
      title: sourceCopy.checkingTitle,
      detail: params.stateLabel,
      tone: 'warning',
    };
  }

  if (params.state === 'downloading') {
    return {
      icon: 'cloud-download-outline',
      eyebrow: sourceCopy.eyebrow,
      title: sourceCopy.preparingTitle,
      detail: `${params.stateLabel}. ${sourceCopy.keepOpenDetailSuffix}`,
      tone: 'warning',
    };
  }

  if (params.state === 'verifying') {
    return {
      icon: 'shield-checkmark-outline',
      eyebrow: sourceCopy.eyebrow,
      title: sourceCopy.verifyingTitle,
      detail: `${params.stateLabel}. ${sourceCopy.keepOpenDetailSuffix}`,
      tone: 'warning',
    };
  }

  if (params.state === 'configuring') {
    return {
      icon: 'hardware-chip-outline',
      eyebrow: sourceCopy.eyebrow,
      title: sourceCopy.configuringTitle,
      detail: `${params.stateLabel}. ${sourceCopy.startingDetailSuffix}`,
      tone: 'warning',
    };
  }

  if (params.state === 'downloaded') {
    return {
      icon: 'phone-portrait-outline',
      eyebrow: sourceCopy.eyebrow,
      title: sourceCopy.modelSavedTitle,
      detail: sourceCopy.tapLoadDetail,
      tone: 'warning',
    };
  }

  if (params.state === 'error') {
    return {
      icon: 'alert-circle-outline',
      eyebrow: sourceCopy.eyebrow,
      title: params.resumable || (params.progress ?? 0) > 0
        ? sourceCopy.localModelPausedTitle
        : sourceCopy.localModelUnavailableTitle,
      detail: params.resumable || (params.progress ?? 0) > 0
        ? sourceCopy.savedProgressDetail
        : params.modelDownloaded
        ? sourceCopy.savedModelCouldNotStart
        : sourceCopy.trySetupAgain,
      tone: params.resumable || (params.progress ?? 0) > 0 ? 'warning' : 'error',
    };
  }

  return {
    icon: 'phone-portrait-outline',
    eyebrow: sourceCopy.eyebrow,
    title: params.modelDownloaded ? sourceCopy.modelSavedTitle : sourceCopy.modelNotReadyTitle,
    detail: params.modelDownloaded
      ? sourceCopy.tapLoadDetail
      : sourceCopy.downloadForOfflineReplies,
    tone: 'neutral',
  };
}

export default function ChatLegalAidScreen({navigation}: {navigation: any}) {
  const { colors, colorScheme } = useTheme();
  const ui = useMemo(() => createChatUI(colors), [colors]);
  const styles = useMemo(() => createStyles(ui), [ui]);
  const toast = useToast();
  const { isOnline } = useOnline();
  const { languageCode } = useLanguage();
  const copy = useMemo(() => getChatLegalAidCopy(languageCode), [languageCode]);
  const pilotCopy = useMemo(() => getLocalAiPilotCopy(languageCode), [languageCode]);
  const aiPilotDiagnosticsEnabled = useMemo(() => isAiPilotDiagnosticsEnabled(), []);
  const insets = useSafeAreaInsets();
  const { width: viewportWidth } = useWindowDimensions();
  const isWideChatLayout = viewportWidth >= 820;

  const scrollRef = useRef<ScrollView>(null);
  const inputRef = useRef<TextInput>(null);
  const subscriptionRef = useRef<{ unsubscribe: () => void } | null>(null);
  const activeSessionRef = useRef<ChatSession | null>(null);
  const messagesRef = useRef<Message[]>([]);
  const downloadEtaSampleRef = useRef<{
    receivedBytes: number;
    totalBytes: number;
    recordedAt: number;
    rateBytesPerSecond?: number;
  } | null>(null);
  const initialisedOwnerRef = useRef<string | null>(null);
  const hydratingSessionIdRef = useRef<string | null>(null);
  const loadSessionRunRef = useRef(0);
  const activeSendRunRef = useRef(0);
  const stoppedSendRunsRef = useRef(new Set<number>());
  const retryQueueInFlightRef = useRef(false);

  const [session, setSession] = useState<ChatSession | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [availableSessions, setAvailableSessions] = useState<ChatSession[]>([]);
  const [isSessionPickerVisible, setIsSessionPickerVisible] = useState(false);
  const [isChatDetailsVisible, setIsChatDetailsVisible] = useState(false);
  const [isRefreshingSessions, setIsRefreshingSessions] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [isAssistantTyping, setIsAssistantTyping] = useState(false);
  const [localAssistantState, setLocalAssistantState] = useState<ReturnType<typeof getLocalAssistantStatus>>(() =>
    getLocalAssistantStatus(),
  );
  const [localAssistantProgress, setLocalAssistantProgress] = useState(localAssistantState.percent ?? 0);
  const [localAssistantEtaSeconds, setLocalAssistantEtaSeconds] = useState<number | null>(null);
  const localAssistantStateRef = useRef(localAssistantState);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [queuedMessageCount, setQueuedMessageCount] = useState(0);
  const [isSideNavExpanded, setIsSideNavExpanded] = useState(isWideChatLayout);
  const measurementPreparationCapturedRef = useRef(false);
  const [pilotFeedbackByMessageId, setPilotFeedbackByMessageId] = useState<
    Record<string, 'helpful' | 'not-helpful'>
  >({});

  const { user } = useAuth();
  const ownerId = user?.id ?? DEFAULT_LOCAL_CHAT_OWNER_ID;
  const sessionLocalOnly = isLocalChatSession(session);
  const { enabled: localAssistantEnabled } = localAssistantConfig;
  const localAssistantDescriptor = useMemo(() => getLocalAssistantDescriptor(), []);

  useEffect(() => {
    setIsSideNavExpanded(isWideChatLayout);
  }, [isWideChatLayout]);

  const handleLocalAssistantProgress = useCallback((percent: number) => {
    if (percent > 0 && !measurementPreparationCapturedRef.current) {
      measurementPreparationCapturedRef.current = true;
      captureMeasurementEvent({
        name: 'ai_preparation',
        screenId: 'chat-legal-aid',
        taskId: 'ai-setup',
        outcome: 'started',
      });
    }
    setLocalAssistantProgress(percent);
  }, []);
  const updateLocalAssistantDownloadEta = useCallback((payload: ReturnType<typeof getLocalAssistantStatus>) => {
    if (
      payload.state !== 'downloading' ||
      typeof payload.receivedBytes !== 'number' ||
      typeof payload.totalBytes !== 'number' ||
      payload.totalBytes <= 0 ||
      payload.receivedBytes <= 0 ||
      payload.receivedBytes >= payload.totalBytes
    ) {
      downloadEtaSampleRef.current = null;
      setLocalAssistantEtaSeconds(null);
      return;
    }

    const now = Date.now();
    const previous = downloadEtaSampleRef.current;
    if (!previous || payload.receivedBytes <= previous.receivedBytes) {
      downloadEtaSampleRef.current = {
        receivedBytes: payload.receivedBytes,
        totalBytes: payload.totalBytes,
        recordedAt: now,
        rateBytesPerSecond: previous?.rateBytesPerSecond,
      };
      return;
    }

    const elapsedSeconds = Math.max(0.1, (now - previous.recordedAt) / 1000);
    const instantRate = (payload.receivedBytes - previous.receivedBytes) / elapsedSeconds;
    const smoothedRate = previous.rateBytesPerSecond
      ? previous.rateBytesPerSecond * 0.65 + instantRate * 0.35
      : instantRate;

    downloadEtaSampleRef.current = {
      receivedBytes: payload.receivedBytes,
      totalBytes: payload.totalBytes,
      recordedAt: now,
      rateBytesPerSecond: smoothedRate,
    };

    setLocalAssistantEtaSeconds(
      smoothedRate > 0 ? Math.ceil((payload.totalBytes - payload.receivedBytes) / smoothedRate) : null,
    );
  }, []);
  const hydrateLocalAssistantStatus = useCallback(async (shouldApply: () => boolean = () => true) => {
    await hydrateLocalAssistantPreparationState();
    const payload = await refreshLocalAssistantStatus();
    if (!shouldApply()) return payload;
    setLocalAssistantState(payload);
    if (typeof payload.percent === 'number') {
      setLocalAssistantProgress(payload.percent);
    }
    updateLocalAssistantDownloadEta(payload);
    return payload;
  }, [updateLocalAssistantDownloadEta]);
  const restoreDownloadedLocalAssistant = useCallback(async (
    payload: ReturnType<typeof getLocalAssistantStatus> | undefined,
  ) => {
    if (payload?.state !== 'downloaded' || !payload.modelDownloaded) return;
    await startAutomaticLocalAssistantPreparation(handleLocalAssistantProgress);
  }, [handleLocalAssistantProgress]);

  const greetingName = useMemo(() => {
    const fullName = typeof user?.user_metadata?.full_name === 'string'
      ? user?.user_metadata?.full_name.trim()
      : '';
    if (fullName) {
      const [first] = fullName.split(/\s+/);
      if (first) {
        return first;
      }
    }

    const email = user?.email?.trim();
    if (email) {
      const [local] = email.split('@');
      if (local) {
        return local;
      }
    }

    return copy.defaultGreetingName;
  }, [copy, user]);

  useEffect(() => {
    // Content-free: RAM/storage ranges for failure reasons and pilot diagnostics.
    void loadLocalAiDeviceFacts();
    checkAiPilotInterruptions();
  }, []);

  useEffect(() => {
    activeSessionRef.current = session;
  }, [session]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    localAssistantStateRef.current = localAssistantState;
  }, [localAssistantState]);

  useEffect(() => {
    if (!localAssistantEnabled) return;
    let mounted = true;
    const unsubscribe = subscribeToAssistantState(payload => {
      setLocalAssistantState(payload);
      if (typeof payload.percent === 'number') {
        setLocalAssistantProgress(payload.percent);
      } else if (payload.state === 'ready') {
        setLocalAssistantProgress(100);
      }
      updateLocalAssistantDownloadEta(payload);
    });
    hydrateLocalAssistantStatus(() => mounted)
      .then(payload => restoreDownloadedLocalAssistant(payload))
      .catch(error => {
        devPrivacyError('local assistant status refresh failed', { reason: getPrivacySafeErrorReason(error) });
      });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [
    hydrateLocalAssistantStatus,
    localAssistantEnabled,
    restoreDownloadedLocalAssistant,
    updateLocalAssistantDownloadEta,
  ]);

  useEffect(() => {
    if (!localAssistantEnabled) return;

    let disposed = false;
    let previousAppState: AppStateStatus = AppState.currentState;

    const hydrateSavedProgress = async () => {
      try {
        const payload = await hydrateLocalAssistantStatus(() => !disposed);
        await restoreDownloadedLocalAssistant(payload);
      } catch (error) {
        devPrivacyError('local assistant foreground hydration failed', {
          reason: getPrivacySafeErrorReason(error),
        });
      }
    };

    const pauseForNonForeground = async () => {
      try {
        await setLocalAssistantForegroundActive(false);
        if (localAssistantStateRef.current.state === 'downloading') {
          await pauseLocalAssistantPreparation();
        }
      } catch (error) {
        devPrivacyError('local assistant background pause failed', {
          reason: getPrivacySafeErrorReason(error),
        });
      }
    };

    void setLocalAssistantForegroundActive(previousAppState === 'active');

    const subscription = AppState.addEventListener('change', nextAppState => {
      const wasForeground = previousAppState === 'active';
      const isForeground = nextAppState === 'active';
      previousAppState = nextAppState;

      if (wasForeground && !isForeground) {
        void pauseForNonForeground();
        return;
      }

      if (!wasForeground && isForeground) {
        void setLocalAssistantForegroundActive(true)
          .then(hydrateSavedProgress)
          .catch(error => {
            devPrivacyError('local assistant foreground activation failed', {
              reason: getPrivacySafeErrorReason(error),
            });
          });
      }
    });

    return () => {
      disposed = true;
      subscription.remove();
      void pauseForNonForeground();
    };
  }, [hydrateLocalAssistantStatus, localAssistantEnabled, restoreDownloadedLocalAssistant]);

  const localAssistantReady = localAssistantState.state === 'ready';
  const localAssistantCanRunOrConfigure =
    localAssistantReady || Boolean(localAssistantState.modelDownloaded);

  const localAssistantStateLabel = useMemo(() => {
    switch (localAssistantState.state) {
      case 'ready':
        return copy.stateLabel.readyOffline;
      case 'checking':
        return copy.stateLabel.checking;
      case 'downloading':
        return copy.stateLabel.downloading(localAssistantProgress);
      case 'verifying':
        return copy.stateLabel.verifying(localAssistantProgress);
      case 'configuring':
        return copy.stateLabel.configuring(localAssistantProgress);
      case 'downloaded':
        return copy.stateLabel.downloaded;
      case 'error':
        if (localAssistantState.modelDownloaded) return copy.stateLabel.setupFailedAfterDownload;
        if (localAssistantState.resumable || localAssistantProgress > 0) {
          return copy.stateLabel.resume(localAssistantProgress);
        }
        return copy.stateLabel.unavailable;
      default:
        if (localAssistantState.modelDownloaded) return copy.stateLabel.downloaded;
        if (localAssistantProgress > 0) {
          return localAssistantState.resumable
            ? copy.stateLabel.paused(localAssistantProgress)
            : copy.stateLabel.partial(localAssistantProgress);
        }
        return copy.stateLabel.notDownloaded;
    }
  }, [
    copy,
    localAssistantProgress,
    localAssistantState.modelDownloaded,
    localAssistantState.resumable,
    localAssistantState.state,
  ]);

  const assistantSourceSummary = useMemo(() => getAssistantSourceSummary({
    enabled: localAssistantEnabled,
    ready: localAssistantReady,
    state: localAssistantState.state,
    modelDownloaded: localAssistantState.modelDownloaded,
    resumable: localAssistantState.resumable,
    progress: localAssistantProgress,
    modelLabel: localAssistantDescriptor.label,
    stateLabel: localAssistantStateLabel,
    copy,
  }), [
    copy,
    localAssistantDescriptor.label,
    localAssistantEnabled,
    localAssistantReady,
    localAssistantState.modelDownloaded,
    localAssistantState.resumable,
    localAssistantState.state,
    localAssistantProgress,
    localAssistantStateLabel,
  ]);

  const localAssistantEtaLabel = localAssistantState.state === 'downloading'
    ? formatRemainingDownloadTime(localAssistantEtaSeconds)
    : null;

  const localAssistantStatusDescription = useMemo(() => {
    switch (localAssistantState.state) {
      case 'ready':
        return copy.localStatus.ready;
      case 'checking':
        return copy.localStatus.checking;
      case 'downloading':
        return copy.localStatus.downloading(localAssistantEtaLabel);
      case 'verifying':
        return copy.localStatus.verifying(localAssistantProgress);
      case 'configuring':
        return copy.localStatus.configuring;
      case 'downloaded':
        return copy.localStatus.downloaded;
      case 'error':
        if (localAssistantState.modelDownloaded) {
          return copy.localStatus.savedModelRetry(localAssistantState.error);
        }
        if (localAssistantState.resumable || localAssistantProgress > 0) {
          return copy.localStatus.resumeProgress(localAssistantState.error);
        }
        return localAssistantState.error
          ? localAssistantState.error
          : copy.localStatus.unavailable;
      default:
        if (localAssistantState.modelDownloaded) {
          return copy.localStatus.downloaded;
        }
        return localAssistantProgress > 0
          ? localAssistantState.resumable
            ? copy.localStatus.downloadPaused
            : copy.localStatus.downloadStarted
          : copy.localStatus.downloadOnce;
    }
  }, [
    copy,
    localAssistantProgress,
    localAssistantEtaLabel,
    localAssistantState.error,
    localAssistantState.modelDownloaded,
    localAssistantState.resumable,
    localAssistantState.state,
  ]);

  const exactModelSizeLabel = useMemo(
    () => formatExactBytes(localAssistantDescriptor.exactSizeBytes),
    [localAssistantDescriptor.exactSizeBytes],
  );
  const requiredStorageLabel = useMemo(
    () => formatExactBytes(localAssistantDescriptor.storageRequiredBytes),
    [localAssistantDescriptor.storageRequiredBytes],
  );
  const compactModelSizeLabel = useMemo(
    () => formatProgressBytes(localAssistantDescriptor.exactSizeBytes),
    [localAssistantDescriptor.exactSizeBytes],
  );
  const compactRequiredStorageLabel = useMemo(
    () => formatProgressBytes(localAssistantDescriptor.storageRequiredBytes),
    [localAssistantDescriptor.storageRequiredBytes],
  );
  const localAssistantProgressPercent = Math.min(100, Math.max(0, Math.round(localAssistantProgress)));
  const localAssistantProgressWidth = `${localAssistantProgressPercent}%` as `${number}%`;
  const localAssistantProgressBytes = useMemo(() => {
    const received = formatProgressBytes(localAssistantState.receivedBytes);
    const total = formatProgressBytes(localAssistantState.totalBytes);
    return received && total ? `${received} / ${total}` : null;
  }, [localAssistantState.receivedBytes, localAssistantState.totalBytes]);
  const showLocalAssistantDeterminateProgress = localAssistantState.state === 'downloading'
    || localAssistantState.state === 'verifying'
    || Boolean(localAssistantState.resumable && localAssistantProgressPercent > 0);
  const showLocalAssistantIndeterminateProgress = localAssistantState.state === 'checking'
    || localAssistantState.state === 'downloaded'
    || localAssistantState.state === 'configuring';
  const localAssistantSetupBusy = localAssistantState.state === 'checking'
    || localAssistantState.state === 'verifying'
    || localAssistantState.state === 'configuring';
  const localAssistantSetupActionLabel = useMemo(() => {
    if (!localAssistantDescriptor.appReady) return copy.setup.notReadyAction;
    if (localAssistantState.state === 'checking') return copy.setup.checkingModelAction;
    if (localAssistantState.state === 'downloading') return copy.setup.pauseDownloadAction;
    if (localAssistantState.state === 'verifying') return copy.setup.verifyingModelAction;
    if (localAssistantState.state === 'configuring') return copy.setup.startingModelAction;
    if (localAssistantState.modelDownloaded || localAssistantState.state === 'downloaded') {
      return copy.setup.loadModelAction;
    }
    if (localAssistantState.resumable || localAssistantProgress > 0) {
      return copy.setup.resumeDownloadAction;
    }
    if (localAssistantState.state === 'error') return copy.setup.retrySetupAction;
    return copy.setup.downloadModelAction;
  }, [
    copy,
    localAssistantDescriptor.appReady,
    localAssistantProgress,
    localAssistantState.modelDownloaded,
    localAssistantState.resumable,
    localAssistantState.state,
  ]);
  const localAssistantSetupActionDisabled = !localAssistantDescriptor.appReady
    || localAssistantSetupBusy;
  const setupActionForeground = localAssistantSetupActionDisabled
    ? ui.colors.textSecondary
    : ui.colors.userBubbleText;
  const showLocalAssistantCancel = Boolean(
    !localAssistantState.modelDownloaded
    && (
      localAssistantState.state === 'downloading'
      || localAssistantState.resumable
      || localAssistantProgress > 0
    ),
  );

  const handlePrepareLocalAssistant = useCallback(async () => {
    if (!localAssistantDescriptor.appReady) {
      toast.show({
        title: copy.setup.localAiNotReady,
        message: localAssistantState.error ?? copy.setup.latestQaBuild,
        variant: 'warning',
      });
      return;
    }

    try {
      if (localAssistantState.modelDownloaded || localAssistantState.state === 'downloaded') {
        await prepareLocalAssistant(handleLocalAssistantProgress);
      } else {
        // Warn before a fresh download only; resuming keeps the earlier decision.
        if (!localAssistantState.resumable && localAssistantProgress <= 0) {
          const ramRequirement = await checkLocalAiRamRequirement();
          if (ramRequirement.belowMinimum && ramRequirement.ramClassGb !== null) {
            // Pilot builds may proceed below the RAM guidance so the limitation can be measured.
            const proceed = await confirmAction(
              pilotCopy.ramWarning.title,
              pilotCopy.ramWarning.message(
                ramRequirement.ramClassGb,
                ramRequirement.minimumRamGb,
                aiPilotDiagnosticsEnabled,
              ),
              pilotCopy.ramWarning.cancelAction,
              pilotCopy.ramWarning.continueAction,
            );
            recordAiPilotRamCheck({
              outcome: proceed ? 'warning-proceeded' : 'warning-declined',
              ramBucket: ramRequirement.ramBucket,
            });
            if (!proceed) return;
          } else {
            recordAiPilotRamCheck({
              outcome: ramRequirement.known ? 'meets-minimum' : 'unknown',
              ramBucket: ramRequirement.ramBucket,
            });
          }
        }
        const exactSize = exactModelSizeLabel ?? copy.setup.unknownExactSize;
        const requiredStorage = requiredStorageLabel ?? exactSize;
        const accepted = await confirmAction(
          copy.setup.downloadConsentTitle,
          copy.setup.downloadConsentMessage(exactSize, requiredStorage),
          copy.setup.cancelAction,
          copy.setup.downloadModelAction,
        );
        if (!accepted) return;

        const networkType = await getModelDownloadNetworkType();
        if (networkType === 'unknown') {
          Alert.alert(copy.setup.networkUnknownTitle, copy.setup.networkUnknownMessage);
          return;
        }
        const meteredNetworkAccepted = networkType === 'metered'
          ? await confirmAction(
            copy.setup.meteredNetworkTitle,
            copy.setup.meteredNetworkMessage(exactSize),
            copy.setup.cancelAction,
            copy.setup.useMeteredNetworkAction,
          )
          : false;
        if (networkType === 'metered' && !meteredNetworkAccepted) return;

        const authorization = createLargeModelDownloadAuthorization(
          localAssistantDescriptor,
          networkType,
          meteredNetworkAccepted,
        );
        await prepareLocalAssistant(handleLocalAssistantProgress, authorization);
      }
      toast.show({
        title: copy.toast.localAssistantReadyTitle,
        message: copy.toast.localAssistantReadyMessage,
        variant: 'success',
      });
    } catch (error) {
      if (
        isLocalAssistantPreparationPausedError(error)
        || isLocalAssistantPreparationCancelledError(error)
      ) {
        return;
      }
      devPrivacyError('local assistant explicit preparation failed', {
        reason: getPrivacySafeErrorReason(error),
      });
      const latestStatus = getLocalAssistantStatus();
      const failureCategory = categorizeLocalAiFailure(classifyLocalAiFailure(error), {
        ramClassGb: getCachedLocalAiDeviceFacts()?.ramClassGb ?? null,
      });
      toast.show({
        title: copy.toast.preparationFailedTitle,
        message: failureCategory !== 'unknown'
          ? pilotCopy.failure.statusMessage(failureCategory, latestStatus.modelDownloaded === true)
          : latestStatus.modelDownloaded
            ? copy.toast.savedModelStartFailed
            : copy.toast.checkConnectionStorageBattery,
        variant: 'warning',
      });
    }
  }, [
    aiPilotDiagnosticsEnabled,
    copy,
    exactModelSizeLabel,
    handleLocalAssistantProgress,
    localAssistantDescriptor,
    localAssistantProgress,
    localAssistantState.error,
    localAssistantState.modelDownloaded,
    localAssistantState.resumable,
    localAssistantState.state,
    pilotCopy,
    requiredStorageLabel,
    toast,
  ]);

  const handlePilotFeedback = useCallback((messageId: string, value: 'helpful' | 'not-helpful') => {
    if (pilotFeedbackByMessageId[messageId]) return;
    setPilotFeedbackByMessageId(current => ({ ...current, [messageId]: value }));
    // Only the tap value is kept; no message ID or content is recorded.
    recordAiPilotFeedback(value);
  }, [pilotFeedbackByMessageId]);

  const handleLocalAssistantSetupAction = useCallback(async () => {
    if (
      localAssistantState.state === 'checking'
      || localAssistantState.state === 'verifying'
      || localAssistantState.state === 'configuring'
    ) {
      return;
    }
    if (localAssistantState.state !== 'downloading') {
      await handlePrepareLocalAssistant();
      return;
    }
    try {
      const paused = await pauseLocalAssistantPreparation();
      toast.show({
        title: paused ? copy.toast.downloadPausedTitle : copy.toast.downloadPauseUnavailableTitle,
        message: paused ? copy.toast.downloadPausedMessage : copy.toast.downloadPauseUnavailableMessage,
        variant: paused ? 'info' : 'warning',
      });
    } catch (error) {
      devPrivacyError('local assistant explicit pause failed', {
        reason: getPrivacySafeErrorReason(error),
      });
      toast.show({
        title: copy.toast.pauseFailedTitle,
        message: copy.toast.downloadPauseUnavailableMessage,
        variant: 'warning',
      });
    }
  }, [copy, handlePrepareLocalAssistant, localAssistantState.state, toast]);

  const handleCancelLocalAssistantSetup = useCallback(async () => {
    const confirmed = await confirmAction(
      copy.setup.cancelDownloadTitle,
      copy.setup.cancelDownloadMessage,
      copy.setup.keepDownloadAction,
      copy.setup.cancelDownloadAction,
    );
    if (!confirmed) return;
    try {
      const cancelled = await cancelLocalAssistantPreparation();
      toast.show({
        title: cancelled ? copy.toast.downloadCancelledTitle : copy.toast.downloadCancelUnavailableTitle,
        message: cancelled ? copy.toast.downloadCancelledMessage : copy.toast.downloadCancelUnavailableMessage,
        variant: cancelled ? 'info' : 'warning',
      });
    } catch (error) {
      devPrivacyError('local assistant explicit cancel failed', {
        reason: getPrivacySafeErrorReason(error),
      });
      toast.show({
        title: copy.toast.downloadCancelUnavailableTitle,
        message: copy.toast.downloadCancelUnavailableMessage,
        variant: 'warning',
      });
    }
  }, [copy, toast]);

  const showLocalAssistantSetup = localAssistantEnabled && !localAssistantReady;
  const showCompactLocalAssistantPreparation = showLocalAssistantSetup && (
    localAssistantState.state === 'checking' ||
    localAssistantState.state === 'downloaded' ||
    localAssistantState.state === 'configuring'
  );

  const assistantTypingLabel = useMemo(() => {
    if (localAssistantReady) {
      return copy.assistantTyping.ready;
    }
    if (localAssistantEnabled && localAssistantState.state === 'checking') {
      return copy.assistantTyping.checking;
    }
    if (localAssistantEnabled && localAssistantState.state === 'downloading') {
      return copy.assistantTyping.downloading(localAssistantProgress, localAssistantEtaLabel);
    }
    if (localAssistantEnabled && localAssistantState.state === 'verifying') {
      return copy.assistantTyping.verifying(localAssistantProgress);
    }
    if (localAssistantEnabled && localAssistantState.state === 'downloaded') {
      return copy.assistantTyping.loadingDownloaded;
    }
    if (localAssistantEnabled && localAssistantState.state === 'configuring') {
      return copy.assistantTyping.configuring(localAssistantProgress);
    }
    return copy.assistantTyping.savingNotice;
  }, [copy, localAssistantEnabled, localAssistantEtaLabel, localAssistantProgress, localAssistantReady, localAssistantState.state]);

  const hasUserMessages = messages.some(message => message.role === 'user');
  const sheetBottomInset = Math.max(insets.bottom, 12);
  const restingFooterPadding = 8;
  const keyboardOffset = Platform.select<number>({
    ios: insets.top,
    android: 0,
    default: 0,
  }) ?? 0;
  const keyboardPadding = keyboardHeight > 0 ? Math.max(0, keyboardHeight - insets.bottom) + 8 : restingFooterPadding;
  const scrollBottomPadding = keyboardHeight > 0 ? 24 : 16;
  const hasInput = Boolean(session) && inputValue.trim().length > 0;
  const assistantBusy = isSending || isAssistantTyping;
  const lastAssistantActionMessageId = useMemo(() => getLastAssistantActionMessageId(messages), [messages]);
  const lastEditableUserMessageId = useMemo(() => getLastEditableUserMessageId(messages), [messages]);
  const currentSessionIndex = session ? availableSessions.findIndex(item => item.id === session.id) : -1;
  const currentThreadTitle = currentSessionIndex >= 0
    ? copy.conversationTitle(currentSessionIndex + 1)
    : copy.newConversation;
  const sideNavSessions = useMemo(() => {
    const mergedSessions = session
      ? mergeChatSessions([session], availableSessions)
      : availableSessions;

    return mergedSessions.slice(0, 8);
  }, [availableSessions, session]);
  const hasStoredHistory = messages.some(message => !message.isOffline && !message.id.endsWith('-welcome'));
  const chatMode = useMemo(() => deriveLegalAidChatMode({
    isOnline,
    hasSession: Boolean(session),
    sessionLocalOnly,
    hasStoredHistory,
    queuedMessageCount,
    localAssistantEnabled,
    localAssistantState: localAssistantState.state,
    localAssistantProgress,
    localAssistantResumable: localAssistantState.resumable,
    providerReferralAvailable: CHAT_PROVIDER_REFERRAL_AVAILABLE,
  }), [
    hasStoredHistory,
    isOnline,
    localAssistantEnabled,
    localAssistantProgress,
    localAssistantState.resumable,
    localAssistantState.state,
    queuedMessageCount,
    session,
    sessionLocalOnly,
  ]);
  const chatModeBadge = copy.chatMode.badge[chatMode.id] ?? chatMode.badge;
  const scrollToBottom = useCallback(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, []);

  const persistMessagesForSession = useCallback(async (
    targetSession: ChatSession | null | undefined,
    nextMessages: Message[],
  ): Promise<boolean> => {
    if (!targetSession || nextMessages.length === 0) {
      return false;
    }

    const saved = await ChatErrorHandler.persistMessageSnapshot(targetSession.id, nextMessages);
    if (!saved) {
      return false;
    }

    if (isLocalChatSession(targetSession)) {
      const lastConversationMessage = [...nextMessages]
        .reverse()
        .find(message => !isWelcomeMessage(message));
      const nextLastActivity = lastConversationMessage?.createdAt ?? targetSession.lastActivity;
      void touchLocalChatSessionRecord(targetSession.ownerId, targetSession.id, nextLastActivity);
      setAvailableSessions(prev => mergeChatSessions([
        { ...targetSession, lastActivity: nextLastActivity },
      ], prev));
    }

    return true;
  }, []);

  const appendMessage = useCallback(
      (message: Message) => {
        if (message.role === 'assistant') {
          setIsAssistantTyping(false);
        }

        setMessages(prev => {
          if (prev.some(existing => existing.id === message.id)) {
            return prev;
          }
          const nextMessages = [...prev, message];
          messagesRef.current = nextMessages;
          void persistMessagesForSession(activeSessionRef.current, nextMessages);
          return nextMessages;
        });
        requestAnimationFrame(scrollToBottom);
      },
      [persistMessagesForSession, scrollToBottom],
  );

  const replaceMessage = useCallback((messageId: string, nextMessage: Message) => {
    setMessages(prev => {
      const nextMessages = prev.map(message => (
        message.id === messageId ? nextMessage : message
      ));
      messagesRef.current = nextMessages;
      void persistMessagesForSession(activeSessionRef.current, nextMessages);
      return nextMessages;
    });
    requestAnimationFrame(scrollToBottom);
  }, [persistMessagesForSession, scrollToBottom]);

  const beginSendRun = useCallback(() => {
    const runId = activeSendRunRef.current + 1;
    activeSendRunRef.current = runId;
    stoppedSendRunsRef.current.delete(runId);
    return runId;
  }, []);

  const isSendRunStopped = useCallback((runId: number) => (
    activeSendRunRef.current !== runId || stoppedSendRunsRef.current.has(runId)
  ), []);

  const clearSendRun = useCallback((runId: number) => {
    stoppedSendRunsRef.current.delete(runId);
    if (activeSendRunRef.current === runId) {
      activeSendRunRef.current = 0;
    }
  }, []);

  const refreshSessions = useCallback(
      async (withSpinner: boolean = false) => {
        try {
          if (withSpinner) {
            setIsRefreshingSessions(true);
          }
          const localRecords = await listLocalChatSessionRecords(ownerId);
          const activeSession = activeSessionRef.current;
          const localSessions = localRecords.map(mapLocalSessionRecordToChatSession);
          setAvailableSessions(activeSession && isLocalChatSession(activeSession)
            ? mergeChatSessions([activeSession], localSessions)
            : localSessions);
        } catch (error) {
          devPrivacyError('chat sessions refresh failed', {
            reason: getPrivacySafeErrorReason(error),
            status: getPrivacySafeHttpStatus(error),
          });
          const activeSession = activeSessionRef.current;
          const localSessions = (await listLocalChatSessionRecords(ownerId)).map(mapLocalSessionRecordToChatSession);
          setAvailableSessions(activeSession && isLocalChatSession(activeSession)
            ? mergeChatSessions([activeSession], localSessions)
            : localSessions);
        } finally {
          if (withSpinner) {
            setIsRefreshingSessions(false);
          }
        }
      },
      [ownerId],
  );


  const refreshQueuedMessageCount = useCallback(async (sessionId: string | null = null) => {
    const targetSessionId = sessionId ?? activeSessionRef.current?.id ?? null;
    if (!targetSessionId) {
      setQueuedMessageCount(0);
      return 0;
    }

    const count = await ChatErrorHandler.getRetryQueueCount(targetSessionId);
    setQueuedMessageCount(count);
    return count;
  }, []);

  const loadSession = useCallback(
      async (
        targetSession: ChatSession,
        options: { includeOffline?: boolean; showLoader?: boolean; preserveInput?: boolean } = {},
      ) => {
        const { includeOffline = false, showLoader = false, preserveInput = false } = options;
        const loadRun = ++loadSessionRunRef.current;
        const previousSession = activeSessionRef.current;
        hydratingSessionIdRef.current = targetSession.id;

        if (showLoader) {
          setIsLoading(true);
        }

        subscriptionRef.current?.unsubscribe();
        subscriptionRef.current = null;
        activeSessionRef.current = targetSession;
        setSession(targetSession);
        if (!preserveInput) {
          setInputValue('');
        }
        setIsAssistantTyping(false);

        const applyLoadedMessages = (nextMessages: Message[]) => {
          if (loadSessionRunRef.current !== loadRun) {
            return;
          }
          const visibleMessages = withWelcomeFallback(targetSession.id, nextMessages, copy);
          messagesRef.current = visibleMessages;
          setMessages(visibleMessages);
          void persistMessagesForSession(targetSession, visibleMessages);
          requestAnimationFrame(() => {
            if (loadSessionRunRef.current === loadRun && hydratingSessionIdRef.current === targetSession.id) {
              hydratingSessionIdRef.current = null;
            }
            scrollToBottom();
          });
        };

        try {
          if (isLocalChatSession(targetSession)) {
            await upsertLocalChatSessionRecord({
              id: targetSession.id,
              ownerId: targetSession.ownerId,
              mode: targetSession.mode ?? 'legal-aid-local',
              createdAt: safeSerializeDate(targetSession.createdAt),
              lastActivity: safeSerializeDate(targetSession.lastActivity),
              syncStatus: 'local-only',
            });
            const offlineMessages = includeOffline ? await ChatErrorHandler.loadMessagesOffline(targetSession.id) : [];
            applyLoadedMessages(offlineMessages.map(off => mapStoredChatMessage(off, 'local-only')));
            setAvailableSessions(prev => mergeChatSessions([targetSession], prev));
            await refreshQueuedMessageCount(targetSession.id);
            return;
          }

          let cachedMessages: Message[] = [];
          if (includeOffline) {
            const offlineMessages = await ChatErrorHandler.loadMessagesOffline(targetSession.id);
            cachedMessages = offlineMessages.map(off => mapStoredChatMessage(off, 'queued'));
            if (cachedMessages.length > 0) {
              applyLoadedMessages(cachedMessages);
            }
          }

          const history = await listChatMessages(targetSession.id);
          if (loadSessionRunRef.current !== loadRun) {
            return;
          }
          applyLoadedMessages(mergeUniqueMessages(history.map(mapRowToMessage), cachedMessages));

          await refreshQueuedMessageCount(targetSession.id);

          const subscription = subscribeToChatMessages(targetSession.id, row => {
            appendMessage(mapRowToMessage(row));
            refreshSessions().catch(() => {});
            refreshQueuedMessageCount(targetSession.id).catch(() => {});
          });
          subscriptionRef.current = subscription;

          refreshSessions().catch(() => {});
        } catch (error) {
          devPrivacyError('chat session load failed', {
            reason: getPrivacySafeErrorReason(error),
            status: getPrivacySafeHttpStatus(error),
          });
          if (previousSession && !isLocalChatSession(targetSession) && isLocalChatSession(previousSession)) {
            activeSessionRef.current = previousSession;
            setSession(previousSession);
          }
          if (hydratingSessionIdRef.current === targetSession.id) {
            hydratingSessionIdRef.current = null;
          }
          toast.show({
            title: copy.toast.localPhoneChatTitle,
            message: copy.toast.localPhoneChatTesting,
            variant: 'warning',
          });
        } finally {
          if (showLoader) {
            setIsLoading(false);
          }
        }
      },
      [appendMessage, copy, persistMessagesForSession, refreshQueuedMessageCount, refreshSessions, scrollToBottom, toast],
  );

  const handleSubmitEditedPrompt = useCallback(async (messageId: string, text: string) => {
    if (!session || isSending) return;

    const currentMessages = messagesRef.current;
    const userIndex = currentMessages.findIndex(message => message.id === messageId);
    if (userIndex < 0 || currentMessages[userIndex]?.role !== 'user' || messageId !== lastEditableUserMessageId) {
      toast.show({
        title: copy.toast.editUnavailableTitle,
        message: copy.toast.onlyLatestPrompt,
        variant: 'warning',
      });
      return;
    }

    const editRunId = beginSendRun();
    const editedUserMessage: Message = {
      ...currentMessages[userIndex],
      content: text,
      createdAt: new Date(),
      isOffline: true,
      deliveryStatus: 'local-only',
    };
    const retainedMessages = currentMessages
      .slice(0, userIndex + 1)
      .map(message => (message.id === messageId ? editedUserMessage : message));
    const originalAssistantReply = currentMessages
      .slice(userIndex + 1)
      .find(message => message.role === 'assistant');

    messagesRef.current = retainedMessages;
    setMessages(retainedMessages);
    void persistMessagesForSession(session, retainedMessages);
    setInputValue('');
    setEditingMessageId(null);
    setIsSending(true);
    setIsAssistantTyping(true);
    requestAnimationFrame(scrollToBottom);

    try {
      let content: string;
      let sources: string[] | undefined;
      if (localAssistantCanRunOrConfigure) {
        const localReply = await generateLocalAssistantReply(
          buildAssistantConversation(retainedMessages),
          { languageCode },
          handleLocalAssistantProgress,
        );
        content = localReply.content;
        sources = [localReply.sourceLabel ?? getLocalAssistantSourceLabel()];
      } else if (isOnline && !sessionLocalOnly) {
        const assistantReply = await requestAssistantReply(buildAssistantConversation(retainedMessages), {
          preferLocal: false,
          languageCode,
          onLocalPreparationProgress: handleLocalAssistantProgress,
        });
        content = assistantReply.content;
        sources = assistantReply.sources;
      } else {
        const offlineReply = ChatErrorHandler.generateOfflineResponse(text, languageCode);
        content = offlineReply.content;
        sources = offlineReply.sources;
      }

      if (isSendRunStopped(editRunId)) return;

      appendMessage({
        id: originalAssistantReply?.id ?? `${messageId}-assistant-edited-${Date.now()}`,
        role: 'assistant',
        content,
        createdAt: new Date(),
        sources,
        isOffline: true,
      });
      toast.show({
        title: copy.toast.promptUpdatedTitle,
        message: copy.toast.promptUpdatedMessage,
        variant: 'success',
      });
    } catch (error) {
      if (isLocalAssistantReplyStoppedError(error) || isSendRunStopped(editRunId)) {
        return;
      }

      devPrivacyError('chat prompt edit failed', {
        reason: getPrivacySafeErrorReason(error),
        status: getPrivacySafeHttpStatus(error),
      });
      const offlineReply = ChatErrorHandler.generateOfflineResponse(text, languageCode);
      appendMessage({
        id: originalAssistantReply?.id ?? `${messageId}-assistant-edit-fallback-${Date.now()}`,
        role: 'assistant',
        content: offlineReply.content,
        createdAt: new Date(),
        sources: offlineReply.sources,
        isOffline: true,
      });
      toast.show({
        title: copy.toast.localReplySavedTitle,
        message: copy.toast.editFallbackMessage,
        variant: 'info',
      });
    } finally {
      clearSendRun(editRunId);
      setIsSending(false);
      setIsAssistantTyping(false);
    }
  }, [
    beginSendRun,
    clearSendRun,
    copy,
    handleLocalAssistantProgress,
    isOnline,
    isSendRunStopped,
    isSending,
    languageCode,
    lastEditableUserMessageId,
    localAssistantCanRunOrConfigure,
    persistMessagesForSession,
    scrollToBottom,
    session,
    sessionLocalOnly,
    toast,
  ]);

  const handleSend = useCallback(async (textOverride?: string) => {
    const text = (textOverride ?? inputValue).trim();
    if (!session || !text || isSending) return;
    if (editingMessageId) {
      await handleSubmitEditedPrompt(editingMessageId, text);
      return;
    }

    const sendRunId = beginSendRun();
    setIsSending(true);
    let sentUserMessage: Message | null = null;

    try {
      if (!isOnline || sessionLocalOnly) {
        const queuedAt = new Date();
        const offlineMessageId = Date.now().toString();
        const queued = sessionLocalOnly
          ? false
          : await ChatErrorHandler.queueMessageForRetry(session.id, {
            id: offlineMessageId,
            role: 'user',
            content: text,
            timestamp: queuedAt.toISOString(),
            deliveryStatus: 'queued',
          });
        const offlineMessage: Message = {
          id: offlineMessageId,
          role: 'user',
          content: text,
          createdAt: queuedAt,
          isOffline: true,
          deliveryStatus: sessionLocalOnly ? 'local-only' : queued ? 'queued' : 'local-only',
        };
        appendMessage(offlineMessage);
        setInputValue('');
        await refreshQueuedMessageCount(session.id);
        if (isSendRunStopped(sendRunId)) return;

        if (localAssistantCanRunOrConfigure) {
          setIsAssistantTyping(true);
          try {
            const conversationForModel = buildAssistantConversation([...messages, offlineMessage]);
            const assistantReply = await generateLocalAssistantReply(
              conversationForModel,
              { languageCode },
              handleLocalAssistantProgress,
            );
            if (isSendRunStopped(sendRunId)) return;
            appendMessage({
              id: `${offlineMessage.id}-assistant`,
              role: 'assistant',
              content: assistantReply.content,
              createdAt: new Date(),
              sources: [assistantReply.sourceLabel ?? getLocalAssistantSourceLabel()],
              isOffline: true,
            });
            toast.show({
              title: copy.toast.localAssistantTitle,
              message: sessionLocalOnly
                ? copy.toast.localSuggestionLocalOnly
                : copy.toast.localSuggestionQueued,
              variant: 'success',
            });
          } catch (localError) {
            if (isLocalAssistantReplyStoppedError(localError) || isSendRunStopped(sendRunId)) {
              return;
            }

            devPrivacyError('local assistant offline reply failed', { reason: getPrivacySafeErrorReason(localError) });
            const offlineReply = ChatErrorHandler.generateOfflineResponse(text, languageCode);
            appendMessage({
              id: `${offlineMessage.id}-assistant`,
              role: 'assistant',
              content: offlineReply.content,
              createdAt: new Date(),
              sources: offlineReply.sources,
              isOffline: true,
            });
            toast.show({
              title: sessionLocalOnly
                ? copy.toast.savedOnPhoneTitle
                : queued
                  ? copy.toast.messageQueuedTitle
                  : copy.toast.savedLocallyTitle,
              message: sessionLocalOnly
                ? copy.toast.localChatStillConnecting
                : queued
                  ? copy.toast.queuedNoProvider
                  : copy.toast.couldNotQueue,
              variant: sessionLocalOnly || queued ? 'info' : 'error',
            });
          } finally {
            setIsAssistantTyping(false);
          }
        } else {
          const offlineReply = ChatErrorHandler.generateOfflineResponse(text, languageCode);
          appendMessage({
            id: `${offlineMessage.id}-assistant`,
            role: 'assistant',
            content: offlineReply.content,
            createdAt: new Date(),
            sources: offlineReply.sources,
            isOffline: true,
          });
          toast.show({
            title: sessionLocalOnly
              ? copy.toast.savedOnPhoneTitle
              : queued
                ? copy.toast.messageQueuedTitle
                : copy.toast.savedLocallyTitle,
            message: sessionLocalOnly
              ? copy.toast.guidanceStaysVisible
              : queued
                ? copy.toast.queuedNoProvider
                : copy.toast.couldNotQueue,
            variant: sessionLocalOnly || queued ? 'info' : 'error',
          });
        }
        return;
      }

      const userRow = await sendChatMessage({
        sessionId: session.id,
        role: 'user',
        content: text,
      });
      const userMessage = mapRowToMessage(userRow);
      sentUserMessage = userMessage;
      appendMessage(userMessage);
      setInputValue('');
      setIsAssistantTyping(true);

      if (isSendRunStopped(sendRunId)) return;

      const conversationForModel = buildAssistantConversation([...messages, userMessage]);

      const assistantReply = await requestAssistantReply(conversationForModel, {
        preferLocal: localAssistantCanRunOrConfigure,
        languageCode,
        onLocalPreparationProgress: handleLocalAssistantProgress,
      });
      if (isSendRunStopped(sendRunId)) return;

      const replyRow = await sendChatMessage({
        sessionId: session.id,
        role: 'assistant',
        content: assistantReply.content,
        metadata: assistantReply.sources ? { sources: assistantReply.sources } : undefined,
      });
      appendMessage(mapRowToMessage(replyRow));
      await refreshSessions();
    } catch (error) {
      if (isLocalAssistantReplyStoppedError(error) || isSendRunStopped(sendRunId)) {
        return;
      }

      devPrivacyError('chat message send failed', {
        reason: getPrivacySafeErrorReason(error),
        status: getPrivacySafeHttpStatus(error),
      });
      const chatError = ChatErrorHandler.handleError(error);

      if (!sentUserMessage) {
        const queuedAt = new Date();
        const localMessageId = `${Date.now()}-local-fallback`;
        const queued = sessionLocalOnly
          ? false
          : await ChatErrorHandler.queueMessageForRetry(session.id, {
            id: localMessageId,
            role: 'user',
            content: text,
            timestamp: queuedAt.toISOString(),
            deliveryStatus: 'queued',
          });

        appendMessage({
          id: localMessageId,
          role: 'user',
          content: text,
          createdAt: queuedAt,
          isOffline: true,
          deliveryStatus: sessionLocalOnly ? 'local-only' : queued ? 'queued' : 'local-only',
        });
        setInputValue('');
        await refreshQueuedMessageCount(session.id);

        const offlineReply = ChatErrorHandler.generateOfflineResponse(text, languageCode);
        appendMessage({
          id: `${localMessageId}-assistant`,
          role: 'assistant',
          content: offlineReply.content,
          createdAt: new Date(),
          sources: offlineReply.sources,
          isOffline: true,
        });

        toast.show({
          title: sessionLocalOnly
            ? copy.toast.savedOnPhoneTitle
            : queued
              ? copy.toast.messageQueuedTitle
              : copy.toast.savedLocallyTitle,
          message: sessionLocalOnly || queued
            ? copy.toast.chatStaysVisible
            : chatError.message,
          variant: sessionLocalOnly || queued ? 'info' : 'warning',
        });
      } else {
        const offlineReply = ChatErrorHandler.generateOfflineResponse(text, languageCode);
        appendMessage({
          id: `${sentUserMessage.id}-local-assistant`,
          role: 'assistant',
          content: offlineReply.content,
          createdAt: new Date(),
          sources: offlineReply.sources,
          isOffline: true,
        });
        toast.show({
          title: copy.toast.localReplySavedTitle,
          message: copy.toast.serviceConnectingLocalNote,
          variant: 'info',
        });
      }
    } finally {
      clearSendRun(sendRunId);
      setIsSending(false);
      setIsAssistantTyping(false);
    }
  }, [
    appendMessage,
    beginSendRun,
    clearSendRun,
    copy,
    handleLocalAssistantProgress,
    handleSubmitEditedPrompt,
    editingMessageId,
    inputValue,
    isOnline,
    isSending,
    isSendRunStopped,
    languageCode,
    messages,
    localAssistantCanRunOrConfigure,
    refreshQueuedMessageCount,
    refreshSessions,
    session,
    sessionLocalOnly,
    toast,
  ]);

  const handleStopAssistantReply = useCallback(async () => {
    if (!isSending && !isAssistantTyping) return;

    const sendRunId = activeSendRunRef.current;
    if (sendRunId) {
      stoppedSendRunsRef.current.add(sendRunId);
    }

    const stoppedLocalReply = cancelActiveLocalAssistantReply();
    if (localAssistantStateRef.current.state === 'downloading') {
      try {
        await pauseLocalAssistantPreparation();
      } catch (error) {
        devPrivacyError('local assistant stop pause failed', { reason: getPrivacySafeErrorReason(error) });
      }
    }

    setIsAssistantTyping(false);
    setIsSending(false);
    toast.show({
      title: copy.toast.stoppedTitle,
      message: stoppedLocalReply
        ? copy.toast.stoppedLocalReply
        : copy.toast.stoppedWaiting,
      variant: 'info',
    });
  }, [copy, isAssistantTyping, isSending, toast]);

  const handleAttachEvidencePress = useCallback(async () => {
    if (!session) {
      toast.show({
        title: copy.toast.chatStorageUnavailableTitle,
        message: copy.toast.chatStorageUnavailableMessage,
        variant: 'warning',
      });
      return;
    }

    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: true,
        multiple: true,
      });

      if (result.canceled || result.assets.length === 0) {
        return;
      }

      const createdAt = new Date();
      const attachments = await Promise.all(
        result.assets.map((asset, index) => persistChatAttachment(session.id, asset, createdAt, index)),
      );

      appendMessage({
        id: `${createdAt.getTime()}-attachment-upload`,
        role: 'user',
        content: copy.attachmentMessage(attachments.length),
        createdAt,
        attachments,
        isOffline: true,
        deliveryStatus: 'local-only',
      });

      toast.show({
        title: copy.toast.attachmentUploadedTitle,
        message: copy.toast.attachmentUploadedMessage(attachments.length),
        variant: 'success',
      });
    } catch (error) {
      devPrivacyError('chat attachment upload failed', { reason: getPrivacySafeErrorReason(error) });
      toast.show({
        title: copy.toast.attachmentUploadFailedTitle,
        message: copy.toast.attachmentUploadFailedMessage,
        variant: 'error',
      });
    }
  }, [appendMessage, copy, session, toast]);

  const handleCopyMessage = useCallback(async (message: Message) => {
    try {
      await Clipboard.setStringAsync(message.content);
      toast.show({
        title: copy.toast.copiedTitle,
        message: copy.toast.copiedMessage,
        variant: 'success',
      });
    } catch (error) {
      devPrivacyError('chat message copy failed', { reason: getPrivacySafeErrorReason(error) });
      toast.show({
        title: copy.toast.copyFailedTitle,
        message: copy.toast.copyFailedMessage,
        variant: 'error',
      });
    }
  }, [copy, toast]);

  const handleEditUserMessage = useCallback((message: Message) => {
    if (message.id !== lastEditableUserMessageId) {
      toast.show({
        title: copy.toast.editUnavailableTitle,
        message: copy.toast.onlyLatestPrompt,
        variant: 'warning',
      });
      return;
    }

    setEditingMessageId(message.id);
    setInputValue(message.content);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    toast.show({
      title: copy.toast.editingLatestPromptTitle,
      message: copy.toast.editingLatestPromptMessage,
      variant: 'info',
    });
  }, [copy, lastEditableUserMessageId, toast]);

  const handleRetryAssistantReply = useCallback(async (assistantMessage: Message) => {
    if (!session || isSending) return;
    if (assistantMessage.id !== lastAssistantActionMessageId) {
      toast.show({
        title: copy.toast.retryUnavailableTitle,
        message: copy.toast.onlyLatestReply,
        variant: 'warning',
      });
      return;
    }

    const currentMessages = messagesRef.current;
    const assistantIndex = currentMessages.findIndex(message => message.id === assistantMessage.id);
    const userMessage = findPreviousUserMessage(currentMessages, assistantIndex - 1);
    if (!userMessage) {
      toast.show({
        title: copy.toast.retryUnavailableTitle,
        message: copy.toast.promptNotFound,
        variant: 'warning',
      });
      return;
    }

    const userIndex = currentMessages.findIndex(message => message.id === userMessage.id);
    const conversationForModel = buildAssistantConversation(currentMessages.slice(0, userIndex + 1));
    const retryRunId = beginSendRun();

    setIsSending(true);
    setIsAssistantTyping(true);
    try {
      let content: string;
      let sources: string[] | undefined;
      let generatedOffline = true;

      if (localAssistantCanRunOrConfigure) {
        const localReply = await generateLocalAssistantReply(
          conversationForModel,
          { languageCode },
          handleLocalAssistantProgress,
        );
        content = localReply.content;
        sources = [localReply.sourceLabel ?? getLocalAssistantSourceLabel()];
      } else if (isOnline && !sessionLocalOnly) {
        const assistantReply = await requestAssistantReply(conversationForModel, {
          preferLocal: false,
          languageCode,
          onLocalPreparationProgress: handleLocalAssistantProgress,
        });
        content = assistantReply.content;
        sources = assistantReply.sources;
        generatedOffline = false;
      } else {
        const offlineReply = ChatErrorHandler.generateOfflineResponse(userMessage.content, languageCode);
        content = offlineReply.content;
        sources = offlineReply.sources;
      }

      if (isSendRunStopped(retryRunId)) return;

      const retriedMessage: Message = {
        ...assistantMessage,
        role: 'assistant',
        content,
        createdAt: new Date(),
        sources,
        isOffline: generatedOffline || sessionLocalOnly || !isOnline,
      };
      replaceMessage(assistantMessage.id, retriedMessage);
    } catch (error) {
      if (isLocalAssistantReplyStoppedError(error) || isSendRunStopped(retryRunId)) {
        return;
      }

      devPrivacyError('chat assistant retry failed', {
        reason: getPrivacySafeErrorReason(error),
        status: getPrivacySafeHttpStatus(error),
      });
      const offlineReply = ChatErrorHandler.generateOfflineResponse(userMessage.content, languageCode);
      replaceMessage(assistantMessage.id, {
        ...assistantMessage,
        role: 'assistant',
        content: offlineReply.content,
        createdAt: new Date(),
        sources: offlineReply.sources,
        isOffline: true,
      });
      toast.show({
        title: copy.toast.localReplySavedTitle,
        message: copy.toast.serviceConnectingLocalNote,
        variant: 'info',
      });
    } finally {
      clearSendRun(retryRunId);
      setIsSending(false);
      setIsAssistantTyping(false);
    }
  }, [
    appendMessage,
    beginSendRun,
    clearSendRun,
    copy,
    handleLocalAssistantProgress,
    isOnline,
    isSendRunStopped,
    isSending,
    languageCode,
    localAssistantCanRunOrConfigure,
    lastAssistantActionMessageId,
    replaceMessage,
    session,
    sessionLocalOnly,
    toast,
  ]);

  const handleOpenSessionPicker = useCallback(() => {
    Keyboard.dismiss();
    setIsSessionPickerVisible(true);
    refreshSessions(availableSessions.length === 0).catch(() => {});
  }, [availableSessions.length, refreshSessions]);

  const handleCloseSessionPicker = useCallback(() => {
    setIsSessionPickerVisible(false);
  }, []);

  const handleSelectSession = useCallback(
      async (targetSession: ChatSession) => {
        setIsSessionPickerVisible(false);
        if (session?.id === targetSession.id) return;
        Keyboard.dismiss();
        await loadSession(targetSession, { includeOffline: true, showLoader: true });
      },
      [loadSession, session],
  );

  const handleSideNavSessionPress = useCallback(
    (targetSession: ChatSession) => {
      if (!isWideChatLayout) {
        setIsSideNavExpanded(false);
      }
      if (session?.id === targetSession.id) return;

      Keyboard.dismiss();
      void loadSession(targetSession, { includeOffline: true, showLoader: true });
    },
    [isWideChatLayout, loadSession, session?.id],
  );

  const handleDeleteSession = useCallback((targetSession: ChatSession) => {
    if (assistantBusy) {
      toast.show({
        title: copy.toast.replyInProgressTitle,
        message: copy.toast.stopBeforeDeleting,
        variant: 'info',
      });
      return;
    }

    const isDeletingLocalSession = isLocalChatSession(targetSession);
    Alert.alert(
      copy.alerts.deleteConversationTitle,
      isDeletingLocalSession
        ? copy.alerts.deleteLocalConversation
        : copy.alerts.deleteRemoteConversation,
      [
        { text: copy.alerts.cancel, style: 'cancel' },
        {
          text: copy.alerts.delete,
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                if (isDeletingLocalSession) {
                  await deleteLocalChatSessionRecord(targetSession.ownerId, targetSession.id);
                } else {
                  await deleteChatSession(targetSession.id);
                  await deleteLocalChatSessionRecordForRemoteSession(ownerId, targetSession.id);
                }
                await ChatErrorHandler.clearOfflineMessages(targetSession.id);
                await ChatErrorHandler.clearRetryQueue(targetSession.id);

                const remainingSessions = availableSessions.filter(item => item.id !== targetSession.id);
                setAvailableSessions(remainingSessions);
                if (session?.id === targetSession.id) {
                  const nextSession = remainingSessions[0] ?? createLocalChatSession(ownerId);
                  await loadSession(nextSession, { includeOffline: true, showLoader: false });
                }
                await refreshSessions();
                toast.show({
                  title: copy.toast.conversationDeletedTitle,
                  message: isDeletingLocalSession
                    ? copy.toast.localChatRemoved
                    : copy.toast.historyRemoved,
                  variant: 'success',
                });
              } catch (error) {
                devPrivacyError('chat conversation delete failed', {
                  reason: getPrivacySafeErrorReason(error),
                  status: getPrivacySafeHttpStatus(error),
                });
                toast.show({
                  title: copy.toast.deleteFailedTitle,
                  message: copy.toast.deleteFailedMessage,
                  variant: 'error',
                });
              }
            })();
          },
        },
      ],
    );
  }, [
    assistantBusy,
    availableSessions,
    copy,
    loadSession,
    ownerId,
    refreshSessions,
    session?.id,
    toast,
  ]);

  const handleSyncLocalSession = useCallback((targetSession: ChatSession) => {
    if (!isLocalChatSession(targetSession)) return;
    if (!CHAT_REMOTE_SYNC_ENABLED) {
      toast.show({
        title: copy.toast.syncUnavailableTitle,
        message: copy.toast.localPhoneChatTesting,
        variant: 'info',
      });
      return;
    }
    if (!isOnline) {
      toast.show({
        title: copy.toast.syncUnavailableTitle,
        message: copy.toast.connectBeforeSync,
        variant: 'info',
      });
      return;
    }
    if (assistantBusy) {
      toast.show({
        title: copy.toast.replyInProgressTitle,
        message: copy.toast.stopBeforeSync,
        variant: 'info',
      });
      return;
    }

    Alert.alert(
      copy.alerts.syncConversationTitle,
      copy.alerts.syncConversationMessage,
      [
        { text: copy.alerts.cancel, style: 'cancel' },
        {
          text: copy.alerts.sync,
          onPress: () => {
            void (async () => {
              const records = await listLocalChatSessionRecords(targetSession.ownerId);
              const existingRecord = records.find(record => record.id === targetSession.id);
              try {
                await upsertLocalChatSessionRecord({
                  id: targetSession.id,
                  ownerId: targetSession.ownerId,
                  mode: targetSession.mode ?? 'legal-aid-local',
                  createdAt: safeSerializeDate(targetSession.createdAt),
                  lastActivity: safeSerializeDate(targetSession.lastActivity),
                  syncStatus: 'syncing',
                  remoteSessionId: existingRecord?.remoteSessionId,
                });

                const localMessages = (await ChatErrorHandler.loadMessagesOffline(targetSession.id))
                  .filter(message => (
                    !message.id.endsWith('-welcome') &&
                    message.content.trim().length > 0 &&
                    !message.attachments?.length
                  ));
                const remoteSession = existingRecord?.remoteSessionId
                  ? ({
                    id: existingRecord.remoteSessionId,
                    ownerId: targetSession.ownerId,
                    mode: 'legal-aid',
                    createdAt: targetSession.createdAt,
                    lastActivity: targetSession.lastActivity,
                  } satisfies ChatSession)
                  : await createChatSession();

                for (const message of localMessages) {
                  await sendChatMessage({
                    sessionId: remoteSession.id,
                    role: message.role,
                    content: message.content,
                    metadata: message.sources ? { sources: message.sources } : undefined,
                  });
                }

                await upsertLocalChatSessionRecord({
                  id: targetSession.id,
                  ownerId: targetSession.ownerId,
                  mode: targetSession.mode ?? 'legal-aid-local',
                  createdAt: safeSerializeDate(targetSession.createdAt),
                  lastActivity: new Date().toISOString(),
                  syncStatus: 'synced',
                  remoteSessionId: remoteSession.id,
                });

                await loadSession(remoteSession, { includeOffline: true, showLoader: false });
                await refreshSessions();
                toast.show({
                  title: copy.toast.conversationSyncedTitle,
                  message: copy.toast.conversationSyncedMessage,
                  variant: 'success',
                });
              } catch (error) {
                await upsertLocalChatSessionRecord({
                  id: targetSession.id,
                  ownerId: targetSession.ownerId,
                  mode: targetSession.mode ?? 'legal-aid-local',
                  createdAt: safeSerializeDate(targetSession.createdAt),
                  lastActivity: safeSerializeDate(targetSession.lastActivity),
                  syncStatus: 'sync-failed',
                  remoteSessionId: existingRecord?.remoteSessionId,
                });
                devPrivacyError('local chat sync failed', {
                  reason: getPrivacySafeErrorReason(error),
                  status: getPrivacySafeHttpStatus(error),
                });
                toast.show({
                  title: copy.toast.syncFailedTitle,
                  message: copy.toast.syncFailedMessage,
                  variant: 'error',
                });
              }
            })();
          },
        },
      ],
    );
  }, [
    assistantBusy,
    copy,
    isOnline,
    loadSession,
    refreshSessions,
    toast,
  ]);

  const handleStartNewConversation = useCallback(async () => {
    const localSession = createNewLocalChatSession(ownerId);
    setIsSessionPickerVisible(false);
    Keyboard.dismiss();
    await loadSession(localSession, { includeOffline: false, showLoader: false });
    setQueuedMessageCount(0);
    toast.show({
      title: copy.toast.localPhoneChatTitle,
      message: isOnline ? copy.toast.localPhoneChatTesting : copy.toast.localPhoneChatOffline,
      variant: 'info',
    });
  }, [copy, isOnline, loadSession, ownerId, toast]);

  useEffect(() => {
    navigation.setOptions({
      title: currentThreadTitle,
      headerLeft: () => (
        <TouchableOpacity
          style={styles.navIcon}
          onPress={handleOpenSessionPicker}
          accessibilityLabel={copy.openConversations}
        >
          <Ionicons name="menu" size={24} color={ui.colors.iconNeutral} />
        </TouchableOpacity>
      ),
      headerRight: () => (
        <TouchableOpacity
          style={styles.navIcon}
          onPress={handleStartNewConversation}
          accessibilityLabel={copy.startNewChat}
        >
          <Ionicons name="create-outline" size={24} color={ui.colors.iconNeutral} />
        </TouchableOpacity>
      ),
    });
  }, [copy, currentThreadTitle, handleOpenSessionPicker, handleStartNewConversation, navigation]);

  useEffect(() => {
    if (initialisedOwnerRef.current === ownerId) {
      return;
    }
    initialisedOwnerRef.current = ownerId;

    let mounted = true;

    const initialise = async () => {
      const localSessions = (await listLocalChatSessionRecords(ownerId)).map(mapLocalSessionRecordToChatSession);
      const localSession = localSessions[0] ?? createLocalChatSession(ownerId);
      await loadSession(localSession, { includeOffline: true, showLoader: false });
      if (!mounted) {
        return;
      }
      setAvailableSessions(prev => mergeChatSessions(localSessions, prev));
      setIsLoading(false);
    };

    initialise().catch(error => {
      devPrivacyError('chat local initialization failed', {
        reason: getPrivacySafeErrorReason(error),
        status: getPrivacySafeHttpStatus(error),
      });
      if (mounted) {
        setIsLoading(false);
        toast.show({
          title: copy.toast.chatStorageUnavailableTitle,
          message: copy.toast.chatStorageUnavailableMessage,
          variant: 'warning',
        });
      }
    });

    return () => {
      mounted = false;
      subscriptionRef.current?.unsubscribe();
    };
  }, [copy, loadSession, ownerId, toast]);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const showSub = Keyboard.addListener(showEvent, event => {
      const height = event?.endCoordinates?.height ?? 0;
      setKeyboardHeight(height);
      requestAnimationFrame(scrollToBottom);
    });
    const hideSub = Keyboard.addListener(hideEvent, () => setKeyboardHeight(0));

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [scrollToBottom]);

  useEffect(() => {
    const flushActiveSnapshot = () => {
      const activeSession = activeSessionRef.current;
      const activeMessages = messagesRef.current;
      if (!activeSession || activeMessages.length === 0) {
        return;
      }
      void persistMessagesForSession(activeSession, activeMessages);
    };

    const subscription = AppState.addEventListener('change', nextAppState => {
      if (nextAppState !== 'active') {
        flushActiveSnapshot();
      }
    });

    return () => {
      flushActiveSnapshot();
      subscription.remove();
    };
  }, [persistMessagesForSession]);

  useEffect(() => {
    if (!session) return;
    if (isLocalChatSession(session)) return;
    if (!isOnline) return;
    if (retryQueueInFlightRef.current) return;

    const processQueue = async () => {
      retryQueueInFlightRef.current = true;
      try {
        const processed = await ChatErrorHandler.processRetryQueue(session.id, async content => {
          const row = await sendChatMessage({
            sessionId: session.id,
            role: 'user',
            content,
          });
          appendMessage(mapRowToMessage(row));

          const conversationForModel = [{ role: 'user', content }] as Array<{ role: 'user' | 'assistant'; content: string }>;
          setIsAssistantTyping(true);
          try {
            const reply = await requestAssistantReply(conversationForModel, {
              preferLocal: localAssistantCanRunOrConfigure,
              languageCode,
              onLocalPreparationProgress: handleLocalAssistantProgress,
            });
            const replyRow = await sendChatMessage({
              sessionId: session.id,
              role: 'assistant',
              content: reply.content,
              metadata: reply.sources ? { sources: reply.sources } : undefined,
            });
            appendMessage(mapRowToMessage(replyRow));
          } catch (assistantError) {
            devPrivacyError('queued chat assistant follow-up failed', {
              reason: getPrivacySafeErrorReason(assistantError),
              status: getPrivacySafeHttpStatus(assistantError),
            });
            const offlineReply = ChatErrorHandler.generateOfflineResponse(content, languageCode);
            appendMessage({
              id: `${row.id}-assistant-local-fallback`,
              role: 'assistant',
              content: offlineReply.content,
              createdAt: new Date(),
              sources: offlineReply.sources,
              isOffline: true,
            });
          } finally {
            setIsAssistantTyping(false);
          }
        });

        const remainingQueued = await refreshQueuedMessageCount(session.id);

        if (processed > 0) {
          if (remainingQueued === 0) {
            const nextMessages: Message[] = messagesRef.current.map(message => (
              message.deliveryStatus === 'queued'
                ? { ...message, isOffline: false, deliveryStatus: 'sent' }
                : message
            ));
            messagesRef.current = nextMessages;
            setMessages(nextMessages);
            await persistMessagesForSession(session, nextMessages);
            await ChatErrorHandler.clearRetryQueue(session.id);
          }
          toast.show({
            title: copy.toast.queuedMessagesSavedTitle,
            message: copy.toast.queuedMessagesSaved(processed),
            variant: 'success',
          });
          await refreshSessions();
        }
      } finally {
        retryQueueInFlightRef.current = false;
      }
    };

    processQueue().catch(error => {
      devPrivacyError('queued chat processing failed', {
        reason: getPrivacySafeErrorReason(error),
        status: getPrivacySafeHttpStatus(error),
      });
    });
  }, [
    appendMessage,
    copy,
    handleLocalAssistantProgress,
    isOnline,
    languageCode,
    localAssistantCanRunOrConfigure,
    persistMessagesForSession,
    refreshQueuedMessageCount,
    refreshSessions,
    session,
    toast,
  ]);

  useEffect(() => {
    if (!session) return;
    if (messages.length === 0) return;
    if (hydratingSessionIdRef.current === session.id) return;

    void persistMessagesForSession(session, messages);
  }, [messages, persistMessagesForSession, session]);

  const chatDetailsModal = (
    <InfoModal
      visible={isChatDetailsVisible}
      title={copy.modal.chatStatusTitle}
      description={copy.modal.chatStatusDescription}
      onClose={() => setIsChatDetailsVisible(false)}
    >
      <InfoModalSection title={copy.modal.currentSetup}>
        <InfoModalBullet>{assistantSourceSummary.detail}</InfoModalBullet>
        <InfoModalBullet>{localAssistantStatusDescription}</InfoModalBullet>
        <InfoModalBullet>{copy.modal.foregroundDownload}</InfoModalBullet>
        <InfoModalBullet>{copy.modal.modelSize(localAssistantDescriptor.approximateSize)}</InfoModalBullet>
      </InfoModalSection>
      <InfoModalSection title={copy.modal.messageHandling}>
        <InfoModalBullet>{copy.modal.noProviderContact}</InfoModalBullet>
        <InfoModalBullet>{copy.modal.offlineSync}</InfoModalBullet>
      </InfoModalSection>
    </InfoModal>
  );

  if (isLoading) {
    return (
        <View style={styles.loaderRoot}>
          <LinearGradient
              colors={[ui.colors.backgroundTop, ui.colors.backgroundBottom]}
              style={StyleSheet.absoluteFill}
          />
          <SafeAreaView style={styles.loaderSafeArea} edges={['left', 'right']}>
            <StatusBar barStyle={colorScheme === 'dark' ? 'light-content' : 'dark-content'} />
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color={ui.colors.iconNeutral} />
              <Text style={styles.loadingText}>{copy.loadingChat}</Text>
            </View>
          </SafeAreaView>
        </View>
    );
  }

  return (
    <View style={styles.root}>
      <LinearGradient
        colors={[ui.colors.backgroundTop, ui.colors.backgroundBottom]}
        style={StyleSheet.absoluteFill}
      />
      <SafeAreaView style={styles.safeArea} edges={['left', 'right']}>
        <StatusBar barStyle={colorScheme === 'dark' ? 'light-content' : 'dark-content'} />
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.select({ ios: 'padding', android: 'height', default: undefined })}
          keyboardVerticalOffset={keyboardOffset}
        >
          <View style={styles.chatLayout}>
            {isSideNavExpanded && !isWideChatLayout ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Collapse conversation sidebar"
                style={styles.sideNavBackdrop}
                onPress={() => setIsSideNavExpanded(false)}
              />
            ) : null}

            {!isSideNavExpanded ? (
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Expand conversation sidebar"
                activeOpacity={0.75}
                onPress={() => setIsSideNavExpanded(true)}
                style={styles.collapsedNavButton}
              >
                <Ionicons name="menu-outline" size={21} color={ui.colors.textPrimary} />
              </TouchableOpacity>
            ) : null}

            {isSideNavExpanded ? (
              <View
                style={[
                  styles.sideNav,
                  styles.sideNavExpanded,
                  !isWideChatLayout ? styles.sideNavOverlay : null,
                ]}
              >
                <View style={styles.sideNavHeader}>
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel="Collapse conversation sidebar"
                    activeOpacity={0.75}
                    onPress={() => setIsSideNavExpanded(false)}
                    style={styles.sideNavIconButton}
                  >
                    <Ionicons name="chevron-back-outline" size={20} color={ui.colors.textPrimary} />
                  </TouchableOpacity>
                  <View style={styles.sideNavBrand}>
                    <Text style={styles.sideNavBrandTitle} numberOfLines={1}>SafeRide AI</Text>
                    <Text style={styles.sideNavBrandMeta} numberOfLines={1}>{chatModeBadge}</Text>
                  </View>
                </View>

                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={copy.startNewChat}
                  activeOpacity={0.78}
                  onPress={handleStartNewConversation}
                  style={styles.sideNavPrimary}
                >
                  <Ionicons name="create-outline" size={18} color={ui.colors.userBubbleText} />
                  <Text style={styles.sideNavPrimaryText}>{copy.newConversationShort}</Text>
                </TouchableOpacity>

                <View style={styles.sideNavDivider} />

                <Text style={styles.sideNavSectionLabel}>{copy.conversations}</Text>

                <ScrollView
                  style={styles.sideNavList}
                  contentContainerStyle={styles.sideNavListContent}
                  showsVerticalScrollIndicator={false}
                >
                  {sideNavSessions.map((item, index) => {
                    const isActive = session?.id === item.id;
                    const isLocalOnlyThread = isLocalChatSession(item);

                    return (
                      <TouchableOpacity
                        key={item.id}
                        accessibilityRole="button"
                        accessibilityLabel={`${copy.openConversations}: ${copy.conversationTitle(index + 1)}`}
                        activeOpacity={0.78}
                        disabled={isActive}
                        onPress={() => handleSideNavSessionPress(item)}
                        style={[
                          styles.sideNavItem,
                          isActive ? styles.sideNavItemActive : null,
                        ]}
                      >
                        <View style={[styles.sideNavItemIcon, isActive ? styles.sideNavItemIconActive : null]}>
                          <Ionicons
                            name={isActive ? 'chatbubble' : 'chatbubble-outline'}
                            size={16}
                            color={isActive ? ui.colors.userBubbleText : ui.colors.ctaAccent}
                          />
                        </View>
                        <View style={styles.sideNavItemCopy}>
                          <Text style={styles.sideNavItemTitle} numberOfLines={1}>
                            {copy.conversationTitle(index + 1)}
                          </Text>
                          <Text style={styles.sideNavItemMeta} numberOfLines={1}>
                            {`${formatSessionTimestamp(item.lastActivity, copy, languageCode)} - ${isLocalOnlyThread ? copy.currentMeta.localPhone : copy.currentMeta.syncedHistory}`}
                          </Text>
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>

                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={copy.openConversations}
                  activeOpacity={0.76}
                  onPress={handleOpenSessionPicker}
                  style={styles.sideNavFooterButton}
                >
                  <Ionicons name="albums-outline" size={18} color={ui.colors.ctaAccent} />
                  <Text style={styles.sideNavFooterText}>{copy.openConversations}</Text>
                </TouchableOpacity>
              </View>
            ) : null}

          <View style={styles.content}>
            <View style={[styles.threadToolbar, !isSideNavExpanded ? styles.threadToolbarWithCollapsedNav : null]}>
              <View style={styles.threadToolbarCopy}>
                <View style={styles.threadToolbarTitleRow}>
                  <Text style={styles.threadToolbarTitle} numberOfLines={1}>{currentThreadTitle}</Text>
                  <View
                    style={[
                      styles.threadToolbarBadge,
                      chatMode.id === 'local-assistant'
                        ? styles.threadToolbarBadgeReady
                        : styles.threadToolbarBadgePending,
                    ]}
                  >
                    <Ionicons name={assistantSourceSummary.icon} size={12} color={ui.colors.ctaAccent} />
                    <Text style={styles.threadToolbarBadgeText} numberOfLines={1}>{chatModeBadge}</Text>
                  </View>
                </View>
              </View>
            </View>
            <ScrollView
              ref={scrollRef}
              style={styles.messagesContainer}
              contentContainerStyle={[
                styles.messagesContent,
                {
                  paddingBottom: scrollBottomPadding,
                },
              ]}
              keyboardShouldPersistTaps="handled"
              onContentSizeChange={scrollToBottom}
              showsVerticalScrollIndicator={false}
            >
              {showLocalAssistantSetup ? (
                showCompactLocalAssistantPreparation ? (
                  <View
                    accessible
                    accessibilityLiveRegion="polite"
                    accessibilityLabel={`${copy.setup.preparingModelTitle}. ${copy.setup.preparingModelDetail}`}
                    style={styles.localAssistantPreparingCard}
                  >
                    <View style={styles.localAssistantPreparingIcon}>
                      <ActivityIndicator size="small" color={ui.colors.ctaAccent} />
                    </View>
                    <View style={styles.localAssistantPreparingCopy}>
                      <Text style={styles.localAssistantPreparingTitle}>{copy.setup.preparingModelTitle}</Text>
                      <Text style={styles.localAssistantPreparingDetail}>{copy.setup.preparingModelDetail}</Text>
                    </View>
                  </View>
                ) : (
                <View style={styles.localAssistantSetupCard}>
                  <SafetyIllustration kind="support" size={72} responsive />
                  <View style={styles.localAssistantSetupIcon}>
                    <Ionicons name="phone-portrait-outline" size={26} color={ui.colors.ctaAccent} />
                  </View>
                  <Text style={styles.localAssistantSetupKicker}>{copy.setup.heroKicker}</Text>
                  <Text style={styles.localAssistantSetupTitle}>{localAssistantDescriptor.label}</Text>
                  <Text style={styles.localAssistantSetupDetail}>{localAssistantStatusDescription}</Text>
                  {showLocalAssistantDeterminateProgress ? (
                    <View style={styles.localAssistantProgressSection}>
                      <View style={styles.localAssistantProgressHeader}>
                        <Text style={styles.localAssistantProgressLabel}>{localAssistantStateLabel}</Text>
                        <Text style={styles.localAssistantProgressPercent}>{localAssistantProgressPercent}%</Text>
                      </View>
                      <View
                        accessibilityRole="progressbar"
                        accessibilityLabel={localAssistantStateLabel}
                        accessibilityValue={{
                          min: 0,
                          max: 100,
                          now: localAssistantProgressPercent,
                          text: localAssistantStateLabel,
                        }}
                        style={styles.localAssistantProgressTrack}
                      >
                        <View
                          style={[
                            styles.localAssistantProgressFill,
                            { width: localAssistantProgressWidth },
                          ]}
                        />
                      </View>
                      {localAssistantProgressBytes && localAssistantState.state !== 'verifying' ? (
                        <Text style={styles.localAssistantProgressBytes}>{localAssistantProgressBytes}</Text>
                      ) : null}
                    </View>
                  ) : showLocalAssistantIndeterminateProgress ? (
                    <View style={styles.localAssistantIndeterminateProgress}>
                      <ActivityIndicator size="small" color={ui.colors.ctaAccent} />
                      <Text style={styles.localAssistantProgressLabel}>{localAssistantStateLabel}</Text>
                    </View>
                  ) : null}
                  {localAssistantState.state === 'verifying' ? (
                    <View style={styles.localAssistantVerificationNotice}>
                      <Ionicons name="shield-checkmark-outline" size={19} color={ui.colors.ctaAccent} />
                      <Text style={styles.localAssistantVerificationText}>
                        {copy.setup.verificationFact}
                      </Text>
                    </View>
                  ) : null}
                  <View style={styles.localAssistantSetupFacts}>
                    <View style={styles.localAssistantSetupFactRow}>
                      <View style={styles.localAssistantSetupFactIcon}>
                        <Ionicons name="download-outline" size={17} color={ui.colors.ctaAccent} />
                      </View>
                      <Text style={styles.localAssistantSetupFact}>
                        {copy.setup.exactSizeFact(compactModelSizeLabel ?? copy.setup.unknownExactSize)}
                      </Text>
                    </View>
                    <View style={styles.localAssistantSetupFactDivider} />
                    <View style={styles.localAssistantSetupFactRow}>
                      <View style={styles.localAssistantSetupFactIcon}>
                        <Ionicons name="phone-portrait-outline" size={17} color={ui.colors.ctaAccent} />
                      </View>
                      <Text style={styles.localAssistantSetupFact}>
                        {copy.setup.storageFact(compactRequiredStorageLabel ?? copy.setup.unknownExactSize)}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.localAssistantForegroundNotice}>
                    <Ionicons name="information-circle-outline" size={18} color={ui.colors.textSecondary} />
                    <Text style={styles.localAssistantForegroundText}>
                      {copy.setup.foregroundOnlyFact}
                    </Text>
                  </View>
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel={localAssistantSetupActionLabel}
                    activeOpacity={0.78}
                    disabled={localAssistantSetupActionDisabled}
                    onPress={() => {
                      void handleLocalAssistantSetupAction();
                    }}
                    style={[
                      styles.localAssistantSetupPrimary,
                      localAssistantSetupActionDisabled
                        ? styles.localAssistantSetupPrimaryDisabled
                        : null,
                    ]}
                  >
                    {localAssistantSetupBusy ? (
                      <ActivityIndicator size="small" color={setupActionForeground} />
                    ) : localAssistantState.state === 'downloading' ? (
                      <Ionicons name="pause" size={18} color={setupActionForeground} />
                    ) : (
                      <Ionicons
                        name={localAssistantState.modelDownloaded ? 'play' : 'download-outline'}
                        size={18}
                        color={setupActionForeground}
                      />
                    )}
                    <Text style={[styles.localAssistantSetupPrimaryText, { color: setupActionForeground }]}>
                      {localAssistantSetupActionLabel}
                    </Text>
                  </TouchableOpacity>
                  {showLocalAssistantCancel ? (
                    <TouchableOpacity
                      accessibilityRole="button"
                      accessibilityLabel={copy.setup.cancelDownloadAction}
                      activeOpacity={0.72}
                      onPress={() => {
                        void handleCancelLocalAssistantSetup();
                      }}
                      style={styles.localAssistantSetupSecondary}
                    >
                      <Ionicons name="close-circle-outline" size={17} color={ui.colors.error} />
                      <Text style={styles.localAssistantSetupSecondaryText}>
                        {copy.setup.cancelDownloadAction}
                      </Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
                )
              ) : hasUserMessages ? (
                <>
                  <View style={styles.timelineRow}>
                    <Text style={styles.timelineLabel}>{copy.today}</Text>
                    <View style={styles.timelineRule} />
                  </View>
                  {messages.map((message, index) => {
                    const previous = index > 0 ? messages[index - 1] : undefined;
                    const isSameRole = previous?.role === message.role;
                    const canEditMessage = message.id === lastEditableUserMessageId;
                    const canRetryMessage = message.id === lastAssistantActionMessageId;

                    if (message.role === 'user') {
                      return (
                        <View
                          key={message.id}
                          style={[
                            styles.userBubble,
                            { marginTop: index === 0 ? 0 : isSameRole ? 4 : 10 },
                          ]}
                        >
                          <Text style={styles.userMessageText}>{message.content}</Text>
                          {message.attachments?.length ? (
                            <View style={styles.attachmentStack}>
                              {message.attachments.map(attachment => (
                                <View key={attachment.id} style={styles.attachmentCard}>
                                  <View style={styles.attachmentIcon}>
                                    <Ionicons
                                      name={getAttachmentIcon(attachment)}
                                      size={15}
                                      color={ui.colors.userBubbleText}
                                    />
                                  </View>
                                  <View style={styles.attachmentCopy}>
                                    <Text style={styles.attachmentTitle} numberOfLines={1}>
                                      {attachment.fileName}
                                    </Text>
                                    <Text style={styles.attachmentMeta} numberOfLines={1}>
                                      {formatAttachmentMeta(attachment, copy)}
                                    </Text>
                                  </View>
                                </View>
                              ))}
                            </View>
                          ) : null}
                          {getDeliveryStatusLabel(message, copy) ? (
                            <Text style={styles.userMetaText}>{getDeliveryStatusLabel(message, copy)}</Text>
                          ) : null}
                          <View style={styles.userMessageActionRow}>
                            <TouchableOpacity
                              style={styles.userMessageActionButton}
                              onPress={() => {
                                void handleCopyMessage(message);
                              }}
                              accessibilityRole="button"
                              accessibilityLabel={copy.copyPrompt}
                              activeOpacity={0.72}
                            >
                              <Ionicons name="copy-outline" size={15} color={ui.colors.userBubbleText} />
                            </TouchableOpacity>
                            {canEditMessage ? (
                              <TouchableOpacity
                                style={[
                                  styles.userMessageActionButton,
                                  assistantBusy ? styles.messageActionButtonDisabled : null,
                                ]}
                                onPress={() => handleEditUserMessage(message)}
                                disabled={assistantBusy}
                                accessibilityRole="button"
                                accessibilityLabel={copy.editLatestPrompt}
                                activeOpacity={0.72}
                              >
                                <Ionicons name="create-outline" size={15} color={ui.colors.userBubbleText} />
                              </TouchableOpacity>
                            ) : null}
                          </View>
                        </View>
                      );
                    }

                    return (
                      <View
                        key={message.id}
                        style={[
                          styles.assistantContainer,
                          { marginTop: index === 0 ? 0 : isSameRole ? 6 : 12 },
                        ]}
                      >
                        <View style={styles.assistantMessageHeader}>
                          <View style={styles.assistantAvatar}>
                            <Ionicons name="phone-portrait-outline" size={14} color={ui.colors.ctaAccent} />
                          </View>
                          <Text style={styles.assistantMessageTitle}>{copy.assistantName}</Text>
                          <Text style={styles.assistantMessageTime}>
                            {formatSessionTimestamp(message.createdAt, copy, languageCode)}
                          </Text>
                        </View>
                        <MarkdownText
                          content={message.content}
                          textStyle={styles.assistantText}
                          containerStyle={styles.assistantTextContainer}
                          linkColor={ui.colors.ctaAccent}
                          codeBackgroundColor="rgba(15, 23, 42, 0.07)"
                          codeTextColor={ui.colors.textPrimary}
                          quoteBorderColor="rgba(15, 23, 42, 0.24)"
                        />
                        {message.sources && message.sources.length > 0 ? (
                          <View style={styles.sourceRow}>
                            {message.sources.map((source, sourceIndex) => (
                              <View key={`${message.id}-source-${sourceIndex}`} style={styles.sourceBadge}>
                                <Ionicons name="shield-checkmark-outline" size={11} color={ui.colors.ctaAccent} />
                                <Text style={styles.sourceBadgeText}>{source}</Text>
                              </View>
                            ))}
                          </View>
                        ) : null}
                        <View style={styles.assistantMessageActionRow}>
                          <TouchableOpacity
                            style={styles.assistantMessageActionButton}
                            onPress={() => {
                              void handleCopyMessage(message);
                            }}
                            accessibilityRole="button"
                            accessibilityLabel={copy.copyReply}
                            activeOpacity={0.72}
                          >
                            <Ionicons name="copy-outline" size={15} color={ui.colors.ctaAccent} />
                          </TouchableOpacity>
                          {canRetryMessage ? (
                            <TouchableOpacity
                              style={[
                                styles.assistantMessageActionButton,
                                assistantBusy ? styles.messageActionButtonDisabled : null,
                              ]}
                              onPress={() => {
                                void handleRetryAssistantReply(message);
                              }}
                              disabled={assistantBusy}
                              accessibilityRole="button"
                              accessibilityLabel={copy.retryLatestReply}
                              activeOpacity={0.72}
                            >
                              <Ionicons name="refresh-outline" size={15} color={ui.colors.ctaAccent} />
                            </TouchableOpacity>
                          ) : null}
                          {aiPilotDiagnosticsEnabled
                            && !message.isOffline
                            && message.sources?.includes(localAssistantDescriptor.label) ? (
                              (['helpful', 'not-helpful'] as const).map(value => {
                                const selected = pilotFeedbackByMessageId[message.id] === value;
                                const iconName: IoniconName = value === 'helpful'
                                  ? selected ? 'thumbs-up' : 'thumbs-up-outline'
                                  : selected ? 'thumbs-down' : 'thumbs-down-outline';
                                return (
                                  <TouchableOpacity
                                    key={value}
                                    style={styles.assistantMessageActionButton}
                                    onPress={() => handlePilotFeedback(message.id, value)}
                                    disabled={Boolean(pilotFeedbackByMessageId[message.id])}
                                    accessibilityRole="button"
                                    accessibilityLabel={value === 'helpful'
                                      ? pilotCopy.feedback.helpful
                                      : pilotCopy.feedback.notHelpful}
                                    accessibilityState={{ selected }}
                                    activeOpacity={0.72}
                                  >
                                    <Ionicons
                                      name={iconName}
                                      size={15}
                                      color={ui.colors.ctaAccent}
                                    />
                                  </TouchableOpacity>
                                );
                              })
                            ) : null}
                        </View>
                      </View>
                    );
                  })}
                  {isAssistantTyping ? (
                    <View style={styles.typingRow}>
                      <ActivityIndicator size="small" color={ui.colors.iconNeutral} />
                      <Text style={styles.typingLabel}>{assistantTypingLabel}</Text>
                    </View>
                  ) : null}
                </>
              ) : (
                <View style={styles.emptyState}>
                  <Text style={styles.heroHeadline}>{session ? copy.emptyPrompt(greetingName) : copy.chatUnavailable}</Text>
                </View>
              )}
            </ScrollView>

            <View style={[styles.footer, { paddingBottom: keyboardPadding }]}>
              <View style={styles.composerWrapper} accessibilityRole="none">
                <LinearGradient
                  colors={[ui.colors.composerTop, ui.colors.composerBottom]}
                  style={StyleSheet.absoluteFill}
                />
                <View style={styles.composerBorder} />
                <View style={styles.composerContent}>
                  <TouchableOpacity
                    style={[
                      styles.uploadButton,
                      (!session || assistantBusy) ? styles.uploadButtonDisabled : null,
                    ]}
                    onPress={() => {
                      void handleAttachEvidencePress();
                    }}
                    disabled={!session || assistantBusy}
                    activeOpacity={0.75}
                    accessibilityLabel={copy.attachEvidence}
                    accessibilityRole="button"
                  >
                    <Ionicons
                      name="add"
                      size={22}
                      color={!session || assistantBusy ? ui.colors.iconNeutral : ui.colors.ctaAccent}
                    />
                  </TouchableOpacity>
                  <TextInput
                    ref={inputRef}
                    style={styles.textInput}
                    value={inputValue}
                    onChangeText={setInputValue}
                    placeholder={
                      editingMessageId
                        ? copy.editLatestPromptPlaceholder
                        : session
                          ? copy.messagePlaceholder
                          : copy.chatUnavailablePlaceholder
                    }
                    placeholderTextColor={ui.colors.textSecondary}
                    multiline
                    editable={Boolean(session) && !assistantBusy}
                    accessibilityLabel={copy.messageInput}
                  />
                  <TouchableOpacity
                    style={[
                      styles.sendButton,
                      assistantBusy
                        ? styles.stopButtonEnabled
                        : hasInput
                          ? styles.sendButtonEnabled
                          : styles.sendButtonDisabled,
                    ]}
                    onPress={() => {
                      if (assistantBusy) {
                        void handleStopAssistantReply();
                        return;
                      }
                      void handleSend();
                    }}
                    disabled={!assistantBusy && (!hasInput || !session)}
                    activeOpacity={0.75}
                    accessibilityLabel={assistantBusy ? copy.stopReply : copy.sendMessage}
                  >
                    {assistantBusy ? (
                      <Ionicons name="square" size={17} color={ui.colors.userBubbleText} />
                    ) : (
                      <Ionicons
                        name="arrow-up"
                        size={20}
                        color={hasInput ? ui.colors.userBubbleText : ui.colors.iconNeutral}
                      />
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          </View>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>

      {chatDetailsModal}

      <Modal
        visible={isSessionPickerVisible}
        transparent
        animationType="fade"
        onRequestClose={handleCloseSessionPicker}
      >
        <View style={styles.sessionOverlay}>
          <Pressable style={styles.sessionOverlayBackdrop} onPress={handleCloseSessionPicker} />
          <View style={[styles.sessionSheet, { paddingBottom: 24 + sheetBottomInset }]}>
            <View style={styles.sessionHeader}>
              <Text style={styles.sessionHeaderTitle}>{copy.conversations}</Text>
              <TouchableOpacity
                style={styles.sessionHeaderAction}
                onPress={handleStartNewConversation}
                accessibilityLabel={copy.startNewChat}
              >
                <Ionicons name="create-outline" size={18} color={ui.colors.iconNeutral} />
                <Text style={styles.sessionHeaderActionLabel}>{copy.newConversationShort}</Text>
              </TouchableOpacity>
            </View>
            {isRefreshingSessions ? (
              <View style={styles.sessionLoading}>
                <ActivityIndicator size="small" color={ui.colors.iconNeutral} />
                <Text style={styles.sessionLoadingLabel}>{copy.loading}</Text>
              </View>
            ) : null}
            <ScrollView
              style={styles.sessionList}
              contentContainerStyle={styles.sessionListContent}
              showsVerticalScrollIndicator={false}
            >
              {availableSessions.map((item, index) => {
                const isActive = session?.id === item.id;
                const isLocalOnlyThread = isLocalChatSession(item);
                return (
                  <View
                    key={item.id}
                    style={[styles.sessionRow, isActive && styles.sessionRowActive]}
                  >
                    <TouchableOpacity
                      style={styles.sessionRowMain}
                      onPress={() => handleSelectSession(item)}
                      disabled={isActive}
                      accessibilityRole="button"
                      accessibilityLabel={`${copy.openConversations}: ${copy.conversationTitle(index + 1)}`}
                    >
                      <View>
                        <Text style={[styles.sessionTitle, isActive && styles.sessionTitleActive]}>
                          {copy.conversationTitle(index + 1)}
                        </Text>
                        <Text style={styles.sessionSubtitle}>
                          {`${formatSessionTimestamp(item.lastActivity, copy, languageCode)} - ${isLocalOnlyThread ? copy.currentMeta.localPhone : copy.currentMeta.syncedHistory}`}
                        </Text>
                      </View>
                    </TouchableOpacity>
                    <View style={styles.sessionRowActions}>
                      {isActive ? <Ionicons name="checkmark" size={18} color={ui.colors.ctaAccent} /> : null}
                      {CHAT_REMOTE_SYNC_ENABLED && isLocalOnlyThread && isOnline ? (
                        <TouchableOpacity
                          style={styles.sessionSyncAction}
                          onPress={() => handleSyncLocalSession(item)}
                          accessibilityRole="button"
                          accessibilityLabel={`${copy.alerts.sync}: ${copy.conversationTitle(index + 1)}`}
                          activeOpacity={0.72}
                        >
                          <Ionicons name="cloud-upload-outline" size={17} color={ui.colors.ctaAccent} />
                        </TouchableOpacity>
                      ) : null}
                      <TouchableOpacity
                        style={styles.sessionDeleteAction}
                        onPress={() => handleDeleteSession(item)}
                        accessibilityRole="button"
                        accessibilityLabel={`${copy.alerts.delete}: ${copy.conversationTitle(index + 1)}`}
                        activeOpacity={0.72}
                      >
                        <Ionicons name="trash-outline" size={17} color={ui.colors.error} />
                      </TouchableOpacity>
                    </View>
                  </View>
                );
              })}
              {availableSessions.length === 0 && !isRefreshingSessions ? (
                <View style={styles.sessionEmptyState}>
                  <Text style={styles.sessionEmptyTitle}>{copy.noConversationsTitle}</Text>
                  <Text style={styles.sessionEmptySubtitle}>{copy.noConversationsSubtitle}</Text>
                </View>
              ) : null}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function createStyles(ui: ReturnType<typeof createChatUI>) {
  return StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: ui.colors.canvas,
  },
  flex: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
    backgroundColor: ui.colors.canvas,
  },
  loaderRoot: {
    flex: 1,
  },
  loaderSafeArea: {
    flex: 1,
    justifyContent: 'center',
  },
  loadingContainer: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    marginTop: 16,
    color: ui.colors.textSecondary,
  },
  content: {
    flex: 1,
    backgroundColor: ui.colors.canvas,
  },
  chatLayout: {
    flex: 1,
    flexDirection: 'row',
    position: 'relative',
  },
  collapsedNavButton: {
    alignItems: 'center',
    backgroundColor: ui.colors.canvas,
    borderColor: ui.colors.divider,
    borderRadius: 18,
    borderWidth: 1,
    height: 48,
    justifyContent: 'center',
    left: 12,
    position: 'absolute',
    top: 10,
    width: 48,
    zIndex: 12,
  },
  sideNavBackdrop: {
    backgroundColor: 'rgba(17,24,39,0.24)',
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
    zIndex: 15,
  },
  sideNav: {
    backgroundColor: ui.colors.assistantBubbleBg,
    borderRightColor: ui.colors.divider,
    borderRightWidth: 1,
    gap: 10,
    paddingHorizontal: 9,
    paddingVertical: 12,
  },
  sideNavExpanded: {
    alignItems: 'stretch',
    width: 248,
  },
  sideNavOverlay: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    top: 0,
    zIndex: 20,
    ...elevation.floating,
  },
  sideNavHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    minHeight: 40,
  },
  sideNavIconButton: {
    alignItems: 'center',
    backgroundColor: ui.colors.assistantBubbleBg,
    borderColor: ui.colors.divider,
    borderRadius: 18,
    borderWidth: 1,
    height: 48,
    justifyContent: 'center',
    width: 48,
  },
  sideNavBrand: {
    flex: 1,
    minWidth: 0,
  },
  sideNavBrandTitle: {
    ...ui.typography.badge,
    color: ui.colors.textPrimary,
  },
  sideNavBrandMeta: {
    ...ui.typography.meta,
    color: ui.colors.textSecondary,
    marginTop: 1,
  },
  sideNavPrimary: {
    alignItems: 'center',
    backgroundColor: ui.colors.ctaAccent,
    borderRadius: 18,
    flexDirection: 'row',
    gap: 8,
    minHeight: 38,
    paddingHorizontal: 12,
    justifyContent: 'center',
  },
  sideNavPrimaryText: {
    ...ui.typography.badge,
    color: ui.colors.userBubbleText,
    flexShrink: 1,
  },
  sideNavDivider: {
    backgroundColor: ui.colors.divider,
    height: 1,
  },
  sideNavSectionLabel: {
    ...ui.typography.meta,
    color: ui.colors.textSecondary,
    fontWeight: '700',
    paddingHorizontal: 4,
    textTransform: 'uppercase',
  },
  sideNavList: {
    flex: 1,
  },
  sideNavListContent: {
    gap: 6,
    paddingBottom: 8,
  },
  sideNavItem: {
    alignItems: 'center',
    borderColor: 'transparent',
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 9,
    minHeight: 46,
    paddingHorizontal: 8,
  },
  sideNavItemActive: {
    backgroundColor: ui.colors.badgeFill,
    borderColor: ui.colors.composerBorder,
  },
  sideNavItemIcon: {
    alignItems: 'center',
    backgroundColor: ui.colors.assistantBubbleBg,
    borderRadius: 15,
    height: 30,
    justifyContent: 'center',
    width: 30,
  },
  sideNavItemIconActive: {
    backgroundColor: ui.colors.ctaAccent,
  },
  sideNavItemCopy: {
    flex: 1,
    minWidth: 0,
  },
  sideNavItemTitle: {
    ...ui.typography.badge,
    color: ui.colors.textPrimary,
  },
  sideNavItemMeta: {
    ...ui.typography.meta,
    color: ui.colors.textSecondary,
    marginTop: 2,
  },
  sideNavFooterButton: {
    alignItems: 'center',
    borderColor: ui.colors.divider,
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    minHeight: 38,
    paddingHorizontal: 10,
    justifyContent: 'center',
  },
  sideNavFooterText: {
    ...ui.typography.badge,
    color: ui.colors.textPrimary,
    flexShrink: 1,
  },
  navBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
  },
  threadToolbar: {
    alignItems: 'center',
    backgroundColor: ui.colors.canvas,
    borderBottomColor: ui.colors.divider,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 12,
    minHeight: 72,
    paddingHorizontal: 14,
    paddingTop: 16,
    paddingBottom: 16,
  },
  threadToolbarWithCollapsedNav: {
    paddingLeft: 72,
  },
  threadToolbarCopy: {
    flex: 1,
    minWidth: 0,
  },
  threadToolbarTitleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    minWidth: 0,
    flexWrap: 'wrap',
  },
  threadToolbarKicker: {
    ...ui.typography.badge,
    color: ui.colors.textSecondary,
    textTransform: 'uppercase',
  },
  threadToolbarTitle: {
    ...ui.typography.headerTitle,
    color: ui.colors.textPrimary,
    flex: 1,
    marginTop: 1,
  },
  threadToolbarBadge: {
    alignItems: 'center',
    borderRadius: ui.radii.badge,
    flexDirection: 'row',
    gap: 4,
    maxWidth: 128,
    minHeight: 24,
    paddingHorizontal: 8,
  },
  threadToolbarBadgeReady: {
    backgroundColor: ui.colors.successMuted,
  },
  threadToolbarBadgePending: {
    backgroundColor: ui.colors.warningMuted,
  },
  threadToolbarBadgeText: {
    ...ui.typography.badge,
    color: ui.colors.textPrimary,
    flexShrink: 1,
  },
  threadActions: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'flex-end',
  },
  threadActionButton: {
    alignItems: 'center',
    backgroundColor: ui.colors.badgeFill,
    borderColor: ui.colors.divider,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: 'row',
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  threadActionButtonPrimary: {
    backgroundColor: ui.colors.ctaAccent,
    borderColor: ui.colors.ctaAccent,
  },
  navIcon: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  navTitle: {
    ...ui.typography.headerTitle,
    color: ui.colors.textPrimary,
    textAlign: 'center',
  },
  messagesContainer: {
    flex: 1,
    backgroundColor: ui.colors.canvas,
  },
  messagesContent: {
    backgroundColor: ui.colors.canvas,
    flexGrow: 1,
    paddingHorizontal: 16,
  },
  timelineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
    marginBottom: 8,
  },
  timelineLabel: {
    ...ui.typography.timeline,
    color: ui.colors.textSecondary,
    marginRight: 8,
  },
  timelineRule: {
    height: 1,
    flex: 1,
    backgroundColor: ui.colors.divider,
  },
  userBubble: {
    alignSelf: 'flex-end',
    backgroundColor: ui.colors.userBubbleBg,
    borderRadius: ui.radii.bubble,
    borderTopRightRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 14,
    maxWidth: '88%',
    ...elevation.card,
  },
  userMessageText: {
    ...ui.typography.message,
    color: ui.colors.userBubbleText,
  },
  attachmentStack: {
    gap: 7,
    marginTop: 10,
  },
  attachmentCard: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.13)',
    borderColor: 'rgba(255,255,255,0.22)',
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 9,
    minHeight: 48,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  attachmentIcon: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderRadius: 16,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  attachmentCopy: {
    flex: 1,
    minWidth: 0,
  },
  attachmentTitle: {
    ...ui.typography.badge,
    color: ui.colors.userBubbleText,
  },
  attachmentMeta: {
    ...ui.typography.meta,
    color: ui.colors.userBubbleText,
    marginTop: 2,
  },
  metaText: {
    ...ui.typography.meta,
    color: ui.colors.textSecondary,
    marginTop: 6,
  },
  userMetaText: {
    ...ui.typography.meta,
    color: ui.colors.userBubbleText,
    marginTop: 4,
  },
  userMessageActionRow: {
    alignSelf: 'flex-end',
    flexDirection: 'row',
    gap: 6,
    marginTop: 8,
  },
  userMessageActionButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderRadius: 14,
    height: 28,
    justifyContent: 'center',
    width: 28,
  },
  assistantContainer: {
    alignSelf: 'flex-start',
    maxWidth: '100%',
    minWidth: 0,
    paddingHorizontal: 16,
    paddingVertical: 16,
    backgroundColor: ui.colors.assistantBubbleBg,
    borderRadius: ui.radii.bubble,
    borderTopLeftRadius: 8,
    marginVertical: 8,
    width: '100%',
  },
  assistantMessageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 5,
  },
  assistantAvatar: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: ui.colors.badgeFill,
    marginRight: 6,
  },
  assistantMessageTitle: {
    ...ui.typography.badge,
    color: ui.colors.textPrimary,
    flex: 1,
  },
  assistantMessageTime: {
    ...ui.typography.meta,
    color: ui.colors.textSecondary,
  },
  assistantText: {
    ...ui.typography.message,
    color: ui.colors.textPrimary,
  },
  assistantTextContainer: {
    flexShrink: 1,
    minWidth: 0,
    width: '100%',
  },
  assistantMessageActionRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    marginTop: 6,
  },
  assistantMessageActionButton: {
    alignItems: 'center',
    backgroundColor: 'transparent',
    borderRadius: 14,
    height: 28,
    justifyContent: 'center',
    width: 28,
  },
  messageActionButtonDisabled: {
    opacity: 0.42,
  },
  typingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
  },
  typingLabel: {
    ...ui.typography.meta,
    color: ui.colors.textSecondary,
    marginLeft: 6,
  },
  sourceRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 8,
  },
  sourceBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 0,
    paddingHorizontal: 0,
    minHeight: 20,
    justifyContent: 'center',
    marginRight: 8,
    marginBottom: 5,
  },
  sourceBadgeText: {
    ...ui.typography.badge,
    color: ui.colors.textPrimary,
  },
  footer: {
    paddingHorizontal: 12,
    paddingTop: 6,
  },
  composerWrapper: {
    position: 'relative',
    width: '100%',
    borderRadius: radii.sheet,
    minHeight: 64,
    overflow: 'hidden',
    ...elevation.raised,
  },
  composerBorder: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderWidth: 1,
    borderColor: ui.colors.composerBorder,
    borderRadius: radii.sheet,
  },
  composerContent: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 8,
    paddingTop: 8,
    paddingBottom: 8,
  },
  uploadButton: {
    alignItems: 'center',
    backgroundColor: ui.colors.badgeFill,
    borderColor: ui.colors.composerBorder,
    borderRadius: 20,
    borderWidth: 1,
    height: 48,
    justifyContent: 'center',
    marginRight: 8,
    width: 48,
  },
  uploadButtonDisabled: {
    opacity: 0.48,
  },
  textInput: {
    flex: 1,
    ...ui.typography.message,
    color: ui.colors.textPrimary,
    paddingHorizontal: 0,
    paddingVertical: 12,
    margin: 0,
    minHeight: 48,
    maxHeight: 148,
    textAlignVertical: 'top',
  },
  sendButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },
  sendButtonEnabled: {
    backgroundColor: ui.colors.ctaAccent,
  },
  stopButtonEnabled: {
    backgroundColor: ui.colors.error,
  },
  sendButtonDisabled: {
    backgroundColor: 'rgba(17,24,39,0.08)',
  },
  emptyState: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    width: '100%',
    paddingVertical: 32,
  },
  heroHeadline: {
    ...ui.typography.headerTitle,
    color: ui.colors.textPrimary,
    textAlign: 'center',
  },
  localAssistantSetupCard: {
    alignSelf: 'center',
    backgroundColor: ui.colors.assistantBubbleBg,
    borderColor: ui.colors.divider,
    borderRadius: radii.sheet,
    borderWidth: 1,
    marginVertical: 12,
    maxWidth: 520,
    paddingHorizontal: 16,
    paddingVertical: 16,
    width: '100%',
    ...elevation.card,
  },
  localAssistantPreparingCard: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: ui.colors.assistantBubbleBg,
    borderColor: ui.colors.divider,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    marginVertical: 20,
    maxWidth: 420,
    minHeight: 72,
    paddingHorizontal: 16,
    paddingVertical: 12,
    width: '100%',
    ...elevation.card,
  },
  localAssistantPreparingIcon: {
    alignItems: 'center',
    backgroundColor: ui.colors.badgeFill,
    borderRadius: 20,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  localAssistantPreparingCopy: {
    flex: 1,
    minWidth: 0,
  },
  localAssistantPreparingTitle: {
    ...ui.typography.modeLabel,
    color: ui.colors.textPrimary,
    fontWeight: '700',
  },
  localAssistantPreparingDetail: {
    ...ui.typography.timeline,
    color: ui.colors.textSecondary,
    marginTop: 3,
  },
  localAssistantSetupIcon: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: ui.colors.badgeFill,
    borderRadius: 22,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  localAssistantSetupKicker: {
    ...ui.typography.timeline,
    color: ui.colors.ctaAccent,
    marginTop: 12,
    textAlign: 'center',
    textTransform: 'uppercase',
  },
  localAssistantSetupTitle: {
    ...ui.typography.headerTitle,
    color: ui.colors.textPrimary,
    marginTop: 6,
    textAlign: 'center',
  },
  localAssistantSetupDetail: {
    ...ui.typography.meta,
    color: ui.colors.textSecondary,
    lineHeight: 20,
    marginTop: 8,
    textAlign: 'center',
  },
  localAssistantProgressSection: {
    marginTop: 18,
  },
  localAssistantProgressHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  localAssistantProgressLabel: {
    ...ui.typography.meta,
    color: ui.colors.textPrimary,
    fontWeight: '600',
  },
  localAssistantProgressPercent: {
    ...ui.typography.meta,
    color: ui.colors.ctaAccent,
    fontWeight: '700',
  },
  localAssistantProgressTrack: {
    backgroundColor: ui.colors.divider,
    borderRadius: 999,
    height: 10,
    overflow: 'hidden',
    width: '100%',
  },
  localAssistantProgressFill: {
    backgroundColor: ui.colors.ctaAccent,
    borderRadius: 999,
    height: '100%',
  },
  localAssistantProgressBytes: {
    ...ui.typography.timeline,
    color: ui.colors.textSecondary,
    marginTop: 7,
    textAlign: 'right',
  },
  localAssistantIndeterminateProgress: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    marginTop: 18,
  },
  localAssistantSetupFacts: {
    backgroundColor: ui.colors.backgroundTop,
    borderColor: ui.colors.divider,
    borderRadius: 14,
    borderWidth: 1,
    marginTop: 16,
    overflow: 'hidden',
  },
  localAssistantSetupFactRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  localAssistantSetupFactIcon: {
    alignItems: 'center',
    backgroundColor: ui.colors.badgeFill,
    borderRadius: 17,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  localAssistantSetupFactDivider: {
    backgroundColor: ui.colors.divider,
    height: StyleSheet.hairlineWidth,
    marginLeft: 56,
  },
  localAssistantSetupFact: {
    ...ui.typography.meta,
    color: ui.colors.textPrimary,
    flex: 1,
    fontWeight: '600',
  },
  localAssistantForegroundNotice: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
    paddingHorizontal: 2,
  },
  localAssistantForegroundText: {
    ...ui.typography.timeline,
    color: ui.colors.textSecondary,
    flex: 1,
    lineHeight: 18,
  },
  localAssistantVerificationNotice: {
    alignItems: 'flex-start',
    backgroundColor: ui.colors.badgeFill,
    borderRadius: 12,
    flexDirection: 'row',
    gap: 8,
    marginTop: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  localAssistantVerificationText: {
    ...ui.typography.meta,
    color: ui.colors.textPrimary,
    flex: 1,
    lineHeight: 19,
  },
  localAssistantSetupPrimary: {
    alignItems: 'center',
    backgroundColor: ui.colors.ctaAccent,
    borderRadius: 14,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    marginTop: 18,
    minHeight: 48,
    paddingHorizontal: 16,
  },
  localAssistantSetupPrimaryDisabled: {
    // Matches Button's disabled primary: readable text, not a faded fill.
    backgroundColor: ui.colors.disabledFill,
    borderColor: ui.colors.disabledBorder,
    borderWidth: 1,
  },
  localAssistantSetupPrimaryText: {
    ...ui.typography.button,
    color: ui.colors.userBubbleText,
  },
  localAssistantSetupSecondary: {
    alignItems: 'center',
    alignSelf: 'center',
    flexDirection: 'row',
    gap: 6,
    marginTop: 12,
    minHeight: 48,
    paddingHorizontal: 12,
  },
  localAssistantSetupSecondaryText: {
    ...ui.typography.meta,
    color: ui.colors.error,
  },
  sessionOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(17,24,39,0.35)',
  },
  sessionOverlayBackdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  sessionSheet: {
    backgroundColor: ui.colors.assistantBubbleBg,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 22,
  },
  sessionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  sessionHeaderTitle: {
    ...ui.typography.headerTitle,
    color: ui.colors.textPrimary,
  },
  sessionHeaderAction: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: ui.radii.chip,
    backgroundColor: ui.colors.badgeFill,
    gap: 6,
  },
  sessionHeaderActionDisabled: {
    opacity: 0.4,
  },
  sessionHeaderActionLabel: {
    ...ui.typography.modeLabel,
    color: ui.colors.textPrimary,
  },
  sessionLoading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  sessionLoadingLabel: {
    ...ui.typography.systemNote,
    color: ui.colors.textSecondary,
  },
  sessionList: {
    maxHeight: 360,
  },
  sessionListContent: {
    paddingBottom: 8,
  },
  sessionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: ui.radii.bubble,
    paddingVertical: 8,
    paddingLeft: 16,
    paddingRight: 8,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: ui.colors.divider,
    backgroundColor: ui.colors.assistantBubbleBg,
  },
  sessionRowMain: {
    flex: 1,
    paddingVertical: 6,
    paddingRight: 10,
  },
  sessionRowActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  sessionSyncAction: {
    width: 48,
    height: 48,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: ui.colors.badgeFill,
  },
  sessionDeleteAction: {
    width: 48,
    height: 48,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(185, 28, 28, 0.08)',
  },
  sessionRowActive: {
    backgroundColor: ui.colors.badgeFill,
    borderColor: ui.colors.userBubbleBg,
  },
  sessionTitle: {
    ...ui.typography.message,
    color: ui.colors.textPrimary,
  },
  sessionTitleActive: {
    color: ui.colors.ctaAccent,
  },
  sessionSubtitle: {
    ...ui.typography.systemNote,
    color: ui.colors.textSecondary,
    marginTop: 4,
  },
  sessionEmptyState: {
    alignItems: 'center',
    paddingVertical: 32,
  },
  sessionEmptyTitle: {
    ...ui.typography.message,
    color: ui.colors.textPrimary,
    marginBottom: 8,
  },
  sessionEmptySubtitle: {
    ...ui.typography.systemNote,
    color: ui.colors.textSecondary,
    textAlign: 'center',
  },
});
}
