import { describe, expect, it } from 'vitest';

import type { ConsentLedgerEntry, PrivacyHistoryEntry } from '../consentLedger';
import {
  describeConsentEntry,
  getConsentPurposeLabel,
  selectPrivacyHistoryForDisplay,
} from '../privacyHistoryDisplay';

function consent(id: string, purpose: ConsentLedgerEntry['purpose'], overrides: Partial<ConsentLedgerEntry> = {}): ConsentLedgerEntry {
  return {
    id,
    recordType: 'consent',
    purpose,
    version: 'v1',
    status: 'granted',
    grantedAt: '2026-10-21T10:00:00.000Z',
    ...overrides,
  };
}

describe('privacy history display', () => {
  it('uses plain-language labels instead of raw purpose codes', () => {
    expect(getConsentPurposeLabel('partner_follow_up')).toBe('Sharing a report with HURIA');
    expect(getConsentPurposeLabel('partner_callback')).toBe('HURIA may call you back');
    const format = () => '21 Oct 2026';
    expect(describeConsentEntry(consent('a', 'partner_follow_up'), format)).toBe('Sharing a report with HURIA: active · 21 Oct 2026');
    expect(describeConsentEntry(consent('b', 'partner_callback', { status: 'withdrawn', remoteWithdrawalStatus: 'pending' }), format))
      .toBe('HURIA may call you back: withdrawal not yet confirmed by the server · 21 Oct 2026');
    expect(describeConsentEntry(consent('c', 'pathway_submission', { status: 'withdrawn' }), format))
      .toBe('Report pathway choice: withdrawn · 21 Oct 2026');
    expect(describeConsentEntry(consent('d', 'partner_follow_up'), format)).not.toContain('partner_follow_up');
  });

  it('never hides a HURIA consent behind the 10-record cap', () => {
    const entries: PrivacyHistoryEntry[] = [
      ...Array.from({ length: 12 }, (_, index) => consent(`pathway-${index}`, 'pathway_submission')),
      consent('huria-old', 'partner_follow_up'),
      consent('huria-callback-old', 'partner_callback'),
    ];
    const shown = selectPrivacyHistoryForDisplay(entries);
    expect(shown.map(entry => entry.id)).toEqual([
      ...Array.from({ length: 10 }, (_, index) => `pathway-${index}`),
      'huria-old',
      'huria-callback-old',
    ]);
  });
});
