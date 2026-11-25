import { useEffect, useRef } from 'react';

import { useAppState } from '../lib/app.ts';
import { pollSummaryIfDue } from '../lib/attention.ts';
import { faviconFor, shouldChime } from '../lib/attentionRules.ts';
import { playChime } from '../lib/chime.ts';
import { attentionCount } from '../lib/store.ts';

const POLL_CHECK_MS = 5 * 1000;

/**
 * Keeps the attention signals current while signed in: polls GET /summary
 * (background, visible tab only, at most every 60 s), switches the favicon
 * to the version with a red dot while urgent cases need attention, and
 * plays the optional chime when the count goes up. It renders nothing; the
 * banner and header badge read the same state.
 */
export function AttentionWatcher() {
  const signedIn = useAppState(state => state.auth.status === 'signed_in' && state.auth.identity !== null);
  const count = useAppState(attentionCount);
  const loaded = useAppState(state => state.alerts.summary !== null);
  const chime = useAppState(state => state.alerts.chime);
  const previous = useRef<number | null>(null);

  useEffect(() => {
    if (!signedIn) return;
    pollSummaryIfDue();
    const timer = window.setInterval(pollSummaryIfDue, POLL_CHECK_MS);
    document.addEventListener('visibilitychange', pollSummaryIfDue);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', pollSummaryIfDue);
    };
  }, [signedIn]);

  useEffect(() => {
    const href = faviconFor(signedIn ? count : 0);
    for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')) {
      if (link.getAttribute('href') !== href) link.setAttribute('href', href);
    }
  }, [signedIn, count]);

  useEffect(() => {
    if (!signedIn) {
      previous.current = null;
      return;
    }
    if (!loaded) return;
    if (shouldChime(previous.current, count, chime)) playChime();
    previous.current = count;
  }, [loaded, count, chime, signedIn]);

  return null;
}
