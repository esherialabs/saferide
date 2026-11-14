import { describe, expect, it } from 'vitest';

import { mapProviderPackToProviders } from '../catalog';
import { getBundledProviderPack } from '../providerPack';
import { HURIA_PARTNER_STABLE_ID } from '../../utils/partnerSharing';

// The app ships its support directory inside the APK and cannot refresh it
// remotely while rollout is disabled. An expired pack marks every listing
// expired, and the referral picker then refuses HURIA, so the survivor can
// never reach the HURIA consent. Fail the build instead, with time to renew.
const RENEWAL_MARGIN_DAYS = 14;

describe('bundled provider directory', () => {
  it(`stays in date for at least ${RENEWAL_MARGIN_DAYS} days after this build`, () => {
    const now = new Date();
    const assessment = getBundledProviderPack(now);
    const daysLeft = (Date.parse(assessment!.pack.expiresAt) - now.getTime()) / 86_400_000;
    expect(daysLeft, `provider pack expires ${assessment!.pack.expiresAt}; renew it before building`).toBeGreaterThan(RENEWAL_MARGIN_DAYS);
  });

  it('lets HURIA be chosen (pending review, not expired) today', () => {
    const providers = mapProviderPackToProviders(getBundledProviderPack(new Date())!, new Date());
    const huria = providers.find(provider => provider.id === HURIA_PARTNER_STABLE_ID);
    expect(huria?.contactStatus).toBe('pending');
  });
});
