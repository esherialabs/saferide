import { describe, expect, it } from 'vitest';

import { formatPartnerCopy, getPartnerSharingCopy, PARTNER_SHARING_COPY } from '../partnerSharingCopy';

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

describe('partner sharing copy', () => {
  it('serves the English source copy for every language until a reviewed pack exists', () => {
    expect(getPartnerSharingCopy()).toBe(PARTNER_SHARING_COPY);
    expect(getPartnerSharingCopy('sw')).toBe(PARTNER_SHARING_COPY);
  });

  it('uses the opt-in wording agreed for HURIA', () => {
    expect(PARTNER_SHARING_COPY.optIn.toggleLabel)
      .toBe("Also share with HURIA (Human Rights Agenda), SafeRide's partner on the Coast");
    expect(PARTNER_SHARING_COPY.partnerPhone).toBe('0769 546 253');
  });

  it('states the callback rules and the safety tip', () => {
    expect(PARTNER_SHARING_COPY.callback.body).toContain('HURIA staff may call you on this number');
    expect(PARTNER_SHARING_COPY.callback.body).toContain('Authorised HURIA caseworkers can see it');
    expect(PARTNER_SHARING_COPY.callback.body).toContain('every time someone views it, that view is logged');
    expect(PARTNER_SHARING_COPY.callback.body).toContain('If you stop sharing, the number is removed');
    expect(PARTNER_SHARING_COPY.callback.safetyTip).toContain('only share a number that is safe for you to be called on');
  });

  it('has no empty strings or {{placeholder}} slots the locale validator would reject', () => {
    for (const value of strings(PARTNER_SHARING_COPY)) {
      expect(value.trim()).not.toBe('');
      expect(value).not.toMatch(/\{\{[^}]+\}\}|\b(?:TODO|TBD|TRANSLATE|PLACEHOLDER)\b/);
    }
  });

  it('fills named slots and leaves unknown ones visible', () => {
    expect(formatPartnerCopy('Call {phone} and quote {reference}.', { phone: '0769 546 253' }))
      .toBe('Call 0769 546 253 and quote {reference}.');
  });
});
