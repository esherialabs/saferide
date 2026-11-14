/**
 * Loads GET /summary for the attention banner. Every read is a background
 * request (no activity flag), so polling never keeps an idle session alive.
 */
import { api, store } from './app.ts';
import { summaryPollDue } from './attentionRules.ts';
import { csrfTokenOf, summaryLoaded, summaryUnavailable } from './store.ts';

let lastAttemptAt = 0;
let lastSession: string | null = null;
let inFlight: { session: string; promise: Promise<void> } | null = null;

/** Reads the summary now (after an action that changes the counts, or when a poll is due). */
export function refreshSummary(): Promise<void> {
  const session = csrfTokenOf(store.get());
  if (!session) return Promise.resolve();
  if (inFlight?.session === session) return inFlight.promise;
  lastSession = session;
  lastAttemptAt = Date.now();
  const job = { session, promise: Promise.resolve() };
  job.promise = api.summary()
    .then(summary => store.update(state => csrfTokenOf(state) === session ? summaryLoaded(state, summary, Date.now()) : state))
    .catch(() => store.update(state => csrfTokenOf(state) === session ? summaryUnavailable(state) : state))
    .finally(() => {
      if (inFlight === job) inFlight = null;
    });
  inFlight = job;
  return job.promise;
}

/** The poll: at most every 60 s, and only while this tab is visible. */
export function pollSummaryIfDue(): void {
  const state = store.get();
  const session = csrfTokenOf(state);
  const visibility = state.auth.status === 'signed_in' && state.auth.clock.coverageActive ? 'visible' : document.visibilityState;
  if (session && visibility === 'visible' && (lastSession !== session || summaryPollDue(lastAttemptAt, Date.now(), visibility))) void refreshSummary();
}
