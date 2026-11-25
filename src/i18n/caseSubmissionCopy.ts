import sourceResource from './resources/en.product.v1.json';

/** English source copy for sending reports to SafeRide (and saying honestly when nothing was sent). */
export const CASE_SUBMISSION_COPY = sourceResource.caseSubmission;
export type CaseSubmissionCopy = typeof CASE_SUBMISSION_COPY;
