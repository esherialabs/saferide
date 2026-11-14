import type { DraftData } from './draftStorage';
import type { PathwayType } from '../types/pathways';
import { formatPartnerCopy, PARTNER_SHARING_COPY } from '../i18n/partnerSharingCopy';

/**
 * Sharing a report with SafeRide's partner HURIA (huria-dashboard-design.md
 * §1, §6, §11). Pure helpers only: the choice the survivor makes on this
 * phone, the consent versions the shown text belongs to, the callback number
 * rules, and the plain-language status shown back to the survivor.
 */

/** Provider-pack stableId; also the partner id in POST /api/cases partnerRouting. */
export const HURIA_PARTNER_STABLE_ID = 'ke-coast-huria' as const;
export type PartnerStableId = typeof HURIA_PARTNER_STABLE_ID;

/**
 * Consent versions of the wording in i18n/resources (partnerSharing.consent
 * and partnerSharing.callback). The server accepts a consent only at the one
 * version its privacy controls enable, and that version must name the
 * partner (`partner-follow-up.<stableId>.v<n>`), so changed wording needs a
 * new version. v1 was the first draft wording; v2 states the evidence
 * descriptions, transcripts and alias HURIA sees. v3 gives referrals the
 * same explicitly previewed packet as escalations, retaining the no-details choice.
 */
export const PARTNER_FOLLOW_UP_CONSENT_VERSION = 'partner-follow-up.ke-coast-huria.v3';
export const PARTNER_CALLBACK_CONSENT_VERSION = 'partner-callback.ke-coast-huria.v1';

/**
 * The follow-up consent has one version but two wordings, one per pathway
 * (consent.escalationSees / consent.referralSees). The text id records which
 * one the survivor agreed to; the server's consent record holds the version
 * and the routed case's pathway, which together identify the same text.
 */
export const PARTNER_FOLLOW_UP_TEXT_IDS = {
  escalate: `${PARTNER_FOLLOW_UP_CONSENT_VERSION}.escalation`,
  referral: `${PARTNER_FOLLOW_UP_CONSENT_VERSION}.referral`,
} as const;
export const PARTNER_CALLBACK_TEXT_ID = `${PARTNER_CALLBACK_CONSENT_VERSION}.callback`;

export type PartnerSharingPathway = keyof typeof PARTNER_FOLLOW_UP_TEXT_IDS;

/** Runtime-config `features` flags published by GET /api/config/runtime. */
export const PARTNER_ROUTING_FEATURE = 'partnerRouting';
export const PARTNER_CALLBACK_FEATURE = 'partnerCallback';

/** The API's 503 reason when partner sharing is off; only this downgrades to SafeRide-only. */
export const PARTNER_UNAVAILABLE_REASON = 'partner_unavailable';
/** The API's 503 reason when only the callback is off: resend to HURIA without the number. */
export const PARTNER_CALLBACK_UNAVAILABLE_REASON = 'partner_callback_unavailable';

/** The server's schema caps the raw callback input at 24 characters. */
export const MAX_CALLBACK_INPUT_LENGTH = 24;

export const PARTNER_REFERRAL_STATUSES = ['new', 'acknowledged', 'in_progress', 'referred_onward', 'closed'] as const;
export type PartnerReferralStatus = (typeof PARTNER_REFERRAL_STATUSES)[number];

export const PARTNER_ROUTING_CONFLICT_REASONS = [
  'partner_not_accepting',
  'partner_consent_missing',
  'callback_consent_missing',
] as const;
export type PartnerRoutingConflictReason = (typeof PARTNER_ROUTING_CONFLICT_REASONS)[number];

export type PartnerConsentAgreement = {
  version: string;
  /** Which wording was shown (PARTNER_FOLLOW_UP_TEXT_IDS / PARTNER_CALLBACK_TEXT_ID). */
  textId?: string;
  /** When the survivor ticked the separate consent at the review step. */
  agreedAt: string;
  /** Server consent record id, once created right before submission. */
  recordId?: string;
};

export type PartnerSharingOutcome =
  | {
      status: 'routed';
      reference: string;
      partnerStatus: string;
      callbackShared: boolean;
      /** The survivor offered a callback number but the server could not take it. */
      callbackNotShared?: boolean;
      at: string;
    }
  | { status: 'unavailable'; at: string }
  | { status: 'needs_confirmation'; reason: PartnerRoutingConflictReason | 'confirmation_required'; at: string };

export type PartnerSharingDraft = {
  partnerStableId: PartnerStableId;
  /** "Also share with HURIA" is on for this report. Off unless the survivor turns it on. */
  requested: boolean;
  followUpConsent?: PartnerConsentAgreement;
  callback?: {
    requested: boolean;
    /** Kenyan mobile in E.164. Removed from the phone once the report is sent. */
    phoneNumber?: string;
    consent?: PartnerConsentAgreement;
    /** The survivor withdrew the callback consent; the server removes the number. */
    withdrawnAt?: string;
  };
  outcome?: PartnerSharingOutcome;
  /** The callback option was unavailable at sending, so the number was dropped (and not shared). */
  callbackDropped?: boolean;
  /** The survivor withdrew the follow-up consent; nothing more is ever routed for this report. */
  withdrawnAt?: string;
};

export type PartnerSharingAvailability = { routing: boolean; callback: boolean };

/**
 * On only when the server reports the feature on AND enables exactly the
 * consent version whose wording this app shows. A server that enables
 * another version (new wording) hides the choice instead of failing later.
 */
export function getPartnerSharingAvailability(
  features: Record<string, boolean> | null | undefined,
  consentVersions?: Record<string, string | null> | null,
): PartnerSharingAvailability {
  const routing = features?.[PARTNER_ROUTING_FEATURE] === true
    && consentVersions?.partner_follow_up === PARTNER_FOLLOW_UP_CONSENT_VERSION;
  return {
    routing,
    callback: routing
      && features?.[PARTNER_CALLBACK_FEATURE] === true
      && consentVersions?.partner_callback === PARTNER_CALLBACK_CONSENT_VERSION,
  };
}

const E164 = /^\+[1-9]\d{7,14}$/;
const KENYAN_MOBILE_E164 = /^\+254(7\d{8}|1[01]\d{7})$/;

/**
 * Mirrors the API's `normalizeKenyanMobile` (contracts/caseContracts.ts on
 * top of services/partnerCallbackSeal.ts): Kenyan mobiles only, returned in
 * E.164, or null for landlines, short codes and other countries.
 */
export function normalizeKenyanMobile(input: string | null | undefined): string | null {
  if (typeof input !== 'string' || input.length > MAX_CALLBACK_INPUT_LENGTH) return null;
  const compact = input.trim().replace(/[\s().-]/g, '');
  let candidate = compact;
  if (/^0[17]\d{8}$/.test(compact)) candidate = `+254${compact.slice(1)}`;
  else if (/^254[17]\d{8}$/.test(compact)) candidate = `+${compact}`;
  if (!E164.test(candidate)) return null;
  return KENYAN_MOBILE_E164.test(candidate) ? candidate : null;
}

/** +254712345678 -> 0712 345 678, for showing the survivor their own number. */
export function formatKenyanMobileForDisplay(e164: string): string {
  if (!KENYAN_MOBILE_E164.test(e164)) return e164;
  const local = `0${e164.slice(4)}`;
  return `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}`;
}

/** Partner sharing applies to escalations, and to referrals that name HURIA itself. */
export function isPartnerSharingApplicable(
  draft: Pick<DraftData, 'referralSelection' | 'selectedProvider'>,
  pathway: PathwayType | string | null | undefined,
): boolean {
  if (pathway === 'escalate') return true;
  if (pathway !== 'referral') return false;
  return (draft.referralSelection?.providerId ?? draft.selectedProvider) === HURIA_PARTNER_STABLE_ID;
}

/** The survivor's partner choice for this pathway, or null when nothing is to be shared. */
export function getRequestedPartnerSharing(
  draft: Pick<DraftData, 'referralSelection' | 'selectedProvider' | 'partnerSharing'>,
  pathway: PathwayType | string | null | undefined,
): PartnerSharingDraft | null {
  const sharing = draft.partnerSharing;
  if (!sharing?.requested || sharing.withdrawnAt) return null;
  return isPartnerSharingApplicable(draft, pathway) ? sharing : null;
}

export type PartnerSharingFormState = {
  requested: boolean;
  callbackRequested: boolean;
  phoneInput: string;
};

export function getPartnerSharingFormState(sharing: PartnerSharingDraft | null | undefined): PartnerSharingFormState {
  return {
    requested: sharing?.requested === true,
    callbackRequested: sharing?.requested === true && sharing.callback?.requested === true,
    phoneInput: sharing?.callback?.phoneNumber ? formatKenyanMobileForDisplay(sharing.callback.phoneNumber) : '',
  };
}

export type PartnerSharingChoiceResult =
  | { ok: true; sharing: PartnerSharingDraft }
  | { ok: false; error: 'invalid_callback_number' };

/**
 * Turns the form state into the stored choice. Any change to what is shared
 * clears an earlier agreement, so the separate consent is asked again.
 */
export function buildPartnerSharingChoice(
  previous: PartnerSharingDraft | null | undefined,
  form: PartnerSharingFormState,
  availability: PartnerSharingAvailability,
): PartnerSharingChoiceResult {
  const requested = availability.routing && form.requested;
  const callbackRequested = requested && availability.callback && form.callbackRequested;
  let phoneNumber: string | undefined;
  if (callbackRequested) {
    const normalized = normalizeKenyanMobile(form.phoneInput);
    if (!normalized) return { ok: false, error: 'invalid_callback_number' };
    phoneNumber = normalized;
  }

  const unchanged = Boolean(previous)
    && previous?.requested === requested
    && (previous?.callback?.requested === true) === callbackRequested
    && (previous?.callback?.phoneNumber ?? undefined) === phoneNumber;
  const sharing: PartnerSharingDraft = {
    partnerStableId: HURIA_PARTNER_STABLE_ID,
    requested,
    ...(unchanged && previous?.followUpConsent ? { followUpConsent: previous.followUpConsent } : {}),
    ...(callbackRequested
      ? {
          callback: {
            requested: true,
            phoneNumber,
            ...(unchanged && previous?.callback?.consent ? { consent: previous.callback.consent } : {}),
          },
        }
      : {}),
  };
  return { ok: true, sharing };
}

/**
 * True when the survivor has agreed, at the current versions and to the
 * wording for this pathway, to everything this choice shares.
 */
export function hasPartnerConsentAgreement(
  sharing: PartnerSharingDraft | null | undefined,
  pathway: PartnerSharingPathway,
): boolean {
  if (!sharing?.requested || sharing.withdrawnAt) return false;
  if (sharing.followUpConsent?.version !== PARTNER_FOLLOW_UP_CONSENT_VERSION) return false;
  if (sharing.followUpConsent.textId !== PARTNER_FOLLOW_UP_TEXT_IDS[pathway]) return false;
  if (!sharing.callback?.requested) return true;
  return sharing.callback.consent?.version === PARTNER_CALLBACK_CONSENT_VERSION
    && sharing.callback.consent.textId === PARTNER_CALLBACK_TEXT_ID
    && !sharing.callback.withdrawnAt
    && normalizeKenyanMobile(sharing.callback.phoneNumber) !== null;
}

/** Records the separate consent(s) ticked at the review step. Earlier server records are not reused. */
export function withPartnerConsentAgreement(
  sharing: PartnerSharingDraft,
  pathway: PartnerSharingPathway,
  now = new Date(),
): PartnerSharingDraft {
  const agreedAt = now.toISOString();
  return {
    partnerStableId: sharing.partnerStableId,
    requested: sharing.requested,
    followUpConsent: { version: PARTNER_FOLLOW_UP_CONSENT_VERSION, textId: PARTNER_FOLLOW_UP_TEXT_IDS[pathway], agreedAt },
    ...(sharing.callback?.requested
      ? {
          callback: {
            requested: true,
            phoneNumber: sharing.callback.phoneNumber,
            consent: { version: PARTNER_CALLBACK_CONSENT_VERSION, textId: PARTNER_CALLBACK_TEXT_ID, agreedAt },
          },
        }
      : {}),
  };
}

/** The server consent ids this phone holds for the report, follow-up first. */
export function getPartnerConsentRecordIds(sharing: PartnerSharingDraft | null | undefined): string[] {
  return [sharing?.followUpConsent?.recordId, sharing?.callback?.consent?.recordId]
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/**
 * The report must never reach the partner after the survivor withdrew:
 * marks the choice withdrawn and drops the callback number from the phone.
 */
export function markPartnerSharingWithdrawn(
  sharing: PartnerSharingDraft,
  scope: 'follow_up' | 'callback',
  now = new Date(),
): PartnerSharingDraft {
  const at = now.toISOString();
  const callback = sharing.callback
    ? { ...sharing.callback, phoneNumber: undefined, withdrawnAt: sharing.callback.withdrawnAt ?? at }
    : undefined;
  if (scope === 'callback') {
    return callback ? { ...sharing, callback } : sharing;
  }
  return { ...sharing, ...(callback ? { callback } : {}), withdrawnAt: sharing.withdrawnAt ?? at };
}

/** Clears agreement and server records so the survivor must confirm again before anything is sent. */
export function requirePartnerReconfirmation(
  sharing: PartnerSharingDraft,
  reason: PartnerRoutingConflictReason | 'confirmation_required',
  now = new Date(),
): PartnerSharingDraft {
  return {
    partnerStableId: sharing.partnerStableId,
    requested: sharing.requested,
    ...(sharing.callback?.requested
      ? { callback: { requested: true, phoneNumber: sharing.callback.phoneNumber } }
      : {}),
    outcome: { status: 'needs_confirmation', reason, at: now.toISOString() },
  };
}

type ApiErrorLike = { status?: number; details?: unknown };

export type PartnerRoutingFailure =
  | { kind: 'unavailable' }
  | { kind: 'callback_unavailable' }
  | { kind: 'conflict'; reason: PartnerRoutingConflictReason };

/**
 * 503 `partner_unavailable`: partner sharing is off, so the report still
 * goes to SafeRide. 503 `partner_callback_unavailable`: only the callback is
 * off, so the report goes to HURIA without the number. Any other 503
 * (`case_ingestion_disabled`, `privacy_controls_unavailable`,
 * `pathway_consent_disabled`, a passing outage) is an ordinary retryable
 * failure and keeps the HURIA choice. 409 with a consent reason: a consent
 * changed, so nothing was sent and the survivor must confirm again.
 */
export function classifyPartnerRoutingFailure(error: unknown): PartnerRoutingFailure | null {
  if (!error || typeof error !== 'object') return null;
  const { status, details } = error as ApiErrorLike;
  const reason = details && typeof details === 'object' ? (details as { reason?: unknown }).reason : undefined;
  if (status === 503) {
    if (reason === PARTNER_UNAVAILABLE_REASON) return { kind: 'unavailable' };
    if (reason === PARTNER_CALLBACK_UNAVAILABLE_REASON) return { kind: 'callback_unavailable' };
    return null;
  }
  if (status !== 409) return null;
  return typeof reason === 'string' && (PARTNER_ROUTING_CONFLICT_REASONS as readonly string[]).includes(reason)
    ? { kind: 'conflict', reason: reason as PartnerRoutingConflictReason }
    : null;
}

export function getPartnerRoutingConflictMessage(reason: PartnerRoutingConflictReason | 'confirmation_required'): string {
  return reason === 'confirmation_required'
    ? PARTNER_SHARING_COPY.errors.confirmationRequired
    : PARTNER_SHARING_COPY.errors[reason];
}

export function isPartnerReferralStatus(value: unknown): value is PartnerReferralStatus {
  return typeof value === 'string' && (PARTNER_REFERRAL_STATUSES as readonly string[]).includes(value);
}

/** Display name for partners the app knows; the synthetic `test-partner` exists only in dev/test. */
export function getPartnerDisplayName(stableId: unknown): string | null {
  if (stableId === HURIA_PARTNER_STABLE_ID) return PARTNER_SHARING_COPY.partnerShortName;
  if (stableId === 'test-partner') return 'Test partner';
  return null;
}

function withPartnerName(text: string, partnerName: string): string {
  return partnerName === PARTNER_SHARING_COPY.partnerShortName
    ? text
    : text.split(PARTNER_SHARING_COPY.partnerShortName).join(partnerName);
}

export type PartnerSharingState =
  | PartnerReferralStatus
  | 'withdrawn'
  | 'unavailable'
  | 'pending'
  | 'needsAttention';

export function getPartnerSharingStateLabel(state: PartnerSharingState, partnerName = PARTNER_SHARING_COPY.partnerShortName): string {
  return withPartnerName(PARTNER_SHARING_COPY.status[state], partnerName);
}

const STATUS_TIMELINE_BODY: Record<PartnerReferralStatus, string> = {
  new: PARTNER_SHARING_COPY.timeline.newBody,
  acknowledged: PARTNER_SHARING_COPY.timeline.acknowledgedBody,
  in_progress: PARTNER_SHARING_COPY.timeline.inProgressBody,
  referred_onward: PARTNER_SHARING_COPY.timeline.referredOnwardBody,
  closed: PARTNER_SHARING_COPY.timeline.closedBody,
};

type CaseEventLike = {
  eventType: string;
  payload: Record<string, unknown> | null;
  createdAt: Date;
};

export type PartnerTimelineEntry = {
  title: string;
  body: string;
  partnerStatus: PartnerReferralStatus | null;
  reference: string | null;
};

/**
 * Plain-language text for the partner's case events: `partner_routed`
 * (with the reference) and partner `status_change` events. Returns null for
 * every other event, so the existing timeline text is kept.
 */
export function describePartnerCaseEvent(event: CaseEventLike): PartnerTimelineEntry | null {
  const payload = event.payload ?? {};
  const partnerName = getPartnerDisplayName(payload.partner);
  if (!partnerName) return null;

  if (event.eventType === 'partner_routed') {
    const reference = typeof payload.reference === 'string' ? payload.reference : null;
    const status = isPartnerReferralStatus(payload.partner_status) ? payload.partner_status : 'new';
    const routed = reference
      ? formatPartnerCopy(PARTNER_SHARING_COPY.timeline.routedBody, { reference })
      : PARTNER_SHARING_COPY.timeline.routedBody.replace(/\s*Your reference is \{reference\}\./, '');
    return {
      title: withPartnerName(PARTNER_SHARING_COPY.timeline.routedTitle, partnerName),
      body: withPartnerName(`${routed} ${STATUS_TIMELINE_BODY[status]}`, partnerName),
      partnerStatus: status,
      reference,
    };
  }

  if (event.eventType === 'status_change' && payload.actor === 'partner' && isPartnerReferralStatus(payload.partner_status)) {
    const status = payload.partner_status;
    return {
      title: getPartnerSharingStateLabel(status, partnerName),
      body: withPartnerName(STATUS_TIMELINE_BODY[status], partnerName),
      partnerStatus: status,
      reference: null,
    };
  }

  return null;
}

export type PartnerSharingSummary = {
  state: PartnerSharingState;
  label: string;
  reference: string | null;
  callbackShared: boolean;
  /**
   * `available`: this phone holds this report's consent records.
   * `all_reports`: it does not (for example after a reinstall), so the only
   * way to stop is withdrawing every HURIA consent on the account.
   */
  stopSharing: 'available' | 'all_reports' | 'not_applicable';
  /** Plain-language reason when the survivor needs to confirm again. */
  attentionMessage: string | null;
};

const ACTIVE_STATES = new Set<PartnerSharingState>(PARTNER_REFERRAL_STATUSES);

/**
 * What CaseDetail shows about sharing with HURIA: the latest partner status
 * from the case events, falling back to what this phone recorded at
 * submission. Null when the report was never meant for a partner.
 */
export function summarizePartnerSharing(params: {
  events: CaseEventLike[];
  sharing: PartnerSharingDraft | null | undefined;
}): PartnerSharingSummary | null {
  const { sharing } = params;
  const partnerEvents = params.events
    .map(event => ({ event, entry: describePartnerCaseEvent(event) }))
    .filter((item): item is { event: CaseEventLike; entry: PartnerTimelineEntry } => item.entry !== null)
    .sort((a, b) => a.event.createdAt.getTime() - b.event.createdAt.getTime());
  const latest = partnerEvents[partnerEvents.length - 1]?.entry ?? null;
  const routedEvent = partnerEvents.find(item => item.event.eventType === 'partner_routed');
  const outcome = sharing?.outcome;

  const reference = routedEvent?.entry.reference ?? (outcome?.status === 'routed' ? outcome.reference : null);
  const callbackShared = !sharing?.callback?.withdrawnAt && (
    routedEvent?.event.payload?.callback_shared === true
    || (outcome?.status === 'routed' && outcome.callbackShared)
  );

  let state: PartnerSharingState | null = null;
  if (sharing?.withdrawnAt) state = 'withdrawn';
  else if (latest?.partnerStatus) state = latest.partnerStatus;
  else if (outcome?.status === 'routed') state = isPartnerReferralStatus(outcome.partnerStatus) ? outcome.partnerStatus : 'new';
  else if (outcome?.status === 'unavailable') state = 'unavailable';
  else if (outcome?.status === 'needs_confirmation') state = 'needsAttention';
  else if (sharing?.requested && !sharing.withdrawnAt) state = 'pending';
  if (!state) return null;

  const consentRecordId = sharing?.followUpConsent?.recordId;
  const stopSharing = !ACTIVE_STATES.has(state)
    ? 'not_applicable'
    : consentRecordId ? 'available' : 'all_reports';

  return {
    state,
    label: getPartnerSharingStateLabel(state),
    reference,
    callbackShared: state === 'withdrawn' ? false : callbackShared,
    stopSharing,
    attentionMessage: outcome?.status === 'needs_confirmation' ? getPartnerRoutingConflictMessage(outcome.reason) : null,
  };
}

export type SubmissionConfirmationCopy = {
  statusLabel: string;
  title: string;
  subtitle: string;
  reference: string | null;
  referenceHint: string | null;
  callbackNote: string | null;
};

/**
 * The confirmation after a report leaves the phone, or is queued to. It says
 * "Sent to SafeRide" rather than "Delivered", and mentions HURIA only when
 * the report was actually routed to (or is queued for) HURIA.
 */
export function buildSubmissionConfirmationCopy(params: {
  isOffline: boolean;
  sharing: PartnerSharingDraft | null | undefined;
  /** False while the local draft is loading or unknown: say nothing about partners yet. */
  sharingKnown?: boolean;
}): SubmissionConfirmationCopy {
  const copy = PARTNER_SHARING_COPY.confirmation;
  const { sharing } = params;
  const outcome = sharing?.outcome;
  const sharingKnown = params.sharingKnown !== false;

  if (params.isOffline) {
    const partnerQueued = Boolean(sharing?.requested && !sharing.withdrawnAt && outcome?.status !== 'unavailable');
    return {
      statusLabel: copy.statusQueued,
      title: copy.titleQueued,
      subtitle: sharingKnown && partnerQueued ? copy.subtitleQueuedPartner : copy.subtitleQueued,
      reference: null,
      referenceHint: null,
      callbackNote: null,
    };
  }

  if (!sharingKnown) {
    return {
      statusLabel: copy.statusSent,
      title: copy.titleSent,
      subtitle: copy.subtitleSent,
      reference: null,
      referenceHint: null,
      callbackNote: null,
    };
  }

  if (outcome?.status === 'routed' && !sharing?.withdrawnAt) {
    return {
      statusLabel: copy.statusSent,
      title: copy.titleSent,
      subtitle: copy.subtitleRouted,
      reference: outcome.reference,
      referenceHint: copy.referenceHint,
      callbackNote: outcome.callbackShared
        ? copy.callbackShared
        : outcome.callbackNotShared ? copy.callbackNotShared : null,
    };
  }

  return {
    statusLabel: copy.statusSent,
    title: copy.titleSent,
    subtitle: sharing?.withdrawnAt && sharing.requested
      ? PARTNER_SHARING_COPY.errors.withdrawnBody
      : outcome?.status === 'unavailable'
        ? copy.subtitleUnavailable
        : `${copy.subtitleSent} ${copy.subtitleNotRouted}`,
    reference: null,
    referenceHint: null,
    callbackNote: null,
  };
}

/** The consent text shown with the opt-in and again at the review step. */
export function buildPartnerConsentParagraphs(params: {
  pathway: 'escalate' | 'referral';
  redactionLabel?: string | null;
}): string[] {
  const consent = PARTNER_SHARING_COPY.consent;
  const sees = params.pathway === 'escalate'
    ? formatPartnerCopy(consent.escalationSees, { redactionLevel: params.redactionLabel ?? 'Light' })
    : consent.referralSees;
  return [sees, consent.notShared, consent.withdraw, consent.reference];
}

export function buildPartnerCallbackParagraphs(): string[] {
  return [PARTNER_SHARING_COPY.callback.body, PARTNER_SHARING_COPY.callback.safetyTip];
}
