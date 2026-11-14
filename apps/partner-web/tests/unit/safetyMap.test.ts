import assert from 'node:assert/strict';
import { it } from 'node:test';
import { MOMBASA_BOUNDARIES } from '../../src/lib/mombasaMapBoundaries.ts';
import { readPartnerSafetyMap, validatePartnerSafetyMap } from '../../src/lib/partnerSafetyMap.ts';
const zero = { total: 0, open: 0, needsAttention: 0, inProgress: 0, closed: 0 };
function valid() { return { generatedAt: '2026-10-22T08:00:00Z', windowDays: 30, caseLimit: 200, truncated: false, totals: { ...zero }, mapped: 0, unmapped: 0,
  areas: MOMBASA_BOUNDARIES.map(area => ({ id: area.id, name: area.name, counts: { ...zero } })) }; }
it('map data validator rejects false zero maps and inconsistent coverage', () => {
  assert.deepEqual(validatePartnerSafetyMap(valid()), valid());
  for (const value of [{}, { ...valid(), totals: { ...zero, total: -1 } }, { ...valid(), mapped: 1 }, { ...valid(), generatedAt: 'not-a-date' }, { ...valid(), areas: [] }]) assert.throws(() => validatePartnerSafetyMap(value));
});
it('uses the shared authenticated client and leaves polling in the background', async () => {
  let observed: unknown[] = [];
  const client = { safetyMap: async (...args: unknown[]) => { observed = args; return valid(); } };
  await readPartnerSafetyMap(client, 30, true);
  assert.deepEqual(observed, [30, { background: true }]);
  await assert.rejects(readPartnerSafetyMap({}, 30), /unavailable/);
});
it('six real boundary paths are self-hosted and contain no external map URLs', () => {
  assert.equal(MOMBASA_BOUNDARIES.length, 6);
  for (const area of MOMBASA_BOUNDARIES) { assert.match(area.path, /^M/); assert.match(area.path, /Z$/); assert.doesNotMatch(area.path, /https|script|style/i); }
});
