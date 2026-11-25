import { useEffect, useId, useState, type FormEvent } from 'react';

import { api, store } from '../../lib/app.ts';
import { setDraft } from '../../lib/drafts.ts';
import { formatDateTime, t } from '../../lib/i18n.ts';
import { NOTE_MAX_LENGTH, PartnerApiError, stripControlCharacters, type Note } from '../../lib/partnerApi.ts';
import { activityRecorded } from '../../lib/store.ts';
import { NoteIcon } from '../icons.tsx';
import { CardHeading, ErrorNotice, LiveMessage } from '../ui.tsx';

/** Append-only: notes can be added, never edited or deleted. */
export function NotesPanel({ referralId, notes, onAdded, onWithdrawn }: {
  referralId: string;
  notes: Note[];
  onAdded: (note: Note) => void;
  onWithdrawn: () => void;
}) {
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const length = [...body].length;
  const draftKey = `note-${useId()}`;

  // Sign-out and the expiry warnings say when a typed note would be lost.
  useEffect(() => {
    setDraft(draftKey, body.trim().length > 0);
  }, [draftKey, body]);
  useEffect(() => () => setDraft(draftKey, false), [draftKey]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFailure(null);
    setAnnouncement('');
    const text = body.trim();
    if (!text) {
      setError(t('notes.empty'));
      return;
    }
    if ([...text].length > NOTE_MAX_LENGTH) {
      setError(t('notes.tooLong'));
      return;
    }
    setError(null);
    setBusy(true);
    store.update(state => activityRecorded(state, Date.now()));
    try {
      const result = await api.addNote(referralId, text);
      onAdded(result.note);
      setBody('');
      setAnnouncement(t('notes.added'));
    } catch (caught) {
      if (caught instanceof PartnerApiError && caught.kind === 'gone') onWithdrawn();
      // A refused note (e.g. characters the server does not accept) is shown at the field.
      else if (caught instanceof PartnerApiError && caught.kind === 'bad_request') setError(t('notes.rejected'));
      else setFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="notes-heading" className="card space-y-4">
      <CardHeading id="notes-heading" icon={<NoteIcon />}>{t('notes.heading')}</CardHeading>
      <p className="text-sm text-ink-2">{t('notes.intro')}</p>
      {notes.length === 0 ? (
        <p className="text-ink-2">{t('notes.none')}</p>
      ) : (
        <ol className="space-y-3" data-testid="notes-list">
          {notes.map(note => (
            <li key={note.id} className="rounded-xl border border-line bg-surface-2 p-4">
              <p className="whitespace-pre-wrap break-words text-ink">{note.body}</p>
              <p className="mt-2 text-sm text-ink-3">{t('notes.by', { name: note.author.displayName, time: formatDateTime(note.createdAt) })}</p>
            </li>
          ))}
        </ol>
      )}
      <form className="space-y-3 border-t border-line pt-4" noValidate onSubmit={submit}>
        <div>
          <label className="label" htmlFor="note-body">{t('notes.label')}</label>
          <span id="note-hint" className="hint">{t('notes.hint')}</span>
          {error ? <span id="note-error" className="field-error" role="alert">{error}</span> : null}
          <textarea
            id="note-body"
            className="input mt-2 min-h-[8rem]"
            value={body}
            maxLength={NOTE_MAX_LENGTH}
            // Keep note text away from cloud spellcheck and autocorrect services.
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            autoComplete="off"
            aria-invalid={error ? true : undefined}
            aria-describedby={['note-hint', 'note-counter', error ? 'note-error' : ''].filter(Boolean).join(' ')}
            onChange={event => setBody(stripControlCharacters(event.target.value))}
          />
          <span id="note-counter" className="hint">{t('notes.counter', { count: length })}</span>
        </div>
        {failure ? <ErrorNotice error={failure} /> : null}
        <button type="submit" className="btn-secondary" disabled={busy}>{t('notes.add')}</button>
      </form>
      <LiveMessage message={announcement} />
    </section>
  );
}
