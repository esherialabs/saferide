import { describe, expect, it } from 'vitest';

import type { CaseAttachment } from '../../services/caseService';
import type { DraftData } from '../draftStorage';
import { buildCaseDetailSource, describeStatusChange, normalizeCaseSummaryPayload } from '../caseDetailDisplay';
import { buildHuriaPacket } from '../huriaPacket';

function buildDraft(overrides: Partial<DraftData> = {}): DraftData {
  return {
    id: 'draft-1',
    createdAt: new Date('2026-06-05T08:00:00.000Z'),
    updatedAt: new Date('2026-06-05T08:15:00.000Z'),
    status: 'submitted',
    incidentDescription: 'Local narrative that was not sent.',
    textEvidence: 'Local notes that must stay local.',
    selectedTags: ['local-tag'],
    acceptedSuggestions: ['local-suggestion'],
    patterns: ['local-pattern'],
    selectedPathway: 'anonymous-map',
    location: { description: 'Local location fallback' },
    mediaFiles: [
      {
        id: 'media-1',
        type: 'photo',
        uri: 'file:///photo.jpg',
        fileName: 'photo.jpg',
        size: 1024,
        timestamp: new Date('2026-06-05T08:10:00.000Z'),
      },
    ],
    ...overrides,
  };
}

const remoteAttachment: CaseAttachment = {
  id: 'attachment-1',
  mimeType: 'image/jpeg',
  sizeBytes: 1024,
  createdAt: new Date('2026-06-05T09:00:00.000Z'),
};

describe('case detail display source', () => {
  it('reads a reviewed referral packet without changing the support pathway into escalation', () => {
    const packet = buildHuriaPacket(buildDraft({ includeBrief: true }), { generatedAt: '2026-10-22T08:00:00.000Z', pathway: 'referral' });
    const summary = normalizeCaseSummaryPayload({ schemaVersion: '1.0', workflow: {
      workflowType: 'referral', providerId: 'ke-coast-huria', channel: 'call', supportBrief: { included: true },
      partnerPacket: { consentVersion: 'partner-follow-up.ke-coast-huria.v3', packet },
    } });
    expect(summary).toMatchObject({ pathway: 'referral', selectedProvider: 'ke-coast-huria', selectedChannel: 'call', incidentDescription: 'Local narrative that was not sent.' });
  });
  it('prevents anonymous-map records from falling back to local narrative or evidence', () => {
    const source = buildCaseDetailSource({
      casePathway: 'anonymous-map',
      localDraft: buildDraft(),
      attachments: [remoteAttachment],
      summary: {
        pathway: 'anonymous-map',
        mediaCount: 9,
        anonymousMapSignal: {
          location: { description: 'Remote signal location' },
          locationPrecision: 'saved_description_or_address',
          datetime: { date: '2026-06-05', time: '08:05', accuracy: 'approximate' },
          duration: 'under_5_min',
          isOngoing: true,
          categories: ['harassment', 'public_transport', 'harassment'],
        },
      },
    });

    expect(source.isAnonymousMapRecord).toBe(true);
    expect(source.localDraftFallbackAllowed).toBe(false);
    expect(source.mediaCount).toBe(0);
    expect(source.localMediaFiles).toEqual([]);
    expect(source.showAttachmentSyncNotice).toBe(false);
    expect(source.summaryLocation).toEqual({ description: 'Remote signal location' });
    expect(source.summaryDatetime).toEqual({ date: '2026-06-05', time: '08:05', accuracy: 'approximate' });
    expect(source.anonymousMapCategories).toEqual(['harassment', 'public_transport']);
  });

  it('keeps local fallbacks for ordinary remote records when summary fields are absent', () => {
    const draft = buildDraft({ selectedPathway: 'referral' });
    const source = buildCaseDetailSource({
      casePathway: 'referral',
      localDraft: draft,
      attachments: [],
      summary: { pathway: 'referral' },
    });

    expect(source.isAnonymousMapRecord).toBe(false);
    expect(source.localDraftFallbackAllowed).toBe(true);
    expect(source.mediaCount).toBe(1);
    expect(source.localMediaFiles).toEqual(draft.mediaFiles);
    expect(source.showAttachmentSyncNotice).toBe(true);
    expect(source.summaryLocation).toBeNull();
  });

  it('normalizes the minimized referral envelope without inventing narrative or exact location', () => {
    const summary = normalizeCaseSummaryPayload({
      schemaVersion: '1.0',
      pathwayConsent: { purpose: 'pathway_submission', version: 'pathway-consent.v1' },
      workflow: {
        schemaVersion: '1.0', workflowType: 'referral', providerId: 'provider-1', channel: 'call',
        supportBrief: {
          included: true, selectedFields: ['incident_categories', 'time_context', 'location_type'],
          incidentCategories: ['harassment'], timeContext: { date: '2026-07-30', accuracy: 'approximate' },
          locationType: 'public_transport',
        },
      },
    });
    expect(summary).toMatchObject({
      pathway: 'referral', selectedProvider: 'provider-1', selectedChannel: 'call',
      supportBriefIncluded: true, tags: ['harassment'], location: { type: 'public_transport' }, mediaCount: 0,
    });
    expect(summary).not.toHaveProperty('incidentDescription');
    expect(summary.location).not.toHaveProperty('coordinates');
  });
});

describe('describeStatusChange', () => {
  it('labels a partner status event from new_status', () => {
    const payload = { schemaVersion: 1, new_status: 'in_review', actor: 'partner', partner: 'org', partner_status: 'in_progress' };
    expect(describeStatusChange(payload, 'submitted')).toEqual({ label: 'In review', body: 'Status updated to In review.' });
  });

  it('labels every status the partner path can set', () => {
    const labels = ['in_review', 'referred', 'closed'].map(status => describeStatusChange({ new_status: status }, null).label);
    expect(labels).toEqual(['In review', 'Referred', 'Closed']);
  });

  it('falls back to the case status when the payload has no usable new_status', () => {
    expect(describeStatusChange(null, 'closed').label).toBe('Closed');
    expect(describeStatusChange({ new_status: 42 }, 'referred').label).toBe('Referred');
    expect(describeStatusChange({}, undefined).label).toBe('Unknown');
  });

  it('never surfaces other payload fields', () => {
    const { body } = describeStatusChange({ new_status: 'closed', note: 'internal note', partner: 'Secret Org' }, null);
    expect(body).not.toMatch(/internal note|Secret Org/);
  });
});
