import type { ReactNode } from 'react';

import { formatBytes, formatDate, formatDateTime, t, type MessageKey } from '../../lib/i18n.ts';
import type { EscalationView, ManifestItem, ReferralView } from '../../lib/partnerApi.ts';
import { DocumentIcon, EyeSlashIcon } from '../icons.tsx';
import { CardHeading, Notice } from '../ui.tsx';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="kv-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function listOrNone(values: string[] | undefined): string {
  return values && values.length > 0 ? values.join(', ') : t('packet.notProvided');
}

export function BriefView({ view, reference }: { view: ReferralView; reference: string }) {
  const brief = view.brief;
  return (
    <section aria-labelledby="content-heading" className="card space-y-4">
      <CardHeading id="content-heading" icon={<DocumentIcon />}>{t('brief.heading')}</CardHeading>
      <p className="text-ink-2">{t('brief.channel', { channel: t(`channel.${view.channel}`), reference })}</p>
      {brief ? (
        <>
          <p className="text-ink-2">{t('brief.intro')}</p>
          <dl>
            {brief.incidentCategories ? <Row label={t('brief.incidentCategories')}>{listOrNone(brief.incidentCategories)}</Row> : null}
            {brief.timeContext ? (
              <Row label={t('brief.timeContext')}>
                {`${formatDate(brief.timeContext.date)} (${t(`brief.accuracy.${brief.timeContext.accuracy}`)})`}
              </Row>
            ) : null}
            {brief.locationType ? <Row label={t('brief.locationType')}>{brief.locationType}</Row> : null}
            {brief.isOngoing !== undefined ? (
              <Row label={t('brief.isOngoing')}>{brief.isOngoing ? t('common.yes') : t('common.no')}</Row>
            ) : null}
          </dl>
        </>
      ) : (
        <p className="text-ink-2">{t('brief.none')}</p>
      )}
    </section>
  );
}

const PACKET_FIELDS: { key: keyof EscalationView['content']; label: MessageKey }[] = [
  { key: 'timeRange', label: 'packet.timeRange' },
  { key: 'location', label: 'packet.location' },
  { key: 'incidentDescription', label: 'packet.incidentDescription' },
  { key: 'statement', label: 'packet.statement' },
  { key: 'impactSummary', label: 'packet.impactSummary' },
  { key: 'witnessDetails', label: 'packet.witnessDetails' },
  { key: 'tags', label: 'packet.tags' },
  { key: 'patterns', label: 'packet.patterns' },
  { key: 'transportIdentifiers', label: 'packet.transportIdentifiers' },
];

export function PacketView({ view }: { view: EscalationView }) {
  const level = view.redactionLevel;
  return (
    <section aria-labelledby="content-heading" className="card space-y-4">
      <CardHeading id="content-heading" icon={<DocumentIcon />}>{t('packet.heading')}</CardHeading>
      <div className="flex gap-3 rounded-xl border border-line-strong bg-surface-2 px-4 py-3" data-testid="redaction-banner">
        <EyeSlashIcon className="mt-0.5 h-5 w-5 shrink-0" />
        <div className="min-w-0">
          <p className="font-semibold">{t('packet.redactionLevel', { level: t(`packet.level.${level}`) })}</p>
          <p className="mt-1">{t(`packet.redaction.${level}`)}</p>
          {view.redaction.appliedLabels.length > 0 ? (
            <p className="mt-1 text-sm">{t('packet.redactedFields', { labels: view.redaction.appliedLabels.join(', ') })}</p>
          ) : null}
        </div>
      </div>
      {view.generatedAt ? <p className="text-sm text-ink-3">{t('packet.generatedAt', { time: formatDateTime(view.generatedAt) })}</p> : null}
      <dl>
        <Row label={t('packet.contact')}>
          {view.contact.preference === 'alias'
            ? t('packet.contactAlias', { alias: view.contact.alias })
            : t('packet.contactNone')}
        </Row>
        {PACKET_FIELDS.map(field => {
          const value = view.content[field.key];
          const text = Array.isArray(value) ? listOrNone(value) : value && value.trim() ? value : t('packet.notProvided');
          return <Row key={field.key} label={t(field.label)}>{text}</Row>;
        })}
      </dl>
      <Manifest items={view.evidenceManifest ?? []} />
    </section>
  );
}

/** The evidence the packet describes (text only; files are under Evidence). */
function Manifest({ items }: { items: ManifestItem[] }) {
  return (
    <div className="space-y-3 border-t border-line pt-4" data-testid="packet-manifest">
      <h3>{t('packet.manifest')}</h3>
      {items.length === 0 ? (
        <p className="text-ink-2">{t('packet.manifestNone')}</p>
      ) : (
        <ul className="space-y-3">
          {items.map((item, index) => (
            <li key={`${item.label}-${index}`} className="rounded-xl border border-line bg-surface-2 p-4">
              <p className="font-semibold text-ink">{item.label}</p>
              <p className="text-sm text-ink-3">
                {[
                  t(`evidence.type.${item.type}`),
                  item.sizeBytes !== undefined ? formatBytes(item.sizeBytes) : null,
                  item.capturedAt ? formatDateTime(item.capturedAt) : null,
                  t('packet.manifestMetadata', { status: item.metadataStatus }),
                ].filter(Boolean).join(' · ')}
              </p>
              {item.description ? (
                <p className="mt-1 whitespace-pre-wrap break-words"><span className="font-semibold">{t('packet.manifestDescription')}: </span>{item.description}</p>
              ) : null}
              {item.transcript ? (
                <p className="mt-1 whitespace-pre-wrap break-words"><span className="font-semibold">{t('packet.manifestTranscript')}: </span>{item.transcript}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function UnavailableContent() {
  return (
    <section aria-labelledby="content-heading" className="card space-y-3">
      <CardHeading id="content-heading" icon={<DocumentIcon />}>{t('packet.heading')}</CardHeading>
      <Notice tone="warning">{t('case.unavailable')}</Notice>
    </section>
  );
}
