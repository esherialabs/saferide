import AsyncStorage from '@react-native-async-storage/async-storage';
import { describe, expect, it } from 'vitest';

import { encryptedAsyncStorage } from '../../lib/encryptedAsyncStorage';
import {
  assertActivePathwayConsent,
  confirmRemoteConsentWithdrawal,
  listPrivacyHistory,
  LOCAL_POLICY_DOCUMENTS,
  recordAnonymousAggregateConsent,
  recordPathwayConsent,
  recordPolicyAcceptance,
  getConsentLedgerStatuses,
  recordServerConsent,
  resolveAnonymousAggregateConsent,
  withdrawConsent,
} from '../consentLedger';
import { PRIVACY_CONSENT_LEDGER_KEY } from '../storageKeys';

describe('local privacy history', () => {
  it('stores pathway consent separately in an encrypted ledger and records future-only withdrawal', async () => {
    const consent = await recordPathwayConsent({ pathway: 'referral', now: new Date('2026-07-30T10:00:00Z') });
    const raw = await AsyncStorage.getItem(PRIVACY_CONSENT_LEDGER_KEY);
    expect(raw).not.toContain('referral');
    expect(await listPrivacyHistory()).toEqual([consent]);
    await expect(assertActivePathwayConsent({
      recordId: consent.id,
      pathway: 'referral',
      version: consent.version,
      grantedAt: consent.grantedAt,
    })).resolves.toEqual(consent);
    const withdrawn = await withdrawConsent(consent.id, new Date('2026-07-30T11:00:00Z'));
    expect(withdrawn).toMatchObject({ status: 'withdrawn', withdrawalEffect: 'future_processing_only' });
    expect(withdrawn.externalSharingWarning).toContain('cannot be recalled');
    await expect(assertActivePathwayConsent({
      recordId: consent.id,
      pathway: 'referral',
      version: consent.version,
      grantedAt: consent.grantedAt,
    })).rejects.toThrow(/withdrawn/);
  });

  it('rejects policy acceptance while the versioned legal documents are pending', async () => {
    for (const document of LOCAL_POLICY_DOCUMENTS) {
      await expect(recordPolicyAcceptance(document)).rejects.toThrow(/not approved/);
    }
    expect(await listPrivacyHistory()).toEqual([]);
  });

  it('reuses a retry-safe aggregate checkpoint and records remote withdrawal state', async () => {
    const first = await recordAnonymousAggregateConsent({
      version: 'aggregate-consent.v1',
      now: new Date('2026-07-30T10:00:00Z'),
    });
    await expect(resolveAnonymousAggregateConsent({
      checkpoint: first,
      version: 'aggregate-consent.v1',
    })).resolves.toEqual(first);

    const withdrawn = await withdrawConsent(first.recordId, new Date('2026-07-30T11:00:00Z'));
    expect(withdrawn).toMatchObject({
      purpose: 'anonymous_aggregate',
      status: 'withdrawn',
      remoteWithdrawalStatus: 'pending',
    });
    const confirmed = await confirmRemoteConsentWithdrawal(first.recordId);
    expect(confirmed.remoteWithdrawalStatus).toBe('confirmed');

    const regranted = await resolveAnonymousAggregateConsent({
      checkpoint: first,
      version: 'aggregate-consent.v1',
      now: new Date('2026-07-30T12:00:00Z'),
    });
    expect(regranted.recordId).not.toBe(first.recordId);
    expect(regranted.ingestionId).not.toBe(first.ingestionId);
  });

  it('rejects corrupt history and missing consent checkpoints', async () => {
    await encryptedAsyncStorage.setItem(PRIVACY_CONSENT_LEDGER_KEY, JSON.stringify({ invalid: true }));
    await expect(listPrivacyHistory()).rejects.toThrow(/corrupt/);
    await encryptedAsyncStorage.removeItem(PRIVACY_CONSENT_LEDGER_KEY);
    await expect(withdrawConsent('missing')).rejects.toThrow(/not found/);
    await expect(assertActivePathwayConsent({
      recordId: 'missing',
      pathway: 'save-private',
      version: 'pathway-consent.v1',
      grantedAt: '2026-07-30T00:00:00.000Z',
    })).rejects.toThrow(/missing/);
  });

  it('records approved policy acceptance, sorts mixed history, and keeps withdrawal retry-safe', async () => {
    const earlyConsent = await recordPathwayConsent({
      pathway: 'save-private',
      version: 'pathway-consent.synthetic-v2',
      now: new Date('2026-07-30T08:00:00Z'),
    });
    const accepted = await recordPolicyAcceptance({
      documentType: 'privacy-policy',
      version: 'synthetic-approved-v1',
      locale: 'en',
      sha256: 'a'.repeat(64),
      effectiveDate: '2026-07-30',
      reviewStatus: 'approved',
      acceptanceEnabled: true,
    }, new Date('2026-07-30T10:00:00Z'));
    expect((await listPrivacyHistory()).map(entry => entry.id)).toEqual([accepted.id, earlyConsent.id]);

    const first = await withdrawConsent(earlyConsent.id, new Date('2026-07-30T11:00:00Z'));
    const second = await withdrawConsent(earlyConsent.id, new Date('2026-07-30T12:00:00Z'));
    expect(second).toEqual(first);
    await expect(assertActivePathwayConsent({
      recordId: earlyConsent.id,
      pathway: 'anonymous-map',
      version: earlyConsent.version,
      grantedAt: earlyConsent.grantedAt,
    })).rejects.toThrow(/does not match/);
  });

  it('mirrors server-held partner consents under the server id and tracks their remote withdrawal', async () => {
    const id = '22222222-2222-4222-8222-222222222222';
    const params = {
      id,
      purpose: 'partner_follow_up' as const,
      version: 'partner-follow-up.ke-coast-huria.v1',
      grantedAt: '2026-10-21T10:00:00.000Z',
      pathway: 'escalate' as const,
    };
    const recorded = await recordServerConsent(params);
    expect(recorded).toMatchObject({ id, purpose: 'partner_follow_up', status: 'granted' });
    await expect(recordServerConsent(params)).resolves.toEqual(recorded);
    await expect(recordServerConsent({ ...params, purpose: 'partner_callback' })).rejects.toThrow(/different privacy record/);
    expect(await listPrivacyHistory()).toEqual([recorded]);

    const withdrawn = await withdrawConsent(id, new Date('2026-10-21T11:00:00Z'));
    expect(withdrawn).toMatchObject({ status: 'withdrawn', remoteWithdrawalStatus: 'pending' });
    await expect(confirmRemoteConsentWithdrawal(id)).resolves.toMatchObject({ remoteWithdrawalStatus: 'confirmed' });
  });

  it('reports each consent as granted, pending withdrawal, withdrawn or missing', async () => {
    const granted = await recordServerConsent({
      id: '33333333-3333-4333-8333-333333333333',
      purpose: 'partner_follow_up',
      version: 'partner-follow-up.ke-coast-huria.v2',
      textId: 'partner-follow-up.ke-coast-huria.v2.escalation',
      grantedAt: '2026-10-21T10:00:00.000Z',
    });
    expect(granted).toMatchObject({ textId: 'partner-follow-up.ke-coast-huria.v2.escalation' });
    expect(granted).not.toHaveProperty('pathway');
    const pending = await recordServerConsent({
      id: '44444444-4444-4444-8444-444444444444',
      purpose: 'partner_callback',
      version: 'partner-callback.ke-coast-huria.v1',
      grantedAt: '2026-10-21T10:00:00.000Z',
    });
    expect(pending).not.toHaveProperty('textId');
    await withdrawConsent(pending.id);
    const local = await recordPathwayConsent({ pathway: 'escalate' });
    await withdrawConsent(local.id);

    await expect(getConsentLedgerStatuses([granted.id, pending.id, local.id, 'not-on-this-phone'])).resolves.toEqual({
      [granted.id]: 'granted',
      [pending.id]: 'withdrawal_pending',
      [local.id]: 'withdrawn',
      'not-on-this-phone': 'missing',
    });
    await expect(getConsentLedgerStatuses([])).resolves.toEqual({});
  });

  it('confirms a remote withdrawal only for a withdrawn server-held consent', async () => {
    const local = await recordPathwayConsent({ pathway: 'referral' });
    await withdrawConsent(local.id);
    await expect(confirmRemoteConsentWithdrawal(local.id)).rejects.toThrow(/server-held consent/);

    const partner = await recordServerConsent({
      id: '55555555-5555-4555-8555-555555555555',
      purpose: 'partner_follow_up',
      version: 'partner-follow-up.ke-coast-huria.v2',
      grantedAt: '2026-10-21T10:00:00.000Z',
    });
    await expect(confirmRemoteConsentWithdrawal(partner.id)).rejects.toThrow(/server-held consent/);
    await expect(confirmRemoteConsentWithdrawal('missing-id')).rejects.toThrow(/not found/);
  });
});

