import type { PathwayType } from '../types/pathways';
import type { CaseEvent, CaseRecord } from '../services/caseService';
import type { DraftData } from './draftStorage';
import type { SyncQueueItem } from './offlineSync';
import { normalizeCaseSummaryPayload } from './caseDetailDisplay';
import {
  getReportWizardProgress,
  type ReportWizardStepId,
  type ReportWizardStepStatus,
} from '../navigation/reportPathwayFlow';

export type CaseDisplayState =
  | 'draft'
  | 'local_complete'
  | 'queued'
  | 'submitted'
  | 'provider_pending'
  | 'escalated'
  | 'closed'
  | 'failed_sync'
  | 'needs_attention'
  | 'unknown';

export type CaseSection = 'drafts' | 'active' | 'closed';
export type CaseSource = 'local_draft' | 'local_submission' | 'remote_case';
export type CaseTone = 'muted' | 'info' | 'success' | 'warning' | 'destructive';
export type SyncState = 'idle' | 'syncing' | 'success' | 'error';

export type CasePresentation = {
  state: CaseDisplayState;
  section: CaseSection;
  label: string;
  shortLabel: string;
  description: string;
  nextActionLabel: string;
  nextActionDescription: string;
  tone: CaseTone;
};

export type CaseReportProgress = {
  completedSteps: number;
  totalSteps: number;
  percentage: number;
  currentStepLabel?: string;
  nextStepLabel?: string;
  isComplete: boolean;
  steps: Array<{
    id: ReportWizardStepId;
    label: string;
    status: ReportWizardStepStatus;
  }>;
};

export type CaseListModel = {
  id: string;
  detailId: string;
  draftId?: string;
  caseId?: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  lastUpdate: string;
  location: string;
  pathway: string;
  tags: string[];
  source: CaseSource;
  summary?: Record<string, unknown> | null;
  mediaCount: number;
  presentation: CasePresentation;
  reportProgress?: CaseReportProgress;
  queueItems: SyncQueueItem[];
};

export type CaseTimelineModel = {
  id: string;
  type: string;
  title: string;
  body: string;
  at: Date;
  chips?: string[];
  isKeyEvent?: boolean;
};

export type CaseCollection = {
  all: CaseListModel[];
  drafts: CaseListModel[];
  active: CaseListModel[];
  closed: CaseListModel[];
};

const PRESENTATION_BY_STATE: Record<CaseDisplayState, CasePresentation> = {
  draft: {
    state: 'draft',
    section: 'drafts',
    label: 'Local draft',
    shortLabel: 'Draft',
    description: 'Saved on this device and not submitted.',
    nextActionLabel: 'Continue draft',
    nextActionDescription: 'Finish the report when you are ready.',
    tone: 'muted',
  },
  local_complete: {
    state: 'local_complete',
    section: 'active',
    label: 'Completed locally',
    shortLabel: 'Local',
    description: 'The report pathway is complete and saved on this device.',
    nextActionLabel: 'Review record',
    nextActionDescription: 'Open the saved local record and choose any follow-up action.',
    tone: 'success',
  },
  queued: {
    state: 'queued',
    section: 'active',
    label: 'Queued offline',
    shortLabel: 'Queued',
    description: 'Waiting on this device until sync can run.',
    nextActionLabel: 'Sync when online',
    nextActionDescription: 'Keep the app open when you have a connection.',
    tone: 'warning',
  },
  failed_sync: {
    state: 'failed_sync',
    section: 'active',
    label: 'Failed sync',
    shortLabel: 'Sync failed',
    description: 'The last sync attempt failed. The local copy is still on this device.',
    nextActionLabel: 'Retry sync',
    nextActionDescription: 'Check your connection and try syncing again.',
    tone: 'destructive',
  },
  submitted: {
    state: 'submitted',
    section: 'active',
    label: 'Submitted',
    shortLabel: 'Submitted',
    description: 'Recorded as submitted. Provider receipt is shown only when available.',
    nextActionLabel: 'Review timeline',
    nextActionDescription: 'Check timeline events and saved evidence status.',
    tone: 'success',
  },
  provider_pending: {
    state: 'provider_pending',
    section: 'active',
    label: 'Provider pending',
    shortLabel: 'Provider',
    description: 'Referral or review context is saved, but provider receipt is not confirmed here.',
    nextActionLabel: 'Watch for updates',
    nextActionDescription: 'Use support contacts if your situation changes.',
    tone: 'info',
  },
  escalated: {
    state: 'escalated',
    section: 'active',
    label: 'Escalated',
    shortLabel: 'Escalated',
    description: 'Escalation packet context is saved for review.',
    nextActionLabel: 'Review escalation',
    nextActionDescription: 'Check the escalation details and timeline.',
    tone: 'warning',
  },
  needs_attention: {
    state: 'needs_attention',
    section: 'active',
    label: 'Needs attention',
    shortLabel: 'Attention',
    description: 'A recorded update asks you to review this case.',
    nextActionLabel: 'Open case',
    nextActionDescription: 'Review the timeline and saved notes.',
    tone: 'destructive',
  },
  closed: {
    state: 'closed',
    section: 'closed',
    label: 'Closed',
    shortLabel: 'Closed',
    description: 'This case is closed. It remains available for in-app review.',
    nextActionLabel: 'Review record',
    nextActionDescription: 'View the closed timeline and saved details.',
    tone: 'muted',
  },
  unknown: {
    state: 'unknown',
    section: 'active',
    label: 'Status unknown',
    shortLabel: 'Unknown',
    description: 'Status could not be verified from local or remote data.',
    nextActionLabel: 'Refresh',
    nextActionDescription: 'Refresh when a connection is available.',
    tone: 'muted',
  },
};

const STATE_ORDER: Record<CaseDisplayState, number> = {
  needs_attention: 0,
  failed_sync: 1,
  queued: 2,
  escalated: 3,
  provider_pending: 4,
  submitted: 5,
  local_complete: 6,
  draft: 7,
  closed: 8,
  unknown: 9,
};

export function getCasePresentation(state: CaseDisplayState): CasePresentation {
  return PRESENTATION_BY_STATE[state] ?? PRESENTATION_BY_STATE.unknown;
}

export function normalizePathway(pathway?: string | PathwayType | null): string {
  switch (pathway) {
    case 'save-private':
      return 'Private';
    case 'anonymous-map':
      return 'Map update record';
    case 'referral':
      return 'Referral';
    case 'escalate':
      return 'Escalation';
    default:
      if (!pathway) return 'Pathway not selected';
      return String(pathway)
        .split(/[_-]/)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
  }
}

export function formatCaseDateTime(date: Date): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

function safeDate(value: Date | string | number | undefined, fallback: Date): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return fallback;
}

function getLocationLabel(location: unknown): string {
  if (location && typeof location === 'object') {
    const value = location as { address?: unknown; description?: unknown };
    if (typeof value.description === 'string' && value.description.trim()) {
      return value.description.trim();
    }
    if (typeof value.address === 'string' && value.address.trim()) {
      return value.address.trim();
    }
  }
  if (typeof location === 'string' && location.trim()) {
    return location.trim();
  }
  return 'Location not provided';
}

function getTitleFromText(text: unknown, fallback: string): string {
  if (typeof text === 'string' && text.trim().length > 0) {
    const title = text.trim().replace(/\s+/g, ' ');
    return title.length > 90 ? `${title.slice(0, 87)}...` : title;
  }
  return fallback;
}

function getTags(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
    : [];
}

function isSubmitQueueItemForDraft(item: SyncQueueItem, draftId: string): boolean {
  return item.type === 'submit' && item.data?.draftId === draftId;
}

export function getQueueItemsForDraft(queueItems: SyncQueueItem[], draftId: string): SyncQueueItem[] {
  return queueItems.filter(item => isSubmitQueueItemForDraft(item, draftId));
}

export function deriveDraftDisplayState(
  draft: DraftData,
  queueItems: SyncQueueItem[] = [],
  syncState: SyncState = 'idle',
): CaseDisplayState {
  if (draft.status === 'closed' || draft.status === 'archived') return 'closed';

  const draftQueueItems = getQueueItemsForDraft(queueItems, draft.id);
  const hasQueuedSubmission = draftQueueItems.some(item => item.type === 'submit') || draft.status === 'queued';
  const hasRetryFailure = draftQueueItems.some(item => (
    item.retryCount > 0 || Boolean(item.lastError) || Boolean(item.blockedReason)
  )) || (hasQueuedSubmission && syncState === 'error');

  if (hasRetryFailure) return 'failed_sync';
  if (hasQueuedSubmission) return 'queued';
  if (draft.status === 'submitted') return 'submitted';
  if (draft.currentStep === 'completed') {
    if (draft.selectedPathway === 'referral') return 'provider_pending';
    if (draft.selectedPathway === 'escalate') return 'escalated';
    return 'local_complete';
  }

  return 'draft';
}

export function canDeleteLocalDraft(
  draft: DraftData | null | undefined,
  queueItems: SyncQueueItem[] = [],
  syncState: SyncState = 'idle',
): boolean {
  if (!draft) return false;
  return deriveDraftDisplayState(draft, queueItems, syncState) === 'draft';
}

export function deriveRemoteDisplayState(
  record: Pick<CaseRecord, 'status' | 'pathway' | 'summary'>,
  events: CaseEvent[] = [],
): CaseDisplayState {
  if (record.status === 'closed') return 'closed';

  const summary = record.summary && typeof record.summary === 'object' ? record.summary : {};
  const actionRequired =
    summary.needsAttention === true ||
    summary.actionRequired === true ||
    events.some(event => ['action_required', 'needs_attention'].includes(event.eventType));

  if (actionRequired) return 'needs_attention';
  if (record.pathway === 'escalate') return 'escalated';
  if (record.status === 'referred' || record.status === 'in_review' || record.pathway === 'referral') {
    return 'provider_pending';
  }
  if (record.status === 'submitted') return 'submitted';

  return 'unknown';
}

export function buildDraftCaseListItem(
  draft: DraftData,
  queueItems: SyncQueueItem[] = [],
  syncState: SyncState = 'idle',
): CaseListModel {
  const createdAt = safeDate(draft.createdAt, new Date(0));
  const updatedAt = safeDate(draft.updatedAt, createdAt);
  const state = deriveDraftDisplayState(draft, queueItems, syncState);
  const presentation = getCasePresentation(state);
  const draftQueueItems = getQueueItemsForDraft(queueItems, draft.id);
  const pathway = normalizePathway(draft.selectedPathway);
  const title = getTitleFromText(draft.incidentDescription, `${presentation.shortLabel} - ${createdAt.toLocaleDateString()}`);
  const progress = state === 'draft' ? getReportWizardProgress(draft) : undefined;
  const currentProgressStep = progress?.steps.find(step => step.status === 'current');

  return {
    id: `draft:${draft.id}`,
    detailId: draft.id,
    draftId: draft.id,
    title,
    createdAt,
    updatedAt,
    lastUpdate: formatCaseDateTime(updatedAt),
    location: getLocationLabel(draft.location),
    pathway,
    tags: [...getTags(draft.selectedTags), ...getTags(draft.acceptedSuggestions)],
    source: state === 'draft' ? 'local_draft' : 'local_submission',
    summary: null,
    mediaCount: draft.mediaFiles?.length ?? 0,
    presentation,
    reportProgress: progress ? {
      completedSteps: progress.completedSteps,
      totalSteps: progress.totalSteps,
      percentage: progress.percentage,
      currentStepLabel: currentProgressStep?.label,
      nextStepLabel: progress.nextStep
        ? progress.steps.find(step => step.status === 'upcoming')?.label ?? currentProgressStep?.label
        : currentProgressStep?.label,
      isComplete: progress.isComplete,
      steps: progress.steps.map(step => ({
        id: step.id,
        label: step.label,
        status: step.status,
      })),
    } : undefined,
    queueItems: draftQueueItems,
  };
}

export function buildRemoteCaseListItem(record: CaseRecord, events: CaseEvent[] = []): CaseListModel {
  const summary = normalizeCaseSummaryPayload(record.summary);
  const state = deriveRemoteDisplayState(record, events);
  const presentation = getCasePresentation(state);
  const pathway = normalizePathway(record.pathway ?? (summary.pathway as string | undefined));
  const title = getTitleFromText(summary.incidentDescription, `Case - ${record.createdAt.toLocaleDateString()}`);

  return {
    id: `case:${record.id}`,
    detailId: record.id,
    draftId: record.draftId ?? undefined,
    caseId: record.id,
    title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastUpdate: formatCaseDateTime(record.updatedAt),
    location: getLocationLabel(summary.location),
    pathway,
    tags: getTags(summary.tags),
    source: 'remote_case',
    summary: record.summary,
    mediaCount: typeof summary.mediaCount === 'number' ? summary.mediaCount : 0,
    presentation,
    queueItems: [],
  };
}

function sortCaseItems(a: CaseListModel, b: CaseListModel): number {
  const stateDelta = STATE_ORDER[a.presentation.state] - STATE_ORDER[b.presentation.state];
  if (stateDelta !== 0) return stateDelta;
  return b.updatedAt.getTime() - a.updatedAt.getTime();
}

export function buildCaseCollection(
  drafts: DraftData[],
  remoteCases: CaseRecord[],
  queueItems: SyncQueueItem[] = [],
  syncState: SyncState = 'idle',
): CaseCollection {
  const remoteItems = remoteCases.map(record => buildRemoteCaseListItem(record));
  const remoteDraftIds = new Set(remoteCases.map(record => record.draftId).filter(Boolean));
  const localItems = drafts
    .map(draft => buildDraftCaseListItem(draft, queueItems, syncState))
    .filter(item => {
      if (!item.draftId || !remoteDraftIds.has(item.draftId)) return true;
      return item.presentation.state === 'draft';
    });

  const all = [...localItems, ...remoteItems].sort(sortCaseItems);

  return {
    all,
    drafts: all.filter(item => item.presentation.section === 'drafts'),
    active: all.filter(item => item.presentation.section === 'active'),
    closed: all.filter(item => item.presentation.section === 'closed'),
  };
}

export function buildLocalCaseRecordFromDraft(draft: DraftData): CaseRecord {
  const createdAt = safeDate(draft.createdAt, new Date(0));
  const updatedAt = safeDate(draft.updatedAt, createdAt);
  return {
    id: draft.id,
    draftId: draft.id,
    pathway: (draft.selectedPathway as PathwayType | null) ?? null,
    status: draft.status === 'closed' ? 'closed' : 'submitted',
    summary: buildCaseSummaryFromDraft(draft),
    createdAt,
    updatedAt,
  };
}

export function buildCaseSummaryFromDraft(draft: DraftData): Record<string, unknown> {
  return {
    pathway: draft.selectedPathway ?? null,
    incidentDescription: draft.incidentDescription ?? null,
    location: draft.location ?? null,
    datetime: draft.datetime ?? null,
    tags: [...(draft.selectedTags ?? []), ...(draft.acceptedSuggestions ?? [])],
    patterns: draft.patterns ?? [],
    mediaCount: draft.mediaFiles?.length ?? 0,
    witnesses: draft.witnesses ?? null,
    witnessDetails: draft.witnessDetails ?? null,
    impactLevel: draft.impactLevel ?? null,
    impactSummary: draft.impactSummary ?? null,
    isOngoing: draft.isOngoing ?? null,
    immediateHelp: draft.immediateHelp ?? null,
    followUpAnswers: draft.followUpAnswers ?? null,
    duration: draft.duration ?? null,
    textEvidence: draft.textEvidence ?? null,
    privacySettings: draft.privacySettings ?? null,
    escalationData: draft.escalationData ?? null,
    selectedProvider: draft.selectedProvider ?? null,
    selectedChannel: draft.selectedChannel ?? null,
    fallbackNumber: draft.fallbackNumber ?? null,
    includeBrief: draft.includeBrief ?? null,
    referralSelection: draft.referralSelection ?? null,
    supportBriefIncluded: draft.referralSelection?.includeBrief ?? draft.includeBrief ?? null,
    createdAt: safeDate(draft.createdAt, new Date(0)).toISOString(),
    updatedAt: safeDate(draft.updatedAt, safeDate(draft.createdAt, new Date(0))).toISOString(),
  };
}

export function buildDraftTimelineItems(
  draft: DraftData,
  queueItems: SyncQueueItem[] = [],
  syncState: SyncState = 'idle',
): CaseTimelineModel[] {
  const state = deriveDraftDisplayState(draft, queueItems, syncState);
  const presentation = getCasePresentation(state);
  const createdAt = safeDate(draft.createdAt, new Date(0));
  const updatedAt = safeDate(draft.updatedAt, createdAt);
  const items: CaseTimelineModel[] = [
    {
      id: 'draft-created',
      type: 'created',
      title: state === 'draft' ? 'Draft created' : 'Local case created',
      body: state === 'draft'
        ? 'This report is saved locally and has not been submitted.'
        : 'This case has a local record on this device.',
      at: createdAt,
      chips: [presentation.shortLabel, normalizePathway(draft.selectedPathway)],
      isKeyEvent: true,
    },
  ];

  if (draft.mediaFiles?.length) {
    items.push({
      id: 'draft-evidence',
      type: 'evidence',
      title: 'Evidence saved locally',
      body: `${draft.mediaFiles.length} evidence item${draft.mediaFiles.length === 1 ? '' : 's'} saved on this device.`,
      at: updatedAt,
      chips: ['Local evidence'],
    });
  }

  if (state === 'queued' || state === 'failed_sync') {
    const firstQueueItem = getQueueItemsForDraft(queueItems, draft.id)[0];
    const recoveryBody = firstQueueItem?.blockedReason === 'auth_required'
      ? 'Optional online sync needs attention. The local copy is still saved on this device.'
      : firstQueueItem?.blockedReason === 'sending_paused'
        ? 'Sending to SafeRide is paused. The report is saved on this device and has not been sent.'
      : firstQueueItem?.blockedReason === 'needs_confirmation'
        ? 'Confirm sharing with HURIA again, or turn it off, before this report is sent. Nothing has been sent.'
      : firstQueueItem?.blockedReason === 'max_retries'
        ? 'Automatic retries paused after repeated failures. Use Sync now when you are ready to retry.'
        : firstQueueItem?.lastError
          ? 'The last sync attempt failed. The local copy is still saved on this device.'
          : presentation.description;

    items.push({
      id: 'draft-sync-state',
      type: state,
      title: state === 'failed_sync' ? 'Sync needs attention' : 'Submission queued',
      body: recoveryBody,
      at: firstQueueItem?.timestamp ?? updatedAt,
      chips: [presentation.nextActionLabel],
      isKeyEvent: state === 'failed_sync',
    });
  }

  if (draft.status === 'submitted') {
    items.push({
      id: 'draft-submitted',
      type: 'submission',
      title: 'Marked submitted locally',
      body: 'The local report is marked submitted. Remote receipt appears only when a case ID is available.',
      at: updatedAt,
      chips: [presentation.shortLabel],
      isKeyEvent: true,
    });
  }

  return items.sort((a, b) => b.at.getTime() - a.at.getTime());
}
