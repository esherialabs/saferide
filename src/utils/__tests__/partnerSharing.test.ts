import { describe, expect, it } from 'vitest';

import {
  buildPartnerConsentParagraphs,
  buildPartnerSharingChoice,
  buildSubmissionConfirmationCopy,
  classifyPartnerRoutingFailure,
  describePartnerCaseEvent,
  formatKenyanMobileForDisplay,
  getPartnerSharingAvailability,
  getPartnerSharingFormState,
  getRequestedPartnerSharing,
  hasPartnerConsentAgreement,
  HURIA_PARTNER_STABLE_ID,
  isPartnerSharingApplicable,
  markPartnerSharingWithdrawn,
  normalizeKenyanMobile,
  PARTNER_CALLBACK_CONSENT_VERSION,
  PARTNER_CALLBACK_TEXT_ID,
  PARTNER_FOLLOW_UP_CONSENT_VERSION,
  PARTNER_FOLLOW_UP_TEXT_IDS,
  requirePartnerReconfirmation,
  summarizePartnerSharing,
  withPartnerConsentAgreement,
  type PartnerSharingDraft,
} from '../partnerSharing';

const ON = { routing: true, callback: true };
const SERVER_VERSIONS = {
  partner_follow_up: PARTNER_FOLLOW_UP_CONSENT_VERSION,
  partner_callback: PARTNER_CALLBACK_CONSENT_VERSION,
};
const NOW = new Date('2026-10-21T12:00:00.000Z');

function event(eventType: string, payload: Record<string, unknown>, at: string) {
  return { eventType, payload, createdAt: new Date(at) };
}

function agreedSharing(overrides: Partial<PartnerSharingDraft> = {}): PartnerSharingDraft {
  return {
    partnerStableId: HURIA_PARTNER_STABLE_ID,
    requested: true,
    followUpConsent: {
      version: PARTNER_FOLLOW_UP_CONSENT_VERSION,
      textId: PARTNER_FOLLOW_UP_TEXT_IDS.escalate,
      agreedAt: NOW.toISOString(),
      recordId: '11111111-1111-4111-8111-111111111111',
    },
    ...overrides,
  };
}

describe('partner sharing consent versions', () => {
  it('names the partner, as the API binding requires', () => {
    expect(PARTNER_FOLLOW_UP_CONSENT_VERSION).toMatch(/^partner-follow-up\.ke-coast-huria\.v\d+$/);
    expect(PARTNER_CALLBACK_CONSENT_VERSION).toMatch(/^partner-callback\.ke-coast-huria\.v\d+$/);
  });

  it('moved past the pinned v1 wording and keeps one text id per pathway', () => {
    expect(PARTNER_FOLLOW_UP_CONSENT_VERSION).toBe('partner-follow-up.ke-coast-huria.v3');
    expect(PARTNER_FOLLOW_UP_TEXT_IDS.escalate).not.toBe(PARTNER_FOLLOW_UP_TEXT_IDS.referral);
    expect(Object.values(PARTNER_FOLLOW_UP_TEXT_IDS).every(id => id.startsWith(`${PARTNER_FOLLOW_UP_CONSENT_VERSION}.`))).toBe(true);
  });
});

describe('runtime availability', () => {
  it('is off unless the server reports it at the versions this app shows', () => {
    expect(getPartnerSharingAvailability(undefined)).toEqual({ routing: false, callback: false });
    expect(getPartnerSharingAvailability({}, SERVER_VERSIONS)).toEqual({ routing: false, callback: false });
    expect(getPartnerSharingAvailability({ partnerCallback: true }, SERVER_VERSIONS)).toEqual({ routing: false, callback: false });
    expect(getPartnerSharingAvailability({ partnerRouting: true }, SERVER_VERSIONS)).toEqual({ routing: true, callback: false });
    expect(getPartnerSharingAvailability({ partnerRouting: true, partnerCallback: true }, SERVER_VERSIONS)).toEqual(ON);
  });

  it('hides the choice when the server accepts another consent version, or says nothing about versions', () => {
    const features = { partnerRouting: true, partnerCallback: true };
    expect(getPartnerSharingAvailability(features)).toEqual({ routing: false, callback: false });
    expect(getPartnerSharingAvailability(features, { ...SERVER_VERSIONS, partner_follow_up: 'partner-follow-up.ke-coast-huria.v1' }))
      .toEqual({ routing: false, callback: false });
    expect(getPartnerSharingAvailability(features, { ...SERVER_VERSIONS, partner_callback: 'partner-callback.ke-coast-huria.v9' }))
      .toEqual({ routing: true, callback: false });
  });
});

describe('Kenyan mobile normaliser (mirrors the API)', () => {
  it.each([
    ['0712 345 678', '+254712345678'],
    ['0712-345-678', '+254712345678'],
    ['(0712) 345678', '+254712345678'],
    ['254712345678', '+254712345678'],
    ['+254 712 345 678', '+254712345678'],
    ['0110 123 456', '+254110123456'],
    ['0101123456', '+254101123456'],
  ])('accepts %s', (input, expected) => {
    expect(normalizeKenyanMobile(input)).toBe(expected);
  });

  it.each([
    ['', 'empty'],
    ['020 123 4567', 'a Nairobi landline'],
    ['0121234567', 'an 012 number'],
    ['1195', 'a short code'],
    ['+255712345678', 'a Tanzanian number'],
    ['+44 7700 900123', 'a UK number'],
    ['071234567', 'too short'],
    ['07123456789', 'too long'],
    [`${' '.repeat(15)}0712345678`, 'over the 24-character cap'],
    ['0712 345 678 ext 9', 'an extension'],
    ['0712a45678', 'letters'],
  ])('rejects %s (%s)', input => {
    expect(normalizeKenyanMobile(input)).toBeNull();
  });

  it('formats the stored number for display', () => {
    expect(formatKenyanMobileForDisplay('+254712345678')).toBe('0712 345 678');
    expect(formatKenyanMobileForDisplay('+254110123456')).toBe('0110 123 456');
  });
});

describe('when sharing applies', () => {
  it('applies to escalations and to referrals that name HURIA only', () => {
    expect(isPartnerSharingApplicable({}, 'escalate')).toBe(true);
    expect(isPartnerSharingApplicable({ selectedProvider: HURIA_PARTNER_STABLE_ID }, 'referral')).toBe(true);
    expect(isPartnerSharingApplicable({ selectedProvider: '1195' }, 'referral')).toBe(false);
    expect(isPartnerSharingApplicable({ selectedProvider: HURIA_PARTNER_STABLE_ID }, 'save-private')).toBe(false);
    expect(isPartnerSharingApplicable({}, 'anonymous-map')).toBe(false);
  });

  it('ignores a choice that was not requested, was withdrawn, or no longer applies', () => {
    const sharing = agreedSharing();
    expect(getRequestedPartnerSharing({ partnerSharing: sharing }, 'escalate')).toBe(sharing);
    expect(getRequestedPartnerSharing({ partnerSharing: { ...sharing, requested: false } }, 'escalate')).toBeNull();
    expect(getRequestedPartnerSharing({ partnerSharing: { ...sharing, withdrawnAt: NOW.toISOString() } }, 'escalate')).toBeNull();
    expect(getRequestedPartnerSharing({ partnerSharing: sharing, selectedProvider: '1195' }, 'referral')).toBeNull();
  });
});

describe('recording the choice', () => {
  it('is off by default', () => {
    expect(getPartnerSharingFormState(undefined)).toEqual({ requested: false, callbackRequested: false, phoneInput: '' });
  });

  it('stores a normalised callback number and never a choice the server does not offer', () => {
    const form = { requested: true, callbackRequested: true, phoneInput: '0712 345 678' };
    expect(buildPartnerSharingChoice(null, form, ON)).toEqual({
      ok: true,
      sharing: {
        partnerStableId: HURIA_PARTNER_STABLE_ID,
        requested: true,
        callback: { requested: true, phoneNumber: '+254712345678' },
      },
    });
    expect(buildPartnerSharingChoice(null, form, { routing: true, callback: false })).toEqual({
      ok: true,
      sharing: { partnerStableId: HURIA_PARTNER_STABLE_ID, requested: true },
    });
    expect(buildPartnerSharingChoice(null, form, { routing: false, callback: false })).toEqual({
      ok: true,
      sharing: { partnerStableId: HURIA_PARTNER_STABLE_ID, requested: false },
    });
  });

  it('refuses an invalid callback number', () => {
    expect(buildPartnerSharingChoice(null, { requested: true, callbackRequested: true, phoneInput: '020 123 4567' }, ON))
      .toEqual({ ok: false, error: 'invalid_callback_number' });
  });

  it('keeps an earlier agreement only while nothing shared has changed', () => {
    const previous = withPartnerConsentAgreement(
      { partnerStableId: HURIA_PARTNER_STABLE_ID, requested: true, callback: { requested: true, phoneNumber: '+254712345678' } },
      'escalate',
      NOW,
    );
    const same = buildPartnerSharingChoice(previous, { requested: true, callbackRequested: true, phoneInput: '0712345678' }, ON);
    expect(same.ok && hasPartnerConsentAgreement(same.sharing, 'escalate')).toBe(true);

    const newNumber = buildPartnerSharingChoice(previous, { requested: true, callbackRequested: true, phoneInput: '0722 000 111' }, ON);
    expect(newNumber.ok && newNumber.sharing.followUpConsent).toBeUndefined();
    expect(newNumber.ok && hasPartnerConsentAgreement(newNumber.sharing, 'escalate')).toBe(false);
  });
});

describe('separate consent', () => {
  it('needs the follow-up consent, plus the callback consent when a number is shared', () => {
    const base: PartnerSharingDraft = { partnerStableId: HURIA_PARTNER_STABLE_ID, requested: true };
    expect(hasPartnerConsentAgreement(base, 'escalate')).toBe(false);
    expect(hasPartnerConsentAgreement(withPartnerConsentAgreement(base, 'escalate', NOW), 'escalate')).toBe(true);

    const withCallback = { ...base, callback: { requested: true, phoneNumber: '+254712345678' } };
    const agreed = withPartnerConsentAgreement(withCallback, 'escalate', NOW);
    expect(agreed.followUpConsent).toEqual({
      version: PARTNER_FOLLOW_UP_CONSENT_VERSION,
      textId: PARTNER_FOLLOW_UP_TEXT_IDS.escalate,
      agreedAt: NOW.toISOString(),
    });
    expect(agreed.callback?.consent).toEqual({
      version: PARTNER_CALLBACK_CONSENT_VERSION,
      textId: PARTNER_CALLBACK_TEXT_ID,
      agreedAt: NOW.toISOString(),
    });
    expect(hasPartnerConsentAgreement(agreed, 'escalate')).toBe(true);
    expect(hasPartnerConsentAgreement({ ...agreed, callback: { ...agreed.callback!, consent: undefined } }, 'escalate')).toBe(false);
    expect(hasPartnerConsentAgreement({
      ...agreed,
      followUpConsent: { version: 'partner-follow-up.ke-coast-huria.v1', textId: PARTNER_FOLLOW_UP_TEXT_IDS.escalate, agreedAt: NOW.toISOString() },
    }, 'escalate')).toBe(false);
  });

  it('ties the agreement to the wording shown for the pathway', () => {
    const agreed = withPartnerConsentAgreement({ partnerStableId: HURIA_PARTNER_STABLE_ID, requested: true }, 'escalate', NOW);
    expect(hasPartnerConsentAgreement(agreed, 'escalate')).toBe(true);
    expect(hasPartnerConsentAgreement(agreed, 'referral')).toBe(false);
  });

  it('never counts a withdrawn choice as agreed, and drops the number on withdrawal', () => {
    const agreed = withPartnerConsentAgreement(
      { partnerStableId: HURIA_PARTNER_STABLE_ID, requested: true, callback: { requested: true, phoneNumber: '+254712345678' } },
      'escalate',
      NOW,
    );
    const callbackOnly = markPartnerSharingWithdrawn(agreed, 'callback', NOW);
    expect(callbackOnly.withdrawnAt).toBeUndefined();
    expect(callbackOnly.callback).toMatchObject({ withdrawnAt: NOW.toISOString(), phoneNumber: undefined });
    expect(hasPartnerConsentAgreement(callbackOnly, 'escalate')).toBe(false);

    const all = markPartnerSharingWithdrawn(agreed, 'follow_up', NOW);
    expect(all.withdrawnAt).toBe(NOW.toISOString());
    expect(all.callback?.phoneNumber).toBeUndefined();
    expect(hasPartnerConsentAgreement(all, 'escalate')).toBe(false);
  });

  it('drops agreement and server records when the survivor must confirm again', () => {
    const agreed = withPartnerConsentAgreement(
      { partnerStableId: HURIA_PARTNER_STABLE_ID, requested: true, callback: { requested: true, phoneNumber: '+254712345678' } },
      'escalate',
      NOW,
    );
    const reset = requirePartnerReconfirmation(agreed, 'partner_consent_missing', NOW);
    expect(reset).toEqual({
      partnerStableId: HURIA_PARTNER_STABLE_ID,
      requested: true,
      callback: { requested: true, phoneNumber: '+254712345678' },
      outcome: { status: 'needs_confirmation', reason: 'partner_consent_missing', at: NOW.toISOString() },
    });
    expect(hasPartnerConsentAgreement(reset, 'escalate')).toBe(false);
  });
});

describe('consent text', () => {
  it('names HURIA, what it sees, that evidence files are not shared yet, and withdrawal', () => {
    for (const pathway of ['escalate', 'referral'] as const) {
      const text = buildPartnerConsentParagraphs({ pathway, redactionLabel: 'Heavy' }).join(' ');
      expect(text).toContain('HURIA');
      expect(text).toMatch(/Evidence files .* are not shared with HURIA yet\./);
      expect(text).toMatch(/stop sharing at any time/);
      expect(text).toMatch(/HURIA then loses access/);
      expect(text).toMatch(/never sees? your exact/);
      expect(text).toContain('phone number or email of your SafeRide account');
      expect(text).toContain('only if you choose to add a callback number');
      expect(text).not.toMatch(/cannot contact you/);
    }
    const escalation = buildPartnerConsentParagraphs({ pathway: 'escalate', redactionLabel: 'Heavy' })[0];
    expect(escalation).toContain('at the redaction level you chose (Heavy)');
    expect(escalation).toContain('your alias if you chose one');
    expect(escalation).toContain('including your descriptions and transcripts of any recordings (with the masking you chose), but not the files themselves');
    const referral = buildPartnerConsentParagraphs({ pathway: 'referral' })[0];
    expect(referral).toContain('same reviewed report packet used for escalation');
    expect(referral).toContain('If support details are off, the packet contains no report details or evidence list');
  });
});

describe('409 and 503 handling', () => {
  it('downgrades only on 503 partner_unavailable, and drops only the callback on partner_callback_unavailable', () => {
    expect(classifyPartnerRoutingFailure({ status: 503, details: { reason: 'partner_unavailable' } })).toEqual({ kind: 'unavailable' });
    expect(classifyPartnerRoutingFailure({ status: 503, details: { reason: 'partner_callback_unavailable' } }))
      .toEqual({ kind: 'callback_unavailable' });
    for (const reason of ['case_ingestion_disabled', 'privacy_controls_unavailable', 'pathway_consent_disabled']) {
      expect(classifyPartnerRoutingFailure({ status: 503, details: { reason } })).toBeNull();
    }
    expect(classifyPartnerRoutingFailure({ status: 503 })).toBeNull();
  });

  it('maps the three 409 reasons and nothing else', () => {
    for (const reason of ['partner_not_accepting', 'partner_consent_missing', 'callback_consent_missing']) {
      expect(classifyPartnerRoutingFailure({ status: 409, details: { reason } })).toEqual({ kind: 'conflict', reason });
    }
    expect(classifyPartnerRoutingFailure({ status: 409 })).toBeNull();
    expect(classifyPartnerRoutingFailure({ status: 409, details: { reason: 'stale' } })).toBeNull();
    expect(classifyPartnerRoutingFailure({ status: 400 })).toBeNull();
    expect(classifyPartnerRoutingFailure(new Error('network'))).toBeNull();
  });
});

describe('partner status shown to the survivor', () => {
  it('describes routing and each partner status in plain language', () => {
    expect(describePartnerCaseEvent(event('partner_routed', {
      partner: HURIA_PARTNER_STABLE_ID, reference: 'SR-7K3Q-9M2D', partner_status: 'new', callback_shared: false,
    }, '2026-10-21T10:00:00Z'))).toMatchObject({ title: 'Shared with HURIA', reference: 'SR-7K3Q-9M2D', partnerStatus: 'new' });

    const titles = ['acknowledged', 'in_progress', 'referred_onward', 'closed'].map(status => describePartnerCaseEvent(event(
      'status_change',
      { new_status: 'in_review', actor: 'partner', partner: HURIA_PARTNER_STABLE_ID, partner_status: status },
      '2026-10-21T11:00:00Z',
    ))?.title);
    expect(titles).toEqual([
      'HURIA has received your case',
      'HURIA is working on it',
      'HURIA referred you onward',
      'Closed by HURIA',
    ]);
  });

  it('leaves non-partner events and unknown partners to the existing timeline', () => {
    expect(describePartnerCaseEvent(event('status_change', { new_status: 'in_review' }, '2026-10-21T11:00:00Z'))).toBeNull();
    expect(describePartnerCaseEvent(event('status_change', {
      actor: 'partner', partner: 'someone-else', partner_status: 'closed',
    }, '2026-10-21T11:00:00Z'))).toBeNull();
    expect(describePartnerCaseEvent(event('submission', { partner: HURIA_PARTNER_STABLE_ID }, '2026-10-21T11:00:00Z'))).toBeNull();
  });

  it('summarises the latest status with the reference and the stop-sharing action', () => {
    const events = [
      event('partner_routed', { partner: HURIA_PARTNER_STABLE_ID, reference: 'SR-7K3Q-9M2D', partner_status: 'new', callback_shared: true }, '2026-10-21T10:00:00Z'),
      event('status_change', { actor: 'partner', partner: HURIA_PARTNER_STABLE_ID, partner_status: 'in_progress' }, '2026-10-21T12:00:00Z'),
      event('status_change', { actor: 'partner', partner: HURIA_PARTNER_STABLE_ID, partner_status: 'acknowledged' }, '2026-10-21T11:00:00Z'),
    ];
    expect(summarizePartnerSharing({ events, sharing: agreedSharing() })).toEqual({
      state: 'in_progress',
      label: 'HURIA is working on it',
      reference: 'SR-7K3Q-9M2D',
      callbackShared: true,
      stopSharing: 'available',
      attentionMessage: null,
    });
    expect(summarizePartnerSharing({ events, sharing: null })?.stopSharing).toBe('all_reports');
    expect(summarizePartnerSharing({ events, sharing: agreedSharing({ withdrawnAt: NOW.toISOString() }) })).toMatchObject({
      state: 'withdrawn',
      label: 'You stopped sharing with HURIA',
      callbackShared: false,
      stopSharing: 'not_applicable',
    });
  });

  it('shows a withdrawal recorded before sending, and no callback after the callback is withdrawn', () => {
    expect(summarizePartnerSharing({
      events: [],
      sharing: { partnerStableId: HURIA_PARTNER_STABLE_ID, requested: true, withdrawnAt: NOW.toISOString() },
    })).toMatchObject({ state: 'withdrawn', stopSharing: 'not_applicable' });
    const events = [
      event('partner_routed', { partner: HURIA_PARTNER_STABLE_ID, reference: 'SR-7K3Q-9M2D', partner_status: 'new', callback_shared: true }, '2026-10-21T10:00:00Z'),
    ];
    const sharing = markPartnerSharingWithdrawn(
      agreedSharing({ callback: { requested: true, consent: { version: PARTNER_CALLBACK_CONSENT_VERSION, agreedAt: NOW.toISOString(), recordId: '22222222-2222-4222-8222-222222222222' } } }),
      'callback',
      NOW,
    );
    expect(summarizePartnerSharing({ events, sharing })).toMatchObject({ state: 'new', callbackShared: false, stopSharing: 'available' });
  });

  it('falls back to what this phone recorded before any event arrives', () => {
    expect(summarizePartnerSharing({ events: [], sharing: null })).toBeNull();
    expect(summarizePartnerSharing({ events: [], sharing: { partnerStableId: HURIA_PARTNER_STABLE_ID, requested: false } })).toBeNull();
    expect(summarizePartnerSharing({ events: [], sharing: { partnerStableId: HURIA_PARTNER_STABLE_ID, requested: true } })?.state)
      .toBe('pending');
    expect(summarizePartnerSharing({
      events: [],
      sharing: agreedSharing({ outcome: { status: 'routed', reference: 'SR-AAAA-BBBB', partnerStatus: 'new', callbackShared: false, at: NOW.toISOString() } }),
    })).toMatchObject({ state: 'new', label: 'Waiting for HURIA', reference: 'SR-AAAA-BBBB', stopSharing: 'available' });
    expect(summarizePartnerSharing({
      events: [],
      sharing: agreedSharing({ outcome: { status: 'unavailable', at: NOW.toISOString() } }),
    })).toMatchObject({ state: 'unavailable', stopSharing: 'not_applicable' });
    expect(summarizePartnerSharing({
      events: [],
      sharing: agreedSharing({ outcome: { status: 'needs_confirmation', reason: 'partner_not_accepting', at: NOW.toISOString() } }),
    })).toMatchObject({ state: 'needsAttention', attentionMessage: expect.stringContaining('not accepting new reports') });
  });
});

describe('submission confirmation wording', () => {
  it('says Sent to SafeRide, never Delivered, and that no partner got it', () => {
    const copy = buildSubmissionConfirmationCopy({ isOffline: false, sharing: null });
    expect(copy.statusLabel).toBe('Sent to SafeRide');
    expect(copy.subtitle).toBe('Your report was sent to SafeRide. It has not been shared with any partner.');
    expect(JSON.stringify(copy)).not.toMatch(/deliver/i);
  });

  it('adds the HURIA dashboard line and the reference to quote when routed', () => {
    const copy = buildSubmissionConfirmationCopy({
      isOffline: false,
      sharing: agreedSharing({ outcome: { status: 'routed', reference: 'SR-7K3Q-9M2D', partnerStatus: 'new', callbackShared: true, at: NOW.toISOString() } }),
    });
    expect(copy).toEqual({
      statusLabel: 'Sent to SafeRide',
      title: 'Sent to SafeRide',
      subtitle: 'Sent to SafeRide. HURIA will see it in their secure dashboard.',
      reference: 'SR-7K3Q-9M2D',
      referenceHint: 'To talk to HURIA, call 0769 546 253 and quote this reference.',
      callbackNote: 'HURIA may call you on the number you shared.',
    });
  });

  it('says plainly when HURIA sharing was unavailable', () => {
    const copy = buildSubmissionConfirmationCopy({
      isOffline: false,
      sharing: agreedSharing({ outcome: { status: 'unavailable', at: NOW.toISOString() } }),
    });
    expect(copy.subtitle).toContain('sent to SafeRide only');
    expect(copy.reference).toBeNull();
  });

  it('says the number was not shared when only the callback was unavailable', () => {
    const copy = buildSubmissionConfirmationCopy({
      isOffline: false,
      sharing: agreedSharing({
        callbackDropped: true,
        outcome: { status: 'routed', reference: 'SR-7K3Q-9M2D', partnerStatus: 'new', callbackShared: false, callbackNotShared: true, at: NOW.toISOString() },
      }),
    });
    expect(copy.callbackNote).toContain('Your callback number was not shared');
  });

  it('stays neutral about partners until the local record is known', () => {
    const copy = buildSubmissionConfirmationCopy({ isOffline: false, sharing: null, sharingKnown: false });
    expect(copy.subtitle).toBe('Your report was sent to SafeRide.');
    expect(copy.subtitle).not.toMatch(/partner/);
    expect(buildSubmissionConfirmationCopy({ isOffline: true, sharing: null, sharingKnown: false }).subtitle)
      .toBe("We'll send it to SafeRide when you're online.");
  });

  it('says a withdrawn choice went to SafeRide only', () => {
    const copy = buildSubmissionConfirmationCopy({
      isOffline: false,
      sharing: { partnerStableId: HURIA_PARTNER_STABLE_ID, requested: true, withdrawnAt: NOW.toISOString() },
    });
    expect(copy.subtitle).toContain('You withdrew your HURIA consent before this report was sent');
  });

  it('keeps queued wording accurate', () => {
    expect(buildSubmissionConfirmationCopy({ isOffline: true, sharing: null })).toMatchObject({
      statusLabel: 'Queued on this phone',
      title: 'Queued to send',
      subtitle: "We'll send it to SafeRide when you're online.",
    });
    expect(buildSubmissionConfirmationCopy({ isOffline: true, sharing: agreedSharing() }).subtitle)
      .toContain('if sharing with HURIA is still available');
  });
});
