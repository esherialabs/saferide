import assert from 'node:assert/strict';
import { it } from 'node:test';
import { api, store } from '../../src/lib/app.ts';
import { refreshSummary } from '../../src/lib/attention.ts';
import type { CaseSummary } from '../../src/lib/partnerApi.ts';
import { sessionStarted, signedOut } from '../../src/lib/store.ts';

const summary = (n: number): CaseSummary => ({ needsAttention: n, newTotal: n, inProgress: 0, unassigned: n, mine: 0 });
function signIn(token: string) {
  store.update(state => sessionStarted(state, { csrfToken: token, mfaRequired: false, session: {
    idleExpiresAt: '2099-01-01T00:00:00Z', absoluteExpiresAt: '2099-01-01T12:00:00Z',
  } }, Date.now()));
}

it('an old-session summary cannot populate the next sign-in or block its refresh', async () => {
  const original = api.summary;
  const answers: Array<(value: CaseSummary) => void> = [];
  api.summary = () => new Promise(resolve => { answers.push(resolve); });
  try {
    signIn('synthetic-old-session');
    const old = refreshSummary();
    signIn('synthetic-next-session');
    const current = refreshSummary();
    assert.equal(answers.length, 2);
    answers[0]!(summary(99));
    await old;
    assert.equal(store.get().alerts.summary, null);
    answers[1]!(summary(2));
    await current;
    assert.equal(store.get().alerts.summary?.needsAttention, 2);
  } finally { api.summary = original; store.update(() => signedOut()); }
});

it('an outage marks counts unavailable and a successful retry clears it', async () => {
  const original = api.summary;
  try {
    signIn('synthetic-retry-session');
    api.summary = async () => summary(2);
    await refreshSummary();
    api.summary = async () => { throw new Error('synthetic outage'); };
    await refreshSummary();
    assert.equal(store.get().alerts.unavailable, true);
    assert.equal(store.get().alerts.summary?.needsAttention, 2);
    api.summary = async () => summary(0);
    await refreshSummary();
    assert.equal(store.get().alerts.unavailable, false);
    assert.equal(store.get().alerts.summary?.needsAttention, 0);
  } finally { api.summary = original; store.update(() => signedOut()); }
});
