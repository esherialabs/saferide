/**
 * What a partner caseworker sees of a routed case (design section 1.4).
 * Everything is built field by field from an allow-list; nothing is spread
 * from stored rows. Never included: owner, case, draft, consent,
 * idempotency or request ids, storage keys, checksums or device file ids.
 */
import { referralWorkflowSchema, submittedCaseWorkflowSchema } from '../contracts/caseContracts.js';
import type { AttachmentRow } from '../repositories/caseRepository.js';
import type {
  PartnerActivityRecord,
  PartnerNoteRecord,
  PartnerOnwardRecord,
  PartnerPathway,
  PartnerQueueRow,
  PartnerReferralRecord,
  PartnerStaffRecord,
  PartnerTimelineRecord,
  PartnerUserRef,
} from '../repositories/partnerCaseRepository.js';
import { buildSafeEvidenceMetadata } from './evidenceMetadata.js';
import { getEvidenceDownloadDecision } from './evidenceQuarantine.js';
import { scrubCoordinates, scrubPacketLocation } from './partnerLocationScrub.js';
import {
  PARTNER_ONWARD_TRANSITIONS,
  PARTNER_STATUS_TRANSITIONS,
  partnerNeedsAttention,
  partnerPriority,
  type PartnerOnwardStatus,
  type PartnerOnwardType,
  type PartnerPriority,
  type PartnerReferralStatus,
} from './partnerReferralStatus.js';

export type PartnerQueueItem = {
  id: string;
  reference: string;
  pathway: PartnerPathway | null;
  status: PartnerReferralStatus | 'withdrawn';
  withdrawn: boolean;
  receivedAt: string;
  statusChangedAt: string;
  /** Escalations are urgent; a tombstone is normal (it reveals nothing). */
  priority: PartnerPriority;
  /** Urgent and still `new`: nobody has acknowledged it. */
  needsAttention: boolean;
  assignee: PartnerUserRef | null;
  onward: { count: number; latest: { type: PartnerOnwardType; status: PartnerOnwardStatus } | null };
};

export type PartnerReferralSummary = {
  id: string;
  reference: string;
  pathway: PartnerPathway | null;
  status: PartnerReferralStatus;
  closureReason: string | null;
  withdrawn: false;
  receivedAt: string;
  statusChangedAt: string;
  callbackShared: boolean;
  allowedTransitions: readonly PartnerReferralStatus[];
  priority: PartnerPriority;
  needsAttention: boolean;
  assignee: PartnerUserRef | null;
};

/**
 * Where the partner sent the survivor next. Partner-typed text, shown as
 * typed (it is the partner's own record, not survivor content, so the
 * location scrubber does not apply); never sent to the survivor.
 */
export type PartnerOnwardView = {
  id: string;
  type: PartnerOnwardType;
  organisation: string | null;
  contactRole: string | null;
  externalReference: string | null;
  note: string | null;
  status: PartnerOnwardStatus;
  createdAt: string;
  createdBy: PartnerUserRef;
  statusChangedAt: string;
  allowedTransitions: readonly PartnerOnwardStatus[];
};

export type PartnerStaffView = { id: string; name: string; role: PartnerStaffRecord['role'] };

export type PartnerReferralTombstone = {
  id: string;
  reference: string;
  status: 'withdrawn';
  withdrawn: true;
  receivedAt: string;
  withdrawnAt: string;
};

type ReferralBriefView = {
  incidentCategories?: string[];
  timeContext?: { date: string; accuracy: 'exact' | 'approximate' | 'estimated' };
  locationType?: string;
  isOngoing?: boolean;
};

export type PartnerCaseView =
  | { kind: 'referral'; channel: 'call' | 'whatsapp' | 'sms'; brief: ReferralBriefView | null }
  | {
      kind: 'escalation';
      generatedAt: string;
      redactionLevel: 'none' | 'light' | 'heavy';
      contact: { preference: 'alias'; alias: string; label: string } | { preference: 'none'; label: string };
      content: {
        timeRange: string;
        location: string;
        incidentDescription: string;
        statement: string;
        impactSummary?: string;
        witnessDetails?: string;
        tags: string[];
        patterns: string[];
        transportIdentifiers: string[];
      };
      evidenceManifest: Array<{
        type: 'photo' | 'video' | 'audio' | 'document';
        label: string;
        sizeBytes?: number;
        capturedAt?: string;
        description?: string;
        transcript?: string;
        metadataStatus: string;
        privacyRequests: string[];
      }>;
      redaction: { appliedLabels: string[]; textFields: string[]; evidenceMetadata: string; mediaProcessing: string[] };
    }
  | { kind: 'unavailable' };

export type PartnerAttachmentView = {
  id: string;
  mediaType: string;
  displayName: string;
  mimeType: string | null;
  sizeBytes: number | null;
  receivedAt: string;
  download: { available: true } | { available: false; reason: string };
};

/**
 * `received` and `status_change` come from the routing and status events
 * (no actor). The other events come from the partner's own activity log and
 * name the partner user who acted; an acknowledgement is shown once, as
 * `acknowledged`. Never free text: names, codes and times only.
 */
export type PartnerTimelineItem =
  | { event: 'received' | 'status_change'; status: PartnerReferralStatus | null; at: string }
  | { event: 'acknowledged'; status: 'acknowledged'; at: string; actor: PartnerUserRef }
  | { event: 'assigned'; status: null; at: string; actor: PartnerUserRef; assignee: PartnerUserRef | null }
  | { event: 'unassigned'; status: null; at: string; actor: PartnerUserRef }
  | {
      event: 'onward_created' | 'onward_status';
      status: null;
      at: string;
      actor: PartnerUserRef;
      onward: { id: string; type: PartnerOnwardType; status: PartnerOnwardStatus };
    };

export type PartnerNoteView = {
  id: string;
  body: string;
  createdAt: string;
  author: { id: string; displayName: string };
};

function iso(date: Date): string {
  return date.toISOString();
}

export function toPartnerQueueItem(row: PartnerQueueRow): PartnerQueueItem {
  const withdrawn = row.revokedAt !== null;
  const pathway = withdrawn ? null : row.pathway;
  const status = withdrawn ? 'withdrawn' : row.status;
  return {
    id: row.id,
    reference: row.reference,
    pathway,
    status,
    withdrawn,
    receivedAt: iso(row.receivedAt),
    statusChangedAt: iso(row.revokedAt ?? row.statusChangedAt),
    priority: partnerPriority(pathway),
    needsAttention: partnerNeedsAttention(pathway, status),
    assignee: withdrawn || !row.assignee ? null : { id: row.assignee.id, name: row.assignee.name },
    onward: withdrawn
      ? { count: 0, latest: null }
      : {
          count: row.onward.count,
          latest: row.onward.latest ? { type: row.onward.latest.type, status: row.onward.latest.status } : null,
        },
  };
}

export function toPartnerReferralSummary(record: PartnerReferralRecord): PartnerReferralSummary {
  return {
    id: record.id,
    reference: record.reference,
    pathway: record.pathway,
    status: record.status,
    closureReason: record.closureReason,
    withdrawn: false,
    receivedAt: iso(record.receivedAt),
    statusChangedAt: iso(record.statusChangedAt),
    callbackShared: record.callbackShared,
    allowedTransitions: PARTNER_STATUS_TRANSITIONS[record.status],
    priority: partnerPriority(record.pathway),
    needsAttention: partnerNeedsAttention(record.pathway, record.status),
    assignee: record.assignee ? { id: record.assignee.id, name: record.assignee.name } : null,
  };
}

export function toPartnerReferralTombstone(record: PartnerReferralRecord & { revokedAt: Date }): PartnerReferralTombstone {
  return {
    id: record.id,
    reference: record.reference,
    status: 'withdrawn',
    withdrawn: true,
    receivedAt: iso(record.receivedAt),
    withdrawnAt: iso(record.revokedAt),
  };
}

/**
 * Projects the stored, already-minimised workflow; anything unexpected
 * becomes `unavailable`. Coordinates never pass: the location keeps only
 * its textual description, and coordinate forms are scrubbed from every
 * free-text field.
 */
export function buildPartnerCaseView(summary: Record<string, unknown> | null): PartnerCaseView {
  const workflow = summary?.workflow;
  const referral = referralWorkflowSchema.safeParse(workflow);
  if (referral.success && !referral.data.partnerPacket) {
    // A digital handoff has no phone-channel brief fallback. Stored malformed
    // or historic rows must not make an unreviewed digital packet readable.
    if (referral.data.channel === 'partner_dashboard') return { kind: 'unavailable' };
    const brief = referral.data.supportBrief;
    if (!brief.included) return { kind: 'referral', channel: referral.data.channel, brief: null };
    const selected = new Set(brief.selectedFields);
    const view: ReferralBriefView = {};
    if (selected.has('incident_categories') && brief.incidentCategories) view.incidentCategories = [...brief.incidentCategories];
    if (selected.has('time_context') && brief.timeContext) {
      view.timeContext = { date: brief.timeContext.date, accuracy: brief.timeContext.accuracy };
    }
    if (selected.has('location_type') && brief.locationType) view.locationType = scrubCoordinates(brief.locationType);
    if (selected.has('ongoing_status') && brief.isOngoing !== undefined) view.isOngoing = brief.isOngoing;
    return { kind: 'referral', channel: referral.data.channel, brief: view };
  }

  const escalation = submittedCaseWorkflowSchema.safeParse(workflow);
  const packet = referral.success ? referral.data.partnerPacket?.packet : escalation.success ? escalation.data.submission.packet : undefined;
  if (packet) {
    const content = packet.content;
    return {
      kind: 'escalation',
      generatedAt: packet.generatedAt,
      redactionLevel: packet.redactionLevel,
      contact: packet.contact.preference === 'alias' && packet.contact.alias
        ? { preference: 'alias', alias: scrubCoordinates(packet.contact.alias), label: scrubCoordinates(packet.contact.label) }
        : { preference: 'none', label: scrubCoordinates(packet.contact.label) },
      content: {
        timeRange: scrubCoordinates(content.timeRange),
        location: scrubPacketLocation(content.location),
        incidentDescription: scrubCoordinates(content.incidentDescription),
        statement: scrubCoordinates(content.statement),
        ...(content.impactSummary !== undefined ? { impactSummary: scrubCoordinates(content.impactSummary) } : {}),
        ...(content.witnessDetails !== undefined ? { witnessDetails: scrubCoordinates(content.witnessDetails) } : {}),
        tags: content.tags.map(scrubCoordinates),
        patterns: content.patterns.map(scrubCoordinates),
        transportIdentifiers: content.transportIdentifiers.map(scrubCoordinates),
      },
      evidenceManifest: packet.evidenceManifest.map(item => ({
        type: item.type,
        label: scrubCoordinates(item.label),
        ...(item.sizeBytes !== undefined ? { sizeBytes: item.sizeBytes } : {}),
        ...(item.capturedAt !== undefined ? { capturedAt: item.capturedAt } : {}),
        ...(item.description !== undefined ? { description: scrubCoordinates(item.description) } : {}),
        ...(item.transcript !== undefined ? { transcript: scrubCoordinates(item.transcript) } : {}),
        metadataStatus: item.metadataStatus,
        privacyRequests: [...item.privacyRequests],
      })),
      redaction: {
        appliedLabels: [...packet.redaction.appliedLabels],
        textFields: [...packet.redaction.textFields],
        evidenceMetadata: packet.redaction.evidenceMetadata,
        mediaProcessing: [...packet.redaction.mediaProcessing],
      },
    };
  }

  return { kind: 'unavailable' };
}

/**
 * Type, size and a generic name always; `download.available` only when
 * partner downloads are switched on and the scan/quarantine gate passes.
 */
export function toPartnerAttachmentView(row: AttachmentRow, options: { downloadsEnabled: boolean }): PartnerAttachmentView {
  const metadata = buildSafeEvidenceMetadata(row.metadata, row.mime_type ?? 'application/octet-stream');
  const decision: { allowed: true } | { allowed: false; reason: string } = options.downloadsEnabled
    ? getEvidenceDownloadDecision(row)
    : { allowed: false, reason: 'evidence_not_shareable_yet' };
  return {
    id: row.id,
    mediaType: String(metadata.mediaType),
    displayName: String(metadata.displayName),
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    receivedAt: new Date(row.created_at).toISOString(),
    download: decision.allowed ? { available: true } : { available: false, reason: decision.reason },
  };
}

/** Null for a row that does not have its kind's shape (the database check prevents one). */
function toActivityItem(record: PartnerActivityRecord): PartnerTimelineItem | null {
  const at = iso(record.createdAt);
  const actor = { id: record.actor.id, name: record.actor.name };
  switch (record.kind) {
    case 'acknowledged':
      return { event: 'acknowledged', status: 'acknowledged', at, actor };
    case 'assigned':
      return {
        event: 'assigned', status: null, at, actor,
        assignee: record.assignee ? { id: record.assignee.id, name: record.assignee.name } : null,
      };
    case 'unassigned':
      return { event: 'unassigned', status: null, at, actor };
    case 'onward_created':
    case 'onward_status':
      if (!record.onward) return null;
      return {
        event: record.kind, status: null, at, actor,
        onward: { id: record.onward.id, type: record.onward.type, status: record.onward.status },
      };
    default:
      return null;
  }
}

/**
 * Routing and status events merged with the partner's activity, oldest
 * first (an event and the activity it caused share a time; the event comes
 * first). The status event of an acknowledgement that has an activity row is
 * replaced by that row, so it appears once, with who did it.
 */
export function toPartnerTimeline(records: PartnerTimelineRecord[], activity: PartnerActivityRecord[] = []): PartnerTimelineItem[] {
  const acknowledgedByActivity = activity.some(record => record.kind === 'acknowledged');
  const events: PartnerTimelineItem[] = records
    .filter(record => !(acknowledgedByActivity && record.eventType === 'status_change' && record.partnerStatus === 'acknowledged'))
    .map(record => ({
      event: record.eventType === 'partner_routed' ? 'received' : 'status_change',
      status: record.partnerStatus,
      at: iso(record.createdAt),
    }));
  const merged = [
    ...events,
    ...activity.map(toActivityItem).filter((item): item is PartnerTimelineItem => item !== null),
  ];
  // Stable: equal times keep events before activity.
  return merged
    .map((item, index) => ({ item, index, time: Date.parse(item.at) }))
    .sort((a, b) => a.time - b.time || a.index - b.index)
    .map(entry => entry.item);
}

export function toPartnerOnwardView(record: PartnerOnwardRecord): PartnerOnwardView {
  return {
    id: record.id,
    type: record.type,
    organisation: record.organisation,
    contactRole: record.contactRole,
    externalReference: record.externalReference,
    note: record.note,
    status: record.status,
    createdAt: iso(record.createdAt),
    createdBy: { id: record.createdBy.id, name: record.createdBy.name },
    statusChangedAt: iso(record.statusChangedAt),
    allowedTransitions: PARTNER_ONWARD_TRANSITIONS[record.status],
  };
}

export function toPartnerStaffView(record: PartnerStaffRecord): PartnerStaffView {
  return { id: record.id, name: record.name, role: record.role };
}

export function toPartnerNoteView(note: PartnerNoteRecord): PartnerNoteView {
  return {
    id: note.id,
    body: note.body,
    createdAt: iso(note.createdAt),
    author: { id: note.authorUserId, displayName: note.authorDisplayName },
  };
}
