import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Layout } from '../components/Layout.tsx';
import { RequireSession } from '../components/RequireSession.tsx';
import { PartnerSafetyMap } from '../components/PartnerSafetyMap.tsx';
import { Notice, PageHeading } from '../components/ui.tsx';
import { api, store, useAppState } from '../lib/app.ts';
import { csrfTokenOf } from '../lib/store.ts';
import { formatDateTime } from '../lib/i18n.ts';
import { readPartnerSafetyMap, type PartnerSafetyMap as MapData, type SafetyMapWindow } from '../lib/partnerSafetyMap.ts';
import { mapText } from '../lib/safetyMapI18n.ts';

function MapContent() {
  const auth = useAppState(state => state.auth);
  const session = auth.status === 'signed_in' ? auth.csrfToken : null;
  const [days, setDays] = useState<SafetyMapWindow>(30);
  const [data, setData] = useState<MapData | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const pending = useRef(false);
  const version = useRef(0);
  const lastAttempt = useRef(0);
  const refresh = useCallback(async (background = false) => {
    if (!session || pending.current) return;
    const currentVersion = version.current;
    pending.current = true; lastAttempt.current = Date.now(); setLoading(true);
    try {
      const next = await readPartnerSafetyMap(api, days, background);
      if (version.current === currentVersion && csrfTokenOf(store.get()) === session) { setData(next); setError(false); }
    } catch {
      if (version.current === currentVersion && csrfTokenOf(store.get()) === session) { setData(null); setError(true); }
    } finally { if (version.current === currentVersion) { pending.current = false; setLoading(false); } }
  }, [session, days]);
  useEffect(() => {
    version.current++; pending.current = false; setData(null); setError(false);
    void refresh();
    const poll = () => {
      const current = store.get().auth;
      if ((document.visibilityState === 'visible' || (current.status === 'signed_in' && current.clock.coverageActive)) && Date.now() - lastAttempt.current >= 60_000) void refresh(true);
    };
    const timer = window.setInterval(poll, 5_000);
    document.addEventListener('visibilitychange', poll);
    return () => { version.current++; window.clearInterval(timer); document.removeEventListener('visibilitychange', poll); };
  }, [refresh]);
  return <div className="space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><PageHeading>{mapText('title')}</PageHeading><p className="mt-2 text-ink-3">{mapText('subtitle')}</p></div><Link className="btn-secondary" href="/cases/">{mapText('cases')}</Link></div>
    <p className="max-w-prose text-ink-2">{mapText('scope')}</p>
    <div className="flex flex-wrap items-end gap-4">
      <div><label className="label" htmlFor="map-window">{mapText('window')}</label><select className="input" id="map-window" value={days} onChange={event => setDays(Number(event.target.value) as SafetyMapWindow)}>{([7, 30, 90] as const).map(day => <option key={day} value={day}>{mapText(`days${day}`)}</option>)}</select></div>
      <button className="btn-secondary" type="button" disabled={loading} onClick={() => void refresh()}>{mapText(loading ? 'refreshing' : 'refresh')}</button>
    </div>
    <p className="text-sm text-ink-3">{mapText('live')}</p>
    {error ? <Notice tone="error" live="polite">{mapText('error')}</Notice> : null}
    {data ? <>
      <p className="text-sm text-ink-3" role="status">{mapText('updated')}: {formatDateTime(data.generatedAt)}</p>
      {data.truncated ? <Notice tone="warning">{mapText('limited')}</Notice> : null}
      <dl className="grid gap-4 sm:grid-cols-3">{([['total', data.totals.total], ['mapped', data.mapped], ['unknown', data.unmapped]] as const).map(([key, value]) => <div key={key} className="rounded-card border border-line bg-surface p-4"><dt className="text-sm text-ink-3">{mapText(key)}</dt><dd className="mt-2 text-3xl font-semibold">{value}</dd></div>)}</dl>
      {data.totals.total === 0 ? <Notice>{mapText('empty')}</Notice> : data.mapped === 0 ? <Notice>{mapText('noneMapped')}</Notice> : null}
      <PartnerSafetyMap data={data} />
      <div className="overflow-x-auto rounded-card border border-line"><table className="w-full text-left text-sm"><caption className="sr-only">{mapText('mapTitle')}</caption><thead><tr>{(['area', 'total', 'open', 'attention', 'progress', 'closed'] as const).map(key => <th className="px-3 py-3" scope="col" key={key}>{mapText(key)}</th>)}</tr></thead><tbody>{data.areas.map(area => <tr className="border-t border-line" key={area.id}><th className="px-3 py-3" scope="row">{area.name}</th>{(['total', 'open', 'needsAttention', 'inProgress', 'closed'] as const).map(key => <td className="px-3 py-3" key={key}>{area.counts[key]}</td>)}</tr>)}</tbody></table></div>
    </> : null}
    <Notice><p>{mapText('limitations')}</p><p className="mt-2">{mapText('unmapped')}</p></Notice>
  </div>;
}
export default function SafetyMapPage() { return <Layout title={mapText('title')} section="safety-map"><RequireSession><MapContent /></RequireSession></Layout>; }
