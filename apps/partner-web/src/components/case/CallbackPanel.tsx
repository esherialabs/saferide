import { useState } from 'react';

import { api, store } from '../../lib/app.ts';
import { t } from '../../lib/i18n.ts';
import { PartnerApiError } from '../../lib/partnerApi.ts';
import { activityRecorded } from '../../lib/store.ts';
import { ConfirmDialog } from '../ConfirmDialog.tsx';
import { PhoneIcon } from '../icons.tsx';
import { CardHeading, ErrorNotice, LiveMessage } from '../ui.tsx';

/**
 * Shown only when the survivor consented to share a callback number. The
 * number is fetched on an explicit, audited request and kept only in this
 * component's memory.
 */
export function CallbackPanel({ referralId, onWithdrawn }: { referralId: string; onWithdrawn: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [announcement, setAnnouncement] = useState('');

  async function reveal() {
    setBusy(true);
    setFailure(null);
    store.update(state => activityRecorded(state, Date.now()));
    try {
      const result = await api.revealCallback(referralId);
      setPhoneNumber(result.callback.phoneNumber);
      setAnnouncement(t('callback.revealed'));
    } catch (error) {
      if (error instanceof PartnerApiError && error.kind === 'gone') onWithdrawn();
      else setFailure(error);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <section aria-labelledby="callback-heading" className="card space-y-3" data-testid="callback-panel">
      <CardHeading id="callback-heading" icon={<PhoneIcon />}>{t('callback.heading')}</CardHeading>
      <p className="text-ink-2">{t('callback.consented')}</p>
      {phoneNumber ? (
        <div className="space-y-3">
          <p className="rounded-xl bg-surface-2 p-4">
            <span className="block text-sm font-semibold text-ink-3">{t('callback.number')}</span>
            <span className="font-mono text-2xl tracking-wide text-ink" data-testid="callback-number">{phoneNumber}</span>
          </p>
          <div className="flex flex-wrap gap-3">
            <a className="btn-secondary" href={`tel:${phoneNumber.replace(/[^\d+]/g, '')}`}>
              {t('callback.call', { number: phoneNumber })}
            </a>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setPhoneNumber(null);
                setAnnouncement('');
              }}
            >
              {t('callback.hide')}
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="text-sm text-ink-2">{t('callback.logged')}</p>
          {failure ? <ErrorNotice error={failure} /> : null}
          <button type="button" className="btn-secondary w-full" onClick={() => setConfirming(true)}>
            <PhoneIcon />
            {t('callback.reveal')}
          </button>
        </>
      )}
      <LiveMessage message={announcement} />
      <ConfirmDialog
        open={confirming}
        title={t('callback.confirmTitle')}
        confirmLabel={t('callback.confirm')}
        busy={busy}
        onConfirm={() => void reveal()}
        onCancel={() => setConfirming(false)}
        testId="callback-confirm"
      >
        <p>{t('callback.confirmBody')}</p>
      </ConfirmDialog>
    </section>
  );
}
