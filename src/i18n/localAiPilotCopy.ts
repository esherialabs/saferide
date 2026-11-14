import {
  KENYA_POLICE_EMERGENCY_CONTACT,
  PRIMARY_KENYA_GBV_CONTACT,
} from '../lib/supportResources';
import {
  AI_PILOT_EXPORT_EXCLUDED_FIELDS,
  AI_PILOT_EXPORT_INCLUDED_FIELDS,
} from '../lib/localAssistant/pilotDiagnostics';
import type { LocalAiFailureCategory } from '../lib/localAssistant/pilotFailureReasons';

/**
 * English source copy for the local AI pilot surfaces. Like the moderated-test
 * copy, it is not translated until a reviewed language pack exists.
 */
const FAILURE_CATEGORY_COPY: Record<LocalAiFailureCategory, { label: string; detail: string }> = {
  memory: {
    label: 'Not enough memory',
    detail: 'This phone may not have enough memory (RAM) to run the AI model. Close other apps and try again.',
  },
  storage: {
    label: 'Not enough storage',
    detail: 'There is not enough free storage for the AI model. Free up space, then resume.',
  },
  'download-incomplete': {
    label: 'Download incomplete',
    detail: 'The AI model download did not finish or failed its integrity check. Resume or download it again.',
  },
  'model-start': {
    label: 'Model failed to start',
    detail: 'The AI model could not start on this phone. Try again.',
  },
  'reply-failed': {
    label: 'Reply failed',
    detail: 'The AI could not finish this reply. Try again or send a shorter message.',
  },
  'not-ready': {
    label: 'AI not set up',
    detail: 'The AI model is not downloaded or loaded on this phone yet.',
  },
  unavailable: {
    label: 'AI unavailable',
    detail: 'AI is turned off for this build or model right now.',
  },
  unknown: {
    label: 'Unexpected problem',
    detail: 'The AI hit an unexpected problem. Try again.',
  },
};

const SAVED_MODEL_NOTE = 'The model file is still saved on this phone.';

/** "a, b, or c" for the consent sentence. */
function listWithOr(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')}, or ${items[items.length - 1]}`;
}

const LOCAL_AI_PILOT_COPY = {
  failure: {
    category: (category: LocalAiFailureCategory) => FAILURE_CATEGORY_COPY[category],
    statusMessage: (category: LocalAiFailureCategory, modelSaved: boolean) => {
      const copy = FAILURE_CATEGORY_COPY[category];
      return `${copy.label}: ${copy.detail}${modelSaved ? ` ${SAVED_MODEL_NOTE}` : ''}`;
    },
    chatFallback: (category: LocalAiFailureCategory) => {
      const copy = FAILURE_CATEGORY_COPY[category];
      return `AI could not reply (${copy.label}). ${copy.detail} Your message is saved on this phone. ` +
        `For help now, call ${PRIMARY_KENYA_GBV_CONTACT.displayPhone}. ` +
        `In an emergency, call ${KENYA_POLICE_EMERGENCY_CONTACT.displayPhone}.`;
    },
  },
  ramWarning: {
    title: 'This phone may be too small for local AI',
    message: (ramClassGb: number, minimumRamGb: number, pilotDiagnostics: boolean) =>
      `SafeRide's local AI needs about ${minimumRamGb} GB of memory (RAM). This phone has about ${ramClassGb} GB. ` +
      'You can still download it for this pilot, but it may fail to start, reply slowly, or close the app.' +
      (pilotDiagnostics ? ' The memory size range is recorded in AI pilot diagnostics on this phone.' : ''),
    cancelAction: 'Not now',
    continueAction: 'Continue anyway',
  },
  feedback: {
    helpful: 'Mark reply helpful',
    notHelpful: 'Mark reply not helpful',
    saved: 'Feedback saved on this phone',
  },
  export: {
    settingsTitle: 'Export AI pilot diagnostics',
    settingsMeta: 'Content-free JSON summary that you choose to share',
    deleteTitle: 'Delete AI pilot diagnostics',
    deleteMeta: 'Removes AI pilot records stored on this phone',
    consentTitle: 'Share AI pilot diagnostics?',
    consentMessage:
      `This creates a JSON summary and opens the share sheet. It includes only: ${AI_PILOT_EXPORT_INCLUDED_FIELDS.join('; ')}. ` +
      `It never includes ${listWithOr(AI_PILOT_EXPORT_EXCLUDED_FIELDS)}. Nothing is uploaded automatically.`,
    consentConfirm: 'Create and share',
    consentCancel: 'Not now',
    shareTitle: 'SafeRide AI pilot diagnostics',
    shared: 'AI pilot diagnostics ready to share',
    failed: 'Could not create AI pilot diagnostics',
    deleteConfirmTitle: 'Delete AI pilot diagnostics?',
    deleteConfirmMessage: 'This removes AI performance records stored on this phone. Chats and reports are not affected.',
    deleteConfirm: 'Delete',
    deleted: 'AI pilot diagnostics deleted',
  },
} as const;

export function getLocalAiPilotCopy(_languageCode?: string | null) {
  return LOCAL_AI_PILOT_COPY;
}
