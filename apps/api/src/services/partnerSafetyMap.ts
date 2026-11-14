import type { PartnerSafetyMapRecord } from '../repositories/partnerSafetyMapRepository.js';
import { buildPartnerCaseView } from './partnerCaseView.js';

export const MOMBASA_MAP_AREAS = [
  { id: 'changamwe', name: 'Changamwe' }, { id: 'jomvu', name: 'Jomvu' },
  { id: 'kisauni', name: 'Kisauni' }, { id: 'likoni', name: 'Likoni' },
  { id: 'mvita', name: 'Mvita' }, { id: 'nyali', name: 'Nyali' },
] as const;
export type SafetyMapAreaId = typeof MOMBASA_MAP_AREAS[number]['id'];
export type SafetyMapCounts = { total: number; open: number; needsAttention: number; inProgress: number; closed: number };
export type PartnerSafetyMap = {
  generatedAt: string; windowDays: number; caseLimit: number; truncated: boolean;
  totals: SafetyMapCounts; mapped: number; unmapped: number;
  areas: Array<{ id: SafetyMapAreaId; name: string; counts: SafetyMapCounts }>;
};
function emptyCounts(): SafetyMapCounts { return { total: 0, open: 0, needsAttention: 0, inProgress: 0, closed: 0 }; }

/** Only explicitly named broad areas in the already-scrubbed location field.
 * Multiple named areas, legacy location types, missing and withheld locations
 * stay unmapped. We never geocode narratives or recover removed coordinates.
 */
export function sharedSafetyMapArea(summary: Record<string, unknown> | null): SafetyMapAreaId | null {
  const view = buildPartnerCaseView(summary);
  if (view.kind !== 'escalation') return null;
  const location = view.content.location;
  const matches = MOMBASA_MAP_AREAS.filter(area => new RegExp(`\\b${area.name}\\b`, 'i').test(location));
  return matches.length === 1 ? matches[0].id : null;
}
function count(target: SafetyMapCounts, record: PartnerSafetyMapRecord) {
  target.total++;
  if (record.status === 'closed') target.closed++;
  else target.open++;
  if (record.pathway === 'escalate' && record.status === 'new') target.needsAttention++;
  if (record.status === 'in_progress' || record.status === 'referred_onward') target.inProgress++;
}
export function buildPartnerSafetyMap(records: PartnerSafetyMapRecord[], options: { days: number; limit: number; truncated: boolean; now?: Date }): PartnerSafetyMap {
  const areas = MOMBASA_MAP_AREAS.map(area => ({ ...area, counts: emptyCounts() }));
  const totals = emptyCounts();
  let mapped = 0;
  for (const record of records) {
    count(totals, record);
    const area = areas.find(item => item.id === sharedSafetyMapArea(record.summary));
    if (area) { count(area.counts, record); mapped++; }
  }
  return { generatedAt: (options.now ?? new Date()).toISOString(), windowDays: options.days, caseLimit: options.limit,
    truncated: options.truncated, totals, mapped, unmapped: records.length - mapped, areas };
}
