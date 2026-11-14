/** Scoped dictionary; the existing dashboard currently ships English. */
const en = {
  title: 'Safety map', subtitle: 'HURIA shared cases · Mombasa broad areas',
  scope: 'Only cases currently shared with your organisation are counted. Areas come from the location text in the survivor-reviewed packet; locations are self-reported and are not independently verified.',
  limitations: 'This is a case coverage map, not a measure of area safety or risk. No report does not mean an area is safe. It excludes reports saved only on a phone and anonymous signals that have not been uploaded. No individual incident pins or exact locations are shown.',
  unmapped: 'Cases without one explicit supported area remain unmapped, including missing or withheld locations, older referral briefs and locations naming several areas.',
  window: 'Received within', days7: '7 days', days30: '30 days', days90: '90 days', refresh: 'Refresh map', refreshing: 'Refreshing…',
  updated: 'Last successful update', total: 'Shared cases', mapped: 'Mapped to a broad area', unknown: 'Unmapped',
  area: 'Broad area', open: 'Open', attention: 'Needs attention', progress: 'In progress or referred onward', closed: 'Closed',
  empty: 'No currently shared cases were received in this window. This does not establish that no incidents occurred.',
  noneMapped: 'No cases in this window have a single supported broad area in the shared packet. Counts remain available in the table and case queue.',
  error: 'The current map is unavailable. Previous counts are hidden because sharing or case status may have changed. Check your connection and refresh.',
  limited: 'Only the newest 200 currently shared cases in this window are included. Shorten the window for a more complete view.',
  cases: 'Review case queue', mapTitle: 'Mombasa broad-area case coverage',
  noCases: 'No mapped cases', hasCases: 'Shared cases present', urgentCases: 'New escalation needs attention',
  source: 'Boundaries: geoBoundaries KEN-ADM2-3690345, IEBC / OCHA ROSEA, 2020. CC BY 3.0 IGO. Six simplified Mombasa subcounty features, projected locally. Historical boundaries are for orientation, not a current jurisdiction decision.',
  live: 'Refreshes at least every minute while this tab is visible or live coverage is active, subject to browser and network availability.',
} as const;
export function mapText(key: keyof typeof en): string { return en[key]; }
