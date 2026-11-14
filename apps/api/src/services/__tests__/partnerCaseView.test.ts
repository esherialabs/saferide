import { describe, expect, it } from 'vitest';

import type { AttachmentRow } from '../../repositories/caseRepository.js';
import type { PartnerReferralRecord } from '../../repositories/partnerCaseRepository.js';
import {
  buildPartnerCaseView,
  toPartnerAttachmentView,
  toPartnerOnwardView,
  toPartnerQueueItem,
  toPartnerReferralSummary,
  toPartnerReferralTombstone,
  toPartnerTimeline,
} from '../partnerCaseView.js';

// Synthetic identifiers that must never reach a partner.
const OWNER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CASE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PATHWAY_CONSENT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FOLLOW_UP_CONSENT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CHECKSUM = 'e'.repeat(64);
const DEVICE_FILE_ID = 'file:///data/user/0/synthetic/evidence-1.jpg';
const STORAGE_KEY = 'evidence/2026/10/synthetic-object-key';
const FORBIDDEN = [OWNER_ID, CASE_ID, PATHWAY_CONSENT_ID, FOLLOW_UP_CONSENT_ID, CHECKSUM, DEVICE_FILE_ID, STORAGE_KEY, 'synthetic-draft', 'idempotency'];

const escalationSummary = {
  schemaVersion: '1.0',
  pathwayConsent: { recordId: PATHWAY_CONSENT_ID, purpose: 'pathway_submission', version: 'pathway-consent.v1' },
  partnerRouting: { partnerStableId: 'ke-coast-huria', consentRecordId: FOLLOW_UP_CONSENT_ID, callbackConsentRecordId: null },
  workflow: {
    schemaVersion: '1.0', workflowType: 'submitted-case', pathway: 'escalation',
    submission: {
      schemaVersion: '1.0', workflowType: 'escalation',
      packet: {
        version: '1.0', generatedAt: '2026-10-21T08:00:00.000Z', pathway: 'escalate', redactionLevel: 'light',
        contact: { preference: 'alias', alias: 'Synthetic alias', label: 'Alias: Synthetic alias' },
        content: {
          timeRange: 'Evening, 20 Oct', location: 'Synthetic stage, Mombasa', incidentDescription: 'Synthetic description',
          statement: 'Synthetic statement', impactSummary: 'Synthetic impact', tags: ['harassment'], patterns: [],
          transportIdentifiers: ['KXX 000X'],
        },
        evidenceManifest: [{
          id: DEVICE_FILE_ID, type: 'photo', label: 'Photo 1', sizeBytes: 1024, checksum: CHECKSUM,
          metadataStatus: 'File name and checksum withheld from packet metadata', privacyRequests: [],
        }],
        redaction: { appliedLabels: ['names'], textFields: ['statement'], evidenceMetadata: 'redacted', mediaProcessing: [] },
      },
    },
  },
};

function record(overrides: Partial<PartnerReferralRecord> = {}): PartnerReferralRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    reference: 'SR-7K3Q-9M2D',
    status: 'acknowledged',
    closureReason: null,
    pathway: 'escalation',
    receivedAt: new Date('2026-10-21T08:00:01.000Z'),
    statusChangedAt: new Date('2026-10-21T09:00:00.000Z'),
    revokedAt: null,
    callbackShared: true,
    assignee: null,
    summary: escalationSummary,
    caseId: CASE_ID,
    ownerId: OWNER_ID,
    ...overrides,
  };
}

function expectNoLeaks(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const forbidden of FORBIDDEN) expect(serialized).not.toContain(forbidden);
}

describe('partner case view', () => {
  it('uses the same safe packet renderer for a v3 HURIA referral and escalation', () => {
    const summary = { workflow: { schemaVersion: '1.0', workflowType: 'referral', providerId: 'ke-coast-huria', channel: 'partner_dashboard',
      supportBrief: { included: false, selectedFields: [] }, partnerPacket: {
        consentVersion: 'partner-follow-up.ke-coast-huria.v3', packet: escalationSummary.workflow.submission.packet,
      } } };
    expect(buildPartnerCaseView(summary)).toEqual(buildPartnerCaseView(escalationSummary));
    expectNoLeaks(buildPartnerCaseView(summary));
    expect(buildPartnerCaseView({ workflow: { ...summary.workflow, partnerPacket: undefined } })).toEqual({ kind: 'unavailable' });
  });
  it('shows the escalation packet at its redaction level without device ids, checksums or account ids', () => {
    const view = buildPartnerCaseView(escalationSummary);
    expect(view).toMatchObject({
      kind: 'escalation',
      redactionLevel: 'light',
      contact: { preference: 'alias', alias: 'Synthetic alias' },
      content: { statement: 'Synthetic statement', transportIdentifiers: ['KXX 000X'] },
      evidenceManifest: [{ type: 'photo', label: 'Photo 1', sizeBytes: 1024 }],
    });
    expect(view).toEqual({
      kind: 'escalation',
      generatedAt: '2026-10-21T08:00:00.000Z',
      redactionLevel: 'light',
      contact: { preference: 'alias', alias: 'Synthetic alias', label: 'Alias: Synthetic alias' },
      content: {
        timeRange: 'Evening, 20 Oct', location: 'Synthetic stage, Mombasa', incidentDescription: 'Synthetic description',
        statement: 'Synthetic statement', impactSummary: 'Synthetic impact', tags: ['harassment'], patterns: [],
        transportIdentifiers: ['KXX 000X'],
      },
      evidenceManifest: [{
        type: 'photo', label: 'Photo 1', sizeBytes: 1024,
        metadataStatus: 'File name and checksum withheld from packet metadata', privacyRequests: [],
      }],
      redaction: { appliedLabels: ['names'], textFields: ['statement'], evidenceMetadata: 'redacted', mediaProcessing: [] },
    });
    expectNoLeaks(view);
  });

  it('never passes coordinates from a none/light packet, in the location or anywhere else', () => {
    const summary = structuredClone(escalationSummary);
    summary.workflow.submission.packet.redactionLevel = 'none';
    summary.workflow.submission.packet.content.location = 'Synthetic stage near the market | Moi Avenue | public_transport | Coordinates: -4.0435, 39.6682';
    summary.workflow.submission.packet.content.statement = 'He waited at -4.043512, 39.668234 again';
    summary.workflow.submission.packet.evidenceManifest[0].description = 'Taken at geo:-4.0435,39.6682';
    const view = buildPartnerCaseView(summary);
    expect(view).toMatchObject({
      kind: 'escalation',
      content: { location: 'Synthetic stage near the market | Moi Avenue | public_transport', statement: 'He waited at [coordinates withheld] again' },
    });
    expect(JSON.stringify(view)).not.toMatch(/4\.04|39\.66|Coordinates/);
  });

  it('builds the view of a padded, schema-valid packet over 500 KB in well under 500 ms (review of #297)', () => {
    const pieces = [`lat${' '.repeat(60)}`, ','.repeat(60), '1.1111 ', '-4.0435 ', '4 deg ', 'S4.0435 E', 'www.', '///a.b.', 'Coordinates ', 'x'];
    const pad = (length: number, seed: number): string => {
      let out = '';
      for (let index = seed; out.length < length; index += 1) out += pieces[index % pieces.length];
      return out.slice(0, length);
    };
    const summary = structuredClone(escalationSummary);
    const packet = summary.workflow.submission.packet as Record<string, unknown>;
    packet.contact = { preference: 'alias', alias: pad(120, 1), label: pad(180, 2) };
    packet.content = {
      timeRange: pad(180, 3),
      location: `lat${' '.repeat(497)}`,
      incidentDescription: `lat${' '.repeat(7997)}`,
      statement: pad(8000, 4),
      impactSummary: ','.repeat(2000),
      witnessDetails: pad(2000, 5),
      tags: Array.from({ length: 30 }, (_, index) => pad(80, index)),
      patterns: Array.from({ length: 30 }, (_, index) => pad(80, index + 1)),
      transportIdentifiers: Array.from({ length: 10 }, (_, index) => pad(180, index)),
    };
    packet.evidenceManifest = Array.from({ length: 50 }, (_, index) => ({
      id: `synthetic-${index}`, type: 'photo', label: pad(180, index), sizeBytes: 10,
      description: pad(2000, index + 1), transcript: index % 2 ? pad(8000, index + 2) : `lat${' '.repeat(7997)}`,
      metadataStatus: 'synthetic', privacyRequests: [pad(180, index), pad(180, index + 1), pad(180, index + 2)],
    }));
    packet.redaction = {
      appliedLabels: Array.from({ length: 20 }, (_, index) => pad(180, index)),
      textFields: Array.from({ length: 20 }, (_, index) => pad(80, index)),
      evidenceMetadata: pad(180, 0),
      mediaProcessing: Array.from({ length: 10 }, (_, index) => pad(180, index)),
    };
    expect(JSON.stringify(summary).length).toBeGreaterThan(500_000);

    buildPartnerCaseView(summary);
    const started = performance.now();
    const view = buildPartnerCaseView(summary);
    const elapsed = performance.now() - started;
    expect(view.kind).toBe('escalation');
    expect(elapsed).toBeLessThan(500);
  });

  it('removes the E2E labelled pair from every free-text field of the packet', () => {
    for (const probe of ['X. Coordinates: -4.0435, 39.6682', 'X. Coordinates: -4.0435, 39.6682.', 'X. Coordinates: -4.04, 39.66.']) {
      const summary = structuredClone(escalationSummary);
      const packet = summary.workflow.submission.packet;
      packet.redactionLevel = 'none';
      packet.contact = { preference: 'alias', alias: probe, label: probe } as never;
      Object.assign(packet.content, {
        timeRange: probe, location: probe, incidentDescription: probe, statement: probe,
        impactSummary: probe, witnessDetails: probe, tags: [probe], patterns: [probe], transportIdentifiers: [probe],
      });
      Object.assign(packet.evidenceManifest[0], { label: probe, description: probe, transcript: probe });
      const view = buildPartnerCaseView(summary);
      expect(view.kind).toBe('escalation');
      expect(JSON.stringify(view), probe).not.toMatch(/4\.04|39\.66|-4,|, 39/);
    }
  });

  it('shows "no contact" when the survivor chose no alias', () => {
    const summary = structuredClone(escalationSummary);
    summary.workflow.submission.packet.contact = { preference: 'none', label: 'No contact identity included' } as never;
    expect(buildPartnerCaseView(summary)).toMatchObject({ contact: { preference: 'none', label: 'No contact identity included' } });
  });

  it('shows only the referral brief fields the survivor selected', () => {
    const view = buildPartnerCaseView({
      schemaVersion: '1.0',
      pathwayConsent: { recordId: PATHWAY_CONSENT_ID },
      workflow: {
        schemaVersion: '1.0', workflowType: 'referral', providerId: 'ke-coast-huria', channel: 'whatsapp',
        supportBrief: {
          included: true, selectedFields: ['incident_categories', 'ongoing_status'],
          incidentCategories: ['harassment'], isOngoing: true,
        },
      },
    });
    expect(view).toEqual({ kind: 'referral', channel: 'whatsapp', brief: { incidentCategories: ['harassment'], isOngoing: true } });
    expect(buildPartnerCaseView({
      workflow: {
        schemaVersion: '1.0', workflowType: 'referral', providerId: 'ke-coast-huria', channel: 'call',
        supportBrief: { included: false, selectedFields: [] },
      },
    })).toEqual({ kind: 'referral', channel: 'call', brief: null });
  });

  it('never passes through an unexpected stored shape', () => {
    expect(buildPartnerCaseView(null)).toEqual({ kind: 'unavailable' });
    expect(buildPartnerCaseView({ workflow: { workflowType: 'referral', narrative: 'synthetic free text' } })).toEqual({ kind: 'unavailable' });
  });

  it('summarises a referral with its allowed next steps and no account ids', () => {
    const summary = toPartnerReferralSummary(record());
    expect(summary).toEqual({
      id: '11111111-1111-4111-8111-111111111111', reference: 'SR-7K3Q-9M2D', pathway: 'escalation', status: 'acknowledged',
      closureReason: null, withdrawn: false, receivedAt: '2026-10-21T08:00:01.000Z', statusChangedAt: '2026-10-21T09:00:00.000Z',
      callbackShared: true, allowedTransitions: ['in_progress', 'closed'],
      priority: 'urgent', needsAttention: false, assignee: null,
    });
    expectNoLeaks(summary);
    expect(toPartnerReferralSummary(record({ status: 'new' }))).toMatchObject({ priority: 'urgent', needsAttention: true });
    expect(toPartnerReferralSummary(record({ status: 'new', pathway: 'referral' }))).toMatchObject({ priority: 'normal', needsAttention: false });
    expect(toPartnerReferralSummary(record({ assignee: { id: 'u1', name: 'Synthetic caseworker' } })).assignee)
      .toEqual({ id: 'u1', name: 'Synthetic caseworker' });
  });

  it('reduces withdrawn referrals to a tombstone in the queue and the detail', () => {
    const revokedAt = new Date('2026-10-21T10:00:00.000Z');
    expect(toPartnerQueueItem({
      id: 'r1', reference: 'SR-AAAA-BBBB', status: 'in_progress', pathway: 'escalation',
      receivedAt: new Date('2026-10-21T08:00:00.000Z'), statusChangedAt: new Date('2026-10-21T09:00:00.000Z'), revokedAt,
      assignee: null, onward: { count: 0, latest: null },
    })).toEqual({
      id: 'r1', reference: 'SR-AAAA-BBBB', pathway: null, status: 'withdrawn', withdrawn: true,
      receivedAt: '2026-10-21T08:00:00.000Z', statusChangedAt: '2026-10-21T10:00:00.000Z',
      priority: 'normal', needsAttention: false, assignee: null, onward: { count: 0, latest: null },
    });
    const tombstone = toPartnerReferralTombstone({ ...record({ revokedAt }), revokedAt });
    expect(tombstone).toEqual({
      id: '11111111-1111-4111-8111-111111111111', reference: 'SR-7K3Q-9M2D', status: 'withdrawn', withdrawn: true,
      receivedAt: '2026-10-21T08:00:01.000Z', withdrawnAt: '2026-10-21T10:00:00.000Z',
    });
  });

  it('lists evidence with a download flag and generic names, never the storage key or hashes', () => {
    const base = {
      id: 'att-1', owner_id: OWNER_ID, draft_id: null, case_id: CASE_ID, bucket: 'synthetic', bucket_path: STORAGE_KEY,
      mime_type: 'image/jpeg', size_bytes: 1024, sha256: CHECKSUM, expected_sha256: CHECKSUM, upload_manifest: {},
      retention: {}, retention_policy_id: 'submitted-case-pending-legal-v1', scan_evidence: { scanner: 'synthetic' },
      status: 'uploaded', metadata: { displayName: 'evidence-photo.jpg', mediaType: 'photo' }, created_at: '2026-10-21T08:05:00.000Z',
      updated_at: '2026-10-21T08:05:00.000Z',
    };
    const released = toPartnerAttachmentView({ ...base, antivirus_status: 'clean', quarantine_status: 'released' } as AttachmentRow, { downloadsEnabled: true });
    const pending = toPartnerAttachmentView({ ...base, antivirus_status: 'pending', quarantine_status: 'quarantined' } as AttachmentRow, { downloadsEnabled: true });
    expect(released).toEqual({
      id: 'att-1', mediaType: 'photo', displayName: 'evidence-photo.jpg', mimeType: 'image/jpeg', sizeBytes: 1024,
      receivedAt: '2026-10-21T08:05:00.000Z', download: { available: true },
    });
    expect(pending.download).toEqual({ available: false, reason: 'unscanned' });
    expectNoLeaks([released, pending]);

    // Default: downloads off, but type, size and a generic name still listed.
    const off = toPartnerAttachmentView({ ...base, antivirus_status: 'clean', quarantine_status: 'released' } as AttachmentRow, { downloadsEnabled: false });
    expect(off).toEqual({ ...released, download: { available: false, reason: 'evidence_not_shareable_yet' } });
  });

  it('turns routing and status events into a content-free timeline', () => {
    expect(toPartnerTimeline([
      { eventType: 'partner_routed', partnerStatus: 'new', createdAt: new Date('2026-10-21T08:00:01.000Z') },
      { eventType: 'status_change', partnerStatus: 'acknowledged', createdAt: new Date('2026-10-21T09:00:00.000Z') },
    ])).toEqual([
      { event: 'received', status: 'new', at: '2026-10-21T08:00:01.000Z' },
      { event: 'status_change', status: 'acknowledged', at: '2026-10-21T09:00:00.000Z' },
    ]);
  });

  it('merges who acted into the timeline, shows an acknowledgement once, and carries no free text', () => {
    const caseworker = { id: 'u1', name: 'Synthetic caseworker' };
    const admin = { id: 'u2', name: 'Synthetic admin' };
    const timeline = toPartnerTimeline([
      { eventType: 'partner_routed', partnerStatus: 'new', createdAt: new Date('2026-10-21T08:00:00.000Z') },
      { eventType: 'status_change', partnerStatus: 'acknowledged', createdAt: new Date('2026-10-21T09:00:00.000Z') },
      { eventType: 'status_change', partnerStatus: 'in_progress', createdAt: new Date('2026-10-21T10:00:00.000Z') },
    ], [
      { kind: 'acknowledged', createdAt: new Date('2026-10-21T09:00:00.000Z'), actor: caseworker, assignee: null, onward: null },
      { kind: 'assigned', createdAt: new Date('2026-10-21T09:30:00.000Z'), actor: admin, assignee: caseworker, onward: null },
      { kind: 'onward_created', createdAt: new Date('2026-10-21T10:00:00.000Z'), actor: caseworker, assignee: null,
        onward: { id: 'o1', type: 'police', status: 'made' } },
      { kind: 'onward_status', createdAt: new Date('2026-10-21T11:00:00.000Z'), actor: caseworker, assignee: null,
        onward: { id: 'o1', type: 'police', status: 'accepted' } },
      { kind: 'unassigned', createdAt: new Date('2026-10-21T12:00:00.000Z'), actor: admin, assignee: null, onward: null },
    ]);
    expect(timeline).toEqual([
      { event: 'received', status: 'new', at: '2026-10-21T08:00:00.000Z' },
      { event: 'acknowledged', status: 'acknowledged', at: '2026-10-21T09:00:00.000Z', actor: caseworker },
      { event: 'assigned', status: null, at: '2026-10-21T09:30:00.000Z', actor: admin, assignee: caseworker },
      // Same time: the status event first, then the activity.
      { event: 'status_change', status: 'in_progress', at: '2026-10-21T10:00:00.000Z' },
      { event: 'onward_created', status: null, at: '2026-10-21T10:00:00.000Z', actor: caseworker, onward: { id: 'o1', type: 'police', status: 'made' } },
      { event: 'onward_status', status: null, at: '2026-10-21T11:00:00.000Z', actor: caseworker, onward: { id: 'o1', type: 'police', status: 'accepted' } },
      { event: 'unassigned', status: null, at: '2026-10-21T12:00:00.000Z', actor: admin },
    ]);
  });

  it('shows partner-typed onward text as typed (it is not survivor content) with the moves still allowed', () => {
    const view = toPartnerOnwardView({
      id: 'o1', type: 'police', organisation: 'Synthetic Station, -4.0435, 39.6682', contactRole: 'Gender desk', externalReference: 'OB 1/2/2026',
      note: null, status: 'made', createdAt: new Date('2026-10-21T10:00:00.000Z'), createdBy: { id: 'u1', name: 'Synthetic caseworker' },
      statusChangedAt: new Date('2026-10-21T10:00:00.000Z'),
    });
    expect(view).toEqual({
      id: 'o1', type: 'police', organisation: 'Synthetic Station, -4.0435, 39.6682', contactRole: 'Gender desk', externalReference: 'OB 1/2/2026',
      note: null, status: 'made', createdAt: '2026-10-21T10:00:00.000Z', createdBy: { id: 'u1', name: 'Synthetic caseworker' },
      statusChangedAt: '2026-10-21T10:00:00.000Z', allowedTransitions: ['accepted', 'declined'],
    });
  });
});
