/**
 * Session timing, kept on the client's own clock so a skewed device clock
 * cannot extend or cut a session.
 * Explicit live coverage is the exception to normal idle limits below:
 * authenticated heartbeats renew a bounded 12-hour lease. It still expires
 * if renewals stop and can always be revoked or signed out.
 *
 * The server extends its 30-minute idle timer only on user-initiated
 * requests (writes, and GETs with the P2 activity flag). The client signs
 * out locally 30 minutes after the person's last real input. Three rules
 * keep the two in step without ever letting an unattended tab keep itself
 * alive:
 *
 * - idleness is measured from real input only: this tab's keyboard or
 *   pointer input, or another tab's input reported over the tab channel;
 * - a keep-alive (an interactive GET /me) is sent only at the moment of
 *   this tab's own input, when the server last heard from this tab 2 or
 *   more minutes ago. No timer, idle check or server answer can trigger
 *   one, so no interactive request follows the last real input;
 * - when this tab's own input is the latest, its idle limit is also capped
 *   at the server's idle deadline as this tab knows it (its last
 *   interactive request + 30 min), so the warning always comes before the
 *   server lapses. The effective limit is 28-30 minutes after the last
 *   input, never more;
 * - at the idle limit, the server is asked (without the activity flag)
 *   whether the shared session is in use elsewhere. Only a server deadline
 *   later than this tab's own requests explain can keep the tab signed in,
 *   and that extension never counts as input.
 */
import { PARTNER_SESSION_POLICY, REQUEST_TIMEOUT_MS, type SessionWindow } from './partnerApi.ts';

export type SessionKind = 'pre_mfa' | 'full';

export type SessionClock = {
  coverageActive?: boolean;
  coverageEpoch?: number;
  kind: SessionKind;
  idleMs: number;
  /** Client-clock time at which the server's absolute limit ends. */
  absoluteAt: number;
  /** Last real keyboard/pointer input in this tab. Only this triggers keep-alives. */
  lastLocalInputAt: number;
  /** Last real input in any tab of this browser (this tab's, or another tab's reported input). Idleness counts from it. */
  lastInputAt: number;
  /** Last successful interactive request from this tab (which extended the server's idle timer). */
  lastServerTouchAt: number;
  /** An idle limit the server confirmed because of activity elsewhere (0 if none). Never counts as input. */
  extendedUntil: number;
};

export const IDLE_WARNING_MS = 2 * 60 * 1000;
export const ABSOLUTE_WARNING_MS = 5 * 60 * 1000;
/** On input, refresh the server's idle timer if this tab last reached it this long ago. */
export const KEEPALIVE_AFTER_MS = 2 * 60 * 1000;
/** Slack for clock rounding (the Date header has 1 s resolution) when reading the server's idle deadline. */
export const IDLE_RECHECK_MARGIN_MS = 60 * 1000;
/** How often a visible tab confirms with the server that the session still exists (when nothing else has). */
export const SESSION_WATCH_MS = 60 * 1000;

/**
 * The idle check waits for a keep-alive that is still on its way (it may
 * move the limit), but never longer than a request can take: a hung
 * keep-alive can't hold a tab open.
 */
export function keepAliveBlocksIdleCheck(keepAliveStartedAt: number | null, now: number): boolean {
  return keepAliveStartedAt !== null && now - keepAliveStartedAt < REQUEST_TIMEOUT_MS + 1000;
}

export function idleMsFor(kind: SessionKind): number {
  return (kind === 'full' ? PARTNER_SESSION_POLICY.idleSeconds : PARTNER_SESSION_POLICY.preMfaSeconds) * 1000;
}

/**
 * Converts the server's expiry timestamps to client-clock deadlines, carrying
 * over only durations. `serverNow` is the server's clock (from the response
 * Date header). Without it, the server's clock is recovered from
 * idleExpiresAt = server now + idle, which is exact unless the idle expiry
 * was capped at the absolute expiry (then the time left is at most one idle
 * window and the server's 401 is the backstop).
 */
export function clockFromServer(window: SessionWindow, kind: SessionKind, clientNow: number, serverNow?: number): SessionClock {
  const idleMs = idleMsFor(kind);
  const idleExpiresAt = Date.parse(window.idleExpiresAt);
  const absoluteExpiresAt = Date.parse(window.absoluteExpiresAt);
  let absoluteRemaining = idleMs;
  if (Number.isFinite(absoluteExpiresAt)) {
    const reference = serverNow !== undefined && Number.isFinite(serverNow)
      ? serverNow
      : Number.isFinite(idleExpiresAt) ? idleExpiresAt - (window.coverageActive ? PARTNER_SESSION_POLICY.absoluteSeconds * 1000 : idleMs) : Number.NaN;
    if (Number.isFinite(reference)) {
      absoluteRemaining = Math.min(absoluteExpiresAt - reference, PARTNER_SESSION_POLICY.absoluteSeconds * 1000);
    }
  }
  return {
    kind,
    ...(window.coverageEpoch !== undefined ? { coverageActive: window.coverageActive === true, coverageEpoch: window.coverageEpoch } : {}),
    idleMs,
    absoluteAt: clientNow + Math.max(0, absoluteRemaining),
    lastLocalInputAt: clientNow,
    lastInputAt: clientNow,
    lastServerTouchAt: clientNow,
    extendedUntil: 0,
  };
}

/**
 * The idle limit before the absolute cap: 30 min after the last real input
 * in any tab; when that input was this tab's own, no later than the server
 * deadline this tab's requests set; later only by a server-confirmed
 * extension (activity in another tab).
 */
function idleLimit(clock: SessionClock): number {
  if (clock.coverageActive) return Number.POSITIVE_INFINITY;
  const inputDeadline = clock.lastInputAt + clock.idleMs;
  const ownInputIsLatest = clock.lastLocalInputAt >= clock.lastInputAt;
  const base = ownInputIsLatest ? Math.min(inputDeadline, clock.lastServerTouchAt + clock.idleMs) : inputDeadline;
  return Math.max(base, clock.extendedUntil);
}

/** When this tab signs out for idleness (client clock). */
export function idleDeadline(clock: SessionClock): number {
  return Math.min(idleLimit(clock), clock.absoluteAt);
}

export type SessionPhase =
  | { phase: 'active' }
  | { phase: 'warning'; reason: 'idle' | 'absolute'; endsAt: number }
  | { phase: 'expired'; reason: 'idle' | 'absolute' };

export function sessionPhase(clock: SessionClock, now: number): SessionPhase {
  if (now >= clock.absoluteAt) return { phase: 'expired', reason: 'absolute' };
  const idleAt = idleLimit(clock);
  if (now >= idleAt) return { phase: 'expired', reason: 'idle' };
  if (clock.kind === 'full') {
    if (idleAt <= clock.absoluteAt && now >= idleAt - IDLE_WARNING_MS) return { phase: 'warning', reason: 'idle', endsAt: idleAt };
    if (now >= clock.absoluteAt - ABSOLUTE_WARNING_MS) return { phase: 'warning', reason: 'absolute', endsAt: clock.absoluteAt };
  }
  return { phase: 'active' };
}

/**
 * Called only at the moment of this tab's own real input (`now` is that
 * input's time): whether to send a keep-alive so the server's idle timer
 * does not lapse while the person is working without making requests.
 */
export function keepAliveDue(clock: SessionClock, now: number): boolean {
  return clock.kind === 'full' && now - clock.lastServerTouchAt >= KEEPALIVE_AFTER_MS && now < clock.absoluteAt;
}

/**
 * At the idle limit: the server's idle deadline (client clock) keeps this
 * tab signed in only if it is later than this tab's own interactive
 * requests can explain, so another tab's activity caused it, and leaves
 * more than the margin. Returns the deadline to extend to, or null.
 */
export function serverExtension(clock: SessionClock, serverIdleDeadline: number, now: number): number | null {
  const ownExplained = clock.lastServerTouchAt + clock.idleMs;
  if (serverIdleDeadline - now <= IDLE_RECHECK_MARGIN_MS) return null;
  if (serverIdleDeadline <= ownExplained + IDLE_RECHECK_MARGIN_MS) return null;
  return Math.min(serverIdleDeadline, clock.absoluteAt);
}

/** This tab's own real input. */
export function withLocalInput(clock: SessionClock, now: number): SessionClock {
  if (now <= clock.lastLocalInputAt && now <= clock.lastInputAt) return clock;
  return { ...clock, lastLocalInputAt: Math.max(clock.lastLocalInputAt, now), lastInputAt: Math.max(clock.lastInputAt, now) };
}

/** Another tab's real input (reported over the tab channel): counts for idleness, never for keep-alives. */
export function withRemoteInput(clock: SessionClock, now: number): SessionClock {
  return now > clock.lastInputAt ? { ...clock, lastInputAt: now } : clock;
}

export function withServerTouch(clock: SessionClock, now: number): SessionClock {
  return now > clock.lastServerTouchAt ? { ...clock, lastServerTouchAt: now } : clock;
}

export function withExtension(clock: SessionClock, until: number): SessionClock {
  const capped = Math.min(until, clock.absoluteAt);
  return capped > clock.extendedUntil ? { ...clock, extendedUntil: capped } : clock;
}
