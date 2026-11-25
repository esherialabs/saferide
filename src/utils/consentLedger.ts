import * as Crypto from 'expo-crypto';

import { encryptedAsyncStorage } from '../lib/encryptedAsyncStorage';
import { PRIVACY_CONSENT_LEDGER_KEY } from './storageKeys';

export type ConsentPurpose =
  | 'pathway_submission'
  | 'anonymous_aggregate'
  | 'analytics'
  | 'research'
  | 'model_training'
  | 'partner_follow_up'
  | 'partner_callback';

/** Purposes whose record lives on the SafeRide server, so withdrawal must reach it too. */
export const REMOTE_WITHDRAWAL_PURPOSES: readonly ConsentPurpose[] = [
  'anonymous_aggregate',
  'partner_follow_up',
  'partner_callback',
];

export function requiresRemoteWithdrawal(purpose: ConsentPurpose): boolean {
  return REMOTE_WITHDRAWAL_PURPOSES.includes(purpose);
}
export type ConsentLedgerEntry = {
  id: string;
  recordType: 'consent';
  purpose: ConsentPurpose;
  version: string;
  /** The exact wording agreed to, when one version has several (partner sharing). */
  textId?: string;
  status: 'granted' | 'withdrawn';
  pathway?: 'save-private' | 'anonymous-map' | 'referral' | 'escalate';
  grantedAt: string;
  withdrawnAt?: string;
  withdrawalEffect?: 'future_processing_only';
  externalSharingWarning?: string;
  remoteWithdrawalStatus?: 'pending' | 'confirmed';
};
export type AnonymousAggregateConsentCheckpoint = {
  recordId: string;
  purpose: 'anonymous_aggregate';
  version: string;
  grantedAt: string;
  ingestionId: string;
};
export type PolicyAcceptanceEntry = {
  id: string;
  recordType: 'policy_acceptance';
  documentType: 'privacy-policy' | 'terms';
  version: string;
  locale: string;
  sha256: string;
  acceptedAt: string;
};
export type PrivacyHistoryEntry = ConsentLedgerEntry | PolicyAcceptanceEntry;

export type LocalPolicyDocument = {
  documentType: 'privacy-policy' | 'terms';
  version: string;
  locale: string;
  sha256: string;
  effectiveDate: string | null;
  reviewStatus: 'pending_legal' | 'approved' | 'retired';
  acceptanceEnabled: boolean;
};

export const LOCAL_POLICY_DOCUMENTS: LocalPolicyDocument[] = [
  {
    documentType: 'privacy-policy',
    version: '2026-07-draft.1',
    locale: 'en',
    sha256: 'a963d39da588baa5f440804a40033fbf600ce0d9dbda3243bed89105f6c4f335',
    effectiveDate: null,
    reviewStatus: 'pending_legal',
    acceptanceEnabled: false,
  },
  {
    documentType: 'terms',
    version: '2026-07-draft.1',
    locale: 'en',
    sha256: '337247e83deae0aeb47c888e72ffe59f126956e49492cb812b0af2a6dda6b1a4',
    effectiveDate: null,
    reviewStatus: 'pending_legal',
    acceptanceEnabled: false,
  },
];

async function readLedger(): Promise<PrivacyHistoryEntry[]> {
  const raw = await encryptedAsyncStorage.getItem(PRIVACY_CONSENT_LEDGER_KEY);
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('Privacy history is corrupt.');
  return parsed as PrivacyHistoryEntry[];
}

async function writeLedger(entries: PrivacyHistoryEntry[]): Promise<void> {
  await encryptedAsyncStorage.setItem(PRIVACY_CONSENT_LEDGER_KEY, JSON.stringify(entries));
}

export async function listPrivacyHistory(): Promise<PrivacyHistoryEntry[]> {
  return (await readLedger()).sort((a, b) => {
    const aDate = a.recordType === 'consent' ? a.grantedAt : a.acceptedAt;
    const bDate = b.recordType === 'consent' ? b.grantedAt : b.acceptedAt;
    return bDate.localeCompare(aDate);
  });
}

export async function recordPathwayConsent(params: {
  pathway: NonNullable<ConsentLedgerEntry['pathway']>;
  version?: string;
  now?: Date;
}): Promise<ConsentLedgerEntry> {
  const entry: ConsentLedgerEntry = {
    id: Crypto.randomUUID(),
    recordType: 'consent',
    purpose: 'pathway_submission',
    version: params.version ?? 'pathway-consent.v1',
    status: 'granted',
    pathway: params.pathway,
    grantedAt: (params.now ?? new Date()).toISOString(),
  };
  const entries = await readLedger();
  await writeLedger([...entries, entry]);
  return entry;
}

export async function recordAnonymousAggregateConsent(params: {
  version: string;
  now?: Date;
}): Promise<AnonymousAggregateConsentCheckpoint> {
  const entry: ConsentLedgerEntry = {
    id: Crypto.randomUUID(),
    recordType: 'consent',
    purpose: 'anonymous_aggregate',
    version: params.version,
    status: 'granted',
    pathway: 'anonymous-map',
    grantedAt: (params.now ?? new Date()).toISOString(),
  };
  const entries = await readLedger();
  await writeLedger([...entries, entry]);
  return {
    recordId: entry.id,
    purpose: 'anonymous_aggregate',
    version: entry.version,
    grantedAt: entry.grantedAt,
    ingestionId: Crypto.randomUUID(),
  };
}

export async function resolveAnonymousAggregateConsent(params: {
  checkpoint?: AnonymousAggregateConsentCheckpoint;
  version: string;
  now?: Date;
}): Promise<AnonymousAggregateConsentCheckpoint> {
  if (!params.checkpoint || params.checkpoint.version !== params.version) {
    return recordAnonymousAggregateConsent({ version: params.version, now: params.now });
  }
  const entries = await readLedger();
  const entry = entries.find(candidate =>
    candidate.recordType === 'consent' && candidate.id === params.checkpoint?.recordId,
  );
  if (
    !entry ||
    entry.recordType !== 'consent' ||
    entry.purpose !== 'anonymous_aggregate' ||
    entry.version !== params.version ||
    entry.grantedAt !== params.checkpoint.grantedAt
  ) {
    throw new Error('The anonymous aggregate consent checkpoint is missing or does not match this submission.');
  }
  if (entry.status === 'withdrawn') {
    return recordAnonymousAggregateConsent({ version: params.version, now: params.now });
  }
  return params.checkpoint;
}

/**
 * Mirrors a consent the server just recorded (POST /api/privacy/consents)
 * under the server's id, so it shows in Privacy & data and can be
 * withdrawn from there. Recording the same id again is a no-op.
 */
export async function recordServerConsent(params: {
  id: string;
  purpose: 'partner_follow_up' | 'partner_callback';
  version: string;
  textId?: string;
  grantedAt: string;
  pathway?: NonNullable<ConsentLedgerEntry['pathway']>;
}): Promise<ConsentLedgerEntry> {
  const entries = await readLedger();
  const existing = entries.find(entry => entry.recordType === 'consent' && entry.id === params.id);
  if (existing) {
    if (existing.recordType !== 'consent' || existing.purpose !== params.purpose) {
      throw new Error('A different privacy record already uses this consent id.');
    }
    return existing;
  }
  const entry: ConsentLedgerEntry = {
    id: params.id,
    recordType: 'consent',
    purpose: params.purpose,
    version: params.version,
    ...(params.textId ? { textId: params.textId } : {}),
    status: 'granted',
    ...(params.pathway ? { pathway: params.pathway } : {}),
    grantedAt: params.grantedAt,
  };
  await writeLedger([...entries, entry]);
  return entry;
}

export type ConsentLedgerStatus = 'granted' | 'withdrawn' | 'withdrawal_pending' | 'missing';

/**
 * Where each consent id stands on this phone. A withdrawal counts from the
 * moment it is recorded locally, before the server confirms it, so nothing
 * is shared on the strength of a consent the survivor has taken back.
 */
export async function getConsentLedgerStatuses(ids: string[]): Promise<Record<string, ConsentLedgerStatus>> {
  const entries = await readLedger();
  const statuses: Record<string, ConsentLedgerStatus> = {};
  for (const id of ids) {
    const entry = entries.find(candidate => candidate.recordType === 'consent' && candidate.id === id);
    if (!entry || entry.recordType !== 'consent') statuses[id] = 'missing';
    else if (entry.status === 'granted') statuses[id] = 'granted';
    else statuses[id] = entry.remoteWithdrawalStatus === 'pending' ? 'withdrawal_pending' : 'withdrawn';
  }
  return statuses;
}

export async function assertActivePathwayConsent(params: {
  recordId: string;
  pathway: NonNullable<ConsentLedgerEntry['pathway']>;
  version: string;
  grantedAt: string;
}): Promise<ConsentLedgerEntry> {
  const entries = await readLedger();
  const entry = entries.find(candidate => candidate.recordType === 'consent' && candidate.id === params.recordId);
  if (
    !entry ||
    entry.recordType !== 'consent' ||
    entry.status !== 'granted' ||
    entry.purpose !== 'pathway_submission' ||
    entry.pathway !== params.pathway ||
    entry.version !== params.version ||
    entry.grantedAt !== params.grantedAt
  ) {
    throw new Error('The pathway consent checkpoint is missing, withdrawn, or does not match this submission.');
  }
  return entry;
}

export async function withdrawConsent(consentId: string, now = new Date()): Promise<ConsentLedgerEntry> {
  const entries = await readLedger();
  const index = entries.findIndex(entry => entry.recordType === 'consent' && entry.id === consentId);
  if (index < 0 || entries[index].recordType !== 'consent') throw new Error('Consent record not found.');
  const current = entries[index] as ConsentLedgerEntry;
  if (current.status === 'withdrawn') return current;
  const withdrawn: ConsentLedgerEntry = {
    ...current,
    status: 'withdrawn',
    withdrawnAt: now.toISOString(),
    withdrawalEffect: 'future_processing_only',
    externalSharingWarning: 'Information already shared outside SafeRide cannot be recalled by this withdrawal.',
    remoteWithdrawalStatus: requiresRemoteWithdrawal(current.purpose) ? 'pending' : undefined,
  };
  entries[index] = withdrawn;
  await writeLedger(entries);
  return withdrawn;
}

export async function confirmRemoteConsentWithdrawal(consentId: string): Promise<ConsentLedgerEntry> {
  const entries = await readLedger();
  const index = entries.findIndex(entry => entry.recordType === 'consent' && entry.id === consentId);
  if (index < 0 || entries[index].recordType !== 'consent') throw new Error('Consent record not found.');
  const current = entries[index] as ConsentLedgerEntry;
  if (!requiresRemoteWithdrawal(current.purpose) || current.status !== 'withdrawn') {
    throw new Error('Remote withdrawal can only confirm a withdrawn server-held consent.');
  }
  const confirmed: ConsentLedgerEntry = { ...current, remoteWithdrawalStatus: 'confirmed' };
  entries[index] = confirmed;
  await writeLedger(entries);
  return confirmed;
}

export async function recordPolicyAcceptance(document: LocalPolicyDocument, now = new Date()): Promise<PolicyAcceptanceEntry> {
  if (!document.acceptanceEnabled || document.reviewStatus !== 'approved' || !document.effectiveDate) {
    throw new Error('This policy document is not approved for acceptance.');
  }
  const entry: PolicyAcceptanceEntry = {
    id: Crypto.randomUUID(),
    recordType: 'policy_acceptance',
    documentType: document.documentType,
    version: document.version,
    locale: document.locale,
    sha256: document.sha256,
    acceptedAt: now.toISOString(),
  };
  const entries = await readLedger();
  await writeLedger([...entries, entry]);
  return entry;
}
