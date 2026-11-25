import { describe, expect, it, vi } from 'vitest';
import { demoEscalationWorkflow, demoReferralWorkflow } from '../../jobs/partnerDemoCases.js';
import { buildPartnerSafetyMap, sharedSafetyMapArea } from '../partnerSafetyMap.js';
import type { PartnerSafetyMapRecord } from '../../repositories/partnerSafetyMapRepository.js';
vi.mock('../../config/env.js', () => ({ env: { databaseUrl: 'postgres://unused.invalid/none' } }));

function summary(location: string) {
  const workflow = demoEscalationWorkflow('2026-10-22T07:00:00.000Z', 'urgent');
  (workflow.submission as { packet: { content: { location: string } } }).packet.content.location = location;
  return { workflow };
}
describe('staff safety map from shared case view', () => {
  it('uses only one explicitly named supported area and never returns a coordinate or location text', () => {
    expect(sharedSafetyMapArea(summary('Likoni | public_transport | Coordinates: -4.0435, 39.6682'))).toBe('likoni');
    expect(sharedSafetyMapArea(summary('CHANGAMWE'))).toBe('changamwe');
    for (const location of ['Between Likoni and Changamwe', 'Location withheld', 'Coordinates: -4.0435, 39.6682', 'Matatu stage', 'Near Likonia']) expect(sharedSafetyMapArea(summary(location))).toBeNull();
    expect(sharedSafetyMapArea({ workflow: demoReferralWorkflow() })).toBeNull();
    expect(sharedSafetyMapArea({ workflow: { content: { location: 'Likoni' } } })).toBeNull();
  });
  it('counts current statuses separately from geographic coverage without inventing unmapped dots', () => {
    const records: PartnerSafetyMapRecord[] = [
      { pathway: 'escalate', status: 'new', summary: summary('Likoni') },
      { pathway: 'escalate', status: 'acknowledged', summary: summary('Likoni') },
      { pathway: 'referral', status: 'in_progress', summary: summary('Changamwe') },
      { pathway: 'referral', status: 'closed', summary: { workflow: demoReferralWorkflow() } },
      { pathway: 'escalate', status: 'referred_onward', summary: summary('Unknown area') },
    ];
    const map = buildPartnerSafetyMap(records, { days: 30, limit: 200, truncated: false, now: new Date('2026-10-22T08:00:00Z') });
    expect(map.totals).toEqual({ total: 5, open: 4, needsAttention: 1, inProgress: 2, closed: 1 });
    expect(map).toMatchObject({ generatedAt: '2026-10-22T08:00:00.000Z', mapped: 3, unmapped: 2, truncated: false });
    expect(map.areas.find(area => area.id === 'likoni')?.counts).toEqual({ total: 2, open: 2, needsAttention: 1, inProgress: 0, closed: 0 });
    expect(JSON.stringify(map)).not.toMatch(/Coordinates|39\.6682|Unknown area|workflow|owner_id|case_id/);
  });
  it('preserves honest empty and truncated states', () => {
    const empty = buildPartnerSafetyMap([], { days: 7, limit: 200, truncated: true });
    expect(empty.truncated).toBe(true);
    expect(empty.totals.total).toBe(0);
    expect(empty.areas).toHaveLength(6);
  });
});
