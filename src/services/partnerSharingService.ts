import { request } from '../lib/api/httpClient';
import { getConsentLedgerStatuses, recordServerConsent } from '../utils/consentLedger';
import { draftStorage, type DraftData } from '../utils/draftStorage';
import {
  getPartnerConsentRecordIds,
  markPartnerSharingWithdrawn,
  PARTNER_CALLBACK_CONSENT_VERSION,
  PARTNER_FOLLOW_UP_CONSENT_VERSION,
  type PartnerSharingDraft,
} from '../utils/partnerSharing';
import { devPrivacyWarn, getPrivacySafeErrorReason, getPrivacySafeHttpStatus } from '../utils/privacyLog';
import {
  listServerConsents,
  withdrawConsentForFutureProcessing,
  withdrawServerConsent,
} from './privacyConsentService';

/**
 * Server consent records for sharing a report with HURIA. The API needs a
 * granted, unused partner_follow_up consent (and partner_callback for a
 * callback number) per report, created before POST /api/cases.
 */

type ServerConsentRow = {
  id?: unknown;
  purpose?: unknown;
  consent_version?: unknown;
  status?: unknown;
  granted_at?: unknown;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PartnerConsentPurpose = 'partner_follow_up' | 'partner_callback';

async function createServerConsent(purpose: PartnerConsentPurpose, version: string): Promise<{ id: string; grantedAt: string }> {
  const response = await request<{ consent?: ServerConsentRow }>({
    path: '/privacy/consents',
    method: 'POST',
    body: { purpose, consentVersion: version },
  });
  const consent = response?.consent;
  if (
    !consent ||
    typeof consent.id !== 'string' ||
    !UUID.test(consent.id) ||
    consent.purpose !== purpose ||
    consent.consent_version !== version ||
    consent.status !== 'granted'
  ) {
    throw new Error('Consent service returned an invalid partner consent record.');
  }
  const grantedAt = typeof consent.granted_at === 'string' && Number.isFinite(Date.parse(consent.granted_at))
    ? new Date(consent.granted_at).toISOString()
    : new Date().toISOString();
  return { id: consent.id, grantedAt };
}

async function savePartnerSharing(draftId: string, sharing: PartnerSharingDraft): Promise<void> {
  await draftStorage.saveDraft({ id: draftId, partnerSharing: sharing, updatedAt: new Date() });
}

/**
 * Creates the server consent record(s) the survivor agreed to, once per
 * report. Each new id is saved to the draft straight away, so a retried
 * submission reuses it (the API binds a retry to the same consent ids).
 */
export async function ensurePartnerConsentRecords(params: {
  draftId: string;
  sharing: PartnerSharingDraft;
  pathway: 'escalate' | 'referral';
}): Promise<PartnerSharingDraft> {
  let sharing = params.sharing;
  if (!sharing.followUpConsent) throw new Error('Partner sharing has no recorded agreement.');

  const followUp = sharing.followUpConsent;
  if (!followUp.recordId) {
    const created = await createServerConsent('partner_follow_up', PARTNER_FOLLOW_UP_CONSENT_VERSION);
    sharing = { ...sharing, followUpConsent: { ...followUp, recordId: created.id } };
    await savePartnerSharing(params.draftId, sharing);
    await recordServerConsent({
      id: created.id,
      purpose: 'partner_follow_up',
      version: PARTNER_FOLLOW_UP_CONSENT_VERSION,
      textId: followUp.textId,
      grantedAt: created.grantedAt,
      pathway: params.pathway,
    });
  }

  const callback = sharing.callback;
  if (callback?.requested && callback.consent && !callback.consent.recordId) {
    const created = await createServerConsent('partner_callback', PARTNER_CALLBACK_CONSENT_VERSION);
    sharing = { ...sharing, callback: { ...callback, consent: { ...callback.consent, recordId: created.id } } };
    await savePartnerSharing(params.draftId, sharing);
    await recordServerConsent({
      id: created.id,
      purpose: 'partner_callback',
      version: PARTNER_CALLBACK_CONSENT_VERSION,
      textId: callback.consent.textId,
      grantedAt: created.grantedAt,
      pathway: params.pathway,
    });
  }

  return sharing;
}

function partnerConsentIds(sharing: PartnerSharingDraft | null | undefined): string[] {
  // Follow-up first: withdrawing it is what ends the partner's access.
  return getPartnerConsentRecordIds(sharing).filter(id => UUID.test(id));
}

/**
 * True when any partner consent this report relies on has been withdrawn on
 * this phone, including a withdrawal the server has not confirmed yet.
 */
export async function hasWithdrawnPartnerConsent(sharing: PartnerSharingDraft | null | undefined): Promise<boolean> {
  if (sharing?.withdrawnAt || sharing?.callback?.withdrawnAt) return true;
  const ids = partnerConsentIds(sharing);
  if (ids.length === 0) return false;
  const statuses = await getConsentLedgerStatuses(ids);
  return ids.some(id => statuses[id] === 'withdrawn' || statuses[id] === 'withdrawal_pending');
}

/** Marks every local report that used this consent as withdrawn, so its case screen updates. */
export async function markDraftsForWithdrawnPartnerConsent(consentId: string): Promise<number> {
  const drafts = await draftStorage.getAllDrafts();
  let updated = 0;
  for (const draft of drafts) {
    const sharing = draft.partnerSharing;
    if (!sharing) continue;
    const scope = sharing.followUpConsent?.recordId === consentId
      ? 'follow_up'
      : sharing.callback?.consent?.recordId === consentId ? 'callback' : null;
    if (!scope) continue;
    await draftStorage.saveDraft({
      id: draft.id,
      partnerSharing: markPartnerSharingWithdrawn(sharing, scope),
      updatedAt: new Date(),
    });
    updated += 1;
  }
  return updated;
}

/**
 * Privacy & data withdrawal of any consent. For a partner consent the
 * reports that used it are marked withdrawn as soon as the local record is,
 * even while the server withdrawal is still pending.
 */
export async function withdrawConsentFromPrivacySettings(consentId: string) {
  try {
    return await withdrawConsentForFutureProcessing(consentId);
  } finally {
    try {
      const status = (await getConsentLedgerStatuses([consentId]))[consentId];
      if (status === 'withdrawn' || status === 'withdrawal_pending') {
        await markDraftsForWithdrawnPartnerConsent(consentId);
      }
    } catch (error) {
      devPrivacyWarn('partner draft withdrawal marking failed', { reason: getPrivacySafeErrorReason(error) });
    }
  }
}

async function withdrawPartnerConsent(consentId: string): Promise<void> {
  try {
    await withdrawConsentForFutureProcessing(consentId);
  } catch (error) {
    // A consent missing from this phone's ledger (for example after a
    // restore) is still withdrawn on the server.
    if (error instanceof Error && error.message === 'Consent record not found.') {
      await withdrawServerConsent(consentId);
      return;
    }
    throw error;
  }
}

/**
 * Best effort: withdraws consent records created for a submission that did
 * not route to the partner, so no granted-but-unused consent is left behind.
 */
export async function releaseUnusedPartnerConsents(sharing: PartnerSharingDraft | null | undefined): Promise<void> {
  for (const consentId of partnerConsentIds(sharing)) {
    try {
      await withdrawPartnerConsent(consentId);
    } catch (error) {
      devPrivacyWarn('unused partner consent withdrawal failed', {
        reason: getPrivacySafeErrorReason(error),
        status: getPrivacySafeHttpStatus(error),
      });
    }
  }
}

export class PartnerSharingConsentUnknownError extends Error {
  constructor() {
    super('This phone does not hold the consent records for this report.');
    this.name = 'PartnerSharingConsentUnknownError';
  }
}

/**
 * "Stop sharing with HURIA": withdraws the follow-up consent (the server
 * then revokes HURIA's access, deletes its notes and drops any callback
 * number) and the callback consent, then records it on the draft. Safe to
 * repeat; a failure leaves the draft unchanged so the survivor can retry.
 */
export async function stopPartnerSharing(draft: Pick<DraftData, 'id' | 'partnerSharing'>): Promise<PartnerSharingDraft> {
  const sharing = draft.partnerSharing;
  const consentIds = partnerConsentIds(sharing);
  if (!sharing || consentIds.length === 0 || !sharing.followUpConsent?.recordId) {
    throw new PartnerSharingConsentUnknownError();
  }
  for (const consentId of consentIds) {
    await withdrawPartnerConsent(consentId);
  }
  const stopped = markPartnerSharingWithdrawn(sharing, 'follow_up');
  await savePartnerSharing(draft.id, stopped);
  return stopped;
}

const PARTNER_PURPOSE_ORDER = ['partner_follow_up', 'partner_callback'];

/**
 * When this phone no longer knows which consent belongs to a report (for
 * example after a reinstall): withdraws every granted partner consent on
 * the survivor's account, follow-up consents first. Returns how many.
 */
export async function stopAllPartnerSharing(): Promise<number> {
  const consents = (await listServerConsents())
    .filter(consent => PARTNER_PURPOSE_ORDER.includes(consent.purpose) && consent.status === 'granted' && UUID.test(consent.id))
    .sort((a, b) => PARTNER_PURPOSE_ORDER.indexOf(a.purpose) - PARTNER_PURPOSE_ORDER.indexOf(b.purpose));
  for (const consent of consents) {
    await withdrawPartnerConsent(consent.id);
    await markDraftsForWithdrawnPartnerConsent(consent.id);
  }
  return consents.length;
}
