import { PARTNER_SHARING_COPY } from '../i18n/partnerSharingCopy';
import type { ConsentLedgerEntry, ConsentPurpose, PrivacyHistoryEntry } from './consentLedger';

/** Plain-language names for the survivor's consent history in Privacy & data. */
const CONSENT_PURPOSE_LABELS: Record<ConsentPurpose, string> = {
  pathway_submission: 'Report pathway choice',
  anonymous_aggregate: 'Anonymous safety-map signals',
  analytics: 'Analytics',
  research: 'Research',
  model_training: 'AI model training',
  partner_follow_up: PARTNER_SHARING_COPY.privacy.partner_follow_up,
  partner_callback: PARTNER_SHARING_COPY.privacy.partner_callback,
};

const PARTNER_PURPOSES = new Set<ConsentPurpose>(['partner_follow_up', 'partner_callback']);

export function getConsentPurposeLabel(purpose: ConsentPurpose): string {
  return CONSENT_PURPOSE_LABELS[purpose] ?? 'Consent';
}

export function getConsentStatusLabel(entry: Pick<ConsentLedgerEntry, 'status' | 'remoteWithdrawalStatus'>): string {
  if (entry.status === 'granted') return PARTNER_SHARING_COPY.privacy.granted;
  return entry.remoteWithdrawalStatus === 'pending'
    ? PARTNER_SHARING_COPY.privacy.withdrawalPending
    : PARTNER_SHARING_COPY.privacy.withdrawn;
}

export function describeConsentEntry(entry: ConsentLedgerEntry, formatDate: (date: Date) => string): string {
  return `${getConsentPurposeLabel(entry.purpose)}: ${getConsentStatusLabel(entry)} · ${formatDate(new Date(entry.grantedAt))}`;
}

/**
 * Newest first, as listPrivacyHistory returns them. Partner-sharing
 * consents are never cut off, because each one keeps a report visible to
 * HURIA until it is withdrawn; other records are capped at `limit`.
 */
export function selectPrivacyHistoryForDisplay(entries: PrivacyHistoryEntry[], limit = 10): PrivacyHistoryEntry[] {
  let others = 0;
  return entries.filter(entry => {
    if (entry.recordType === 'consent' && PARTNER_PURPOSES.has(entry.purpose)) return true;
    others += 1;
    return others <= limit;
  });
}
