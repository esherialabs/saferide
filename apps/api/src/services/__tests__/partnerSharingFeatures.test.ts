import { beforeEach, describe, expect, it, vi } from 'vitest';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

const state = vi.hoisted(() => ({
  env: {} as Record<string, string | undefined>,
  ingestion: true,
  purposes: {} as Record<string, { status: string; version?: string }>,
  throwControls: false,
}));

vi.mock('../../config/env', () => ({ env: state.env }));
vi.mock('../../config/privacyControls', () => ({
  isPrivacyCapabilityEnabled: (capability: string) => capability === 'submitted_case_ingestion' && state.ingestion,
  loadPrivacyControls: () => {
    if (state.throwControls) throw new Error('controls unavailable');
    return { consentPurposes: state.purposes };
  },
}));

import { getPartnerSharingFeatures, getPartnerSharingRuntimeConfig } from '../partnerSharingFeatures';

function openAllLocks() {
  state.env.partnerPublicOrigin = 'https://partners.example.test';
  state.env.partnerTotpKey = KEY_A;
  state.env.partnerCallbackKey = KEY_B;
  state.ingestion = true;
  state.throwControls = false;
  state.purposes = {
    partner_follow_up: { status: 'enabled', version: 'partner-follow-up.ke-coast-huria.v1' },
    partner_callback: { status: 'enabled', version: 'partner-callback.ke-coast-huria.v1' },
  };
}

describe('partner sharing runtime features', () => {
  beforeEach(() => {
    for (const key of Object.keys(state.env)) delete state.env[key];
    openAllLocks();
  });

  it('is on only when every server lock is open', () => {
    expect(getPartnerSharingFeatures()).toEqual({ partnerRouting: true, partnerCallback: true });
  });

  it('publishes the enabled consent versions only while the matching feature is on', () => {
    expect(getPartnerSharingRuntimeConfig().consentVersions).toEqual({
      partner_follow_up: 'partner-follow-up.ke-coast-huria.v1',
      partner_callback: 'partner-callback.ke-coast-huria.v1',
    });
    state.env.partnerCallbackKey = undefined;
    expect(getPartnerSharingRuntimeConfig().consentVersions).toEqual({
      partner_follow_up: 'partner-follow-up.ke-coast-huria.v1',
      partner_callback: null,
    });
    state.ingestion = false;
    expect(getPartnerSharingRuntimeConfig().consentVersions).toEqual({ partner_follow_up: null, partner_callback: null });
  });

  it.each([
    ['the partner realm has no public origin', () => { state.env.partnerPublicOrigin = undefined; }],
    ['the partner TOTP key is a placeholder', () => { state.env.partnerTotpKey = 'replace-me'; }],
    ['case ingestion is disabled', () => { state.ingestion = false; }],
    ['partner_follow_up is disabled', () => { state.purposes.partner_follow_up = { status: 'disabled' }; }],
    ['the privacy controls cannot be read', () => { state.throwControls = true; }],
    ['partner_follow_up names another partner', () => {
      state.purposes.partner_follow_up = { status: 'enabled', version: 'partner-follow-up.test-partner.v1' };
    }],
    ['partner_follow_up has an unbound version', () => {
      state.purposes.partner_follow_up = { status: 'enabled', version: 'partner-follow-up.v1' };
    }],
  ])('turns both off when %s', (_label, close) => {
    close();
    expect(getPartnerSharingFeatures()).toEqual({ partnerRouting: false, partnerCallback: false });
  });

  it('accepts any HURIA version number', () => {
    state.purposes.partner_follow_up = { status: 'enabled', version: 'partner-follow-up.ke-coast-huria.v12' };
    expect(getPartnerSharingFeatures().partnerRouting).toBe(true);
  });

  it('keeps routing on but the callback off without its own purpose, a HURIA version or the key', () => {
    state.purposes.partner_callback = { status: 'disabled' };
    expect(getPartnerSharingFeatures()).toEqual({ partnerRouting: true, partnerCallback: false });
    openAllLocks();
    state.purposes.partner_callback = { status: 'enabled', version: 'partner-callback.test-partner.v1' };
    expect(getPartnerSharingFeatures()).toEqual({ partnerRouting: true, partnerCallback: false });
    openAllLocks();
    state.env.partnerCallbackKey = undefined;
    expect(getPartnerSharingFeatures()).toEqual({ partnerRouting: true, partnerCallback: false });
  });
});
