/** Partner referral statuses, their allowed moves and what the survivor sees (no I/O). */
export const PARTNER_REFERRAL_STATUSES = ['new', 'acknowledged', 'in_progress', 'referred_onward', 'closed'] as const;
export type PartnerReferralStatus = (typeof PARTNER_REFERRAL_STATUSES)[number];

/** Mirrors the enforce_partner_referral_update trigger (migration 007). */
export const PARTNER_STATUS_TRANSITIONS: Readonly<Record<PartnerReferralStatus, readonly PartnerReferralStatus[]>> = {
  new: ['acknowledged', 'closed'],
  acknowledged: ['in_progress', 'closed'],
  in_progress: ['referred_onward', 'closed'],
  referred_onward: ['closed'],
  closed: [],
};

/**
 * Why a partner closed a referral: codes only, never free text, so nothing
 * about the survivor can be typed into this column. Matches the dashboard
 * (apps/partner-web, #293) and migration 008's check. It is never copied
 * into survivor-facing events.
 */
export const PARTNER_CLOSURE_REASONS = [
  'support_provided',
  'referred_elsewhere',
  'survivor_did_not_make_contact',
  'outside_mandate',
  'duplicate',
  'other',
] as const;
export type PartnerClosureReason = (typeof PARTNER_CLOSURE_REASONS)[number];

/** What the survivor's case shows for each partner status (existing cases.status enum). */
export const SURVIVOR_STATUS_FOR_PARTNER_STATUS: Readonly<Record<Exclude<PartnerReferralStatus, 'new'>, 'in_review' | 'referred' | 'closed'>> = {
  acknowledged: 'in_review',
  in_progress: 'in_review',
  referred_onward: 'referred',
  closed: 'closed',
};

/**
 * Escalations are urgent, referrals normal. A tombstone (no pathway) is
 * normal: it shows nothing about the report.
 */
export type PartnerPriority = 'urgent' | 'normal';
export function partnerPriority(pathway: 'referral' | 'escalation' | null): PartnerPriority {
  return pathway === 'escalation' ? 'urgent' : 'normal';
}

/** An urgent referral nobody has acknowledged yet (only an explicit status move clears it). */
export function partnerNeedsAttention(pathway: 'referral' | 'escalation' | null, status: PartnerReferralStatus | 'withdrawn'): boolean {
  return pathway === 'escalation' && status === 'new';
}

/** Where a partner sent the survivor next (migration 014). */
export const PARTNER_ONWARD_TYPES = [
  'police', 'medical', 'psychosocial', 'legal_aid', 'shelter', 'child_protection', 'other',
] as const;
export type PartnerOnwardType = (typeof PARTNER_ONWARD_TYPES)[number];

export const PARTNER_ONWARD_STATUSES = ['planned', 'made', 'accepted', 'declined', 'completed', 'cancelled'] as const;
export type PartnerOnwardStatus = (typeof PARTNER_ONWARD_STATUSES)[number];

/** A new onward referral is recorded as planned, or as already made. */
export const PARTNER_ONWARD_INITIAL_STATUSES = ['planned', 'made'] as const;

/** Mirrors the enforce_partner_onward_update trigger (migration 014). */
export const PARTNER_ONWARD_TRANSITIONS: Readonly<Record<PartnerOnwardStatus, readonly PartnerOnwardStatus[]>> = {
  planned: ['made', 'cancelled'],
  made: ['accepted', 'declined'],
  accepted: ['completed'],
  declined: [],
  completed: [],
  cancelled: [],
};

/** Character limits of the partner-typed onward fields (migration 014 checks the same). */
export const PARTNER_ONWARD_LIMITS = { organisation: 120, contactRole: 120, externalReference: 80, note: 1000 } as const;
