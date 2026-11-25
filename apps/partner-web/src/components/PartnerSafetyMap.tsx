import { MOMBASA_BOUNDARIES } from '../lib/mombasaMapBoundaries.ts';
import type { PartnerSafetyMap as MapData } from '../lib/partnerSafetyMap.ts';
import { mapText } from '../lib/safetyMapI18n.ts';

/** Geography is static and self-hosted; only organisation-scoped aggregate counts vary. */
export function PartnerSafetyMap({ data }: { data: MapData }) {
  return <figure className="rounded-card border border-line bg-surface p-4" aria-labelledby="safety-map-caption">
    <svg viewBox="0 0 640 560" role="img" aria-labelledby="safety-map-title safety-map-description" className="mx-auto max-h-[32rem] w-full">
      <title id="safety-map-title">{mapText('mapTitle')}</title>
      <desc id="safety-map-description">{data.areas.map(area => `${area.name}: ${area.counts.total} shared, ${area.counts.needsAttention} need attention`).join('. ')}. {mapText('limitations')}</desc>
      {MOMBASA_BOUNDARIES.map(boundary => {
        const area = data.areas.find(item => item.id === boundary.id)!;
        return <path key={boundary.id} d={boundary.path} fillRule="evenodd" className={`stroke-line-strong ${area.counts.needsAttention > 0 ? 'fill-orange-bg' : area.counts.total > 0 ? 'fill-info-bg' : 'fill-surface-2'}`} strokeWidth="2">
          <title>{`${area.name}: ${area.counts.total} shared, ${area.counts.needsAttention} need attention`}</title>
        </path>;
      })}
      {MOMBASA_BOUNDARIES.map(boundary => <text key={`label-${boundary.id}`} x={boundary.labelX} y={boundary.labelY} textAnchor="middle" className="fill-ink text-xs font-semibold" aria-hidden="true">{boundary.name}</text>)}
      <path d="M590 80V40m-10 15 10-15 10 15" className="fill-none stroke-ink" strokeWidth="2" />
      <text x="590" y="30" textAnchor="middle" className="fill-ink text-sm">N</text>
    </svg>
    <figcaption id="safety-map-caption" className="space-y-3 text-sm text-ink-3">
      <ul className="flex flex-wrap gap-4" aria-label="Map legend">
        <li className="inline-flex items-center gap-2"><span className="h-4 w-4 rounded border border-line-strong bg-surface-2" aria-hidden="true" />{mapText('noCases')}</li>
        <li className="inline-flex items-center gap-2"><span className="h-4 w-4 rounded border border-line-strong bg-info-bg" aria-hidden="true" />{mapText('hasCases')}</li>
        <li className="inline-flex items-center gap-2"><span className="h-4 w-4 rounded border border-line-strong bg-orange-bg" aria-hidden="true" />{mapText('urgentCases')}</li>
      </ul>
      <p>{mapText('source')}</p>
    </figcaption>
  </figure>;
}
