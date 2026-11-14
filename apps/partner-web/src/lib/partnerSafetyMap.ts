export type SafetyMapCounts = { total: number; open: number; needsAttention: number; inProgress: number; closed: number };
export type SafetyMapAreaId = 'changamwe' | 'jomvu' | 'kisauni' | 'likoni' | 'mvita' | 'nyali';
export type PartnerSafetyMap = {
  generatedAt: string; windowDays: number; caseLimit: number; truncated: boolean;
  totals: SafetyMapCounts; mapped: number; unmapped: number;
  areas: Array<{ id: SafetyMapAreaId; name: string; counts: SafetyMapCounts }>;
};
export type SafetyMapWindow = 7 | 30 | 90;
const IDS = ['changamwe', 'jomvu', 'kisauni', 'likoni', 'mvita', 'nyali'];
function counts(value: unknown): value is SafetyMapCounts {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return ['total', 'open', 'needsAttention', 'inProgress', 'closed'].every(key => typeof row[key] === 'number' && Number.isSafeInteger(row[key]) && Number(row[key]) >= 0)
    && Number(row.open) + Number(row.closed) === row.total && Number(row.needsAttention) <= Number(row.open) && Number(row.inProgress) <= Number(row.open);
}
/** A malformed response must never become a reassuring zero-case map. */
export function validatePartnerSafetyMap(value: unknown): PartnerSafetyMap {
  if (!value || typeof value !== 'object') throw new Error('Map unavailable');
  const row = value as PartnerSafetyMap;
  if (!Number.isFinite(Date.parse(row.generatedAt)) || ![7, 30, 90].includes(row.windowDays) || !Number.isSafeInteger(row.caseLimit) || row.caseLimit < 1
    || typeof row.truncated !== 'boolean' || !counts(row.totals) || !Number.isSafeInteger(row.mapped) || row.mapped < 0 || !Number.isSafeInteger(row.unmapped) || row.unmapped < 0
    || row.mapped + row.unmapped !== row.totals.total || row.totals.total > row.caseLimit || !Array.isArray(row.areas) || row.areas.length !== IDS.length
    || new Set(row.areas.map(area => area.id)).size !== IDS.length
    || row.areas.some(area => !IDS.includes(area.id) || typeof area.name !== 'string' || area.name.toLowerCase() !== area.id || !counts(area.counts))
    || row.areas.reduce((sum, area) => sum + area.counts.total, 0) !== row.mapped) throw new Error('Map unavailable');
  return row;
}

/** Root's shared API client owns auth/session callbacks and request deadlines.
 * The adapter fails explicitly when the required method has not been wired.
 */
export async function readPartnerSafetyMap(client: unknown, days: SafetyMapWindow, background = false): Promise<PartnerSafetyMap> {
  const candidate = client as { safetyMap?: (days: SafetyMapWindow, options: { background: boolean }) => Promise<unknown> };
  if (typeof candidate?.safetyMap !== 'function') throw new Error('Map unavailable');
  return validatePartnerSafetyMap(await candidate.safetyMap(days, { background }));
}
