/**
 * Browser wiring: the one store, the one API client, the cross-tab session
 * sync, and sign-out.
 */
import { useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';

import { hasDraft } from './drafts.ts';
import { createPartnerApi, PartnerApiError } from './partnerApi.ts';
import { sessionPhase } from './session.ts';
import { SESSION_SYNC_CHANNEL, createSessionSync, type ChannelLike, type SessionSync } from './sessionSync.ts';
import {
  createStore, csrfTokenOf, identityLoaded, remoteActivityRecorded, serverTouched, signedOut, type AppState, type SignOutReason,
} from './store.ts';

export const store = createStore();

export function useAppState<T>(select: (state: AppState) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.get()), () => select(store.get()));
}

let ending = false;

let lastSessionConfirmedAt = 0;

/** When a request last showed the session still exists (client clock). */
export function sessionLastConfirmedAt(): number {
  return lastSessionConfirmedAt;
}

/**
 * Why the server's session ended, as the person should read it: if this
 * tab's own idle or absolute limit has passed, say so; otherwise it ended
 * on the server (revoked, signed out elsewhere, expired).
 */
export function reasonForServerEnd(): SignOutReason {
  const { auth } = store.get();
  if (auth.status !== 'signed_in') return 'expired';
  const phase = sessionPhase(auth.clock, Date.now());
  return phase.phase === 'expired' ? phase.reason : 'expired';
}

export const api = createPartnerApi({
  getCsrfToken: () => csrfTokenOf(store.get()),
  onSessionExpired: () => {
    // Only a session the app believed it had can "end"; a first visit
    // without one just goes to sign-in (RequireSession handles that).
    // Every tab wipes at once (endSession tells the others).
    if (store.get().auth.status === 'signed_in') void endSession(reasonForServerEnd(), { revoke: false });
  },
  onServerTouch: () => store.update(state => serverTouched(state, Date.now())),
  onSessionConfirmed: () => {
    lastSessionConfirmedAt = Date.now();
  },
});

const LOGOUT_TIMEOUT_MS = 3000;

let sync: SessionSync | null = null;

function openChannel(): ChannelLike | null {
  try {
    return typeof BroadcastChannel === 'function' ? (new BroadcastChannel(SESSION_SYNC_CHANNEL) as unknown as ChannelLike) : null;
  } catch {
    return null;
  }
}

/** The tab's session sync (created on first use, in the browser only). */
export function sessionSync(): SessionSync {
  if (sync) return sync;
  sync = createSessionSync(openChannel(), {
    // Another tab's real input: counts for idleness here, never for keep-alives.
    onActivity: () => store.update(state => remoteActivityRecorded(state, Date.now())),
    // Another tab signed out or expired: wipe and leave now, without revoking again.
    onSignedOut: reason => void endSession(reason, { notifyOtherTabs: false, revoke: false }),
    onSessionStarted: () => void adoptNewSession(),
    hasDraft,
  });
  return sync;
}

/**
 * A sign-in in another tab replaced the shared cookie. If it is still the
 * same person, take the new session's CSRF token; otherwise this tab's
 * content belongs to someone else's session, so wipe and leave.
 */
async function adoptNewSession(): Promise<void> {
  const { auth } = store.get();
  if (auth.status !== 'signed_in' || !auth.identity) return;
  try {
    const me = await api.checkSession();
    if (me.user.id !== auth.identity.userId) {
      await endSession('expired', { notifyOtherTabs: false, revoke: false });
      return;
    }
    // A background read: it did not extend the server's idle timer.
    store.update(state => identityLoaded(state, me, Date.now(), api.serverNow(), { touched: false }));
  } catch (error) {
    if (error instanceof PartnerApiError && error.kind === 'unauthorized') await endSession('expired', { notifyOtherTabs: false, revoke: false });
  }
}

export type EndSessionOptions = {
  /** Tell the other tabs to wipe and leave too (false when they told us). */
  notifyOtherTabs?: boolean;
  /** Revoke the server session (false when another tab already did). */
  revoke?: boolean;
};

/**
 * Tells the other tabs, revokes the server session (best effort), wipes
 * the in-memory state and renders that empty state before leaving, then
 * loads the sign-in page as a new document so nothing from this session
 * remains in memory. The reason travels in the URL as a fixed code, never
 * with case data.
 */
export async function endSession(reason: SignOutReason, options: EndSessionOptions = {}): Promise<void> {
  if (ending) return;
  ending = true;
  const { notifyOtherTabs = true, revoke = true } = options;
  if (notifyOtherTabs) sessionSync().signedOut(reason);
  if (!revoke) {
    flushSync(() => store.update(() => signedOut()));
    window.location.replace(`/sign-in/?signedOut=${reason}`);
    return;
  }
  if (csrfTokenOf(store.get())) {
    await Promise.race([
      api.logout().catch(() => undefined),
      new Promise(resolve => setTimeout(resolve, LOGOUT_TIMEOUT_MS)),
    ]);
  }
  flushSync(() => store.update(() => signedOut()));
  window.location.replace(`/sign-in/?signedOut=${reason}`);
}

export function isEnding(): boolean {
  return ending;
}

/**
 * Rewrites the address bar without navigating (to drop a one-time token
 * fragment or a sign-out code), keeping Next's history entry consistent.
 */
export function replaceUrl(path: string): void {
  const state: unknown = window.history.state;
  const next = state && typeof state === 'object' ? { ...(state as Record<string, unknown>), url: path, as: path } : state;
  window.history.replaceState(next, '', path);
}
