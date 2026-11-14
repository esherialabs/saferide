import * as FileSystem from 'expo-file-system/legacy';
import { File } from 'expo-file-system';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';

import { ApiError, request, setAuthToken } from '../lib/api/httpClient';
import { authClient } from '../lib/auth/authClient';
import { DraftData, draftStorage } from '../utils/draftStorage';
import {
  devPrivacyInfo,
  devPrivacyWarn,
  getPrivacySafeErrorReason,
  getPrivacySafeHttpStatus,
} from '../utils/privacyLog';
import { shouldIncludeDraftBriefDetails } from '../utils/referralSupport';
import { buildHuriaPacket } from '../utils/huriaPacket';
import { buildEvidencePrivacyStatus } from '../utils/evidencePrivacyStatus';
import { PathwayType } from '../types/pathways';
import {
  buildEscalationEvidenceUploadDescriptor,
  buildEscalationPacket,
} from '../utils/escalationPacket';
import { assertActivePathwayConsent } from '../utils/consentLedger';
import {
  classifyPartnerRoutingFailure,
  getPartnerRoutingConflictMessage,
  getRequestedPartnerSharing,
  hasPartnerConsentAgreement,
  PARTNER_FOLLOW_UP_CONSENT_VERSION,
  HURIA_PARTNER_STABLE_ID,
  markPartnerSharingWithdrawn,
  requirePartnerReconfirmation,
  type PartnerRoutingConflictReason,
  type PartnerSharingDraft,
} from '../utils/partnerSharing';
import { notificationCenter } from '../utils/notificationCenter';
import { PARTNER_SHARING_COPY } from '../i18n/partnerSharingCopy';
import {
  ensurePartnerConsentRecords,
  hasWithdrawnPartnerConsent,
  releaseUnusedPartnerConsents,
} from './partnerSharingService';

type CaseStatus = 'submitted' | 'in_review' | 'referred' | 'closed';

type CaseRecordRow = {
  id: string;
  owner_id: string;
  draft_id: string | null;
  pathway: string | null;
  status: CaseStatus;
  summary: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

type AttachmentRow = {
  id: string;
  owner_id: string;
  case_id: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  status?: 'pending_upload' | 'uploaded' | 'hash_mismatch' | 'rejected' | 'deleted';
  antivirus_status?: 'not_scanned' | 'pending' | 'clean' | 'rejected';
  quarantine_status?: 'quarantined' | 'released' | 'rejected';
  retention_policy_id?: string | null;
};

type CaseEventRow = {
  id: string;
  case_id: string;
  owner_id: string | null;
  event_type: string;
  payload: Record<string, unknown> | null;
  created_at: string;
};

export type CaseRecord = {
  id: string;
  draftId: string | null;
  pathway: PathwayType | null;
  status: CaseStatus;
  summary: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CaseAttachment = {
  id: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
  createdAt: Date;
  metadata?: Record<string, unknown> | null;
  status?: AttachmentRow['status'];
  antivirusStatus?: AttachmentRow['antivirus_status'];
  quarantineStatus?: AttachmentRow['quarantine_status'];
  retentionPolicyId?: string | null;
};

export type CaseEvent = {
  id: string;
  caseId: string;
  ownerId: string | null;
  eventType: string;
  payload: Record<string, unknown> | null;
  createdAt: Date;
};

export type CaseDetail = {
  caseRecord: CaseRecord | null;
  attachments: CaseAttachment[];
  events: CaseEvent[];
};

export class CaseEvidenceUploadError extends Error {
  caseId: string;
  failedCount: number;

  constructor(caseId: string, failedCount: number) {
    super(
      failedCount === 1
        ? 'One evidence item did not upload. The report is queued for retry.'
        : `${failedCount} evidence items did not upload. The report is queued for retry.`,
    );
    this.name = 'CaseEvidenceUploadError';
    this.caseId = caseId;
    this.failedCount = failedCount;
  }
}

/** What happened to the survivor's optional choice to also share with HURIA. */
export type PartnerSharingResult =
  | { status: 'not_requested' }
  | { status: 'routed'; reference: string; partnerStatus: string; callbackShared: boolean; callbackNotShared?: boolean }
  | { status: 'unavailable' }
  | { status: 'withdrawn' };

type PartnerReferralResponse = {
  partnerStableId?: unknown;
  reference?: unknown;
  status?: unknown;
  callbackShared?: unknown;
};

/**
 * The partner or a consent changed (409), or the survivor has not agreed at
 * the current version: nothing was sent, and the survivor must confirm
 * sharing with HURIA again (or turn it off) before the report is sent.
 */
export class PartnerRoutingConflictError extends Error {
  readonly reason: PartnerRoutingConflictReason | 'confirmation_required';

  constructor(reason: PartnerRoutingConflictReason | 'confirmation_required') {
    super(getPartnerRoutingConflictMessage(reason));
    this.name = 'PartnerRoutingConflictError';
    this.reason = reason;
  }
}

async function getOwnedApiToken(): Promise<string | null> {
  try {
    const { data, error } = await authClient.getSession();
    if (error) {
      devPrivacyWarn('case API session lookup failed', {
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
    devPrivacyWarn('case API session lookup threw', {
      reason: getPrivacySafeErrorReason(error),
      status: getPrivacySafeHttpStatus(error),
    });
    return null;
  }
}

async function requireOwnedApiToken(): Promise<void> {
  const token = await getOwnedApiToken();
  if (!token) {
    throw new Error('User is not authenticated');
  }
}

function mapCaseRow(row: CaseRecordRow): CaseRecord {
  return {
    id: row.id,
    draftId: row.draft_id,
    pathway: (row.pathway as PathwayType | null) ?? null,
    status: row.status,
    summary: row.summary,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function mapAttachmentRow(row: AttachmentRow): CaseAttachment {
  return {
    id: row.id,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    createdAt: new Date(row.created_at),
    metadata: row.metadata,
    status: row.status,
    antivirusStatus: row.antivirus_status,
    quarantineStatus: row.quarantine_status,
    retentionPolicyId: row.retention_policy_id,
  };
}

function mapCaseEventRow(row: CaseEventRow): CaseEvent {
  return {
    id: row.id,
    caseId: row.case_id,
    ownerId: row.owner_id,
    eventType: row.event_type,
    payload: row.payload,
    createdAt: new Date(row.created_at),
  };
}

function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

type ReferralSelectedField = 'incident_categories' | 'time_context' | 'location_type' | 'ongoing_status';

export type CaseWorkflowPayload =
  | {
      schemaVersion: '1.0';
      workflowType: 'referral';
      providerId: string;
      channel: 'call' | 'whatsapp' | 'sms' | 'partner_dashboard';
      partnerPacket?: { consentVersion: typeof PARTNER_FOLLOW_UP_CONSENT_VERSION; packet: ReturnType<typeof buildHuriaPacket> };
      supportBrief:
        | { included: false; selectedFields: [] }
        | {
            included: true;
            selectedFields: ReferralSelectedField[];
            incidentCategories?: string[];
            timeContext?: { date: string; accuracy: 'exact' | 'approximate' | 'estimated' };
            locationType?: string;
            isOngoing?: boolean;
          };
    }
  | {
      schemaVersion: '1.0';
      workflowType: 'submitted-case';
      pathway: 'escalation';
      submission: {
        schemaVersion: '1.0';
        workflowType: 'escalation';
        packet: ReturnType<typeof buildEscalationPacket>;
      };
    };

function buildReferralWorkflow(draft: DraftData, reviewedPacket = false): CaseWorkflowPayload {
  const providerId = draft.referralSelection?.providerId ?? draft.selectedProvider;
  const channel = draft.referralSelection?.selectedChannel ?? draft.selectedChannel ??
    (reviewedPacket && providerId === HURIA_PARTNER_STABLE_ID ? 'partner_dashboard' : undefined);
  if (!providerId || !channel) {
    throw new Error('A selected provider and channel are required for referral submission.');
  }

  const includeBrief = shouldIncludeDraftBriefDetails('referral', draft);
  if (!includeBrief) {
    return {
      schemaVersion: '1.0',
      workflowType: 'referral',
      providerId,
      channel,
      supportBrief: { included: false, selectedFields: [] },
    };
  }

  const selectedFields: ReferralSelectedField[] = [];
  const supportBrief: Extract<CaseWorkflowPayload, { workflowType: 'referral' }>['supportBrief'] & {
    included: true;
  } = { included: true, selectedFields };
  const incidentCategories = Array.from(new Set([
    ...(draft.patterns ?? []),
    ...(draft.selectedTags ?? []),
    ...(draft.acceptedSuggestions ?? []),
    ...(draft.customTags ?? []),
  ])).slice(0, 12);
  if (incidentCategories.length > 0) {
    selectedFields.push('incident_categories');
    supportBrief.incidentCategories = incidentCategories;
  }
  if (draft.datetime?.date) {
    selectedFields.push('time_context');
    supportBrief.timeContext = { date: draft.datetime.date, accuracy: draft.datetime.accuracy };
  }
  if (draft.location?.type) {
    selectedFields.push('location_type');
    supportBrief.locationType = draft.location.type;
  }
  if (typeof draft.isOngoing === 'boolean') {
    selectedFields.push('ongoing_status');
    supportBrief.isOngoing = draft.isOngoing;
  }
  if (selectedFields.length === 0) {
    if (reviewedPacket) return { schemaVersion: '1.0', workflowType: 'referral', providerId, channel, supportBrief: { included: false, selectedFields: [] } };
    throw new Error('The selected support brief has no shareable minimized fields.');
  }

  return {
    schemaVersion: '1.0',
    workflowType: 'referral',
    providerId,
    channel,
    supportBrief,
  };
}

export function buildCaseSummary(draft: DraftData, pathway: PathwayType): CaseWorkflowPayload {
  const sharing = getRequestedPartnerSharing(draft, pathway);
  const reviewed = sharing && (pathway === 'referral' || pathway === 'escalate') && hasPartnerConsentAgreement(sharing, pathway);
  const generatedAt = draft.pathwayConsent?.grantedAt ?? new Date(draft.createdAt).toISOString();
  if (pathway === 'referral') {
    const workflow = buildReferralWorkflow(draft, Boolean(reviewed));
    return reviewed && workflow.workflowType === 'referral'
      ? { ...workflow, partnerPacket: { consentVersion: PARTNER_FOLLOW_UP_CONSENT_VERSION, packet: buildHuriaPacket(draft, { generatedAt, pathway }) } }
      : workflow;
  }
  if (pathway === 'escalate') {
    return {
      schemaVersion: '1.0',
      workflowType: 'submitted-case',
      pathway: 'escalation',
      submission: {
        schemaVersion: '1.0',
        workflowType: 'escalation',
        // A lost response must retry the same consented packet. Queue and
        // upload updates change updatedAt; the consent checkpoint is stable.
        packet: reviewed ? buildHuriaPacket(draft, { generatedAt, pathway }) : buildEscalationPacket(draft, { generatedAt }),
      },
    };
  }
  throw new Error(`${pathway} does not create an account-linked case payload.`);
}

function guessMimeType(media: NonNullable<DraftData['mediaFiles']>[number]): string {
  if (media.mimeType) return media.mimeType;
  const extension = media.fileName?.split('.').pop()?.toLowerCase();
  switch (extension) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'mp4':
      return 'video/mp4';
    case 'mov':
      return 'video/quicktime';
    case 'm4a':
      return 'audio/mp4';
    case 'mp3':
      return 'audio/mpeg';
    case 'wav':
      return 'audio/wav';
    case 'pdf':
      return 'application/pdf';
    case 'doc':
      return 'application/msword';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    default:
      switch (media.type) {
        case 'photo':
          return 'image/jpeg';
        case 'video':
          return 'video/mp4';
        case 'audio':
          return 'audio/mp4';
        default:
          return 'application/octet-stream';
      }
  }
}

function extensionFromMimeType(mimeType: string): string | null {
  switch (mimeType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/gif':
      return 'gif';
    case 'video/mp4':
      return 'mp4';
    case 'video/quicktime':
      return 'mov';
    case 'audio/mp4':
      return 'm4a';
    case 'audio/mpeg':
      return 'mp3';
    case 'audio/wav':
      return 'wav';
    case 'application/pdf':
      return 'pdf';
    case 'application/msword':
      return 'doc';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return 'docx';
    default:
      return null;
  }
}

function buildGenericEvidenceName(
  media: NonNullable<DraftData['mediaFiles']>[number],
  mimeType: string,
  evidenceIndex: number,
): string {
  const baseName =
    media.type === 'photo'
      ? 'evidence-photo'
      : media.type === 'video'
        ? 'evidence-video'
        : media.type === 'audio'
          ? 'evidence-audio'
          : media.type === 'document'
            ? 'evidence-document'
            : 'evidence-file';
  const extension = extensionFromMimeType(mimeType);
  const indexedName = baseName + '-' + (evidenceIndex + 1);
  return extension ? indexedName + '.' + extension : indexedName;
}

async function readFileAsBlob(uri: string): Promise<{ blob: Blob; size?: number }> {
  try {
    const response = await fetch(uri);
    if (!response.ok) {
      throw new Error('Failed to read file for upload');
    }
    const blob = await response.blob();
    return { blob, size: blob.size };
  } catch (error) {
    devPrivacyWarn('evidence file read failed before upload', {
      reason: getPrivacySafeErrorReason(error),
    });
    throw error;
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new Uint8Array(bytes));
  const hash = bytesToHex(new Uint8Array(digest));
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Evidence checksum generation failed.');
  return hash;
}

function validateEvidenceSize(measuredSize: number, declaredSize: number, filesystemSize?: number): void {
  if (!Number.isSafeInteger(measuredSize) || measuredSize <= 0) {
    throw new Error('Media item has no readable size');
  }
  // Zero represents unavailable picker metadata. A positive declaration must
  // still match the bytes being hashed/uploaded rather than silently drifting.
  if (!Number.isFinite(declaredSize) || declaredSize < 0 ||
    (declaredSize > 0 && declaredSize !== measuredSize) ||
    (filesystemSize !== undefined && filesystemSize !== measuredSize)) {
    throw new Error('Evidence size does not match the readable file');
  }
}

type PartnerRoutingPayload = {
  partnerStableId: string;
  consentRecordId: string;
  callback?: { phoneNumber: string; consentRecordId: string };
};

async function postCase(params: {
  draft: DraftData;
  workflow: CaseWorkflowPayload;
  partnerRouting?: PartnerRoutingPayload;
}): Promise<{ caseRecord: CaseRecord; partnerReferral: PartnerReferralResponse | null }> {
  const pathwayConsent = params.draft.pathwayConsent!;
  if (params.workflow.workflowType === 'referral' && params.workflow.channel === 'partner_dashboard' && !params.partnerRouting) {
    throw new PartnerRoutingConflictError('confirmation_required');
  }
  // A partner outage/withdrawal fallback keeps the original minimized referral.
  // A reviewed HURIA packet is never silently retained in a SafeRide-only referral.
  const workflow = !params.partnerRouting && params.workflow.workflowType === 'referral'
    ? (({ partnerPacket: _packet, ...legacy }) => legacy)(params.workflow)
    : params.workflow;
  const response = await request<{ case: CaseRecordRow; partnerReferral?: PartnerReferralResponse }>({
    path: '/cases',
    method: 'POST',
    body: {
      idempotencyKey: pathwayConsent.recordId,
      // Drafts live only on this phone. Keep their case link locally; the
      // server draft relation must not receive an unrelated local identifier.
      pathwayConsent: {
        recordId: pathwayConsent.recordId,
        purpose: pathwayConsent.purpose,
        version: pathwayConsent.version,
      },
      workflow,
      ...(params.partnerRouting ? { partnerRouting: params.partnerRouting } : {}),
    },
  });
  return { caseRecord: mapCaseRow(response.case), partnerReferral: response.partnerReferral ?? null };
}

async function savePartnerSharing(draftId: string, sharing: PartnerSharingDraft, extra: Partial<DraftData> = {}): Promise<void> {
  await draftStorage.saveDraft({ id: draftId, partnerSharing: sharing, ...extra, updatedAt: new Date() });
}

function isHttpErrorResponse(error: unknown): boolean {
  return error instanceof ApiError && typeof error.status === 'number';
}

/**
 * Partner sharing is unavailable (503), so the report goes to SafeRide only
 * and the survivor is told. The outcome is saved first so a retry after a
 * lost response repeats the same SafeRide-only request; it is rolled back
 * only when the server clearly refused this request as well.
 */
async function sendToSafeRideOnly(params: {
  draft: DraftData;
  workflow: CaseWorkflowPayload;
  sharing: PartnerSharingDraft;
}): Promise<{ caseRecord: CaseRecord; partnerSharing: PartnerSharingResult }> {
  if (params.workflow.workflowType === 'referral' && params.workflow.channel === 'partner_dashboard') {
    // A digital HURIA referral has no independently selected external channel.
    // Keep it on the phone if that recipient is unavailable; do not change
    // its destination or invent a call on the survivor's behalf.
    await savePartnerSharing(params.draft.id, requirePartnerReconfirmation(params.sharing, 'confirmation_required'), {
      caseSubmissionError: getPartnerRoutingConflictMessage('confirmation_required'),
    });
    throw new PartnerRoutingConflictError('confirmation_required');
  }
  const unavailable: PartnerSharingDraft = {
    partnerStableId: params.sharing.partnerStableId,
    requested: true,
    outcome: { status: 'unavailable', at: new Date().toISOString() },
  };
  await savePartnerSharing(params.draft.id, unavailable);
  let created;
  try {
    created = await postCase({ draft: params.draft, workflow: params.workflow });
  } catch (error) {
    if (isHttpErrorResponse(error)) await savePartnerSharing(params.draft.id, params.sharing);
    throw error;
  }
  await releaseUnusedPartnerConsents(params.sharing);
  devPrivacyInfo('partner sharing unavailable; case sent to SafeRide only');
  // Visible wherever the survivor is: the report did not reach HURIA.
  notificationCenter.notify({
    title: PARTNER_SHARING_COPY.errors.unavailableTitle,
    message: PARTNER_SHARING_COPY.errors.unavailableBody,
    variant: 'warning',
  });
  return { caseRecord: created.caseRecord, partnerSharing: { status: 'unavailable' } };
}

async function createCaseOnApi(
  draft: DraftData,
  pathway: PathwayType,
): Promise<{ caseRecord: CaseRecord; partnerSharing: PartnerSharingResult }> {
  const pathwayConsent = draft.pathwayConsent;
  if (
    !pathwayConsent ||
    pathwayConsent.purpose !== 'pathway_submission' ||
    pathwayConsent.version !== 'pathway-consent.v1' ||
    pathwayConsent.pathway !== pathway
  ) {
    throw new Error('A current pathway-specific consent checkpoint is required before submission.');
  }
  const workflow = buildCaseSummary(draft, pathway);
  const requested = getRequestedPartnerSharing(draft, pathway);

  if (!requested) {
    const created = await postCase({ draft, workflow });
    const withdrawnBeforeSend = Boolean(draft.partnerSharing?.requested && draft.partnerSharing.withdrawnAt);
    return {
      caseRecord: created.caseRecord,
      partnerSharing: withdrawnBeforeSend ? { status: 'withdrawn' } : { status: 'not_requested' },
    };
  }
  // Checked before every submit and retry, like the pathway consent: a
  // partner consent withdrawn on this phone (even before the server has
  // confirmed it) means this report is never routed to the partner.
  if (await hasWithdrawnPartnerConsent(requested)) {
    const withdrawn = markPartnerSharingWithdrawn(requested, 'follow_up');
    await savePartnerSharing(draft.id, withdrawn);
    await releaseUnusedPartnerConsents(requested);
    const created = await postCase({ draft, workflow });
    notificationCenter.notify({
      title: PARTNER_SHARING_COPY.errors.unavailableTitle,
      message: PARTNER_SHARING_COPY.errors.withdrawnBody,
      variant: 'info',
    });
    return { caseRecord: created.caseRecord, partnerSharing: { status: 'withdrawn' } };
  }
  if (requested.outcome?.status === 'unavailable') {
    const created = await postCase({ draft, workflow });
    return { caseRecord: created.caseRecord, partnerSharing: { status: 'unavailable' } };
  }
  if (!hasPartnerConsentAgreement(requested, pathway as 'escalate' | 'referral')) {
    await savePartnerSharing(draft.id, requirePartnerReconfirmation(requested, 'confirmation_required'), {
      caseSubmissionError: getPartnerRoutingConflictMessage('confirmation_required'),
    });
    throw new PartnerRoutingConflictError('confirmation_required');
  }

  let sharing: PartnerSharingDraft;
  try {
    sharing = await ensurePartnerConsentRecords({
      draftId: draft.id,
      sharing: requested,
      pathway: pathway as 'escalate' | 'referral',
    });
  } catch (error) {
    // 503 partner_unavailable: the purpose is not enabled. Other errors keep the choice for a retry.
    if (classifyPartnerRoutingFailure(error)?.kind === 'unavailable') {
      // A follow-up consent may already exist when only the callback purpose is off.
      const latest = (await draftStorage.getDraft(draft.id))?.partnerSharing;
      return sendToSafeRideOnly({ draft, workflow, sharing: latest ?? requested });
    }
    throw error;
  }

  return routeToPartner({ draft, workflow, sharing });
}

/**
 * Sends the report with partnerRouting and handles the API's answers:
 * - 503 partner_callback_unavailable: only the callback is off, so the
 *   report is resent to HURIA without the number (and the survivor told);
 * - 503 partner_unavailable: sent to SafeRide only;
 * - 409 consent reasons: nothing was sent; the survivor confirms again;
 * - anything else (including other 503s): thrown, the choice kept for a retry.
 */
async function routeToPartner(params: {
  draft: DraftData;
  workflow: CaseWorkflowPayload;
  sharing: PartnerSharingDraft;
}): Promise<{ caseRecord: CaseRecord; partnerSharing: PartnerSharingResult }> {
  const { draft, workflow, sharing } = params;
  const followUpId = sharing.followUpConsent?.recordId;
  const callback = sharing.callback;
  if (!followUpId || (callback?.requested && (!callback.consent?.recordId || !callback.phoneNumber))) {
    throw new Error('Partner consent records are missing after creation.');
  }
  const partnerRouting: PartnerRoutingPayload = {
    partnerStableId: sharing.partnerStableId,
    consentRecordId: followUpId,
    ...(callback?.requested
      ? { callback: { phoneNumber: callback.phoneNumber!, consentRecordId: callback.consent!.recordId! } }
      : {}),
  };

  let created;
  try {
    created = await postCase({ draft, workflow, partnerRouting });
  } catch (error) {
    const failure = classifyPartnerRoutingFailure(error);
    if (failure?.kind === 'callback_unavailable' && partnerRouting.callback) {
      // Share with HURIA as agreed, but the number cannot go: drop it and say so.
      const withoutCallback: PartnerSharingDraft = { ...sharing, callback: undefined, callbackDropped: true };
      await savePartnerSharing(draft.id, withoutCallback);
      await releaseUnusedPartnerConsents({ partnerStableId: sharing.partnerStableId, requested: true, callback: sharing.callback });
      notificationCenter.notify({
        title: PARTNER_SHARING_COPY.errors.callbackUnavailableTitle,
        message: PARTNER_SHARING_COPY.errors.callbackUnavailableBody,
        variant: 'warning',
      });
      return routeToPartner({ draft, workflow, sharing: withoutCallback });
    }
    if (failure?.kind === 'unavailable') {
      return sendToSafeRideOnly({ draft, workflow, sharing });
    }
    if (failure?.kind === 'conflict') {
      // The whole submission rolled back: nothing reached SafeRide or HURIA.
      await releaseUnusedPartnerConsents(sharing);
      await savePartnerSharing(draft.id, requirePartnerReconfirmation(sharing, failure.reason), {
        caseSubmissionError: getPartnerRoutingConflictMessage(failure.reason),
      });
      throw new PartnerRoutingConflictError(failure.reason);
    }
    throw error;
  }

  const referral = created.partnerReferral;
  if (!referral || typeof referral.reference !== 'string' || referral.partnerStableId !== sharing.partnerStableId) {
    // Created without routing: an API without #294. Keep the report, say it was not shared.
    await savePartnerSharing(draft.id, {
      partnerStableId: sharing.partnerStableId,
      requested: true,
      outcome: { status: 'unavailable', at: new Date().toISOString() },
    });
    await releaseUnusedPartnerConsents(sharing);
    return { caseRecord: created.caseRecord, partnerSharing: { status: 'unavailable' } };
  }

  const result: PartnerSharingResult = {
    status: 'routed',
    reference: referral.reference,
    partnerStatus: typeof referral.status === 'string' ? referral.status : 'new',
    callbackShared: referral.callbackShared === true,
    ...(sharing.callbackDropped ? { callbackNotShared: true } : {}),
  };
  // The callback number now lives sealed on the server; drop it from the phone.
  await savePartnerSharing(draft.id, {
    ...sharing,
    ...(sharing.callback ? { callback: { ...sharing.callback, phoneNumber: undefined } } : {}),
    outcome: { ...result, at: new Date().toISOString() },
  });
  return { caseRecord: created.caseRecord, partnerSharing: result };
}

function partnerSharingResultFromDraft(draft: DraftData, pathway: PathwayType): PartnerSharingResult {
  const outcome = draft.partnerSharing?.outcome;
  if (draft.partnerSharing?.withdrawnAt) {
    return draft.partnerSharing.requested ? { status: 'withdrawn' } : { status: 'not_requested' };
  }
  if (!getRequestedPartnerSharing(draft, pathway)) return { status: 'not_requested' };
  if (outcome?.status === 'routed') {
    return {
      status: 'routed',
      reference: outcome.reference,
      partnerStatus: outcome.partnerStatus,
      callbackShared: outcome.callbackShared,
      ...(outcome.callbackNotShared ? { callbackNotShared: true } : {}),
    };
  }
  return outcome?.status === 'unavailable' ? { status: 'unavailable' } : { status: 'not_requested' };
}

async function uploadAttachmentToApi(params: {
  caseId: string;
  media: NonNullable<DraftData['mediaFiles']>[number];
  pathway: PathwayType;
  evidenceIndex: number;
  privacySettings?: DraftData['privacySettings'];
  redactionLevel?: NonNullable<DraftData['escalationData']>['redactionLevel'];
}): Promise<{ attachment: CaseAttachment; mimeType: string }> {
  const { caseId, media, pathway, evidenceIndex, privacySettings, redactionLevel } = params;
  if (!media.uri) {
    throw new Error('Media item missing URI');
  }

  // Only wait for processing that is actually running. A request this build
  // cannot process (the evidence screen says so) is sent along as recorded
  // intent in privacyStatus; blocking on it held the photo back forever.
  const privacyStatus = buildEvidencePrivacyStatus(media, privacySettings);
  const processingFeatures = Object.entries(privacyStatus)
    .filter(([, entry]) => entry.status === 'processing')
    .map(([feature]) => feature);
  if (processingFeatures.length > 0) {
    throw new Error(`Evidence privacy processing is incomplete: ${processingFeatures.join(', ')}`);
  }

  const mimeType = guessMimeType(media);
  const escalationDescriptor = pathway === 'escalate'
    ? buildEscalationEvidenceUploadDescriptor({
        media,
        evidenceIndex,
        redactionLevel: redactionLevel ?? 'light',
        privacySettings,
      })
    : null;
  const displayName = escalationDescriptor?.fileName ?? buildGenericEvidenceName(media, mimeType, evidenceIndex);
  const uploadMetadata: Record<string, unknown> = {
    displayName,
    mediaType: media.type,
    privacyStatus,
  };
  if (escalationDescriptor) {
    if (typeof escalationDescriptor.metadata.packetRedactionLevel === 'string') {
      uploadMetadata.packetRedactionLevel = escalationDescriptor.metadata.packetRedactionLevel;
    }
    if (typeof escalationDescriptor.metadata.packetMetadataStatus === 'string') {
      uploadMetadata.packetMetadataStatus = escalationDescriptor.metadata.packetMetadataStatus;
    }
    if (Array.isArray(escalationDescriptor.metadata.privacyRequests)) {
      uploadMetadata.privacyRequests = escalationDescriptor.metadata.privacyRequests;
    }
  }
  const isWeb = Platform.OS === 'web';
  const webBlob = isWeb ? (await readFileAsBlob(media.uri)).blob : null;
  const fileInfo = isWeb ? null : await FileSystem.getInfoAsync(media.uri);
  if (fileInfo && (!fileInfo.exists || fileInfo.isDirectory)) {
    throw new Error('Evidence file is unavailable');
  }
  const bytes = webBlob
    ? new Uint8Array(await webBlob.arrayBuffer())
    : await new File(media.uri).bytes();
  const sizeBytes = bytes.byteLength;
  validateEvidenceSize(sizeBytes, media.size,
    fileInfo?.exists && typeof fileInfo.size === 'number' ? fileInfo.size : undefined);
  const sha256 = await sha256Bytes(bytes);

  const signed = await request<{
    attachment: AttachmentRow;
    upload: {
      method: 'POST';
      url: string;
      expiresInSeconds: number;
      fields: Record<string, string>;
    };
  }>({
    path: `/cases/${encodeURIComponent(caseId)}/evidence`,
    method: 'POST',
    body: {
      fileName: displayName,
      mimeType,
      sizeBytes,
      sha256,
      retentionPolicyId: 'submitted-case-pending-legal-v1',
      metadata: uploadMetadata,
    },
  });

  const uploadBody = new FormData();
  for (const [key, value] of Object.entries(signed.upload.fields)) {
    uploadBody.append(key, value);
  }
  if (webBlob) {
    uploadBody.append('file', webBlob, displayName);
  } else {
    // React Native FormData serializes file URIs, not browser Blob objects.
    uploadBody.append('file', { uri: media.uri, name: displayName, type: mimeType } as any);
  }

  const uploadResponse = await fetch(signed.upload.url, {
    method: signed.upload.method,
    body: uploadBody,
  });

  if (!uploadResponse.ok) {
    throw new Error(`Evidence upload failed with ${uploadResponse.status}`);
  }

  const completed = await request<{ attachment: AttachmentRow }>({
    path: `/cases/${encodeURIComponent(caseId)}/evidence/${encodeURIComponent(signed.attachment.id)}/complete`,
    method: 'POST',
    body: {},
  });

  if (completed.attachment.status !== 'uploaded') {
    throw new Error('Evidence upload verification failed');
  }

  return {
    attachment: mapAttachmentRow(completed.attachment),
    mimeType,
  };
}

async function fetchCasesFromApi(): Promise<CaseRecord[]> {
  const response = await request<{ cases: CaseRecordRow[] }>({ path: '/cases' });
  return response.cases.map(mapCaseRow);
}

async function fetchCaseDetailFromApi(caseId: string): Promise<CaseDetail> {
  const response = await request<{
    case: CaseRecordRow;
    attachments: AttachmentRow[];
    events: CaseEventRow[];
  }>({ path: `/cases/${encodeURIComponent(caseId)}` });

  return {
    caseRecord: mapCaseRow(response.case),
    attachments: response.attachments.map(mapAttachmentRow),
    events: response.events.map(mapCaseEventRow),
  };
}

export async function createAttachmentDownloadUrl(params: {
  caseId: string;
  attachment: CaseAttachment;
}): Promise<string> {
  await requireOwnedApiToken();
  const response = await request<{ url: string; expiresInSeconds: number }>({
    path: `/cases/${encodeURIComponent(params.caseId)}/evidence/${encodeURIComponent(params.attachment.id)}/download`,
  });
  return response.url;
}

export async function submitCase({
  draft,
  pathway,
}: {
  draft: DraftData;
  pathway: PathwayType;
}): Promise<{ caseRecord: CaseRecord | null; attachments: CaseAttachment[]; partnerSharing: PartnerSharingResult }> {
  const includeDraftDetails = pathway === 'escalate';

  devPrivacyInfo('case submission started', {
    pathway,
    mediaCount: includeDraftDetails ? draft.mediaFiles?.length ?? 0 : 0,
    status: draft.status,
  });

  if (pathway === 'save-private') {
    await draftStorage.saveDraft({
      id: draft.id,
      status: 'submitted',
      updatedAt: new Date(),
    });
    return {
      caseRecord: null,
      attachments: [],
      partnerSharing: { status: 'not_requested' },
    };
  }

  if (pathway === 'anonymous-map') {
    throw new Error(
      'Anonymous map submission is unavailable until coarse-location and privacy-threshold approval is configured.',
    );
  }

  const pathwayConsent = draft.pathwayConsent;
  if (
    !pathwayConsent ||
    pathwayConsent.purpose !== 'pathway_submission' ||
    pathwayConsent.version !== 'pathway-consent.v1' ||
    pathwayConsent.pathway !== pathway
  ) {
    throw new Error('A current pathway-specific consent checkpoint is required before submission.');
  }
  await assertActivePathwayConsent({
    recordId: pathwayConsent.recordId,
    pathway,
    version: pathwayConsent.version,
    grantedAt: pathwayConsent.grantedAt,
  });

  await requireOwnedApiToken();
  const storedCaseId = typeof draft.caseId === 'string' && draft.caseId.trim()
    ? draft.caseId.trim()
    : null;
  const created = storedCaseId
    ? {
        caseRecord: {
          id: storedCaseId,
          draftId: draft.id,
          pathway,
          status: 'submitted' as const,
          summary: buildCaseSummary(draft, pathway),
          createdAt: draft.createdAt,
          updatedAt: new Date(),
        },
        partnerSharing: partnerSharingResultFromDraft(draft, pathway),
      }
    : await createCaseOnApi(draft, pathway);
  const { caseRecord, partnerSharing } = created;

  await draftStorage.saveDraft({
    id: draft.id,
    caseId: caseRecord.id,
    caseSubmissionError: undefined,
    updatedAt: new Date(),
  });

  devPrivacyInfo(storedCaseId ? 'case submission retry using existing API case' : 'case record created through API', {
    pathway: caseRecord.pathway,
  });

  const attachments: CaseAttachment[] = [];
  const failedUploads: string[] = [];
  if (includeDraftDetails && draft.mediaFiles?.length) {
    for (const [evidenceIndex, media] of draft.mediaFiles.entries()) {
      if (media.uploadStatus === 'uploaded' && (media.attachmentId || media.storagePath)) {
        continue;
      }

      try {
        const result = await uploadAttachmentToApi({
          caseId: caseRecord.id,
          media,
          pathway,
          evidenceIndex,
          privacySettings: draft.privacySettings,
          redactionLevel: draft.escalationData?.redactionLevel,
        });
        attachments.push(result.attachment);
        media.attachmentId = result.attachment.id;
        media.mimeType = result.mimeType;
        media.uploadedAt = new Date();
        media.uploadStatus = 'uploaded';
        media.uploadError = undefined;
      } catch (error) {
        const reason = getPrivacySafeErrorReason(error);
        failedUploads.push(media.id);
        media.uploadStatus = 'failed';
        media.uploadError = reason;
        devPrivacyWarn('case attachment upload failed', {
          reason,
          status: getPrivacySafeHttpStatus(error),
        });
      }
    }
  }

  if (failedUploads.length > 0) {
    const caseSubmissionError = failedUploads.length === 1
      ? 'One evidence item did not upload. The report is queued for retry.'
      : `${failedUploads.length} evidence items did not upload. The report is queued for retry.`;

    await draftStorage.saveDraft({
      id: draft.id,
      status: 'queued',
      caseId: caseRecord.id,
      caseSubmissionError,
      mediaFiles: draft.mediaFiles,
      updatedAt: new Date(),
    });

    throw new CaseEvidenceUploadError(caseRecord.id, failedUploads.length);
  }

  await draftStorage.saveDraft({
    id: draft.id,
    status: 'submitted',
    caseId: caseRecord.id,
    caseSubmissionError: undefined,
    mediaFiles: draft.mediaFiles,
    updatedAt: new Date(),
  });

  devPrivacyInfo('case submission completed through API', {
    attachments: attachments.length,
    partnerSharing: partnerSharing.status,
  });

  return { caseRecord, attachments, partnerSharing };
}

export async function fetchCases(): Promise<CaseRecord[]> {
  await requireOwnedApiToken();
  return fetchCasesFromApi();
}

export async function fetchCaseAttachments(caseId: string): Promise<CaseAttachment[]> {
  await requireOwnedApiToken();
  return (await fetchCaseDetailFromApi(caseId)).attachments;
}

export async function fetchCaseEvents(caseId: string): Promise<CaseEvent[]> {
  await requireOwnedApiToken();
  return (await fetchCaseDetailFromApi(caseId)).events;
}

export async function fetchCaseDetail(caseId: string): Promise<CaseDetail> {
  if (!isValidUuid(caseId)) {
    throw new Error('Case details are only available after the report finishes syncing.');
  }

  await requireOwnedApiToken();
  return fetchCaseDetailFromApi(caseId);
}

export async function fetchCaseById(caseId: string): Promise<CaseRecord | null> {
  await requireOwnedApiToken();
  try {
    return (await fetchCaseDetailFromApi(caseId)).caseRecord;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}
