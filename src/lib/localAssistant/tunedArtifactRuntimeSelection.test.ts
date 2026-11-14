import AsyncStorage from '@react-native-async-storage/async-storage';
import { describe, expect, it } from 'vitest';

import { TUNED_ARTIFACT_ROLLOUT_BUCKET_KEY } from '../../utils/storageKeys';
import {
  SAFERIDE_GEMMA4_E2B_V058_ORIGINAL_419806_LITERTLM_ARTIFACT_PRODUCED_MANIFEST,
  TUNED_MOBILE_ARTIFACT_LIFECYCLE,
} from './modelManifest';
import { TUNED_ARTIFACT_CONTROLS, type TunedArtifactControls } from './tunedArtifactControls';
import {
  hydrateTunedArtifactRolloutBucket,
  resolveTunedArtifactRuntimeSelection,
} from './tunedArtifactRuntimeSelection';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function releaseReadyFixture() {
  const manifest = clone(SAFERIDE_GEMMA4_E2B_V058_ORIGINAL_419806_LITERTLM_ARTIFACT_PRODUCED_MANIFEST);
  const controls = clone(TUNED_ARTIFACT_CONTROLS) as TunedArtifactControls;
  manifest.status = 'release-ready';
  manifest.stateHistory = TUNED_MOBILE_ARTIFACT_LIFECYCLE.slice(0, 8).map((state, index) => ({
    state,
    enteredAt: `2026-07-${String(4 + index).padStart(2, '0')}T00:00:00.000Z`,
    evidenceRefs: [`synthetic-${state}`],
  }));
  manifest.exportPath.decision = 'merge-peft-then-export-litertlm';
  delete manifest.exportPath.blocker;
  manifest.exportTooling.exporterRepositoryRevision = 'a'.repeat(40);
  manifest.exportTooling.pythonVersion = '3.11.9';
  manifest.exportTooling.packages = { 'litert-lm': '0.9.0' };
  manifest.exportTooling.tokenizer.metadataSha256 = 'b'.repeat(64);
  manifest.deviceRequirements.minRamGb = 6;
  manifest.deviceRequirements.storageRequiredBytes = 2048;
  manifest.artifact = {
    ...manifest.artifact,
    downloadMode: 'app-download',
    immutableLocation: 'https://artifacts.example/immutable/tuned.litertlm',
    sha256: 'c'.repeat(64),
    sizeBytes: 1024,
    fileInventoryRef: 'private://inventory/tuned-v1',
  };
  manifest.attestation = {
    status: 'approved',
    processId: 'organization-artifact-attestation-v1',
    attestationRef: 'private://attestation/tuned-v1',
    approverRole: 'release approver',
    approvedAt: '2026-07-12T00:00:00.000Z',
  };
  manifest.androidProof.tunedArtifactPhysicalDeviceProof = true;
  manifest.androidProof.deviceEvidenceId = 'synthetic-device-evidence';
  manifest.androidProof.deviceEvidenceRef = 'private://device/tuned-v1';
  manifest.approvals = { legal: 'approved', safety: 'approved', release: 'approved' };

  controls.activation.enabled = true;
  controls.download.enabled = true;
  controls.activation.activeManifestId = manifest.manifestId;
  controls.activation.activeManifestSha256 = 'd'.repeat(64);
  controls.activation.rolloutPercent = 10;
  controls.approvals = { legal: 'approved', safety: 'approved', release: 'approved' };

  const runtime = {
    enabled: true,
    reasonCode: 'enabled',
    controlId: controls.controlId,
    activeManifestId: manifest.manifestId,
    activeManifestSha256: 'd'.repeat(64),
    rolloutPercent: 10,
    minimumAppVersion: controls.activation.minimumAppVersion,
    remoteDisableSupported: true as const,
    revokedManifestIds: [] as string[],
    revokedArtifactSha256: [] as string[],
    rollbackTargetManifestId: controls.rollback.targetManifestId,
    expiresAt: controls.expiresAt,
  };
  return { manifest, controls, runtime };
}

describe('tuned artifact runtime selection', () => {
  it('does not create a rollout assignment while checked-in controls are disabled', async () => {
    await expect(hydrateTunedArtifactRolloutBucket()).resolves.toBeNull();
    await expect(AsyncStorage.getItem(TUNED_ARTIFACT_ROLLOUT_BUCKET_KEY)).resolves.toBeNull();
    expect(resolveTunedArtifactRuntimeSelection({ now: new Date('2026-07-30T00:00:00.000Z') })).toMatchObject({
      selectionRequired: false,
      config: null,
      decision: { enabled: false, reason: 'controls-disabled' },
    });
  });

  it('selects only an exact enabled manifest inside its stable cohort', () => {
    const { manifest, controls, runtime } = releaseReadyFixture();
    const selected = resolveTunedArtifactRuntimeSelection({
      manifest,
      manifestSha256: 'd'.repeat(64),
      bundledControls: controls,
      runtime,
      appVersion: '1.0.0',
      cohortBucket: 0,
      now: new Date('2026-07-30T00:00:00.000Z'),
    });
    expect(selected).toMatchObject({
      selectionRequired: true,
      decision: { enabled: true, reason: 'enabled' },
      config: {
        manifestId: manifest.manifestId,
        manifestSha256: 'd'.repeat(64),
        files: [{ sha256: 'c'.repeat(64) }],
      },
    });
  });

  it('selects artifact-produced v0.5.8 only through the exact QA manifest id', () => {
    const selected = resolveTunedArtifactRuntimeSelection({
      qaTunedArtifactManifestId:
        SAFERIDE_GEMMA4_E2B_V058_ORIGINAL_419806_LITERTLM_ARTIFACT_PRODUCED_MANIFEST.manifestId,
    });
    expect(selected).toMatchObject({
      selectionRequired: true,
      decision: { enabled: true, reason: 'qa-controlled-testing' },
      config: {
        qaOnly: true,
        lifecycleStatus: 'artifact-produced',
        rolloutDownloadMode: 'app-download',
      },
    });

    expect(resolveTunedArtifactRuntimeSelection({
      qaTunedArtifactManifestId: 'different-manifest',
    })).toMatchObject({
      selectionRequired: true,
      config: null,
      decision: { enabled: false, reason: 'qa-manifest-mismatch' },
    });
  });

  it('returns no fallback outside rollout or after remote disable', () => {
    const { manifest, controls, runtime } = releaseReadyFixture();
    const common = {
      manifest,
      manifestSha256: 'd'.repeat(64),
      bundledControls: controls,
      appVersion: '1.0.0',
      now: new Date('2026-07-30T00:00:00.000Z'),
    };
    expect(resolveTunedArtifactRuntimeSelection({
      ...common,
      runtime,
      cohortBucket: 99,
    })).toMatchObject({
      selectionRequired: true,
      config: null,
      decision: { reason: 'outside-rollout' },
    });
    expect(resolveTunedArtifactRuntimeSelection({
      ...common,
      runtime: {
        ...runtime,
        enabled: false,
        reasonCode: 'remote-revocation',
        activeManifestId: null,
        activeManifestSha256: null,
        rolloutPercent: 0,
      },
      cohortBucket: 0,
    })).toMatchObject({
      selectionRequired: true,
      config: null,
      decision: { reason: 'controls-disabled' },
    });
  });

  it.each([
    ['before', -1, 'enabled'],
    ['at', 0, 'enabled'],
    ['after', 1, 'controls-expired'],
  ] as const)('enforces the existing expiry boundary %s expiry', (_label, offset, reason) => {
    const { manifest, controls, runtime } = releaseReadyFixture();
    const selected = resolveTunedArtifactRuntimeSelection({
      manifest,
      manifestSha256: 'd'.repeat(64),
      bundledControls: controls,
      runtime,
      appVersion: '1.0.0',
      cohortBucket: 0,
      now: new Date(Date.parse(controls.expiresAt) + offset),
    });
    expect(selected.decision.reason).toBe(reason);
    expect(selected.decision.enabled).toBe(offset <= 0);
    expect(Boolean(selected.config)).toBe(offset <= 0);
  });
});
