import { io, Socket } from 'socket.io-client';

import { request, setAuthToken } from '../lib/api/httpClient';
import { authClient } from '../lib/auth/authClient';
import { getRuntimeConfigSnapshot } from '../config/runtime/runtimeConfigStore';
import {
  generateLocalAssistantReply,
  getLocalAssistantSourceLabel,
  getLocalAssistantStatus,
  isLocalAssistantReplyStoppedError,
} from './localAssistantService';
import { localAssistantConfig } from '../config/localAssistant';
import {
  normalizeSelectableLanguageCode,
  type SelectableAppLanguageCode,
} from '../config/languageAvailability';
import { getAssistantLanguageCopy } from '../i18n/appLanguage';
import { devPrivacyWarn, getPrivacySafeErrorReason, getPrivacySafeHttpStatus } from '../utils/privacyLog';
import { getCachedLocalAiDeviceFacts } from '../lib/localAssistant/pilotDeviceProfile';
import { recordAiPilotFallback } from '../lib/localAssistant/pilotDiagnostics';
import {
  categorizeLocalAiFailure,
  classifyLocalAiFailure,
  type LocalAiFailureCode,
} from '../lib/localAssistant/pilotFailureReasons';
import { getLocalAiPilotCopy } from '../i18n/localAiPilotCopy';

export type ChatSession = {
  id: string;
  ownerId: string;
  mode: string | null;
  createdAt: Date;
  lastActivity: Date;
};

export type ChatMessageRow = {
  id: string;
  session_id: string;
  owner_id: string | null;
  role: string;
  content: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

async function getOwnedApiToken(): Promise<string | null> {
  try {
    const { data, error } = await authClient.getSession();
    if (error) {
      devPrivacyWarn('chat API session lookup failed', {
        reason: getPrivacySafeErrorReason(error),
        status: getPrivacySafeHttpStatus(error),
      });
      return null;
    }

    const token = data.session?.access_token ?? null;
    if (!token) return null;

    setAuthToken(token);
    return token;
  } catch (error) {
    devPrivacyWarn('chat API session lookup threw', {
      reason: getPrivacySafeErrorReason(error),
      status: getPrivacySafeHttpStatus(error),
    });
    return null;
  }
}

async function requireOwnedApiToken(): Promise<string> {
  const token = await getOwnedApiToken();
  if (!token) {
    throw new Error('User is not authenticated');
  }
  return token;
}

function mapSessionRowToModel(row: any): ChatSession {
  const createdAt = new Date(row.created_at);
  const lastActivityRaw = row.last_activity ?? row.created_at;
  return {
    id: row.id,
    ownerId: row.owner_id,
    mode: row.mode,
    createdAt,
    lastActivity: new Date(lastActivityRaw),
  };
}

export async function ensureChatSession(mode: string = 'legal-aid'): Promise<ChatSession> {
  await requireOwnedApiToken();
  const response = await request<{ session: any }>({
    path: '/chat/session',
    method: 'POST',
    body: { mode },
  });
  return mapSessionRowToModel(response.session);
}

export async function listChatMessages(sessionId: string): Promise<ChatMessageRow[]> {
  await requireOwnedApiToken();
  const response = await request<{ messages: ChatMessageRow[] }>({
    path: `/chat/session/${encodeURIComponent(sessionId)}/messages`,
  });
  return response.messages;
}

export async function sendChatMessage(params: {
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  metadata?: Record<string, unknown> | null;
}): Promise<ChatMessageRow> {
  await requireOwnedApiToken();
  const response = await request<{ sessionId: string; message: ChatMessageRow }>({
    path: '/chat/message',
    method: 'POST',
    body: {
      sessionId: params.sessionId,
      role: params.role,
      content: params.content,
      metadata: params.metadata ?? null,
    },
  });
  return response.message;
}

export type ChatSubscription = {
  unsubscribe: () => void;
};

function subscribeToOwnedChatMessages(
  sessionId: string,
  onMessage: (payload: ChatMessageRow) => void,
): ChatSubscription {
  let socket: Socket | null = null;
  let closed = false;

  getOwnedApiToken()
    .then(token => {
      if (closed || !token) return;
      socket = io(getRuntimeConfigSnapshot().wsBaseUrl, {
        auth: { token },
        transports: ['websocket'],
      });

      socket.on('connect', () => {
        socket?.emit('chat:join', { sessionId });
      });
      socket.on('chat:message', (message: ChatMessageRow) => {
        if (message.session_id === sessionId) {
          onMessage(message);
        }
      });
      socket.on('connect_error', error => {
        devPrivacyWarn('chat websocket connection failed', {
          reason: getPrivacySafeErrorReason(error),
        });
      });
    })
    .catch(error => {
      devPrivacyWarn('chat websocket subscription initialization failed', {
        reason: getPrivacySafeErrorReason(error),
      });
    });

  return {
    unsubscribe: () => {
      closed = true;
      if (socket) {
        socket.emit('chat:leave', { sessionId });
        socket.disconnect();
      }
    },
  };
}

export function subscribeToChatMessages(
  sessionId: string,
  onMessage: (payload: ChatMessageRow) => void,
): ChatSubscription {
  return subscribeToOwnedChatMessages(sessionId, onMessage);
}

type AssistantResponse = {
  content: string;
  sources?: string[];
};

export type AssistantRequestOptions = {
  preferLocal?: boolean;
  allowUnavailableFallback?: boolean;
  onLocalPreparationProgress?: (percent: number) => void;
  languageCode?: SelectableAppLanguageCode;
};

function buildAssistantUnavailableResponse(languageCode?: SelectableAppLanguageCode): AssistantResponse {
  return {
    content: getAssistantLanguageCopy(languageCode).unavailableMessage,
    sources: ['System notice'],
  };
}

/**
 * Replaces the former silent fallback: the reply names a short reason category
 * (still with help-line guidance) and the reason code is kept in pilot diagnostics.
 */
function buildAssistantFailureResponse(
  failureCode: LocalAiFailureCode,
  languageCode?: SelectableAppLanguageCode,
): AssistantResponse {
  const category = categorizeLocalAiFailure(failureCode, {
    ramClassGb: getCachedLocalAiDeviceFacts()?.ramClassGb ?? null,
  });
  if (category === 'not-ready') return buildAssistantUnavailableResponse(languageCode);
  return {
    content: getLocalAiPilotCopy(languageCode).failure.chatFallback(category),
    sources: ['System notice'],
  };
}

export async function requestAssistantReply(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  options: AssistantRequestOptions = {},
): Promise<AssistantResponse> {
  const enabledLanguageCode = normalizeSelectableLanguageCode(options.languageCode);
  const preferLocal =
    typeof options.preferLocal === 'boolean' ? options.preferLocal : localAssistantConfig.preferOnDevice;
  const allowUnavailableFallback = options.allowUnavailableFallback ?? true;

  if (localAssistantConfig.enabled) {
    const status = getLocalAssistantStatus();
    const shouldAttemptLocal =
      status.state === 'ready' || (preferLocal && status.modelDownloaded);
    if (shouldAttemptLocal) {
      try {
        const localResponse = await generateLocalAssistantReply(
          messages.map(message => ({ role: message.role, content: message.content })),
          options.languageCode ? { languageCode: enabledLanguageCode } : undefined,
          options.onLocalPreparationProgress,
        );
        return {
          content: localResponse.content,
          sources: [localResponse.sourceLabel ?? getLocalAssistantSourceLabel()],
        };
      } catch (error) {
        if (isLocalAssistantReplyStoppedError(error)) {
          throw error;
        }

        devPrivacyWarn('local assistant reply failed', {
          reason: getPrivacySafeErrorReason(error),
        });
        const failureCode = classifyLocalAiFailure(error);
        recordAiPilotFallback({ failureCode, attemptedLocal: true });
        if (!allowUnavailableFallback) {
          throw error instanceof Error ? error : new Error(String(error));
        }
        return buildAssistantFailureResponse(failureCode, enabledLanguageCode);
      }
    }
  }

  recordAiPilotFallback({
    failureCode: !localAssistantConfig.enabled
      ? 'LOCAL_AI_DISABLED'
      : getLocalAssistantStatus().modelDownloaded
        ? 'MODEL_NOT_LOADED'
        : 'MODEL_NOT_DOWNLOADED',
    attemptedLocal: false,
  });
  if (!allowUnavailableFallback) {
    throw new Error('Local assistant is not ready on this device.');
  }

  return buildAssistantUnavailableResponse(enabledLanguageCode);
}

export async function listChatSessions(): Promise<ChatSession[]> {
  await requireOwnedApiToken();
  const response = await request<{ sessions: any[] }>({ path: '/chat/sessions' });
  return response.sessions.map(row => mapSessionRowToModel(row));
}

export async function createChatSession(mode: string = 'legal-aid'): Promise<ChatSession> {
  await requireOwnedApiToken();
  const response = await request<{ session: any }>({
    path: '/chat/sessions',
    method: 'POST',
    body: { mode },
  });
  return mapSessionRowToModel(response.session);
}

export async function deleteChatSession(sessionId: string): Promise<void> {
  await requireOwnedApiToken();
  await request<{ deleted: boolean }>({
    path: `/chat/session/${encodeURIComponent(sessionId)}`,
    method: 'DELETE',
  });
}
