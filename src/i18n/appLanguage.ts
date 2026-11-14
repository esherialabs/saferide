import {
  normalizeSelectableLanguageCode,
  type SelectableAppLanguageCode,
} from '../config/languageAvailability';
import {
  KENYA_POLICE_EMERGENCY_CONTACT,
  KENYA_IMMEDIATE_HELP_TEXT,
  PRIMARY_KENYA_GBV_CONTACT,
} from '../lib/supportResources';
import type { RootRouteName } from '../navigation/shellRoutes';

export type AppCopyLanguageCode = SelectableAppLanguageCode;

const ROOT_ROUTE_TITLES: Record<AppCopyLanguageCode, Partial<Record<RootRouteName, string>>> = {
  en: {
    DraftOverview: 'Incident Report',
    EvidenceDetail: 'Evidence',
    WhatHappened: 'What Happened',
    WhereWhen: 'Where & When',
    ConsentGate: 'Consent',
    ReferralPicker: 'Find Support',
    EscalationForm: 'Report Incident',
    StatementReview: 'Review Statement',
    Cases: 'Cases',
    CaseDetail: 'Case Details',
    EscalationConfirmation: 'Report status',
    Settings: 'Settings',
    SafetySettings: 'Safety Settings',
    PrivacyData: 'Privacy & Data',
    LanguageAccessibility: 'Language & Accessibility',
    TestMeasurementConsent: 'Moderated Test',
    IssueReport: 'Report a Product Issue',
    TestSessionSummary: 'Local Test Data',
    TipsRights: 'Tips & Rights',
    AboutLegal: 'About & Legal',
  },
  sw: {
    DraftOverview: 'Ripoti ya Tukio',
    EvidenceDetail: 'Ushahidi',
    WhatHappened: 'Kilichotokea',
    WhereWhen: 'Wapi na Lini',
    ConsentGate: 'Ridhaa',
    ReferralPicker: 'Tafuta Msaada',
    EscalationForm: 'Ripoti Tukio',
    StatementReview: 'Kagua Maelezo',
    Cases: 'Kesi',
    CaseDetail: 'Maelezo ya Kesi',
    EscalationConfirmation: 'Ujumbe Umetumwa',
    Settings: 'Mipangilio',
    SafetySettings: 'Mipangilio ya Usalama',
    PrivacyData: 'Faragha na Data',
    LanguageAccessibility: 'Lugha na Ufikivu',
    TestMeasurementConsent: 'Jaribio Linalosimamiwa',
    IssueReport: 'Ripoti Tatizo la Programu',
    TestSessionSummary: 'Data ya Jaribio la Kifaa',
    TipsRights: 'Vidokezo na Haki',
    AboutLegal: 'Kuhusu na Sheria',
  },
};

export function getRootRouteTitle(routeName: RootRouteName, languageCode?: string | null): string {
  const normalized = normalizeSelectableLanguageCode(languageCode);
  return ROOT_ROUTE_TITLES[normalized][routeName] ?? ROOT_ROUTE_TITLES.en[routeName] ?? routeName;
}

export function getAssistantLanguageInstruction(languageCode?: string | null): string {
  return normalizeSelectableLanguageCode(languageCode) === 'sw'
    ? 'Jibu kwa Kiswahili sanifu kinachoeleweka Kenya. Tumia sauti tulivu, fupi, na ya vitendo. Weka ushauri wa usalama, matibabu, kuripoti, ushahidi, haki za kisheria, na rufaa kwa usahihi. Usidai kuwa wakili, daktari, mshauri, mhudumu wa dharura, au mtoa huduma. Ikiwa mtumiaji anaomba Kiingereza au lugha nyingine waziwazi, fuata ombi hilo.'
    : 'Reply in English unless the user explicitly asks for another language. Keep SafeRide guidance concise, practical, survivor-centred, and rooted in Kenya safety, medical, reporting, evidence, legal-rights, and referral context. Do not claim to be a lawyer, clinician, counsellor, emergency responder, or provider.';
}

export const ASSISTANT_LANGUAGE_COPY = {
  en: {
    fastGreeting:
      'Hi. I can help with safety, medical care, reporting, evidence, or support contacts. What do you need?',
    fallbackReply:
      'I can help with safety, reporting, medical care, evidence, or support contacts. Please send your question in simple words.',
    unavailableMessage:
      `AI is not ready yet. Your message is saved on this phone. For help now, call ${PRIMARY_KENYA_GBV_CONTACT.displayPhone}. In an emergency, call ${KENYA_POLICE_EMERGENCY_CONTACT.displayPhone}.`,
  },
  sw: {
    fastGreeting:
      'Habari. Ninaweza kusaidia kuhusu usalama, matibabu, kuripoti, ushahidi, au mawasiliano ya msaada. Unahitaji nini?',
    fallbackReply:
      'Ninaweza kusaidia kuhusu usalama, kuripoti, matibabu, ushahidi, au mawasiliano ya msaada. Tafadhali uliza kwa maneno rahisi.',
    unavailableMessage:
      `AI haiko tayari bado. Ujumbe wako umehifadhiwa kwenye simu hii. Kwa msaada sasa, piga ${PRIMARY_KENYA_GBV_CONTACT.displayPhone}. Ukiwa kwenye dharura, piga ${KENYA_POLICE_EMERGENCY_CONTACT.displayPhone}.`,
  },
} as const;

export function getAssistantLanguageCopy(languageCode?: string | null) {
  return ASSISTANT_LANGUAGE_COPY[normalizeSelectableLanguageCode(languageCode)];
}

export const OFFLINE_CHAT_RESPONSE_COPY = {
  en: {
    greeting:
      `Hi. SafeRide can save this chat on your phone. If you need help now:\n\n` +
      `${KENYA_IMMEDIATE_HELP_TEXT}\n\n` +
      'You can ask about reporting, medical care, evidence, or support contacts.\n\n' +
      'No provider received this chat.',
    reporting:
      'Basic Kenya reporting options. Not legal advice:\n\n' +
      '- You can report at a police station and ask for the Gender Desk officer\n' +
      '- Ask about a P3 form if medical documentation is needed\n' +
      `- Call ${PRIMARY_KENYA_GBV_CONTACT.displayPhone} for GBV support\n\n` +
      'Your message is saved on this phone. No provider received this chat.',
    medical:
      'Health support options:\n\n' +
      '- Go to the nearest public health facility or hospital as soon as you can\n' +
      '- Ask a clinician about PEP, emergency contraception, STI care, and injury documentation\n' +
      '- You can seek medical care before deciding whether to report\n\n' +
      'Your message is saved on this phone.',
    support:
      'Kenya support contacts:\n\n' +
      `- ${PRIMARY_KENYA_GBV_CONTACT.label}: ${PRIMARY_KENYA_GBV_CONTACT.displayPhone} (${PRIMARY_KENYA_GBV_CONTACT.availability})\n` +
      `- ${KENYA_POLICE_EMERGENCY_CONTACT.label}: ${KENYA_POLICE_EMERGENCY_CONTACT.displayPhone}\n` +
      '- Medical care: nearest public health facility or hospital\n\n' +
      'Your message is saved on this phone.',
    default:
      `Your message is saved on this phone. Help options:\n\n${KENYA_IMMEDIATE_HELP_TEXT}\n\nNo provider received this chat.`,
    sources: [
      'SafeRide Kenya support catalog',
      'HAK 1195 GBV Helpline',
      'Kenya National Police Service emergency contacts',
    ],
  },
  sw: {
    greeting:
      'Habari. SafeRide inaweza kuhifadhi gumzo hili kwenye simu yako. Ikiwa unahitaji msaada sasa:\n\n' +
      `- Msaada na rufaa za GBV: Piga ${PRIMARY_KENYA_GBV_CONTACT.displayPhone} (${PRIMARY_KENYA_GBV_CONTACT.availability}).\n` +
      `- Polisi au huduma za dharura: Piga ${KENYA_POLICE_EMERGENCY_CONTACT.displayPhone}.\n` +
      '- Matibabu: Nenda kituo cha afya cha umma au hospitali iliyo karibu na uulize huduma ya haraka.\n\n' +
      'Unaweza kuuliza kuhusu kuripoti, matibabu, ushahidi, au mawasiliano ya msaada.\n\n' +
      'Hakuna mtoa huduma aliyepokea gumzo hili.',
    reporting:
      'Chaguo za msingi za kuripoti nchini Kenya. Huu si ushauri wa kisheria:\n\n' +
      '- Unaweza kuripoti katika kituo cha polisi na kuulizia afisa wa Gender Desk\n' +
      '- Ulizia fomu ya P3 ikiwa nyaraka za matibabu zinahitajika\n' +
      `- Piga ${PRIMARY_KENYA_GBV_CONTACT.displayPhone} kwa msaada wa GBV\n\n` +
      'Ujumbe wako umehifadhiwa kwenye simu hii. Hakuna mtoa huduma aliyepokea gumzo hili.',
    medical:
      'Chaguo za msaada wa afya:\n\n' +
      '- Nenda kituo cha afya cha umma au hospitali iliyo karibu haraka iwezekanavyo\n' +
      '- Muulize mhudumu wa afya kuhusu PEP, uzazi wa mpango wa dharura, huduma ya STI, na kuandikisha majeraha\n' +
      '- Unaweza kupata matibabu kabla ya kuamua kama utaripoti\n\n' +
      'Ujumbe wako umehifadhiwa kwenye simu hii.',
    support:
      'Mawasiliano ya msaada nchini Kenya:\n\n' +
      `- ${PRIMARY_KENYA_GBV_CONTACT.label}: ${PRIMARY_KENYA_GBV_CONTACT.displayPhone} (${PRIMARY_KENYA_GBV_CONTACT.availability})\n` +
      `- ${KENYA_POLICE_EMERGENCY_CONTACT.label}: ${KENYA_POLICE_EMERGENCY_CONTACT.displayPhone}\n` +
      '- Matibabu: kituo cha afya cha umma au hospitali iliyo karibu\n\n' +
      'Ujumbe wako umehifadhiwa kwenye simu hii.',
    default:
      'Ujumbe wako umehifadhiwa kwenye simu hii. Chaguo za msaada:\n\n' +
      `- Msaada na rufaa za GBV: Piga ${PRIMARY_KENYA_GBV_CONTACT.displayPhone} (${PRIMARY_KENYA_GBV_CONTACT.availability}).\n` +
      `- Polisi au huduma za dharura: Piga ${KENYA_POLICE_EMERGENCY_CONTACT.displayPhone}.\n` +
      '- Matibabu: Nenda kituo cha afya cha umma au hospitali iliyo karibu na uulize huduma ya haraka.\n\n' +
      'Hakuna mtoa huduma aliyepokea gumzo hili.',
    sources: [
      'Orodha ya msaada SafeRide Kenya',
      'Nambari ya msaada wa GBV 1195 HAK',
      'Mawasiliano ya dharura ya Polisi Kenya',
    ],
  },
} as const;

export function getOfflineChatResponseCopy(languageCode?: string | null) {
  return OFFLINE_CHAT_RESPONSE_COPY[normalizeSelectableLanguageCode(languageCode)];
}

export const CHAT_LEGAL_AID_COPY = {
  en: {
    welcomeMessage: 'General support only. For urgent danger, use emergency contacts.',
    quickChips: [
      { label: 'How do I report to the police?', icon: 'document-text-outline' },
      { label: 'What evidence should I collect?', icon: 'camera-outline' },
      { label: 'Where can I get medical help?', icon: 'medkit-outline' },
      { label: 'Explain the P3 form', icon: 'reader-outline' },
      { label: 'Rights after an incident', icon: 'shield-checkmark-outline' },
    ],
    unknownTime: 'Unknown time',
    defaultGreetingName: 'there',
    systemNoticeSource: 'System notice',
    today: 'Today',
    assistantName: 'SafeRide AI',
    loadingChat: 'Loading chat...',
    chatUnavailable: 'Chat is unavailable right now',
    emptyPrompt: (name: string) => `Hey ${name}, what would you like to understand?`,
    messageInput: 'Message input',
    editLatestPromptPlaceholder: 'Edit latest prompt',
    messagePlaceholder: 'Message SafeRide',
    chatUnavailablePlaceholder: 'Chat unavailable',
    sendMessage: 'Send message',
    stopReply: 'Stop reply',
    attachEvidence: 'Upload attachment',
    attachmentLocalLabel: 'Local upload',
    attachmentMessage: (count: number) => `Uploaded ${count} ${count === 1 ? 'file' : 'files'}`,
    noProviderHandoff: 'No provider handoff',
    chatMode: {
      badge: {
        'chat-unavailable': 'Unavailable',
        'offline-queued': 'Queued locally',
        'local-assistant': 'Local',
        'local-assistant-preparing': 'Preparing',
        'local-assistant-downloaded': 'Loading',
        'local-assistant-setup': 'Setting up',
        'stored-history': 'History',
        'local-guidance-unavailable': 'Guidance only',
      },
      description: {
        'chat-unavailable': 'SafeRide could not load or create a chat session.',
        'offline-queued': 'Queued messages are saved on this device. No provider has received them from chat.',
        'local-assistant': 'On-device support suggestions are ready. It is not a lawyer, clinician, counsellor, or provider.',
        'local-assistant-preparing': 'Setup is in progress.',
        'local-assistant-downloaded': 'SafeRide is loading the saved model for replies.',
        'local-assistant-setup': 'SafeRide is preparing replies while this chat is open.',
        'stored-history': 'Chat history is available; the assistant is not ready.',
        'local-guidance-unavailable': 'Try setup again.',
      },
    },
    copyPrompt: 'Copy prompt',
    editLatestPrompt: 'Edit latest prompt',
    copyReply: 'Copy reply',
    retryLatestReply: 'Retry latest reply',
    openConversations: 'Open conversations',
    startNewChat: 'Start new chat',
    deleteCurrentConversation: 'Delete current conversation',
    conversations: 'Conversations',
    newConversationShort: 'New',
    loading: 'Loading...',
    noConversationsTitle: 'No conversations yet',
    noConversationsSubtitle: 'Start a new chat to see it here.',
    conversationTitle: (index: number) => `Conversation ${index}`,
    newConversation: 'New conversation',
    currentMeta: {
      chatUnavailable: 'Chat unavailable',
      localPhoneSave: 'Local phone save',
      historySyncOnline: 'History sync online',
      offlineLocalSave: 'Offline local save',
      savedOnPhone: 'Saved on this phone',
      syncedChatHistory: 'Synced chat history',
      syncedHistoryOffline: 'Synced history, offline now',
      localPhone: 'local phone',
      syncedHistory: 'synced history',
    },
    deliveryStatus: {
      queued: 'Queued to send when online. No provider or human has received it from chat.',
      localOnly: 'Saved on this device only. It was not queued for sending.',
      failed: 'Could not send. The message remains saved on this device.',
      offline: 'Saved offline. No provider or human has received it from chat.',
    },
    assistantSource: {
      eyebrow: 'Assistant source',
      localModelDisabledTitle: 'Local model disabled',
      localModelDisabledDetail: 'Chat can still save messages and show support contacts.',
      readyDetailSuffix: 'Replies stay on this phone.',
      checkingTitle: 'Checking model',
      preparingTitle: 'Preparing AI',
      verifyingTitle: 'Verifying model',
      configuringTitle: 'Starting AI',
      modelSavedTitle: 'Model saved',
      keepOpenDetailSuffix: 'Keep SafeRide open.',
      startingDetailSuffix: 'Starting on this phone.',
      tapLoadDetail: 'Saved on this phone. SafeRide is loading it.',
      localModelPausedTitle: 'Preparing AI',
      localModelUnavailableTitle: 'AI unavailable',
      savedProgressDetail: 'Saved progress resumes when you return to SafeRide.',
      savedModelCouldNotStart: 'Saved model could not start.',
      trySetupAgain: 'Try setup again.',
      modelNotReadyTitle: 'Setting up AI',
      downloadForOfflineReplies: 'SafeRide downloads once for offline replies while this chat is open.',
    },
    stateLabel: {
      readyOffline: 'Ready offline',
      checking: 'Checking saved model',
      downloading: (progress: number) => `Downloading ${progress}%`,
      verifying: (progress: number) => `Verifying ${progress}%`,
      configuring: (progress: number) => `Configuring ${progress}%`,
      downloaded: 'Downloaded',
      setupFailedAfterDownload: 'Setup failed after download',
      resume: (progress: number) => `Resume ${progress}%`,
      unavailable: 'Unavailable',
      paused: (progress: number) => `Paused ${progress}%`,
      partial: (progress: number) => `Partial ${progress}%`,
      notDownloaded: 'Not downloaded',
    },
    localStatus: {
      ready: 'On-device replies are ready.',
      checking: 'Checking for a saved model on this phone.',
      downloading: (eta: string | null) => eta
        ? `Downloading. ${eta}. Keep SafeRide open.`
        : 'Downloading. Keep SafeRide open.',
      verifying: (progress: number) =>
        `Download complete. Checking the saved file - ${progress}%. This is not another download.`,
      configuring: 'Starting the model.',
      downloaded: 'Model saved. SafeRide is loading it.',
      savedModelRetry: (error?: string) => error
        ? `${error} Retry loads the saved model.`
        : 'The model is saved, but SafeRide could not start it. Try again.',
      resumeProgress: (error?: string) => error
        ? `${error} Saved progress resumes while SafeRide is open.`
        : 'Download progress is saved and resumes while SafeRide is open.',
      unavailable: 'Assistant unavailable.',
      downloadPaused: 'Download paused. SafeRide resumes when you return.',
      downloadStarted: 'Download started. SafeRide resumes while open.',
      downloadOnce: 'Setting up AI. Download starts while SafeRide is open.',
    },
    composerStatus: {
      ready: (label: string) => `${label} ready`,
      configuring: (progress: number) => `Starting AI ${progress}%`,
      preparing: (progress: number, eta: string | null) =>
        `Setting up AI ${progress}%${eta ? ` - ${eta}` : ''}`,
      needsRetry: 'AI needs retry',
      modelSaved: 'Model saved',
      notReady: 'Setting up AI',
      disabled: 'AI disabled',
    },
    assistantTyping: {
      ready: 'SafeRide AI is replying...',
      checking: 'Checking the saved model...',
      downloading: (progress: number, eta: string | null) =>
        `Downloading model... ${progress}%${eta ? ` - ${eta}` : ''}`,
      verifying: (progress: number) => `Verifying downloaded model... ${progress}%`,
      loadingDownloaded: 'Loading the saved model...',
      configuring: (progress: number) => `Starting model... ${progress}%`,
      savingNotice: 'Saving assistant availability notice...',
    },
    initializing: {
      title: 'Initializing',
      detail: {
        downloading: (progress: number, eta: string | null, speed: string | null) =>
          `${progress}% - ${eta ?? 'calculating time'}${speed ? ` - ${speed}` : ''}`,
        configuring: (progress: number) => `Starting model${progress > 0 ? ` - ${progress}%` : ''}`,
        downloaded: 'Loading saved model',
        resume: (progress: number) => `Saved progress - ${progress}%`,
        preparing: 'Starting setup',
      },
      tips: {
        timeRemaining: (eta: string) => `Time remaining: ${eta}.`,
        timeCalculating: 'Time remaining: calculating.',
        speed: (speed: string) => `Download speed: ${speed}.`,
        progress: (progress: number) => `Progress: ${progress}% complete.`,
        configuring: 'Starting the saved model on this device.',
        downloaded: 'The model is saved. SafeRide is loading it.',
        resumable: 'Saved progress can resume while SafeRide stays open.',
        preparing: 'Setup is starting for this chat.',
        keepOpen: 'Keep SafeRide open while setup continues.',
        localPrivacy: 'Chat stays on this phone while setup continues.',
      },
    },
    setup: {
      notReadyAction: 'Not ready',
      checkingModelAction: 'Checking model',
      pauseDownloadAction: 'Pause download',
      verifyingModelAction: 'Verifying model',
      startingModelAction: 'Starting model',
      retrySetupAction: 'Retry setup',
      loadModelAction: 'Load model',
      resumeDownloadAction: 'Resume download',
      downloadModelAction: 'Download model',
      cancelAction: 'Not now',
      unknownExactSize: 'exact size unavailable',
      downloadConsentTitle: 'Download the local AI model?',
      downloadConsentMessage: (exactSize: string, requiredStorage: string) =>
        `SafeRide will download exactly ${exactSize}. Keep at least ${requiredStorage} free. The file stays in SafeRide app storage, is checksum-verified before use, and can be paused or cancelled. Keep SafeRide open while downloading.`,
      networkUnknownTitle: 'Network type unavailable',
      networkUnknownMessage:
        'SafeRide could not verify whether this connection is Wi-Fi or metered. Connect to Wi-Fi or retry when the network type is available.',
      meteredNetworkTitle: 'Use metered data?',
      meteredNetworkMessage: (exactSize: string) =>
        `This connection may charge for data. Downloading ${exactSize} could use a large part of your data plan.`,
      useMeteredNetworkAction: 'Use metered data',
      cancelDownloadTitle: 'Cancel this model download?',
      cancelDownloadMessage: 'Downloaded partial data and saved resume state will be removed from this device.',
      keepDownloadAction: 'Keep download',
      cancelDownloadAction: 'Cancel and remove',
      exactSizeFact: (size: string) => `Download size: ${size}`,
      storageFact: (size: string) => `Free space needed: ${size}`,
      foregroundOnlyFact: 'Keep SafeRide open. Leaving pauses setup, and you can resume safely when you return.',
      verificationFact: 'SafeRide is reading the model already saved on this phone. This can take time for a large file, but it is not downloading it again.',
      heroKicker: 'SafeRide AI setup',
      preparingModelTitle: 'Preparing SafeRide AI',
      preparingModelDetail: 'Starting the saved model on this phone.',
      setupOfflineChat: 'Set up offline chat',
      localAiNotReady: 'AI not ready',
      setupNoticeAction: 'Setup notice',
      buildCannotStartLead: 'This build cannot start AI yet.',
      latestQaBuild: 'Install the latest QA build and try again.',
      modelLabel: 'Model',
      sizeStatLabel: 'Size',
      statusStatLabel: 'Status',
      modeStatLabel: 'Mode',
      compactReady: 'Ready',
      compactSaved: 'Saved',
      compactNeeded: 'Needed',
      compactUnavailable: 'Unavailable',
      compactRetry: 'Retry',
      compactOffline: 'Offline',
      compactPhone: 'Phone',
      downloadSuffix: 'download',
      calculatingSpeed: 'calculating speed',
      downloadedMeta: (progress: number, speed: string | null) =>
        `${progress}% downloaded${speed ? ` - ${speed}` : ' - calculating speed'}`,
      completeMeta: (progress: number) => `${progress}% complete`,
      modelSelected: 'Model selected',
      modelSelectedDetail: 'SafeRide is set to use the approved model.',
      phoneRuntime: 'Phone runtime',
      phoneRuntimeDetail: 'This build needs AI enabled before setup can start.',
      tryAgain: 'Try again',
      tryAgainDetail: 'Install the latest QA build and retry setup.',
      modelSaved: 'Model saved',
      downloadModel: 'Download model',
      modelSavedDetail: 'Load it to start chat.',
      keepOpenProgress: 'Keep SafeRide open. Progress can resume.',
      startOnPhone: 'Start on phone',
      startOnPhoneDetail: 'SafeRide checks the model before chat opens.',
      chatOffline: 'Chat offline',
      chatOfflineDetail: 'Replies stay on this phone.',
      modelRepo: 'Model repo',
      openModelSource: 'Open model source',
    },
    modal: {
      chatStatusTitle: 'Chat status',
      chatStatusDescription: 'Local model, sync, and support status.',
      currentSetup: 'Current setup',
      foregroundDownload:
        'Foreground download keeps the screen awake. Background download is not guaranteed; saved progress can resume when you return.',
      modelSize: (size: string | null) => `Model size: ${size ?? 'device dependent'}.`,
      messageHandling: 'Message handling',
      noProviderContact: 'Chat does not contact a provider, lawyer, or emergency service.',
      offlineSync: 'Offline messages stay visible here and sync only when supported.',
    },
    toast: {
      localAssistantReadyTitle: 'Local assistant ready',
      localAssistantReadyMessage: 'General support suggestions can now run on this device.',
      downloadPausedTitle: 'Download paused',
      downloadPausedMessage: 'Local model progress was saved. Resume when you are ready.',
      preparationFailedTitle: 'Preparation failed',
      savedModelStartFailed: 'The model is saved, but SafeRide could not start it.',
      checkConnectionStorageBattery: 'Check your connection, free storage, and battery before trying again.',
      downloadPauseUnavailableTitle: 'Download pause unavailable',
      downloadPauseUnavailableMessage: 'SafeRide could not pause the active download. Try again after a moment.',
      pauseFailedTitle: 'Pause failed',
      downloadCancelledTitle: 'Download cancelled',
      downloadCancelledMessage: 'Partial model data and saved resume state were removed.',
      downloadCancelUnavailableTitle: 'Nothing to cancel',
      downloadCancelUnavailableMessage: 'No active or resumable model download was found.',
      pauseFailedMessage: 'SafeRide could not save the current download state.',
      promptUpdatedTitle: 'Prompt updated',
      promptUpdatedMessage: 'SafeRide updated the latest turn on this device.',
      localReplySavedTitle: 'Local reply saved',
      editFallbackMessage: 'SafeRide updated the prompt locally and saved a support note.',
      localAssistantTitle: 'Local assistant',
      localSuggestionLocalOnly: 'General support suggestion generated on this phone.',
      localSuggestionQueued: 'General support suggestion generated locally. No provider received this chat.',
      savedOnPhoneTitle: 'Saved on this phone',
      messageQueuedTitle: 'Message queued',
      savedLocallyTitle: 'Saved locally',
      localChatStillConnecting:
        'SafeRide is still connecting. You can test the local assistant here; no provider received this chat.',
      queuedNoProvider:
        'No provider has received it. SafeRide will try to save it to chat history when online.',
      couldNotQueue: 'Could not queue for sending. It remains visible on this device.',
      guidanceStaysVisible: 'SafeRide is still connecting. The message and guidance stay visible on this device.',
      chatStaysVisible: 'SafeRide is still connecting. Your chat stays visible here.',
      serviceConnectingLocalNote:
        'SafeRide saved a local support note because the chat service is still connecting.',
      stoppedTitle: 'Stopped',
      stoppedLocalReply: 'SafeRide stopped the local reply.',
      stoppedWaiting: 'SafeRide stopped waiting for this reply.',
      copiedTitle: 'Copied',
      copiedMessage: 'Message text copied.',
      copyFailedTitle: 'Copy failed',
      copyFailedMessage: 'SafeRide could not copy this message.',
      editUnavailableTitle: 'Edit unavailable',
      onlyLatestPrompt: 'Only the latest prompt can be edited for now.',
      editingLatestPromptTitle: 'Editing latest prompt',
      editingLatestPromptMessage: 'Sending will update this turn instead of creating a new prompt.',
      retryUnavailableTitle: 'Retry unavailable',
      onlyLatestReply: 'Only the latest assistant reply can be retried.',
      promptNotFound: 'SafeRide could not find the prompt for this reply.',
      replyInProgressTitle: 'Reply in progress',
      stopBeforeDeleting: 'Stop the current reply before deleting this conversation.',
      conversationDeletedTitle: 'Conversation deleted',
      localChatRemoved: 'Local chat was removed from this phone.',
      historyRemoved: 'Chat history was removed from the SafeRide API and local cache.',
      deleteFailedTitle: 'Delete failed',
      deleteFailedMessage: 'SafeRide could not delete that conversation yet. Try again when the connection is stable.',
      syncUnavailableTitle: 'Sync unavailable',
      connectBeforeSync: 'Connect to the internet before syncing this local conversation.',
      stopBeforeSync: 'Stop the current reply before syncing this conversation.',
      conversationSyncedTitle: 'Conversation synced',
      conversationSyncedMessage: 'SafeRide saved the local conversation to your chat history.',
      syncFailedTitle: 'Sync failed',
      syncFailedMessage: 'The conversation remains saved on this phone. Try again when the connection is stable.',
      localPhoneChatTitle: 'Local phone chat',
      localPhoneChatOffline: 'SafeRide is still connecting. This conversation stays on this phone.',
      localPhoneChatTesting:
        'SafeRide is still connecting. You can keep testing local assistant replies on this phone.',
      dialFailedTitle: 'Dial failed',
      dialFailedMessage: 'Unable to launch the phone dialer.',
      draftStatusUnavailableTitle: 'Draft status unavailable',
      openingProvidersAnyway: 'Opening provider listings anyway.',
      chatStorageUnavailableTitle: 'Chat storage unavailable',
      chatStorageUnavailableMessage: 'SafeRide could not open saved chat yet. Try again after freeing phone storage.',
      queuedMessagesSavedTitle: 'Queued messages saved',
      queuedMessagesSaved: (count: number) =>
        `${count} queued ${count === 1 ? 'message was' : 'messages were'} saved to chat history. No provider handoff was sent from chat.`,
      attachmentUploadedTitle: 'Upload saved',
      attachmentUploadedMessage: (count: number) =>
        `${count} ${count === 1 ? 'file is' : 'files are'} saved in this chat on your phone. No provider or human has received it from chat.`,
      attachmentUploadFailedTitle: 'Upload failed',
      attachmentUploadFailedMessage:
        'SafeRide could not save that file in chat. Try again after checking phone storage.',
    },
    alerts: {
      cancel: 'Cancel',
      delete: 'Delete',
      sync: 'Sync',
      deleteConversationTitle: 'Delete conversation?',
      deleteLocalConversation:
        'This removes the local conversation from this phone. It does not affect any remote records.',
      deleteRemoteConversation:
        'This removes the conversation from SafeRide chat history and clears the local cache on this phone.',
      syncConversationTitle: 'Sync conversation?',
      syncConversationMessage:
        'This uploads the selected local conversation to your SafeRide chat history. No provider, lawyer, or emergency service is contacted from chat.',
    },
  },
  sw: {
    welcomeMessage: 'Msaada wa jumla tu. Ukiwa kwenye hatari ya haraka, tumia mawasiliano ya dharura.',
    quickChips: [
      { label: 'Ninaripotije polisi?', icon: 'document-text-outline' },
      { label: 'Nikusanye ushahidi gani?', icon: 'camera-outline' },
      { label: 'Ninaweza kupata msaada wa matibabu wapi?', icon: 'medkit-outline' },
      { label: 'Eleza fomu ya P3', icon: 'reader-outline' },
      { label: 'Haki baada ya tukio', icon: 'shield-checkmark-outline' },
    ],
    unknownTime: 'Wakati haujulikani',
    defaultGreetingName: 'rafiki',
    systemNoticeSource: 'Taarifa ya mfumo',
    today: 'Leo',
    assistantName: 'AI ya SafeRide',
    loadingChat: 'Inapakia gumzo...',
    chatUnavailable: 'Gumzo halipatikani sasa',
    emptyPrompt: (name: string) => `Habari ${name}, ungependa kuelewa nini?`,
    messageInput: 'Sehemu ya ujumbe',
    editLatestPromptPlaceholder: 'Hariri swali la mwisho',
    messagePlaceholder: 'Tuma ujumbe kwa SafeRide',
    chatUnavailablePlaceholder: 'Gumzo halipatikani',
    sendMessage: 'Tuma ujumbe',
    stopReply: 'Simamisha jibu',
    attachEvidence: 'Pakia kiambatisho',
    attachmentLocalLabel: 'Upakiaji wa ndani',
    attachmentMessage: (count: number) => `Umepakia ${count} ${count === 1 ? 'faili' : 'faili'}`,
    noProviderHandoff: 'Hakuna rufaa kwa mtoa huduma',
    chatMode: {
      badge: {
        'chat-unavailable': 'Haipatikani',
        'offline-queued': 'Imehifadhiwa ndani',
        'local-assistant': 'Ndani',
        'local-assistant-preparing': 'Inaandaa',
        'local-assistant-downloaded': 'Inapakia',
        'local-assistant-setup': 'Inasanidi',
        'stored-history': 'Historia',
        'local-guidance-unavailable': 'Mwongozo tu',
      },
      description: {
        'chat-unavailable': 'SafeRide haikuweza kupakia au kuunda kikao cha gumzo.',
        'offline-queued': 'Ujumbe uliopangwa umehifadhiwa kwenye kifaa hiki. Hakuna mtoa huduma aliyepokea kutoka kwenye gumzo.',
        'local-assistant': 'Mapendekezo ya msaada kwenye kifaa yako tayari. Huyu si wakili, daktari, mshauri, au mtoa huduma.',
        'local-assistant-preparing': 'Usanidi unaendelea.',
        'local-assistant-downloaded': 'SafeRide inapakia muundo uliohifadhiwa kwa majibu.',
        'local-assistant-setup': 'SafeRide inaandaa majibu gumzo hili likiwa wazi.',
        'stored-history': 'Historia ya gumzo inapatikana; msaidizi hauko tayari.',
        'local-guidance-unavailable': 'Jaribu usanidi tena.',
      },
    },
    copyPrompt: 'Nakili swali',
    editLatestPrompt: 'Hariri swali la mwisho',
    copyReply: 'Nakili jibu',
    retryLatestReply: 'Jaribu tena jibu la mwisho',
    openConversations: 'Fungua mazungumzo',
    startNewChat: 'Anza gumzo jipya',
    deleteCurrentConversation: 'Futa gumzo hili',
    conversations: 'Mazungumzo',
    newConversationShort: 'Jipya',
    loading: 'Inapakia...',
    noConversationsTitle: 'Bado hakuna mazungumzo',
    noConversationsSubtitle: 'Anza gumzo jipya ili lionekane hapa.',
    conversationTitle: (index: number) => `Mazungumzo ${index}`,
    newConversation: 'Gumzo jipya',
    currentMeta: {
      chatUnavailable: 'Gumzo halipatikani',
      localPhoneSave: 'Hifadhi kwenye simu',
      historySyncOnline: 'Historia inasawazishwa mtandaoni',
      offlineLocalSave: 'Hifadhi ya ndani nje ya mtandao',
      savedOnPhone: 'Imehifadhiwa kwenye simu hii',
      syncedChatHistory: 'Historia ya gumzo imesawazishwa',
      syncedHistoryOffline: 'Historia imesawazishwa, uko nje ya mtandao',
      localPhone: 'simu hii',
      syncedHistory: 'historia iliyosawazishwa',
    },
    deliveryStatus: {
      queued: 'Imepangwa kutumwa ukiwa mtandaoni. Hakuna mtoa huduma au mtu aliyepokea kutoka kwenye gumzo.',
      localOnly: 'Imehifadhiwa kwenye kifaa hiki pekee. Haikupangwa kutumwa.',
      failed: 'Haikuweza kutumwa. Ujumbe umebaki kwenye kifaa hiki.',
      offline: 'Imehifadhiwa nje ya mtandao. Hakuna mtoa huduma au mtu aliyepokea kutoka kwenye gumzo.',
    },
    assistantSource: {
      eyebrow: 'Chanzo cha msaidizi',
      localModelDisabledTitle: 'Muundo wa ndani umezimwa',
      localModelDisabledDetail: 'Gumzo bado linaweza kuhifadhi ujumbe na kuonyesha mawasiliano ya msaada.',
      readyDetailSuffix: 'Majibu hubaki kwenye simu hii.',
      checkingTitle: 'Inakagua muundo',
      preparingTitle: 'Inaandaa AI',
      verifyingTitle: 'Inathibitisha muundo',
      configuringTitle: 'Inaanzisha AI',
      modelSavedTitle: 'Muundo umehifadhiwa',
      keepOpenDetailSuffix: 'Wacha SafeRide ikiwa wazi.',
      startingDetailSuffix: 'Inaanza kwenye simu hii.',
      tapLoadDetail: 'Umehifadhiwa kwenye simu hii. SafeRide inaupakia.',
      localModelPausedTitle: 'Inaandaa AI',
      localModelUnavailableTitle: 'AI haipatikani',
      savedProgressDetail: 'Hatua iliyohifadhiwa huendelea ukirudi SafeRide.',
      savedModelCouldNotStart: 'Muundo uliohifadhiwa haukuweza kuanza.',
      trySetupAgain: 'Jaribu usanidi tena.',
      modelNotReadyTitle: 'Inasanidi AI',
      downloadForOfflineReplies: 'SafeRide hupakua mara moja kwa majibu ya nje ya mtandao gumzo hili likiwa wazi.',
    },
    stateLabel: {
      readyOffline: 'Tayari nje ya mtandao',
      checking: 'Inakagua muundo uliohifadhiwa',
      downloading: (progress: number) => `Inapakua ${progress}%`,
      verifying: (progress: number) => `Inathibitisha ${progress}%`,
      configuring: (progress: number) => `Inasanidi ${progress}%`,
      downloaded: 'Imepakuliwa',
      setupFailedAfterDownload: 'Usanidi umeshindikana baada ya kupakua',
      resume: (progress: number) => `Endelea ${progress}%`,
      unavailable: 'Haipatikani',
      paused: (progress: number) => `Imesitishwa ${progress}%`,
      partial: (progress: number) => `Sehemu ${progress}%`,
      notDownloaded: 'Haijapakuliwa',
    },
    localStatus: {
      ready: 'Majibu ya kwenye kifaa yako tayari.',
      checking: 'Inakagua kama muundo umehifadhiwa kwenye simu hii.',
      downloading: (eta: string | null) => eta
        ? `Inapakua. ${eta}. Wacha SafeRide ikiwa wazi.`
        : 'Inapakua. Wacha SafeRide ikiwa wazi.',
      verifying: (progress: number) =>
        `Upakuaji umekamilika. Inakagua faili iliyohifadhiwa - ${progress}%. Huu si upakuaji mwingine.`,
      configuring: 'Inaanzisha muundo.',
      downloaded: 'Muundo umehifadhiwa. SafeRide inaupakia.',
      savedModelRetry: (error?: string) => error
        ? `${error} Jaribu tena hupakia muundo uliohifadhiwa.`
        : 'Muundo umehifadhiwa, lakini SafeRide haikuweza kuuanzisha. Jaribu tena.',
      resumeProgress: (error?: string) => error
        ? `${error} Hatua iliyohifadhiwa huendelea SafeRide ikiwa wazi.`
        : 'Hatua ya kupakua imehifadhiwa na huendelea SafeRide ikiwa wazi.',
      unavailable: 'Msaidizi haupatikani.',
      downloadPaused: 'Upakuaji umesitishwa. SafeRide huendelea ukirudi.',
      downloadStarted: 'Upakuaji umeanza. SafeRide huendelea ikiwa wazi.',
      downloadOnce: 'Inasanidi AI. Upakuaji huanza SafeRide ikiwa wazi.',
    },
    composerStatus: {
      ready: (label: string) => `${label} iko tayari`,
      configuring: (progress: number) => `Inaanzisha AI ${progress}%`,
      preparing: (progress: number, eta: string | null) =>
        `Inasanidi AI ${progress}%${eta ? ` - ${eta}` : ''}`,
      needsRetry: 'AI inahitaji jaribio tena',
      modelSaved: 'Muundo umehifadhiwa',
      notReady: 'Inasanidi AI',
      disabled: 'AI imezimwa',
    },
    assistantTyping: {
      ready: 'AI ya SafeRide inajibu...',
      checking: 'Inakagua muundo uliohifadhiwa...',
      downloading: (progress: number, eta: string | null) =>
        `Inapakua muundo... ${progress}%${eta ? ` - ${eta}` : ''}`,
      verifying: (progress: number) => `Inathibitisha muundo uliopakuliwa... ${progress}%`,
      loadingDownloaded: 'Inapakia muundo uliohifadhiwa...',
      configuring: (progress: number) => `Inaanzisha muundo... ${progress}%`,
      savingNotice: 'Inahifadhi taarifa ya upatikanaji wa msaidizi...',
    },
    initializing: {
      title: 'Inaanzisha',
      detail: {
        downloading: (progress: number, eta: string | null, speed: string | null) =>
          `${progress}% - ${eta ?? 'inahesabu muda'}${speed ? ` - ${speed}` : ''}`,
        configuring: (progress: number) => `Inaanzisha muundo${progress > 0 ? ` - ${progress}%` : ''}`,
        downloaded: 'Inapakia muundo uliohifadhiwa',
        resume: (progress: number) => `Hatua iliyohifadhiwa - ${progress}%`,
        preparing: 'Usanidi unaanza',
      },
      tips: {
        timeRemaining: (eta: string) => `Muda uliobaki: ${eta}.`,
        timeCalculating: 'Muda uliobaki: inahesabu.',
        speed: (speed: string) => `Kasi ya kupakua: ${speed}.`,
        progress: (progress: number) => `Hatua: ${progress}% imekamilika.`,
        configuring: 'Inaanzisha muundo uliohifadhiwa kwenye kifaa hiki.',
        downloaded: 'Muundo umehifadhiwa. SafeRide inaupakia.',
        resumable: 'Hatua iliyohifadhiwa inaweza kuendelea SafeRide ikiwa wazi.',
        preparing: 'Usanidi unaanza kwa gumzo hili.',
        keepOpen: 'Wacha SafeRide ikiwa wazi usanidi ukiendelea.',
        localPrivacy: 'Gumzo linabaki kwenye simu hii usanidi ukiendelea.',
      },
    },
    setup: {
      notReadyAction: 'Haiko tayari',
      checkingModelAction: 'Inakagua muundo',
      pauseDownloadAction: 'Sitisha upakuaji',
      verifyingModelAction: 'Inathibitisha muundo',
      startingModelAction: 'Inaanzisha muundo',
      retrySetupAction: 'Jaribu usanidi tena',
      loadModelAction: 'Pakia muundo',
      resumeDownloadAction: 'Endelea kupakua',
      downloadModelAction: 'Pakua muundo',
      cancelAction: 'Sio sasa',
      unknownExactSize: 'ukubwa kamili haupatikani',
      downloadConsentTitle: 'Pakua muundo wa AI wa ndani?',
      downloadConsentMessage: (exactSize: string, requiredStorage: string) =>
        `SafeRide itapakua baiti ${exactSize} kamili. Weka angalau ${requiredStorage} wazi. Faili hubaki kwenye hifadhi ya SafeRide, hukaguliwa kwa checksum kabla ya kutumika, na inaweza kusitishwa au kufutwa. Wacha SafeRide ikiwa wazi wakati wa upakuaji.`,
      networkUnknownTitle: 'Aina ya mtandao haijulikani',
      networkUnknownMessage:
        'SafeRide haikuweza kuthibitisha kama muunganisho huu ni Wi-Fi au mtandao wenye gharama. Unganisha Wi-Fi au ujaribu tena aina ya mtandao ikipatikana.',
      meteredNetworkTitle: 'Tumia data yenye gharama?',
      meteredNetworkMessage: (exactSize: string) =>
        `Muunganisho huu unaweza kutoza data. Kupakua ${exactSize} kunaweza kutumia sehemu kubwa ya kifurushi chako.`,
      useMeteredNetworkAction: 'Tumia data hii',
      cancelDownloadTitle: 'Futa upakuaji huu wa muundo?',
      cancelDownloadMessage: 'Data iliyopakuliwa kwa sehemu na hali ya kuendelea iliyohifadhiwa zitaondolewa kwenye kifaa hiki.',
      keepDownloadAction: 'Endelea kuuhifadhi',
      cancelDownloadAction: 'Futa na uondoe',
      exactSizeFact: (size: string) => `Ukubwa wa upakuaji: ${size}`,
      storageFact: (size: string) => `Nafasi wazi inayohitajika: ${size}`,
      foregroundOnlyFact: 'Wacha SafeRide ikiwa wazi. Ukiondoka, usanidi husitishwa na unaweza kuendelea salama ukirudi.',
      verificationFact: 'SafeRide inasoma muundo ambao tayari umehifadhiwa kwenye simu hii. Hii inaweza kuchukua muda kwa faili kubwa, lakini haipakui tena.',
      heroKicker: 'Usanidi wa AI ya SafeRide',
      preparingModelTitle: 'Inaandaa AI ya SafeRide',
      preparingModelDetail: 'Inaanzisha muundo uliohifadhiwa kwenye simu hii.',
      setupOfflineChat: 'Sanidi gumzo la nje ya mtandao',
      localAiNotReady: 'AI haiko tayari',
      setupNoticeAction: 'Taarifa ya usanidi',
      buildCannotStartLead: 'Toleo hili haliwezi kuanzisha AI bado.',
      latestQaBuild: 'Sakinisha toleo jipya la QA kisha ujaribu tena.',
      modelLabel: 'Muundo',
      sizeStatLabel: 'Ukubwa',
      statusStatLabel: 'Hali',
      modeStatLabel: 'Njia',
      compactReady: 'Tayari',
      compactSaved: 'Hifadhi',
      compactNeeded: 'Inahitaji',
      compactUnavailable: 'Haipo',
      compactRetry: 'Rudia',
      compactOffline: 'Offline',
      compactPhone: 'Simu',
      downloadSuffix: 'upakuaji',
      calculatingSpeed: 'inahesabu kasi',
      downloadedMeta: (progress: number, speed: string | null) =>
        `${progress}% imepakuliwa${speed ? ` - ${speed}` : ' - inahesabu kasi'}`,
      completeMeta: (progress: number) => `${progress}% imekamilika`,
      modelSelected: 'Muundo umechaguliwa',
      modelSelectedDetail: 'SafeRide imewekwa kutumia muundo ulioidhinishwa.',
      phoneRuntime: 'Uendeshaji wa simu',
      phoneRuntimeDetail: 'Toleo hili linahitaji AI iwashwe kabla ya usanidi kuanza.',
      tryAgain: 'Jaribu tena',
      tryAgainDetail: 'Sakinisha toleo jipya la QA kisha urudie usanidi.',
      modelSaved: 'Muundo umehifadhiwa',
      downloadModel: 'Pakua muundo',
      modelSavedDetail: 'Upakie ili kuanza gumzo.',
      keepOpenProgress: 'Wacha SafeRide ikiwa wazi. Hatua inaweza kuendelea baadaye.',
      startOnPhone: 'Anza kwenye simu',
      startOnPhoneDetail: 'SafeRide hukagua muundo kabla ya gumzo kufunguka.',
      chatOffline: 'Gumzo nje ya mtandao',
      chatOfflineDetail: 'Majibu hubaki kwenye simu hii.',
      modelRepo: 'Hifadhi ya muundo',
      openModelSource: 'Fungua chanzo cha muundo',
    },
    modal: {
      chatStatusTitle: 'Hali ya gumzo',
      chatStatusDescription: 'Hali ya muundo wa ndani, usawazishaji, na msaada.',
      currentSetup: 'Usanidi wa sasa',
      foregroundDownload:
        'Upakuaji ukiwa mbele huweka skrini ikiwa macho. Upakuaji wa chinichini haujahakikishwa; hatua iliyohifadhiwa inaweza kuendelea ukirudi.',
      modelSize: (size: string | null) => `Ukubwa wa muundo: ${size ?? 'hutegemea kifaa'}.`,
      messageHandling: 'Ushughulikiaji wa ujumbe',
      noProviderContact: 'Gumzo haliwasiliani na mtoa huduma, wakili, au huduma ya dharura.',
      offlineSync: 'Ujumbe wa nje ya mtandao hubaki hapa na husawazishwa tu inapowezekana.',
    },
    toast: {
      localAssistantReadyTitle: 'Msaidizi wa ndani yuko tayari',
      localAssistantReadyMessage: 'Mapendekezo ya msaada wa jumla sasa yanaweza kuendeshwa kwenye kifaa hiki.',
      downloadPausedTitle: 'Upakuaji umesitishwa',
      downloadPausedMessage: 'Hatua ya muundo wa ndani imehifadhiwa. Endelea ukiwa tayari.',
      preparationFailedTitle: 'Maandalizi yameshindwa',
      savedModelStartFailed: 'Muundo umehifadhiwa, lakini SafeRide haikuweza kuuanzisha.',
      checkConnectionStorageBattery: 'Kagua intaneti, nafasi ya kuhifadhi, na betri kabla ya kujaribu tena.',
      downloadPauseUnavailableTitle: 'Haiwezi kusitisha upakuaji',
      downloadPauseUnavailableMessage: 'SafeRide haikuweza kusitisha upakuaji unaoendelea. Jaribu tena baada ya muda.',
      pauseFailedTitle: 'Kusitisha kumeshindikana',
      downloadCancelledTitle: 'Upakuaji umefutwa',
      downloadCancelledMessage: 'Data ya muundo iliyokuwa sehemu na hali ya kuendelea zimeondolewa.',
      downloadCancelUnavailableTitle: 'Hakuna cha kufuta',
      downloadCancelUnavailableMessage: 'Hakuna upakuaji wa muundo unaoendelea au unaoweza kuendelea uliopatikana.',
      pauseFailedMessage: 'SafeRide haikuweza kuhifadhi hali ya upakuaji wa sasa.',
      promptUpdatedTitle: 'Swali limesasishwa',
      promptUpdatedMessage: 'SafeRide imesasisha sehemu ya mwisho kwenye kifaa hiki.',
      localReplySavedTitle: 'Jibu la ndani limehifadhiwa',
      editFallbackMessage: 'SafeRide imesasisha swali ndani ya kifaa na kuhifadhi taarifa ya msaada.',
      localAssistantTitle: 'Msaidizi wa ndani',
      localSuggestionLocalOnly: 'Pendekezo la msaada wa jumla limetengenezwa kwenye simu hii.',
      localSuggestionQueued: 'Pendekezo la msaada wa jumla limetengenezwa ndani ya kifaa. Hakuna mtoa huduma aliyepokea gumzo hili.',
      savedOnPhoneTitle: 'Imehifadhiwa kwenye simu hii',
      messageQueuedTitle: 'Ujumbe umepangwa',
      savedLocallyTitle: 'Imehifadhiwa ndani',
      localChatStillConnecting:
        'SafeRide bado inaunganisha. Unaweza kujaribu msaidizi wa ndani hapa; hakuna mtoa huduma aliyepokea gumzo hili.',
      queuedNoProvider:
        'Hakuna mtoa huduma aliyepokea. SafeRide itajaribu kuhifadhi kwenye historia ya gumzo ukiwa mtandaoni.',
      couldNotQueue: 'Haikuweza kupanga kutumwa. Inaendelea kuonekana kwenye kifaa hiki.',
      guidanceStaysVisible: 'SafeRide bado inaunganisha. Ujumbe na mwongozo vitabaki kuonekana kwenye kifaa hiki.',
      chatStaysVisible: 'SafeRide bado inaunganisha. Gumzo lako linabaki kuonekana hapa.',
      serviceConnectingLocalNote:
        'SafeRide imehifadhi taarifa ya msaada ndani ya kifaa kwa sababu huduma ya gumzo bado inaunganisha.',
      stoppedTitle: 'Imesimamishwa',
      stoppedLocalReply: 'SafeRide imesimamisha jibu la ndani.',
      stoppedWaiting: 'SafeRide imeacha kusubiri jibu hili.',
      copiedTitle: 'Imenakiliwa',
      copiedMessage: 'Maandishi ya ujumbe yamenakiliwa.',
      copyFailedTitle: 'Kunakili kumeshindikana',
      copyFailedMessage: 'SafeRide haikuweza kunakili ujumbe huu.',
      editUnavailableTitle: 'Kuhariri hakupatikani',
      onlyLatestPrompt: 'Ni swali la mwisho pekee linaweza kuhaririwa kwa sasa.',
      editingLatestPromptTitle: 'Inahariri swali la mwisho',
      editingLatestPromptMessage: 'Kutuma kutasasisha sehemu hii badala ya kuunda swali jipya.',
      retryUnavailableTitle: 'Kujaribu tena hakupatikani',
      onlyLatestReply: 'Ni jibu la mwisho la msaidizi pekee linaweza kujaribiwa tena.',
      promptNotFound: 'SafeRide haikuweza kupata swali la jibu hili.',
      replyInProgressTitle: 'Jibu linaendelea',
      stopBeforeDeleting: 'Simamisha jibu la sasa kabla ya kufuta mazungumzo haya.',
      conversationDeletedTitle: 'Mazungumzo yamefutwa',
      localChatRemoved: 'Gumzo la ndani limeondolewa kwenye simu hii.',
      historyRemoved: 'Historia ya gumzo imeondolewa kwenye API ya SafeRide na akiba ya ndani.',
      deleteFailedTitle: 'Kufuta kumeshindikana',
      deleteFailedMessage: 'SafeRide haikuweza kufuta mazungumzo hayo bado. Jaribu tena muunganisho ukiwa thabiti.',
      syncUnavailableTitle: 'Usawazishaji haupatikani',
      connectBeforeSync: 'Unganisha intaneti kabla ya kusawazisha mazungumzo haya ya ndani.',
      stopBeforeSync: 'Simamisha jibu la sasa kabla ya kusawazisha mazungumzo haya.',
      conversationSyncedTitle: 'Mazungumzo yamesawazishwa',
      conversationSyncedMessage: 'SafeRide imehifadhi mazungumzo ya ndani kwenye historia yako ya gumzo.',
      syncFailedTitle: 'Usawazishaji umeshindikana',
      syncFailedMessage: 'Mazungumzo yanabaki yamehifadhiwa kwenye simu hii. Jaribu tena muunganisho ukiwa thabiti.',
      localPhoneChatTitle: 'Gumzo la simu hii',
      localPhoneChatOffline: 'SafeRide bado inaunganisha. Mazungumzo haya yanabaki kwenye simu hii.',
      localPhoneChatTesting:
        'SafeRide bado inaunganisha. Unaweza kuendelea kujaribu majibu ya msaidizi wa ndani kwenye simu hii.',
      dialFailedTitle: 'Kupiga simu kumeshindikana',
      dialFailedMessage: 'Haikuweza kufungua kipiga simu.',
      draftStatusUnavailableTitle: 'Hali ya rasimu haipatikani',
      openingProvidersAnyway: 'Inafungua orodha za watoa huduma hata hivyo.',
      chatStorageUnavailableTitle: 'Hifadhi ya gumzo haipatikani',
      chatStorageUnavailableMessage: 'SafeRide haikuweza kufungua gumzo lililohifadhiwa. Jaribu tena baada ya kuongeza nafasi kwenye simu.',
      queuedMessagesSavedTitle: 'Ujumbe uliopangwa umehifadhiwa',
      queuedMessagesSaved: (count: number) =>
        `Ujumbe ${count} ${count === 1 ? 'uliopangwa umehifadhiwa' : 'iliyopangwa imehifadhiwa'} kwenye historia ya gumzo. Hakuna rufaa kwa mtoa huduma iliyotumwa kutoka kwenye gumzo.`,
      attachmentUploadedTitle: 'Upakiaji umehifadhiwa',
      attachmentUploadedMessage: (count: number) =>
        `${count} ${count === 1 ? 'faili limehifadhiwa' : 'faili yamehifadhiwa'} kwenye gumzo hili kwenye simu yako. Hakuna mtoa huduma au mtu aliyelipokea kutoka kwenye gumzo.`,
      attachmentUploadFailedTitle: 'Upakiaji umeshindikana',
      attachmentUploadFailedMessage:
        'SafeRide haikuweza kuhifadhi faili hilo kwenye gumzo. Jaribu tena baada ya kuangalia nafasi kwenye simu.',
    },
    alerts: {
      cancel: 'Ghairi',
      delete: 'Futa',
      sync: 'Sawazisha',
      deleteConversationTitle: 'Futa mazungumzo?',
      deleteLocalConversation:
        'Hii huondoa mazungumzo ya ndani kwenye simu hii. Haiathiri rekodi za mbali.',
      deleteRemoteConversation:
        'Hii huondoa mazungumzo kwenye historia ya gumzo ya SafeRide na kufuta akiba ya ndani kwenye simu hii.',
      syncConversationTitle: 'Sawazisha mazungumzo?',
      syncConversationMessage:
        'Hii hupakia mazungumzo ya ndani uliyochagua kwenye historia yako ya gumzo ya SafeRide. Hakuna mtoa huduma, wakili, au huduma ya dharura inayowasiliana kutoka kwenye gumzo.',
    },
  },
} as const;

export function getChatLegalAidCopy(languageCode?: string | null) {
  return CHAT_LEGAL_AID_COPY[normalizeSelectableLanguageCode(languageCode)];
}

export type ChatLegalAidCopy = ReturnType<typeof getChatLegalAidCopy>;

export const SETTINGS_COPY = {
  en: {
    checkingCatalogStatus: 'Checking saved catalog status...',
    catalogStatusUnavailable: 'Catalog status could not be checked. Bundled entries remain available.',
    catalogUpdateFailed: 'Catalog update failed. Saved or bundled catalogs remain available.',
    catalogUpdateFailedTitle: 'Catalog update failed',
    offlinePrefix: 'Offline. ',
    signedOut: 'Signed out',
    signOutFailed: 'Sign out failed',
    noAccountRider: 'No-account rider',
    noAccountSession: 'No-account session',
    profileAccount: 'Profile & account',
    account: 'Account',
    signOut: 'Sign out',
    preferences: 'Preferences',
    safetySettings: 'Safety Settings',
    privacyData: 'Privacy & Data',
    refreshingCatalogs: 'Refreshing catalogs...',
    refreshSupportCatalogs: 'Refresh support catalogs',
    catalogMeta: 'Providers, tips, and rights tags',
    languageAccessibility: 'Language & Accessibility',
    languageMeta: 'English',
    supportInfo: 'Support & information',
    tipsRights: 'Tips & Rights',
    aboutLegal: 'About & Legal',
    settingsEyebrow: 'Settings',
  },
  sw: {
    checkingCatalogStatus: 'Inakagua hali ya katalogi iliyohifadhiwa...',
    catalogStatusUnavailable: 'Hali ya katalogi haikuweza kukaguliwa. Orodha zilizopakiwa bado zinapatikana.',
    catalogUpdateFailed: 'Kusasisha katalogi kumeshindikana. Katalogi zilizohifadhiwa au zilizopakiwa bado zinapatikana.',
    catalogUpdateFailedTitle: 'Kusasisha katalogi kumeshindikana',
    offlinePrefix: 'Nje ya mtandao. ',
    signedOut: 'Umeondoka',
    signOutFailed: 'Kuondoka kumeshindikana',
    noAccountRider: 'Mtumiaji bila akaunti',
    noAccountSession: 'Kikao bila akaunti',
    profileAccount: 'Wasifu na akaunti',
    account: 'Akaunti',
    signOut: 'Ondoka',
    preferences: 'Mapendeleo',
    safetySettings: 'Mipangilio ya Usalama',
    privacyData: 'Faragha na Data',
    refreshingCatalogs: 'Inasasisha katalogi...',
    refreshSupportCatalogs: 'Sasisha katalogi za msaada',
    catalogMeta: 'Watoa huduma, vidokezo, na lebo za haki',
    languageAccessibility: 'Lugha na Ufikivu',
    languageMeta: 'Kiswahili kimetumika',
    supportInfo: 'Msaada na taarifa',
    tipsRights: 'Vidokezo na Haki',
    aboutLegal: 'Kuhusu na Sheria',
    settingsEyebrow: 'Mipangilio',
  },
} as const;

export function getSettingsCopy(languageCode?: string | null) {
  return SETTINGS_COPY[normalizeSelectableLanguageCode(languageCode)];
}

export const LANGUAGE_ACCESS_HEADER_COPY = {
  en: {
    eyebrow: 'Language and access',
    title: 'Accessibility',
    description:
      'Tune language, reading previews, contrast cues, screen-reader hints, and haptics from one compact control panel.',
    statLanguage: 'Language',
    statTextPreview: 'Text preview',
    statHaptics: 'Haptics',
    hapticsOn: 'On',
    hapticsOff: 'Off',
    fallbackLanguage: 'English',
  },
  sw: {
    eyebrow: 'Lugha na ufikivu',
    title: 'Ufikivu',
    description:
      'Badilisha lugha, onyesho la usomaji, alama za utofauti, vidokezo vya kisomaji skrini, na mitikisiko katika sehemu moja.',
    statLanguage: 'Lugha',
    statTextPreview: 'Onyesho la maandishi',
    statHaptics: 'Mitikisiko',
    hapticsOn: 'Imewashwa',
    hapticsOff: 'Imezimwa',
    fallbackLanguage: 'Kiingereza',
  },
} as const;

export function getLanguageAccessHeaderCopy(languageCode?: string | null) {
  return LANGUAGE_ACCESS_HEADER_COPY[normalizeSelectableLanguageCode(languageCode)];
}
