/**
 * Pure rules for the attention signals (banner, header count, favicon dot,
 * document title, optional chime). Kept free of browser APIs so they can be
 * unit-tested; src/components/AttentionWatcher.tsx applies them.
 */
import { BACKGROUND_REFRESH_MIN_MS } from './partnerApi.ts';

export const FAVICON = '/favicon.svg';
export const FAVICON_ALERT = '/favicon-alert.svg';

/**
 * The summary poll runs only in a visible tab, and never sooner than
 * BACKGROUND_REFRESH_MIN_MS after the last attempt (successful or not).
 */
export function summaryPollDue(lastAttemptAt: number, now: number, visibility: DocumentVisibilityState | string): boolean {
  return visibility === 'visible' && now - lastAttemptAt >= BACKGROUND_REFRESH_MIN_MS;
}

export function faviconFor(attention: number): string {
  return attention > 0 ? FAVICON_ALERT : FAVICON;
}

/** The document title may carry a count and nothing else about cases. */
export function titleWithCount(title: string, attention: number): string {
  return attention > 0 ? `(${Math.min(attention, 99)}${attention > 99 ? '+' : ''}) ${title}` : title;
}

/** Chime only when switched on and the count went up since the last summary (not on the first one). */
export function shouldChime(previous: number | null, next: number, chimeOn: boolean): boolean {
  return chimeOn && previous !== null && next > previous;
}
