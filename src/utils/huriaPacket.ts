import type { DraftData } from './draftStorage';
import { buildEscalationPacket, type EscalationPacket } from './escalationPacket';
import { shouldIncludeDraftBriefDetails } from './referralSupport';

/** Same reviewed packet for support and urgent escalation; exact map coordinates never leave in it. */
export function buildHuriaPacket(draft: DraftData, options: { generatedAt?: string; pathway: 'referral' | 'escalate' }): EscalationPacket {
  const packet = buildEscalationPacket({ ...draft, location: draft.location ? { ...draft.location, coordinates: undefined } : undefined }, options);
  if (options.pathway === 'referral' && !shouldIncludeDraftBriefDetails('referral', draft)) {
    return { ...packet, contact: { preference: 'none', label: 'No contact details included in this packet' },
      content: { timeRange: 'Not shared', location: 'Not shared', incidentDescription: 'Details not shared', statement: 'Details not shared', tags: [], patterns: [], transportIdentifiers: [] },
      evidenceManifest: [], redaction: { ...packet.redaction, appliedLabels: ['Support details were not selected for sharing'], textFields: ['all report details'] } };
  }
  return packet;
}
