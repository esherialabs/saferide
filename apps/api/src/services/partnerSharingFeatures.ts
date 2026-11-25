import { env } from '../config/env.js';
import { decodePartnerKey } from '../config/partnerKey.js';
import { isPrivacyCapabilityEnabled, loadPrivacyControls } from '../config/privacyControls.js';

/**
 * What the survivor app may offer for sharing with HURIA, published as
 * booleans in `GET /api/config/runtime` `features`.
 *
 * Both are off unless every server-side lock that `POST /api/cases`
 * applies to `partnerRouting` is open: case ingestion, the partner realm
 * (public origin and TOTP key), the `partner_follow_up` purpose at a version
 * naming HURIA (`partner-follow-up.ke-coast-huria.v<n>`) and, for a
 * callback, the `partner_callback` purpose at a HURIA version and
 * `PARTNER_CALLBACK_KEY`. The partner organisation's own `intake_enabled`
 * switch is not checked here; the app handles that as a 409
 * `partner_not_accepting` at submission.
 */
export type PartnerSharingFeatures = {
  partnerRouting: boolean;
  partnerCallback: boolean;
};

/** The only partner the survivor app offers in phase 1. */
const APP_PARTNER_STABLE_ID = 'ke-coast-huria';

/** The enabled version when it names the partner (the binding POST /api/cases requires), else null. */
function enabledPartnerVersion(purpose: string, versionPrefix: string): string | null {
  try {
    const control = loadPrivacyControls().consentPurposes[purpose];
    if (control?.status !== 'enabled' || typeof control.version !== 'string') return null;
    const expectedStart = `${versionPrefix}.${APP_PARTNER_STABLE_ID}.v`;
    return control.version.startsWith(expectedStart) && /^\d+$/.test(control.version.slice(expectedStart.length))
      ? control.version
      : null;
  } catch {
    return null;
  }
}

/**
 * The consent versions the server accepts right now, published as
 * `partnerConsentVersions`. The app offers sharing only when they equal the
 * versions of the wording it shows, so a new wording on the server hides
 * the choice in older apps instead of failing at submission.
 */
export type PartnerConsentVersions = {
  partner_follow_up: string | null;
  partner_callback: string | null;
};

export function getPartnerSharingRuntimeConfig(): { features: PartnerSharingFeatures; consentVersions: PartnerConsentVersions } {
  const followUpVersion = enabledPartnerVersion('partner_follow_up', 'partner-follow-up');
  const partnerRouting = Boolean(env.partnerPublicOrigin)
    && decodePartnerKey(env.partnerTotpKey) !== null
    && isPrivacyCapabilityEnabled('submitted_case_ingestion')
    && followUpVersion !== null;
  const callbackVersion = partnerRouting ? enabledPartnerVersion('partner_callback', 'partner-callback') : null;
  const partnerCallback = partnerRouting
    && callbackVersion !== null
    && decodePartnerKey(env.partnerCallbackKey) !== null;
  return {
    features: { partnerRouting, partnerCallback },
    consentVersions: {
      partner_follow_up: partnerRouting ? followUpVersion : null,
      partner_callback: partnerCallback ? callbackVersion : null,
    },
  };
}

export function getPartnerSharingFeatures(): PartnerSharingFeatures {
  return getPartnerSharingRuntimeConfig().features;
}
