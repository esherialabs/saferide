import { CASE_SUBMISSION_COPY } from '../i18n/caseSubmissionCopy';
import type { PathwayType } from '../types/pathways';

/**
 * What happens to a report when the survivor confirms it at the consent
 * review, for the pathways that send a case to SafeRide (referral and
 * escalation). Pure, so the decision is tested apart from the screen.
 */
export type CaseSubmissionPlan = 'stay_on_phone' | 'needs_sign_in' | 'queue';

export function planCaseSubmission(params: {
  pathway: PathwayType;
  submissionEnabled: boolean;
  hasOwnedSession: boolean;
}): CaseSubmissionPlan {
  if (params.pathway !== 'referral' && params.pathway !== 'escalate') return 'stay_on_phone';
  if (!params.submissionEnabled) return 'stay_on_phone';
  return params.hasOwnedSession ? 'queue' : 'needs_sign_in';
}

export type CaseSubmissionToast = { title: string; message: string; variant: 'success' | 'warning' | 'info' };

/** Honest wording: "not sent" unless the report was actually queued to leave the phone. */
export function buildCaseSubmissionToast(params: {
  pathway: 'referral' | 'escalate';
  plan: CaseSubmissionPlan;
  isOnline: boolean;
  partnerSharingChosen: boolean;
}): CaseSubmissionToast {
  const copy = CASE_SUBMISSION_COPY;
  if (params.plan === 'queue') {
    return {
      title: copy.queuedTitle,
      message: params.isOnline ? copy.queuedBody : copy.queuedOfflineBody,
      variant: 'success',
    };
  }
  const body = params.pathway === 'escalate' ? copy.escalationNotSentBody : copy.referralNotSentBody;
  return {
    title: copy.notSentTitle,
    message: params.partnerSharingChosen ? `${body} ${copy.partnerNotSentNote}` : body,
    variant: params.plan === 'needs_sign_in' ? 'warning' : 'info',
  };
}

/**
 * The confirmation screen's state. With the local draft it follows the
 * queue (queued until the draft holds a SafeRide case id); without it,
 * it trusts the route as before.
 */
export function resolveConfirmationState(params: {
  routeIsOffline: boolean;
  routeCaseId: string;
  draft: { status?: string; caseId?: string } | null;
}): { queued: boolean; caseId: string } {
  if (!params.draft) return { queued: params.routeIsOffline, caseId: params.routeCaseId };
  const sent = params.draft.status === 'submitted' && typeof params.draft.caseId === 'string' && params.draft.caseId.length > 0;
  return { queued: !sent, caseId: sent ? params.draft.caseId! : params.routeCaseId };
}
