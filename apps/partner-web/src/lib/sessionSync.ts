/**
 * Keeps the tabs of one browser in step for the shared partner session
 * (one cookie, so one session, for all tabs):
 *
 * - activity: input in any tab counts as activity in every tab, so an idle
 *   tab never signs out the session someone is using in another tab;
 * - signed_out: sign-out or expiry in one tab makes every tab wipe its
 *   memory and leave at once;
 * - session_started: a new sign-in replaced the cookie, so other tabs
 *   refresh their CSRF token (or leave, if it is another person);
 * - draft_query / draft_reply: "does any tab hold an unsaved note?", asked
 *   before signing out.
 *
 * Messages carry no case data, identity or tokens: only a type, a fixed
 * reason code, a random query id and a yes/no. Transport is a
 * BroadcastChannel; nothing is written to localStorage or any other
 * storage. Without BroadcastChannel the app falls back to asking the server
 * (see SessionManager).
 */
import type { SignOutReason } from './store.ts';

export const SESSION_SYNC_CHANNEL = 'saferide-partner-session.v1';
export const ACTIVITY_BROADCAST_THROTTLE_MS = 5000;
export const DRAFT_QUERY_TIMEOUT_MS = 300;

const SIGN_OUT_REASONS: readonly SignOutReason[] = ['user', 'idle', 'absolute', 'expired'];

export type SyncMessage =
  | { type: 'activity' }
  | { type: 'signed_out'; reason: SignOutReason }
  | { type: 'session_started' }
  | { type: 'draft_query'; queryId: string }
  | { type: 'draft_reply'; queryId: string; hasDraft: boolean };

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every(key => own.includes(key));
}

const QUERY_ID = /^[a-f0-9]{16}$/;

/** Accepts only the exact message shapes above; anything else is ignored. */
export function parseSyncMessage(data: unknown): SyncMessage | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const message = data as Record<string, unknown>;
  switch (message.type) {
    case 'activity':
    case 'session_started':
      return hasExactKeys(message, ['type']) ? { type: message.type } : null;
    case 'signed_out':
      return hasExactKeys(message, ['type', 'reason']) && (SIGN_OUT_REASONS as readonly unknown[]).includes(message.reason)
        ? { type: 'signed_out', reason: message.reason as SignOutReason }
        : null;
    case 'draft_query':
      return hasExactKeys(message, ['type', 'queryId']) && typeof message.queryId === 'string' && QUERY_ID.test(message.queryId)
        ? { type: 'draft_query', queryId: message.queryId }
        : null;
    case 'draft_reply':
      return hasExactKeys(message, ['type', 'queryId', 'hasDraft'])
        && typeof message.queryId === 'string' && QUERY_ID.test(message.queryId) && typeof message.hasDraft === 'boolean'
        ? { type: 'draft_reply', queryId: message.queryId, hasDraft: message.hasDraft }
        : null;
    default:
      return null;
  }
}

/** The part of BroadcastChannel this module uses (a fake in tests). */
export type ChannelLike = {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
};

export type SessionSyncHandlers = {
  onActivity: () => void;
  onSignedOut: (reason: SignOutReason) => void;
  onSessionStarted: () => void;
  hasDraft: () => boolean;
};

export type SessionSync = {
  /** False when there is no BroadcastChannel: the caller then relies on server checks. */
  readonly available: boolean;
  activity(): void;
  signedOut(reason: SignOutReason): void;
  sessionStarted(): void;
  /** True if any other tab answers that it holds an unsaved note. */
  otherTabsHaveDraft(timeoutMs?: number): Promise<boolean>;
  close(): void;
};

function randomQueryId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function createSessionSync(
  channel: ChannelLike | null,
  handlers: SessionSyncHandlers,
  options: { now?: () => number; activityThrottleMs?: number } = {},
): SessionSync {
  const now = options.now ?? (() => Date.now());
  const throttle = options.activityThrottleMs ?? ACTIVITY_BROADCAST_THROTTLE_MS;
  const pending = new Map<string, (found: boolean) => void>();
  let lastActivityPost = Number.NEGATIVE_INFINITY;

  function post(message: SyncMessage): void {
    try {
      channel?.postMessage(message);
    } catch {
      // A closed channel is the same as no channel.
    }
  }

  if (channel) {
    channel.onmessage = event => {
      const message = parseSyncMessage(event.data);
      if (!message) return;
      switch (message.type) {
        case 'activity':
          handlers.onActivity();
          break;
        case 'signed_out':
          handlers.onSignedOut(message.reason);
          break;
        case 'session_started':
          handlers.onSessionStarted();
          break;
        case 'draft_query':
          post({ type: 'draft_reply', queryId: message.queryId, hasDraft: handlers.hasDraft() });
          break;
        case 'draft_reply':
          if (message.hasDraft) pending.get(message.queryId)?.(true);
          break;
      }
    };
  }

  return {
    available: channel !== null,
    activity() {
      const at = now();
      if (at - lastActivityPost < throttle) return;
      lastActivityPost = at;
      post({ type: 'activity' });
    },
    signedOut(reason) {
      post({ type: 'signed_out', reason });
    },
    sessionStarted() {
      post({ type: 'session_started' });
    },
    otherTabsHaveDraft(timeoutMs = DRAFT_QUERY_TIMEOUT_MS) {
      if (!channel) return Promise.resolve(false);
      const queryId = randomQueryId();
      return new Promise<boolean>(resolve => {
        const finish = (found: boolean) => {
          if (!pending.has(queryId)) return;
          pending.delete(queryId);
          resolve(found);
        };
        pending.set(queryId, finish);
        setTimeout(() => finish(false), timeoutMs);
        post({ type: 'draft_query', queryId });
      });
    },
    close() {
      for (const finish of pending.values()) finish(false);
      pending.clear();
      if (channel) {
        channel.onmessage = null;
        try {
          channel.close();
        } catch {
          // already closed
        }
      }
    },
  };
}
