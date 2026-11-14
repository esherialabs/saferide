import { describe, expect, it } from 'vitest';

import { buildCaseSubmissionToast, planCaseSubmission, resolveConfirmationState } from '../caseSubmissionFlow';

describe('what confirming a report does', () => {
  it('keeps everything on the phone while sending is switched off, as before', () => {
    for (const pathway of ['referral', 'escalate'] as const) {
      expect(planCaseSubmission({ pathway, submissionEnabled: false, hasOwnedSession: true })).toBe('stay_on_phone');
    }
  });

  it('never sends the local-only pathways', () => {
    for (const pathway of ['save-private', 'anonymous-map'] as const) {
      expect(planCaseSubmission({ pathway, submissionEnabled: true, hasOwnedSession: true })).toBe('stay_on_phone');
    }
  });

  it('queues only with a SafeRide session, and asks to sign in otherwise', () => {
    expect(planCaseSubmission({ pathway: 'escalate', submissionEnabled: true, hasOwnedSession: true })).toBe('queue');
    expect(planCaseSubmission({ pathway: 'referral', submissionEnabled: true, hasOwnedSession: false })).toBe('needs_sign_in');
  });

  it('says "Saved on this phone; not sent" unless the report was queued', () => {
    const notSent = buildCaseSubmissionToast({ pathway: 'escalate', plan: 'stay_on_phone', isOnline: true, partnerSharingChosen: false });
    expect(notSent.title).toBe('Saved on this phone; not sent');
    expect(notSent.message).toContain('nothing has left this phone');
    expect(buildCaseSubmissionToast({ pathway: 'escalate', plan: 'needs_sign_in', isOnline: true, partnerSharingChosen: true }))
      .toMatchObject({ title: 'Saved on this phone; not sent', variant: 'warning', message: expect.stringContaining('Nothing has been shared with HURIA') });
    expect(buildCaseSubmissionToast({ pathway: 'referral', plan: 'queue', isOnline: false, partnerSharingChosen: false }))
      .toMatchObject({ title: 'Queued to send to SafeRide', message: expect.stringContaining('when you are online') });
  });

  it('shows the confirmation as queued until the draft holds a SafeRide case id', () => {
    expect(resolveConfirmationState({ routeIsOffline: false, routeCaseId: 'draft-1', draft: null }))
      .toEqual({ queued: false, caseId: 'draft-1' });
    expect(resolveConfirmationState({ routeIsOffline: false, routeCaseId: 'draft-1', draft: { status: 'draft' } }))
      .toEqual({ queued: true, caseId: 'draft-1' });
    expect(resolveConfirmationState({ routeIsOffline: true, routeCaseId: 'draft-1', draft: { status: 'submitted', caseId: 'case-9' } }))
      .toEqual({ queued: false, caseId: 'case-9' });
  });
});
