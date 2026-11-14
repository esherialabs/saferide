import { describe, expect, it } from 'vitest';
import type { DraftData } from '../draftStorage';
import { buildHuriaPacket } from '../huriaPacket';

const draft: DraftData = {
  id: 'synthetic-packet', createdAt: new Date('2026-10-22T08:00:00Z'), updatedAt: new Date('2026-10-22T08:00:00Z'),
  incidentDescription: 'Synthetic incident description', textEvidence: 'Synthetic statement',
  includeBrief: true, location: { type: 'bus_stop', description: 'Likoni', coordinates: { latitude: -4.08, longitude: 39.66 } },
  escalationData: { redactionLevel: 'light', contactPreference: 'none' },
};
const generatedAt = '2026-10-22T08:00:00.000Z';
describe('common HURIA packet', () => {
  it('builds the identical minimized content for support and escalation', () => {
    const referral = buildHuriaPacket(draft, { generatedAt, pathway: 'referral' });
    expect(referral).toEqual(buildHuriaPacket(draft, { generatedAt, pathway: 'escalate' }));
    expect(referral.content.location).toContain('Likoni');
    expect(JSON.stringify(referral)).not.toContain('-4.08');
    expect(JSON.stringify(referral)).not.toContain('39.66');
  });
  it('retains the referral no-details choice without leaking narrative, alias or evidence text', () => {
    const packet = buildHuriaPacket({ ...draft, includeBrief: false }, { generatedAt, pathway: 'referral' });
    expect(packet.content).toMatchObject({ statement: 'Details not shared', location: 'Not shared', tags: [] });
    expect(packet.evidenceManifest).toEqual([]);
    expect(JSON.stringify(packet)).not.toContain('Synthetic incident');
    expect(JSON.stringify(packet)).not.toContain('Likoni');
  });
});
