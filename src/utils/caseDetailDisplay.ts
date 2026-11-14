import type { CaseAttachment } from '../services/caseService';
import type { PathwayType } from '../types/pathways';
import type { DraftData, ReferralSelectionData } from './draftStorage';

export type CaseLocationPayload = {
  address?: string;
  description?: string;
  type?: string;
  coordinates?: {
    latitude?: number;
    longitude?: number;
  };
};

export type AnonymousMapSignalPayload = {
  location?: CaseLocationPayload | null;
  locationPrecision?: string | null;
  datetime?: { date?: string; time?: string; accuracy?: string } | null;
  duration?: string | null;
  isOngoing?: boolean | null;
  categories?: unknown[];
};

export type CaseSummaryPayload = {
  incidentDescription?: string;
  location?: CaseLocationPayload;
  datetime?: { date?: string; time?: string; accuracy?: string };
  tags?: string[];
  patterns?: string[];
  mediaCount?: number;
  pathway?: PathwayType;
  witnesses?: boolean | null;
  impactLevel?: string | null;
  impactSummary?: string | null;
  isOngoing?: boolean | null;
  witnessDetails?: string | null;
  immediateHelp?: boolean | null;
  followUpAnswers?: Record<string, string> | null;
  duration?: string | null;
  textEvidence?: string | null;
  privacySettings?: DraftData['privacySettings'] | null;
  escalationData?: DraftData['escalationData'] | null;
  selectedProvider?: string | null;
  selectedChannel?: DraftData['selectedChannel'] | null;
  fallbackNumber?: string | null;
  includeBrief?: boolean | null;
  referralSelection?: ReferralSelectionData | null;
  supportBriefIncluded?: boolean | null;
  anonymousMapSignal?: AnonymousMapSignalPayload | null;
  [key: string]: unknown;
};

export type DraftMedia = NonNullable<DraftData['mediaFiles']>[number];

export type CaseDetailSource = {
  isAnonymousMapRecord: boolean;
  localDraftFallbackAllowed: boolean;
  anonymousMapSignal: AnonymousMapSignalPayload | null;
  anonymousMapCategories: string[];
  summaryLocation: CaseLocationPayload | null;
  summaryDatetime: CaseSummaryPayload['datetime'] | null;
  mediaCount: number;
  localMediaFiles: DraftMedia[];
  showAttachmentSyncNotice: boolean;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeCaseSummaryPayload(value: unknown): CaseSummaryPayload {
  if (!isObjectRecord(value)) return {};
  if (value.schemaVersion !== '1.0' || !isObjectRecord(value.workflow)) {
    return value as CaseSummaryPayload;
  }

  const workflow = value.workflow;
  const reviewedReferralPacket = workflow.workflowType === 'referral' && isObjectRecord(workflow.partnerPacket)
    && workflow.partnerPacket.consentVersion === 'partner-follow-up.ke-coast-huria.v3' && isObjectRecord(workflow.partnerPacket.packet)
    ? workflow.partnerPacket.packet : null;
  if (workflow.workflowType === 'referral' && isObjectRecord(workflow.supportBrief) && !reviewedReferralPacket) {
    const brief = workflow.supportBrief;
    const timeContext = isObjectRecord(brief.timeContext) ? brief.timeContext : null;
    const locationType = typeof brief.locationType === 'string' ? brief.locationType : null;
    return {
      pathway: 'referral',
      selectedProvider: typeof workflow.providerId === 'string' ? workflow.providerId : null,
      selectedChannel: typeof workflow.channel === 'string' ? workflow.channel as DraftData['selectedChannel'] : null,
      supportBriefIncluded: brief.included === true,
      tags: Array.isArray(brief.incidentCategories)
        ? brief.incidentCategories.filter((item): item is string => typeof item === 'string')
        : [],
      datetime: timeContext && typeof timeContext.date === 'string'
        ? {
            date: timeContext.date,
            time: '',
            accuracy: typeof timeContext.accuracy === 'string' ? timeContext.accuracy : 'approximate',
          }
        : undefined,
      location: locationType ? { type: locationType } : undefined,
      isOngoing: typeof brief.isOngoing === 'boolean' ? brief.isOngoing : null,
      mediaCount: 0,
    };
  }

  if (reviewedReferralPacket || (workflow.workflowType === 'submitted-case' && isObjectRecord(workflow.submission))) {
    const submission = isObjectRecord(workflow.submission) ? workflow.submission : {};
    const packet = reviewedReferralPacket ?? (isObjectRecord(submission.packet) ? submission.packet : null);
    const content = packet && isObjectRecord(packet.content) ? packet.content : null;
    const evidenceManifest = packet && Array.isArray(packet.evidenceManifest) ? packet.evidenceManifest : [];
    if (content) {
      return {
        pathway: reviewedReferralPacket ? 'referral' : 'escalate',
        ...(reviewedReferralPacket ? {
          selectedProvider: typeof workflow.providerId === 'string' ? workflow.providerId : null,
          selectedChannel: typeof workflow.channel === 'string' ? workflow.channel as DraftData['selectedChannel'] : null,
          supportBriefIncluded: isObjectRecord(workflow.supportBrief) && workflow.supportBrief.included === true,
        } : {}),
        incidentDescription: typeof content.incidentDescription === 'string' ? content.incidentDescription : undefined,
        textEvidence: typeof content.statement === 'string' ? content.statement : undefined,
        location: typeof content.location === 'string' ? { description: content.location } : undefined,
        tags: Array.isArray(content.tags) ? content.tags.filter((item): item is string => typeof item === 'string') : [],
        patterns: Array.isArray(content.patterns) ? content.patterns.filter((item): item is string => typeof item === 'string') : [],
        impactSummary: typeof content.impactSummary === 'string' ? content.impactSummary : null,
        witnessDetails: typeof content.witnessDetails === 'string' ? content.witnessDetails : null,
        mediaCount: evidenceManifest.length,
      };
    }
  }
  return {};
}

function getLocationPayload(value: unknown): CaseLocationPayload | null {
  return isObjectRecord(value) ? (value as CaseLocationPayload) : null;
}

function getDatetimePayload(value: unknown): CaseSummaryPayload['datetime'] | null {
  return isObjectRecord(value) ? (value as CaseSummaryPayload['datetime']) : null;
}

export function getAnonymousMapSignal(summary?: CaseSummaryPayload | Record<string, unknown> | null): AnonymousMapSignalPayload | null {
  if (!summary || !isObjectRecord(summary.anonymousMapSignal)) {
    return null;
  }

  const signal = summary.anonymousMapSignal as Record<string, unknown>;
  return {
    location: getLocationPayload(signal.location),
    locationPrecision: typeof signal.locationPrecision === 'string' ? signal.locationPrecision : null,
    datetime: getDatetimePayload(signal.datetime),
    duration: typeof signal.duration === 'string' ? signal.duration : null,
    isOngoing: typeof signal.isOngoing === 'boolean' ? signal.isOngoing : null,
    categories: Array.isArray(signal.categories) ? signal.categories : [],
  };
}

export function isAnonymousMapCaseRecord(
  pathway?: PathwayType | string | null,
  summary?: CaseSummaryPayload | Record<string, unknown> | null,
): boolean {
  return pathway === 'anonymous-map' || summary?.pathway === 'anonymous-map';
}

export function getAnonymousMapCategoryLabels(summary?: CaseSummaryPayload | Record<string, unknown> | null): string[] {
  const signal = getAnonymousMapSignal(summary);
  if (!signal?.categories?.length) return [];

  return Array.from(new Set(
    signal.categories.filter((value): value is string => typeof value === 'string' && value.trim().length > 0),
  ));
}

export function buildCaseDetailSource({
  casePathway,
  summary,
  localDraft,
  attachments,
}: {
  casePathway?: PathwayType | string | null;
  summary: CaseSummaryPayload;
  localDraft?: DraftData | null;
  attachments: CaseAttachment[];
}): CaseDetailSource {
  const isAnonymousMapRecord = isAnonymousMapCaseRecord(casePathway, summary);
  const anonymousMapSignal = getAnonymousMapSignal(summary);
  const localDraftFallbackAllowed = !isAnonymousMapRecord;
  const localMediaFiles = localDraftFallbackAllowed ? localDraft?.mediaFiles ?? [] : [];
  const mediaCount = isAnonymousMapRecord
    ? 0
    : typeof summary.mediaCount === 'number'
      ? summary.mediaCount
      : attachments.length > 0
        ? attachments.length
        : localMediaFiles.length;

  return {
    isAnonymousMapRecord,
    localDraftFallbackAllowed,
    anonymousMapSignal,
    anonymousMapCategories: getAnonymousMapCategoryLabels(summary),
    summaryLocation: isAnonymousMapRecord
      ? anonymousMapSignal?.location ?? null
      : getLocationPayload(summary.location),
    summaryDatetime: isAnonymousMapRecord
      ? anonymousMapSignal?.datetime ?? null
      : getDatetimePayload(summary.datetime),
    mediaCount,
    localMediaFiles,
    showAttachmentSyncNotice: !isAnonymousMapRecord && attachments.length === 0 && mediaCount > 0,
  };
}

export function getStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case 'draft':
      return 'Draft';
    case 'queued':
      return 'Queued';
    case 'submitted':
      return 'Submitted';
    case 'in_review':
      return 'In review';
    case 'referred':
      return 'Referred';
    case 'closed':
      return 'Closed';
    case 'acknowledged':
      return 'Acknowledged';
    case 'action-required':
      return 'Action required';
    default:
      return status ? status.replace(/[_-]/g, ' ') : 'Unknown';
  }
}

/** Timeline wording for a `status_change` case event. Only `new_status` is read: partner identity and notes never reach this payload. */
export function describeStatusChange(
  payload: Record<string, unknown> | null | undefined,
  fallbackStatus: string | null | undefined,
): { label: string; body: string } {
  const newStatus = typeof payload?.new_status === 'string' ? payload.new_status : fallbackStatus;
  const label = getStatusLabel(newStatus);
  return { label, body: `Status updated to ${label}.` };
}
