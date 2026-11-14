import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { api, endSession, reasonForServerEnd, sessionLastConfirmedAt, sessionSync, store, useAppState } from '../lib/app.ts';
import { hasDraft, subscribeDrafts } from '../lib/drafts.ts';
import { formatDuration, t } from '../lib/i18n.ts';
import { PartnerApiError } from '../lib/partnerApi.ts';
import {
  SESSION_WATCH_MS, idleDeadline, keepAliveBlocksIdleCheck, keepAliveDue, serverExtension, sessionPhase, type SessionPhase,
} from '../lib/session.ts';
import { activityRecorded, identityLoaded, idleExtendedTo } from '../lib/store.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';

const ACTIVITY_THROTTLE_MS = 1000;
/** Without BroadcastChannel, how often a tab asks the server whether the shared session still exists. */
export const FALLBACK_SESSION_CHECK_MS = 30 * 1000;
const WATCH_TICK_MS = 5000;
/** How long past the idle limit a failing (not 401) server check may be retried before the tab signs out anyway. */
const IDLE_CHECK_GRACE_MS = 30 * 1000;
let warningOpen = false;
/** When the keep-alive now on its way was sent (null when none). */
let keepAliveStartedAt: number | null = null;

/**
 * The only keep-alive: an interactive GET /me sent at the moment of this
 * tab's own input (see keepAliveDue). Nothing else sends one. Like every
 * request it gives up after REQUEST_TIMEOUT_MS.
 */
function sendKeepAlive(): void {
  if (keepAliveStartedAt !== null) return;
  keepAliveStartedAt = Date.now();
  api.me()
    .then(me => store.update(state => identityLoaded(state, me, Date.now(), api.serverNow())))
    .catch(() => undefined) // a 401 ends the session through the API client; a timeout is just dropped
    .finally(() => {
      keepAliveStartedAt = null;
    });
}

/** A background check found the session gone: wipe this tab and every other tab now. */
function sessionGoneOnServer(): void {
  void endSession(reasonForServerEnd(), { revoke: false });
}

/**
 * Enforces the idle (30 min) and absolute (12 h) limits on the client,
 * warns before either ends (and about an unsaved note), keeps the server
 * session alive while the person is active, shares activity and sign-out
 * with the other tabs, and makes sure a page restored from the back/forward
 * cache is reloaded (so a signed-out tab never shows old case data).
 */
export function SessionManager() {
  const auth = useAppState(state => state.auth);
  const draft = useSyncExternalStore(subscribeDrafts, hasDraft, () => false);
  const [now, setNow] = useState(() => Date.now());
  const [absoluteDismissed, setAbsoluteDismissed] = useState(false);
  const [staying, setStaying] = useState(false);
  const idleCheckInFlight = useRef(false);

  useEffect(() => {
    const sync = sessionSync();
    let last = 0;
    const onInput = () => {
      if (warningOpen) return; // only the dialog's buttons decide while it is open
      const at = Date.now();
      if (at - last < ACTIVITY_THROTTLE_MS) return;
      last = at;
      store.update(state => activityRecorded(state, at));
      const current = store.get().auth;
      if (current.status !== 'signed_in') return;
      sync.activity();
      if (keepAliveDue(current.clock, at)) sendKeepAlive();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload();
    };
    window.addEventListener('pointerdown', onInput, { capture: true, passive: true });
    window.addEventListener('keydown', onInput, { capture: true, passive: true });
    window.addEventListener('pageshow', onPageShow);
    return () => {
      window.removeEventListener('pointerdown', onInput, { capture: true });
      window.removeEventListener('keydown', onInput, { capture: true });
      window.removeEventListener('pageshow', onPageShow);
    };
  }, []);

  const signedIn = auth.status === 'signed_in';
  useEffect(() => {
    if (!signedIn) return;
    const tick = () => setNow(Date.now());
    tick();
    const timer = window.setInterval(tick, 1000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [signedIn]);

  // Confirm with the server, in the background (no activity flag), that the
  // session still exists, so a session revoked or ended elsewhere is noticed
  // at once rather than at the local deadline. With BroadcastChannel this
  // runs every 60 s in visible tabs (one tab's finding reaches all); without
  // it, every 30 s in every tab. Skipped when a request just confirmed it.
  useEffect(() => {
    if (!signedIn) return;
    const sync = sessionSync();
    const every = sync.available ? SESSION_WATCH_MS : FALLBACK_SESSION_CHECK_MS;
    let checking = false;
    const timer = window.setInterval(() => {
      const current = store.get().auth;
      if (checking || current.status !== 'signed_in') return;
      if (sync.available && document.visibilityState !== 'visible') return;
      const at = Date.now();
      if (at - sessionLastConfirmedAt() < every) return;
      if (sessionPhase(current.clock, at).phase === 'expired') return; // the idle/absolute path decides
      checking = true;
      const userId = current.identity?.userId;
      api.checkSession()
        .then(me => {
          // Another person signed in from another tab: this tab's content is not theirs.
          if (userId && me.user.id !== userId) void endSession('expired', { revoke: false });
          else store.update(state => identityLoaded(state, me, Date.now(), api.serverNow(), { touched: false }));
        })
        .catch((error: unknown) => {
          if (error instanceof PartnerApiError && error.kind === 'unauthorized') sessionGoneOnServer();
        })
        .finally(() => {
          checking = false;
        });
    }, WATCH_TICK_MS);
    return () => window.clearInterval(timer);
  }, [signedIn]);

  const phase: SessionPhase = auth.status === 'signed_in' ? sessionPhase(auth.clock, now) : { phase: 'active' };
  const expiredReason = phase.phase === 'expired' ? phase.reason : null;

  useEffect(() => {
    if (!expiredReason) return;
    if (expiredReason === 'absolute') {
      void endSession('absolute');
      return;
    }
    // A keep-alive sent at the person's last input may still be on its way:
    // let it land (it moves the limit) and decide on a later tick.
    if (idleCheckInFlight.current || keepAliveBlocksIdleCheck(keepAliveStartedAt, Date.now())) return;
    idleCheckInFlight.current = true;
    // Idle here, but the session is shared: if the person kept it in use in
    // another tab (seen by the server, beyond what this tab's own requests
    // explain), stay signed in. The check itself is a background read: it
    // never extends the session and never counts as input.
    void (async () => {
      try {
        const me = await api.checkSession();
        const serverNow = api.serverNow();
        const current = store.get().auth;
        const at = Date.now();
        const serverIdleDeadline = serverNow === undefined ? at : at + (Date.parse(me.session.idleExpiresAt) - serverNow);
        const extension = current.status === 'signed_in' ? serverExtension(current.clock, serverIdleDeadline, at) : null;
        if (extension !== null) {
          store.update(state => idleExtendedTo(state, extension));
          return;
        }
        await endSession('idle');
      } catch (error) {
        // Gone on the server too: end now. A failed check (timeout, network)
        // is retried on the next tick, but only briefly: then fail closed.
        const current = store.get().auth;
        const pastBy = current.status === 'signed_in' ? Date.now() - idleDeadline(current.clock) : Number.POSITIVE_INFINITY;
        if ((error instanceof PartnerApiError && error.kind === 'unauthorized') || pastBy > IDLE_CHECK_GRACE_MS) {
          await endSession('idle');
        }
      } finally {
        idleCheckInFlight.current = false;
      }
    })();
  }, [expiredReason, now]);

  const showWarning = phase.phase === 'warning' && !(phase.reason === 'absolute' && absoluteDismissed);
  warningOpen = showWarning;
  const remaining = phase.phase === 'warning' ? formatDuration(phase.endsAt - now) : '';
  const isIdle = phase.phase === 'warning' && phase.reason === 'idle';

  // "Stay signed in" is real input: record it and refresh the server session now.
  async function stay() {
    setStaying(true);
    keepAliveStartedAt = Date.now();
    store.update(state => activityRecorded(state, Date.now()));
    sessionSync().activity();
    try {
      const me = await api.me();
      store.update(state => identityLoaded(state, me, Date.now(), api.serverNow()));
    } catch {
      // A 401 here ends the session through the API client.
    } finally {
      keepAliveStartedAt = null;
      setStaying(false);
    }
  }

  return (
    <ConfirmDialog
      open={showWarning}
      role="alertdialog"
      testId="session-warning"
      initialFocus="confirm"
      title={isIdle ? t('session.idleTitle') : t('session.absoluteTitle')}
      confirmLabel={isIdle ? t('session.stay') : t('session.continue')}
      cancelLabel={t('session.signOutNow')}
      busy={staying}
      onConfirm={() => (isIdle ? void stay() : setAbsoluteDismissed(true))}
      onCancel={() => void endSession('user')}
      onEscape={() => (isIdle ? void stay() : setAbsoluteDismissed(true))}
    >
      <p>{isIdle ? t('session.idleBody', { time: remaining }) : t('session.absoluteBody', { time: remaining })}</p>
      {draft ? (
        <p className="font-semibold" data-testid="session-warning-draft">
          {isIdle ? t('session.draftIdle') : t('session.draftAbsolute')}
        </p>
      ) : null}
    </ConfirmDialog>
  );
}
