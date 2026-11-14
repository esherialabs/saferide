import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { derivePartnerKeys } from '../partnerCredentials.js';
import {
  PARTNER_KNOWN_DEVICE_TTL_SECONDS,
  issueKnownDeviceToken,
  knownDeviceCookie,
  verifyKnownDeviceToken,
} from '../partnerKnownDevice.js';

const key = derivePartnerKeys(randomBytes(32)).knownDevice;
const now = 1_790_000_000;
const userA = '22222222-2222-4222-8222-222222222222';
const userB = '33333333-3333-4333-8333-333333333333';

describe('partner known-device token', () => {
  it('names its user and epoch until it expires', () => {
    const token = issueKnownDeviceToken(key, { userId: userA, epoch: 41 }, now);
    expect(verifyKnownDeviceToken(key, token, now + PARTNER_KNOWN_DEVICE_TTL_SECONDS - 1)).toEqual({ userId: userA, epoch: 41 });
    expect(verifyKnownDeviceToken(key, token, now + PARTNER_KNOWN_DEVICE_TTL_SECONDS)).toBeNull();
    // Two cookies for one user differ (random device id) but name the same account.
    const again = issueKnownDeviceToken(key, { userId: userA, epoch: 41 }, now);
    expect(again).not.toBe(token);
    expect(verifyKnownDeviceToken(key, again, now)).toEqual({ userId: userA, epoch: 41 });
  });

  it('cannot be moved to another user or epoch, re-dated, or made under another key', () => {
    const token = issueKnownDeviceToken(key, { userId: userA, epoch: 0 }, now);
    const [version, user, epoch, expiry, id, mac] = token.split('.');
    expect(verifyKnownDeviceToken(key, [version, userB, epoch, expiry, id, mac].join('.'), now)).toBeNull();
    expect(verifyKnownDeviceToken(key, [version, user, '1', expiry, id, mac].join('.'), now)).toBeNull();
    const later = (parseInt(expiry, 36) + 3600).toString(36);
    expect(verifyKnownDeviceToken(key, [version, user, epoch, later, id, mac].join('.'), now)).toBeNull();
    expect(verifyKnownDeviceToken(derivePartnerKeys(randomBytes(32)).knownDevice, token, now)).toBeNull();
    expect(verifyKnownDeviceToken(key, `${token}x`, now)).toBeNull();
    expect(verifyKnownDeviceToken(key, null, now)).toBeNull();
    // The unbound v1 format from #311's first revision is no longer accepted.
    expect(verifyKnownDeviceToken(key, `v1.zz.${'A'.repeat(22)}.${'B'.repeat(43)}`, now)).toBeNull();
  });

  it('is an HttpOnly, Secure, SameSite=Strict __Host- cookie for 30 days', () => {
    expect(knownDeviceCookie('v2.x')).toBe(
      '__Host-saferide_partner_device=v2.x; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict',
    );
  });
});
