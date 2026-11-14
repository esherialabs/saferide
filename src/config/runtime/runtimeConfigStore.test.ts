import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  TUNED_ARTIFACT_CONTROLS,
  type TunedArtifactControls,
} from '../../lib/localAssistant/tunedArtifactControls';

const releaseEndpointHost = 'd111111abcdef8.cloudfront.net';
const releaseStorageHost = 'saferide-staging-evidence.s3.eu-central-1.amazonaws.com';

const baseAppConfig = {
  environment: 'development',
  api: {
    baseUrl: 'http://localhost:3333/api',
    timeoutMs: 10000,
  },
  websocket: {
    baseUrl: 'ws://localhost:3334',
  },
  auth: {
    baseUrl: 'http://localhost:3333/auth',
  },
  storage: {
    baseUrl: 'http://localhost:9000/evidence',
  },
  remoteConfig: {
    refreshSeconds: 60,
  },
  releaseEndpointPolicy: {
    releaseLike: false,
    endpointHosts: [] as string[],
    storageHosts: [] as string[],
  },
};

type AppConfig = typeof baseAppConfig;

async function loadRuntimeConfigStore(
  appConfig: AppConfig = baseAppConfig,
  tunedControls?: TunedArtifactControls,
) {
  vi.resetModules();
  vi.doMock('../appConfig', () => ({ appConfig }));
  if (tunedControls) {
    vi.doMock('../../lib/localAssistant/tunedArtifactControls', () => ({
      TUNED_ARTIFACT_CONTROLS: tunedControls,
    }));
  }
  return import('./runtimeConfigStore');
}

function enabledTunedControls(expiresAt: string): TunedArtifactControls {
  const controls = JSON.parse(JSON.stringify(TUNED_ARTIFACT_CONTROLS)) as TunedArtifactControls;
  controls.activation.enabled = true;
  controls.activation.reasonCode = 'enabled';
  controls.activation.activeManifestId = 'synthetic-tuned-manifest';
  controls.activation.activeManifestSha256 = 'b'.repeat(64);
  controls.activation.rolloutPercent = 10;
  controls.download.enabled = true;
  controls.approvals = { legal: 'approved', safety: 'approved', release: 'approved' };
  controls.expiresAt = expiresAt;
  return controls;
}

function enabledRuntimeControl(expiresAt: string) {
  return {
    enabled: true,
    reasonCode: 'enabled',
    controlId: TUNED_ARTIFACT_CONTROLS.controlId,
    activeManifestId: 'synthetic-tuned-manifest',
    activeManifestSha256: 'b'.repeat(64),
    rolloutPercent: 10,
    minimumAppVersion: '1.0.0',
    remoteDisableSupported: true as const,
    revokedManifestIds: [] as string[],
    revokedArtifactSha256: [] as string[],
    rollbackTargetManifestId: 'fail-closed:no-local-ai',
    expiresAt,
  };
}

function releaseAppConfig(): AppConfig {
  return {
    ...baseAppConfig,
    environment: 'staging',
    api: {
      baseUrl: `https://${releaseEndpointHost}/api`,
      timeoutMs: 10000,
    },
    websocket: {
      baseUrl: `wss://${releaseEndpointHost}`,
    },
    auth: {
      baseUrl: `https://${releaseEndpointHost}/auth`,
    },
    storage: {
      baseUrl: `https://${releaseStorageHost}/evidence`,
    },
    releaseEndpointPolicy: {
      releaseLike: true,
      endpointHosts: [releaseEndpointHost],
      storageHosts: [releaseStorageHost],
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock('../appConfig');
  vi.doUnmock('../../lib/localAssistant/tunedArtifactControls');
});

describe('runtime config release endpoint gate', () => {
  it('allows local runtime endpoint overrides outside release-like builds', async () => {
    const store = await loadRuntimeConfigStore();

    const snapshot = await store.setRuntimeConfigOverride({
      apiBaseUrl: 'http://192.168.1.20:3333/api',
      wsBaseUrl: 'ws://192.168.1.20:3334',
    });

    expect(snapshot.apiBaseUrl).toBe('http://192.168.1.20:3333/api');
    expect(snapshot.wsBaseUrl).toBe('ws://192.168.1.20:3334');
  });

  it('accepts release overrides only when hosts match the configured public allowlists', async () => {
    const store = await loadRuntimeConfigStore(releaseAppConfig());

    const snapshot = await store.setRuntimeConfigOverride({
      environment: 'staging',
      apiBaseUrl: `https://${releaseEndpointHost}/api`,
      wsBaseUrl: `wss://${releaseEndpointHost}`,
      authBaseUrl: `https://${releaseEndpointHost}/auth`,
      storageBaseUrl: `https://${releaseStorageHost}/evidence`,
    });

    expect(snapshot.source).toBe('override');
    expect(snapshot.environment).toBe('staging');
    expect(snapshot.storageBaseUrl).toBe(`https://${releaseStorageHost}/evidence`);
  });

  it('rejects release overrides that point to localhost or private endpoints', async () => {
    const store = await loadRuntimeConfigStore(releaseAppConfig());

    await expect(
      store.setRuntimeConfigOverride({
        apiBaseUrl: 'http://localhost:3333/api',
      }),
    ).rejects.toThrow(/must use https|public remote hostname/);
  });

  it('rejects release overrides that are public but outside the allowlisted endpoint family', async () => {
    const store = await loadRuntimeConfigStore(releaseAppConfig());

    await expect(
      store.setRuntimeConfigOverride({
        apiBaseUrl: 'https://example.com/api',
      }),
    ).rejects.toThrow(/release host allowlist/);
  });

  it('rejects runtime config attempts to downgrade a release build environment', async () => {
    const store = await loadRuntimeConfigStore(releaseAppConfig());

    await expect(
      store.setRuntimeConfigOverride({
        environment: 'local',
        apiBaseUrl: `https://${releaseEndpointHost}/api`,
        wsBaseUrl: `wss://${releaseEndpointHost}`,
        authBaseUrl: `https://${releaseEndpointHost}/auth`,
        storageBaseUrl: `https://${releaseStorageHost}/evidence`,
      }),
    ).rejects.toThrow(/cannot change a release build environment/);
  });

  it('accepts remote disable and revocation metadata without exposing an active tuned artifact', async () => {
    const store = await loadRuntimeConfigStore();
    const snapshot = await store.setRuntimeConfigOverride({
      localAi: {
        enabled: false,
        reasonCode: 'remote-revocation',
        controlId: 'saferide-tuned-artifact-controls-2026-07-30.1',
        activeManifestId: null,
        activeManifestSha256: null,
        rolloutPercent: 0,
        minimumAppVersion: '1.0.0',
        remoteDisableSupported: true,
        revokedManifestIds: ['synthetic-revoked-manifest'],
        revokedArtifactSha256: ['a'.repeat(64)],
        rollbackTargetManifestId: 'fail-closed:no-local-ai',
        expiresAt: '2026-08-14T00:00:00.000Z',
      },
    });

    expect(snapshot.localAi).toMatchObject({
      enabled: false,
      reasonCode: 'remote-revocation',
      activeManifestId: null,
      rolloutPercent: 0,
      revokedManifestIds: ['synthetic-revoked-manifest'],
    });
  });

  it('rejects a remote attempt to enable an artifact disabled by bundled controls', async () => {
    const store = await loadRuntimeConfigStore();
    await expect(store.setRuntimeConfigOverride({
      localAi: {
        enabled: true,
        reasonCode: 'enabled',
        controlId: 'saferide-tuned-artifact-controls-2026-07-30.1',
        activeManifestId: 'synthetic-manifest',
        activeManifestSha256: 'b'.repeat(64),
        rolloutPercent: 1,
        minimumAppVersion: '1.0.0',
        remoteDisableSupported: true,
        revokedManifestIds: [],
        revokedArtifactSha256: [],
        rollbackTargetManifestId: 'fail-closed:no-local-ai',
        expiresAt: '2026-08-14T00:00:00.000Z',
      },
    })).rejects.toThrow('cannot enable an unbundled');
  });

  it('expires an active tuned control and notifies subscribers without a remote response', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T00:00:00.000Z'));
    const expiresAt = '2026-07-30T00:00:30.000Z';
    const controls = enabledTunedControls(expiresAt);
    const store = await loadRuntimeConfigStore(baseAppConfig, controls);
    const snapshots: Array<ReturnType<typeof store.getRuntimeConfigSnapshot>> = [];
    store.subscribeToRuntimeConfig(snapshot => snapshots.push(snapshot));
    await store.setRuntimeConfigOverride({ localAi: enabledRuntimeControl(expiresAt) });

    const stop = store.startRuntimeConfigRefreshLoop();
    await vi.advanceTimersByTimeAsync(60_000);
    stop();

    expect(store.getRuntimeConfigSnapshot().localAi).toMatchObject({
      enabled: false,
      reasonCode: 'remote-control-expired',
      activeManifestId: null,
      activeManifestSha256: null,
      rolloutPercent: 0,
    });
    expect(snapshots.at(-1)?.localAi.reasonCode).toBe('remote-control-expired');
  });
});

describe('partner consent versions', () => {
  it('start empty and are replaced, not merged, so a server answer without them turns sharing off', async () => {
    const store = await loadRuntimeConfigStore({
      ...baseAppConfig,
      remoteConfig: { refreshSeconds: 60, url: 'http://localhost:3333/api/config/runtime' },
    } as AppConfig);
    expect(store.getRuntimeConfigSnapshot().partnerConsentVersions).toEqual({});

    const overridden = await store.setRuntimeConfigOverride({
      partnerConsentVersions: { partner_follow_up: 'partner-follow-up.ke-coast-huria.v2', partner_callback: null },
    });
    expect(overridden.partnerConsentVersions).toEqual({
      partner_follow_up: 'partner-follow-up.ke-coast-huria.v2',
      partner_callback: null,
    });

    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ features: { partnerRouting: true } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));
    try {
      const refreshed = await store.refreshRemoteRuntimeConfig();
      expect(refreshed.features.partnerRouting).toBe(true);
      expect(refreshed.partnerConsentVersions).toEqual({});
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('case submission flag', () => {
  it('is never carried over: a server answer without it turns sending off', async () => {
    const store = await loadRuntimeConfigStore({
      ...baseAppConfig,
      remoteConfig: { refreshSeconds: 60, url: 'http://localhost:3333/api/config/runtime' },
    } as AppConfig);
    const respond = (features: Record<string, boolean>) => vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ features }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));
    try {
      respond({ caseSubmission: true });
      const on = await store.refreshRemoteRuntimeConfig();
      expect(on.features.caseSubmission).toBe(true);
      expect(on.source).toBe('remote');
      expect(Number.isFinite(Date.parse(on.appliedAt ?? ''))).toBe(true);

      respond({ ownedApi: true });
      const off = await store.refreshRemoteRuntimeConfig();
      expect(off.features.caseSubmission).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
