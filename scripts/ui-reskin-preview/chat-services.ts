// Preview-only assistant/session stubs: no models, network, device files or history.
const noop = async () => {};
const unavailable = async () => { throw new Error('Synthetic UI preview: this service action is unavailable.'); };
const status = { state: 'idle', percent: 0, modelDownloaded: false, resumable: false };
export const localAssistantConfig = { enabled: true };
export const getLocalAssistantStatus = () => status;
export const refreshLocalAssistantStatus = async () => status;
export const getLocalAssistantDescriptor = () => ({ label: 'Synthetic assistant preview', appReady: false, exactSizeBytes: null, storageRequiredBytes: null });
export const getLocalAssistantSourceLabel = () => 'Synthetic preview';
export const hydrateLocalAssistantPreparationState = noop;
export const setLocalAssistantForegroundActive = noop;
export const subscribeToAssistantState = () => () => {};
export const cancelLocalAssistantPreparation = noop;
export const cancelActiveLocalAssistantReply = noop;
export const pauseLocalAssistantPreparation = noop;
export const prepareLocalAssistant = unavailable;
export const startAutomaticLocalAssistantPreparation = unavailable;
export const generateLocalAssistantReply = unavailable;
export const isLocalAssistantPreparationCancelledError = () => false;
export const isLocalAssistantPreparationPausedError = () => false;
export const isLocalAssistantReplyStoppedError = () => false;
export const createLargeModelDownloadAuthorization = unavailable;
export const getModelDownloadNetworkType = async () => 'unknown';
export const listChatMessages = async () => [];
export const sendChatMessage = unavailable;
export const subscribeToChatMessages = () => ({ unsubscribe: () => {} });
export const requestAssistantReply = unavailable;
export const createChatSession = unavailable;
export const deleteChatSession = unavailable;
export const DEFAULT_LOCAL_CHAT_OWNER_ID = 'synthetic-ui-owner';
export const getLocalChatSessionId = () => 'local-legal-aid-synthetic-preview';
export const isLocalChatSessionId = (id?: string) => id?.startsWith('local-legal-aid-') ?? false;
export const listLocalChatSessionRecords = async () => [];
export const createLocalChatSessionRecord = (ownerId: string) => ({ id: getLocalChatSessionId(), ownerId, mode: 'legal-aid-local', createdAt: new Date(), lastActivity: new Date() });
export const deleteLocalChatSessionRecord = noop;
export const deleteLocalChatSessionRecordForRemoteSession = noop;
export const touchLocalChatSessionRecord = noop;
export const upsertLocalChatSessionRecord = noop;
export default {
  getRetryQueueCount: async () => 0, loadMessagesOffline: async () => [],
  persistMessageSnapshot: async () => false, clearOfflineMessages: noop,
  clearRetryQueue: noop, processRetryQueue: noop, queueMessageForRetry: unavailable,
  handleError: () => ({ message: 'Synthetic preview: service actions are unavailable.', retryable: false }),
  generateOfflineResponse: () => ({ content: 'Synthetic preview: no assistant reply is generated.', sources: [] }),
};
