import sourceResource from './resources/en.product.v1.json';

/**
 * English source copy for sharing a report with SafeRide's partner HURIA.
 * Like the other product copy, it stays English-only until a reviewed,
 * versioned language pack exists (config/localization/locale-availability.v1.json).
 * The consent wording needs legal and safeguarding sign-off before the
 * partner_follow_up and partner_callback purposes are enabled.
 */
export const PARTNER_SHARING_COPY = sourceResource.partnerSharing;
export type PartnerSharingCopy = typeof PARTNER_SHARING_COPY;

export function getPartnerSharingCopy(_languageCode?: string | null): PartnerSharingCopy {
  return PARTNER_SHARING_COPY;
}

/** Fills `{name}` slots. Unknown slots are left as written so a missing value is visible in review. */
export function formatPartnerCopy(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (slot, name: string) => (
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : slot
  ));
}
