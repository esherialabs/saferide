import { describe, expect, it } from 'vitest';

import packRaw from '../../data/providers/provider-pack.v1.json';
import manifestRaw from '../../data/providers/provider-pack.v1.manifest.json';
import controlsRaw from '../../config/providers/provider-pack-rollout.v1.json';
import {
  canonicalProviderPackSha256,
  getBundledProviderPack,
  inspectProviderPack,
  isProviderPackRemoteRefreshEligible,
  verifyProviderPack,
} from './providerPack';

describe('provider pack runtime verifier', () => {
  it('matches the repository canonical hash and keeps the candidate non-actionable', () => {
    const now = new Date('2026-07-30T12:00:00.000Z');
    const assessment = getBundledProviderPack(now);
    expect(canonicalProviderPackSha256(packRaw)).toBe(manifestRaw.packSha256);
    expect(assessment).toMatchObject({
      packSha256: manifestRaw.packSha256,
      freshness: 'current',
      trust: 'pending',
      contactActionsAllowed: false,
    });
  });

  it('rejects changed bytes, unknown source references, and malformed records', () => {
    const changed = structuredClone(packRaw);
    changed.providers[0].name = 'Changed without a new manifest';
    expect(verifyProviderPack(changed, manifestRaw)).toEqual({ ok: false, code: 'hash-mismatch' });

    const badReference = structuredClone(packRaw);
    badReference.providers[0].contacts[0].sourceId = 'missing-source';
    const matchingManifest = { ...manifestRaw, packSha256: canonicalProviderPackSha256(badReference) };
    expect(verifyProviderPack(badReference, matchingManifest)).toEqual({ ok: false, code: 'invalid-references' });

    expect(verifyProviderPack({ ...packRaw, providers: [] }, manifestRaw)).toEqual({ ok: false, code: 'invalid-shape' });
  });

  it('reports stale and expired state without silently granting trust', () => {
    const expiresAt = Date.parse(packRaw.expiresAt);
    const day = 24 * 60 * 60 * 1000;
    expect(inspectProviderPack(packRaw, manifestRaw, controlsRaw, new Date(expiresAt - 5 * day))?.freshness).toBe('stale');
    expect(inspectProviderPack(packRaw, manifestRaw, controlsRaw, new Date(expiresAt + day))).toMatchObject({
      freshness: 'expired',
      trust: 'pending',
      contactActionsAllowed: false,
    });
  });

  it('keeps remote refresh at zero under checked-in controls', () => {
    expect(isProviderPackRemoteRefreshEligible(0, new Date('2026-07-30T12:00:00.000Z'))).toBe(false);
    expect(isProviderPackRemoteRefreshEligible(99, new Date('2026-07-30T12:00:00.000Z'))).toBe(false);
  });

  it('uses a stable zero-to-99 bucket for an approved staged rollout window', () => {
    const controls = {
      ...controlsRaw,
      activation: { status: 'enabled', reason: null },
      rolloutPercent: 10,
      approvedPackId: packRaw.packId,
      approvedPackVersion: packRaw.version,
      approvedPackSha256: manifestRaw.packSha256,
      approvedManifestSha256: 'a'.repeat(64),
      immutableRevision: 'b'.repeat(40),
      validFrom: '2026-07-30T00:00:00.000Z',
      validUntil: '2026-08-30T00:00:00.000Z',
    };
    const now = new Date('2026-08-01T00:00:00.000Z');
    expect(isProviderPackRemoteRefreshEligible(0, now, controls)).toBe(true);
    expect(isProviderPackRemoteRefreshEligible(9, now, controls)).toBe(true);
    expect(isProviderPackRemoteRefreshEligible(10, now, controls)).toBe(false);
    expect(isProviderPackRemoteRefreshEligible(99, new Date('2026-08-31T00:00:00.000Z'), controls)).toBe(false);
  });
});
