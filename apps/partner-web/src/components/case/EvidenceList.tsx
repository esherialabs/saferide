import { useEffect, useState } from 'react';

import { api } from '../../lib/app.ts';
import { formatBytes, formatDateTime, t, type MessageKey } from '../../lib/i18n.ts';
import { EVIDENCE_NOT_SHAREABLE_YET, PartnerApiError, type Attachment } from '../../lib/partnerApi.ts';
import { DownloadIcon, PaperClipIcon } from '../icons.tsx';
import { CardHeading, ErrorNotice, LiveMessage, Notice } from '../ui.tsx';

const LINK_SECONDS = 60;
const REFUSAL_REASONS = [
  EVIDENCE_NOT_SHAREABLE_YET, 'not_uploaded', 'hash_missing', 'hash_mismatch', 'unscanned', 'scan_rejected', 'quarantined',
];
const MEDIA_TYPES = ['photo', 'video', 'audio', 'document', 'file'];

function unavailableText(reason: string): string {
  const key = REFUSAL_REASONS.includes(reason) ? reason : 'other';
  return t(`evidence.unavailable.${key}` as MessageKey);
}

function conflictReason(error: PartnerApiError): string | undefined {
  const details = error.details;
  return details && typeof details === 'object' && typeof (details as { reason?: unknown }).reason === 'string'
    ? (details as { reason: string }).reason
    : undefined;
}

function mediaLabel(mediaType: string): string {
  return t(`evidence.type.${MEDIA_TYPES.includes(mediaType) ? mediaType : 'file'}` as MessageKey);
}

type LinkState =
  | { kind: 'idle' }
  | { kind: 'requesting' }
  | { kind: 'ready'; url: string; expiresAt: number }
  | { kind: 'expired' }
  | { kind: 'refused' }
  | { kind: 'error'; error: unknown };

function EvidenceItem({ referralId, attachment, downloadsOff, onAnnounce, onWithdrawn, onNotShareable }: {
  referralId: string;
  attachment: Attachment;
  /** The server said partner downloads are off: no item offers a link any more. */
  downloadsOff: boolean;
  onAnnounce: (message: string) => void;
  onWithdrawn: () => void;
  onNotShareable: () => void;
}) {
  const [link, setLink] = useState<LinkState>({ kind: 'idle' });
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (link.kind !== 'ready') return;
    const timer = window.setInterval(() => {
      const at = Date.now();
      setNow(at);
      if (at >= link.expiresAt) setLink({ kind: 'expired' });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [link]);

  async function requestLink() {
    setLink({ kind: 'requesting' });
    try {
      const result = await api.evidenceLink(referralId, attachment.id);
      const seconds = Math.max(1, Math.min(result.expiresInSeconds || LINK_SECONDS, LINK_SECONDS));
      const issuedAt = Date.now();
      setNow(issuedAt);
      setLink({ kind: 'ready', url: result.url, expiresAt: issuedAt + seconds * 1000 });
      onAnnounce(t('evidence.ready', { label: attachment.displayName, seconds }));
    } catch (error) {
      if (error instanceof PartnerApiError && error.kind === 'gone') onWithdrawn();
      else if (error instanceof PartnerApiError && error.kind === 'conflict' && conflictReason(error) === EVIDENCE_NOT_SHAREABLE_YET) {
        // Same calm line as an item the list already marks as not shareable,
        // for the whole list, so no further (audited) refusals pile up.
        setLink({ kind: 'idle' });
        onNotShareable();
      } else if (error instanceof PartnerApiError && error.kind === 'conflict') setLink({ kind: 'refused' });
      else setLink({ kind: 'error', error });
    }
  }

  const details = [
    mediaLabel(attachment.mediaType),
    typeof attachment.sizeBytes === 'number' ? formatBytes(attachment.sizeBytes) : null,
    attachment.receivedAt ? t('evidence.received', { time: formatDateTime(attachment.receivedAt) }) : null,
  ].filter(Boolean).join(' · ');
  const download = attachment.download;

  return (
    <li className="space-y-3 border-b border-line py-4 last:border-0 last:pb-0" data-testid="evidence-item">
      <div className="flex items-start gap-3">
        <span className="card-icon h-9 w-9 rounded-lg"><PaperClipIcon className="h-4 w-4" /></span>
        <div className="min-w-0">
          <p className="break-words font-semibold text-ink">{attachment.displayName}</p>
          <p className="text-sm text-ink-3">{details}</p>
        </div>
      </div>
      {!download.available || downloadsOff ? (
        <p className="text-ink-2" data-testid="evidence-unavailable">
          {unavailableText(download.available ? EVIDENCE_NOT_SHAREABLE_YET : download.reason)}
        </p>
      ) : link.kind === 'ready' ? (
        <div className="flex flex-wrap items-center gap-3">
          <a className="btn-secondary" href={link.url} rel="noopener noreferrer" referrerPolicy="no-referrer" download>
            <DownloadIcon />
            {t('evidence.download', { label: attachment.displayName })}
          </a>
          <span className="text-sm text-ink-2">
            {t('evidence.expiresIn', { seconds: Math.max(0, Math.ceil((link.expiresAt - now) / 1000)) })}
          </span>
        </div>
      ) : (
        <div className="space-y-2">
          {link.kind === 'expired' ? <p className="text-ink-2">{t('evidence.expired')}</p> : null}
          {link.kind === 'refused' ? <Notice tone="warning" live="polite">{t('evidence.refused')}</Notice> : null}
          {link.kind === 'error' ? <ErrorNotice error={link.error} /> : null}
          <button
            type="button"
            className="btn-secondary"
            aria-label={t('evidence.getLinkFor', { label: attachment.displayName })}
            disabled={link.kind === 'requesting'}
            onClick={() => void requestLink()}
          >
            {link.kind === 'requesting' ? t('evidence.requesting') : t('evidence.getLink')}
          </button>
        </div>
      )}
    </li>
  );
}

export function EvidenceList({ referralId, attachments, onWithdrawn }: {
  referralId: string;
  attachments: Attachment[];
  onWithdrawn: () => void;
}) {
  const [announcement, setAnnouncement] = useState('');
  const [downloadsOff, setDownloadsOff] = useState(false);
  // Only promise 60-second links when a file can actually be downloaded.
  const anyDownloadable = !downloadsOff && attachments.some(attachment => attachment.download.available);
  return (
    <section aria-labelledby="evidence-heading" className="card space-y-3">
      <CardHeading id="evidence-heading" icon={<PaperClipIcon />}>{t('evidence.heading')}</CardHeading>
      <Notice tone="info">
        <p data-testid="evidence-logged">
          {anyDownloadable ? t('evidence.logged', { seconds: LINK_SECONDS }) : t('evidence.listedOnly')}
        </p>
      </Notice>
      {attachments.length === 0 ? (
        <p className="text-ink-2">{t('evidence.none')}</p>
      ) : (
        <ul>
          {attachments.map(attachment => (
            <EvidenceItem
              key={attachment.id}
              referralId={referralId}
              attachment={attachment}
              downloadsOff={downloadsOff}
              onAnnounce={setAnnouncement}
              onWithdrawn={onWithdrawn}
              onNotShareable={() => setDownloadsOff(true)}
            />
          ))}
        </ul>
      )}
      <LiveMessage message={announcement} />
    </section>
  );
}
