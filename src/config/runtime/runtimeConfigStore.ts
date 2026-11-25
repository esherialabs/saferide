import AsyncStorage from '@react-native-async-storage/async-storage';
import { z } from 'zod';

import { appConfig } from '../appConfig';
import { TUNED_ARTIFACT_CONTROLS } from '../../lib/localAssistant/tunedArtifactControls';
import { devPrivacyInfo, devPrivacyWarn, getPrivacySafeErrorReason } from '../../utils/privacyLog';

const STORAGE_KEY = '@saferide_runtime_config_override';
const PLACEHOLDER_PATTERN = /^(replace|change|your|todo|example|placeholder|xxx)/i;
const RELEASE_ENVIRONMENTS = new Set(['staging', 'production']);
const WEB_PROTOCOLS = new Set(['http:', 'https:']);
const WS_PROTOCOLS = new Set(['ws:', 'wss:']);
const MAX_EXPIRY_POLL_MS = 60_000;

type EndpointName = 'apiBaseUrl' | 'authBaseUrl' | 'storageBaseUrl' | 'wsBaseUrl';

function isRealValue(value: string): boolean {
  return value.trim().length > 0 && !PLACEHOLDER_PATTERN.test(value.trim());
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function isSupabaseHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  return host === 'supabase.co' || host.endsWith('.supabase.co');
}

function isLocalOrPrivateHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.endsWith('.local')
  ) {
    return true;
  }
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;

  const private172 = host.match(/^172\.(\d+)\./);
  if (private172) {
    const secondOctet = Number(private172[1]);
    if (secondOctet >= 16 && secondOctet <= 31) return true;
  }

  return /^169\.254\./.test(host) || /^(fc|fd)[0-9a-f]{2}:/i.test(host) || /^fe80:/i.test(host);
}

const endpointUrlSchema = z
  .string()
  .trim()
  .min(1)
  .refine(isRealValue, 'must not be a placeholder value')
  .refine(value => parseUrl(value) !== null, 'must be a valid URL')
  .refine(value => !isSupabaseHost(parseUrl(value)?.hostname ?? ''), 'must point to the owned SafeRide backend');

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const localAiRuntimeConfigSchema = z.object({
  enabled: z.boolean(),
  reasonCode: z.string().min(1),
  controlId: z.string().min(1).nullable(),
  activeManifestId: z.string().min(1).nullable(),
  activeManifestSha256: sha256Schema.nullable(),
  rolloutPercent: z.number().int().min(0).max(100),
  minimumAppVersion: z.string().regex(/^\d+\.\d+\.\d+$/).nullable(),
  remoteDisableSupported: z.literal(true),
  revokedManifestIds: z.array(z.string().min(1)),
  revokedArtifactSha256: z.array(sha256Schema),
  rollbackTargetManifestId: z.string().min(1),
  expiresAt: z.string().datetime().nullable(),
});

const remoteRuntimeConfigSchema = z.object({
  environment: z.enum(['local', 'development', 'staging', 'production', 'test']).optional(),
  apiBaseUrl: endpointUrlSchema.optional(),
  wsBaseUrl: endpointUrlSchema.optional(),
  authBaseUrl: endpointUrlSchema.optional(),
  storageBaseUrl: endpointUrlSchema.optional(),
  features: z.record(z.string(), z.boolean()).optional(),
  partnerConsentVersions: z.record(z.string(), z.string().min(1).max(120).nullable()).optional(),
  localAi: localAiRuntimeConfigSchema.optional(),
  refreshedAt: z.string().optional(),
});

export type TunedArtifactRuntimeSnapshot = z.infer<typeof localAiRuntimeConfigSchema>;

export type RuntimeConfigSnapshot = {
  environment: string;
  apiBaseUrl: string;
  apiTimeoutMs: number;
  wsBaseUrl: string;
  authBaseUrl: string;
  storageBaseUrl: string;
  features: Record<string, boolean>;
  /** Partner consent versions the server accepts now; empty (sharing off) unless the server says so. */
  partnerConsentVersions: Record<string, string | null>;
  localAi: TunedArtifactRuntimeSnapshot;
  source: 'bundled' | 'override' | 'remote';
  refreshedAt?: string;
  /** When this phone applied the config (device clock), for staleness checks. */
  appliedAt?: string;
};

const bundledRuntimeConfig: RuntimeConfigSnapshot = {
  environment: appConfig.environment,
  apiBaseUrl: appConfig.api.baseUrl,
  apiTimeoutMs: appConfig.api.timeoutMs,
  wsBaseUrl: appConfig.websocket.baseUrl,
  authBaseUrl: appConfig.auth.baseUrl,
  storageBaseUrl: appConfig.storage.baseUrl,
  features: {},
  partnerConsentVersions: {},
  localAi: {
    enabled: false,
    reasonCode: TUNED_ARTIFACT_CONTROLS.activation.reasonCode,
    controlId: TUNED_ARTIFACT_CONTROLS.controlId,
    activeManifestId: null,
    activeManifestSha256: null,
    rolloutPercent: 0,
    minimumAppVersion: TUNED_ARTIFACT_CONTROLS.activation.minimumAppVersion,
    remoteDisableSupported: true,
    revokedManifestIds: [...TUNED_ARTIFACT_CONTROLS.activation.revokedManifestIds],
    revokedArtifactSha256: [...TUNED_ARTIFACT_CONTROLS.activation.revokedArtifactSha256],
    rollbackTargetManifestId: TUNED_ARTIFACT_CONTROLS.rollback.targetManifestId,
    expiresAt: TUNED_ARTIFACT_CONTROLS.expiresAt,
  },
  source: 'bundled',
};

let activeRuntimeConfig = bundledRuntimeConfig;
const subscribers = new Set<(config: RuntimeConfigSnapshot) => void>();

export function getRuntimeConfigSnapshot(): RuntimeConfigSnapshot {
  return enforceRuntimeConfigExpiry();
}

export function subscribeToRuntimeConfig(
  callback: (config: RuntimeConfigSnapshot) => void,
): () => void {
  const current = enforceRuntimeConfigExpiry();
  subscribers.add(callback);
  try {
    callback(current);
  } catch {
    console.warn('Runtime config subscriber failed.');
  }
  return () => subscribers.delete(callback);
}

export function enforceRuntimeConfigExpiry(now = new Date()): RuntimeConfigSnapshot {
  const expiresAt = activeRuntimeConfig.localAi.expiresAt;
  if (
    activeRuntimeConfig.localAi.enabled
    && (
      expiresAt === null
      || !Number.isFinite(Date.parse(expiresAt))
      || now.getTime() > Date.parse(expiresAt)
    )
  ) {
    return commitRuntimeConfig({
      ...activeRuntimeConfig,
      localAi: disabledLocalAiRuntimeConfig(
        activeRuntimeConfig.localAi,
        'remote-control-expired',
      ),
    });
  }

  return activeRuntimeConfig;
}

export function startRuntimeConfigRefreshLoop(
  onRefreshError?: (error: unknown) => void,
): () => void {
  const refreshMs = Math.max(1, appConfig.remoteConfig.refreshSeconds) * 1000;
  const pollMs = Math.min(refreshMs, MAX_EXPIRY_POLL_MS);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let nextRefreshAt = Date.now() + refreshMs;

  const schedule = () => {
    if (!stopped) timer = setTimeout(runTick, pollMs);
  };

  const runTick = async () => {
    try {
      enforceRuntimeConfigExpiry();
      const now = Date.now();
      if (appConfig.remoteConfig.url && now >= nextRefreshAt) {
        nextRefreshAt = now + refreshMs;
        await refreshRemoteRuntimeConfig();
      }
    } catch (error) {
      try {
        onRefreshError?.(error);
      } catch {
        // A diagnostic callback cannot stop expiry enforcement or refresh.
      }
    } finally {
      schedule();
    }
  };

  schedule();
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
  };
}

export async function hydrateRuntimeConfig(): Promise<RuntimeConfigSnapshot> {
  const cached = await AsyncStorage.getItem(STORAGE_KEY);
  if (cached) {
    try {
      const parsed = remoteRuntimeConfigSchema.safeParse(JSON.parse(cached));
      if (parsed.success) {
        applyRuntimeConfig(parsed.data, 'override');
      } else {
        await AsyncStorage.removeItem(STORAGE_KEY);
      }
    } catch (error) {
      devPrivacyWarn('discarding invalid runtime config override', {
        reason: getPrivacySafeErrorReason(error),
      });
      await AsyncStorage.removeItem(STORAGE_KEY);
    }
  }

  if (appConfig.remoteConfig.url) {
    await refreshRemoteRuntimeConfig().catch(error => {
      const meta = { reason: getPrivacySafeErrorReason(error) };
      if (RELEASE_ENVIRONMENTS.has(appConfig.environment)) {
        devPrivacyWarn('remote runtime config refresh failed', meta);
      } else {
        devPrivacyInfo('remote runtime config unavailable; using bundled defaults', meta);
      }
    });
  }

  return activeRuntimeConfig;
}

export async function setRuntimeConfigOverride(
  config: z.infer<typeof remoteRuntimeConfigSchema>,
): Promise<RuntimeConfigSnapshot> {
  const parsed = remoteRuntimeConfigSchema.parse(config);
  const nextRuntimeConfig = resolveRuntimeConfig(parsed, 'override');
  validateRuntimeConfigSnapshot(nextRuntimeConfig);
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
  return commitRuntimeConfig(nextRuntimeConfig);
}

export async function clearRuntimeConfigOverride(): Promise<RuntimeConfigSnapshot> {
  await AsyncStorage.removeItem(STORAGE_KEY);
  activeRuntimeConfig = bundledRuntimeConfig;
  notifySubscribers();
  return activeRuntimeConfig;
}

export async function refreshRemoteRuntimeConfig(): Promise<RuntimeConfigSnapshot> {
  if (!appConfig.remoteConfig.url) return enforceRuntimeConfigExpiry();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), appConfig.api.timeoutMs);
  try {
    const response = await fetch(appConfig.remoteConfig.url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Runtime config refresh failed with ${response.status}`);
    }
    const parsed = remoteRuntimeConfigSchema.parse(await response.json());
    return applyRuntimeConfig(parsed, 'remote');
  } finally {
    clearTimeout(timeout);
  }
}

function applyRuntimeConfig(
  config: z.infer<typeof remoteRuntimeConfigSchema>,
  source: RuntimeConfigSnapshot['source'],
): RuntimeConfigSnapshot {
  const nextRuntimeConfig = resolveRuntimeConfig(config, source);
  validateRuntimeConfigSnapshot(nextRuntimeConfig);
  return commitRuntimeConfig(nextRuntimeConfig);
}

function resolveRuntimeConfig(
  config: z.infer<typeof remoteRuntimeConfigSchema>,
  source: RuntimeConfigSnapshot['source'],
): RuntimeConfigSnapshot {
  return {
    ...activeRuntimeConfig,
    environment: config.environment ?? activeRuntimeConfig.environment,
    apiBaseUrl: config.apiBaseUrl ?? activeRuntimeConfig.apiBaseUrl,
    wsBaseUrl: config.wsBaseUrl ?? activeRuntimeConfig.wsBaseUrl,
    authBaseUrl: config.authBaseUrl ?? activeRuntimeConfig.authBaseUrl,
    storageBaseUrl: config.storageBaseUrl ?? activeRuntimeConfig.storageBaseUrl,
    features: {
      ...activeRuntimeConfig.features,
      ...(config.features ?? {}),
      // Never carried over: a server answer that does not say true turns case sending off.
      ...(source === 'remote' ? { caseSubmission: config.features?.caseSubmission === true } : {}),
    },
    // Replaced, never merged: a fresh server answer without versions turns partner sharing off.
    partnerConsentVersions: config.partnerConsentVersions
      ?? (source === 'remote' ? {} : activeRuntimeConfig.partnerConsentVersions),
    localAi: config.localAi
      ? resolveLocalAiRuntimeConfig(config.localAi, activeRuntimeConfig.localAi)
      : source === 'remote' && activeRuntimeConfig.localAi.enabled
        ? disabledLocalAiRuntimeConfig(activeRuntimeConfig.localAi, 'remote-config-missing-local-ai-control')
        : activeRuntimeConfig.localAi,
    source,
    refreshedAt: config.refreshedAt ?? new Date().toISOString(),
    appliedAt: new Date().toISOString(),
  };
}

function disabledLocalAiRuntimeConfig(
  current: TunedArtifactRuntimeSnapshot,
  reasonCode: string,
): TunedArtifactRuntimeSnapshot {
  return {
    ...current,
    enabled: false,
    reasonCode,
    activeManifestId: null,
    activeManifestSha256: null,
    rolloutPercent: 0,
  };
}

function resolveLocalAiRuntimeConfig(
  remote: TunedArtifactRuntimeSnapshot,
  current: TunedArtifactRuntimeSnapshot,
): TunedArtifactRuntimeSnapshot {
  const revokedManifestIds = [...new Set([
    ...current.revokedManifestIds,
    ...TUNED_ARTIFACT_CONTROLS.activation.revokedManifestIds,
    ...remote.revokedManifestIds,
  ])];
  const revokedArtifactSha256 = [...new Set([
    ...current.revokedArtifactSha256,
    ...TUNED_ARTIFACT_CONTROLS.activation.revokedArtifactSha256,
    ...remote.revokedArtifactSha256,
  ])];

  if (!remote.enabled) {
    return {
      ...remote,
      enabled: false,
      activeManifestId: null,
      activeManifestSha256: null,
      rolloutPercent: 0,
      revokedManifestIds,
      revokedArtifactSha256,
    };
  }

  const bundled = TUNED_ARTIFACT_CONTROLS.activation;
  if (
    !bundled.enabled
    || !TUNED_ARTIFACT_CONTROLS.download.enabled
    || remote.controlId !== TUNED_ARTIFACT_CONTROLS.controlId
    || remote.activeManifestId !== bundled.activeManifestId
    || remote.activeManifestSha256 !== bundled.activeManifestSha256
    || remote.rolloutPercent > bundled.rolloutPercent
    || remote.minimumAppVersion !== bundled.minimumAppVersion
    || remote.rollbackTargetManifestId !== TUNED_ARTIFACT_CONTROLS.rollback.targetManifestId
    || remote.expiresAt !== TUNED_ARTIFACT_CONTROLS.expiresAt
    || remote.expiresAt === null
    || Date.now() > Date.parse(remote.expiresAt)
    || remote.activeManifestId === null
    || remote.activeManifestSha256 === null
    || revokedManifestIds.includes(remote.activeManifestId)
  ) {
    throw new Error('Remote runtime config cannot enable an unbundled, expired, mismatched, or revoked tuned artifact.');
  }

  return {
    ...remote,
    revokedManifestIds,
    revokedArtifactSha256,
  };
}

function commitRuntimeConfig(config: RuntimeConfigSnapshot): RuntimeConfigSnapshot {
  activeRuntimeConfig = config;
  notifySubscribers();
  return activeRuntimeConfig;
}

function validateRuntimeConfigSnapshot(config: RuntimeConfigSnapshot) {
  if (appConfig.releaseEndpointPolicy.releaseLike && !RELEASE_ENVIRONMENTS.has(config.environment)) {
    throw new Error('Runtime config cannot change a release build environment to a non-release environment.');
  }

  validateEndpoint('apiBaseUrl', config.apiBaseUrl, WEB_PROTOCOLS, config.environment);
  validateEndpoint('authBaseUrl', config.authBaseUrl, WEB_PROTOCOLS, config.environment);
  validateEndpoint('storageBaseUrl', config.storageBaseUrl, WEB_PROTOCOLS, config.environment);
  validateEndpoint('wsBaseUrl', config.wsBaseUrl, WS_PROTOCOLS, config.environment);
}

function validateEndpoint(
  name: EndpointName,
  value: string,
  allowedProtocols: Set<string>,
  environment: string,
) {
  const url = parseUrl(value);
  if (!url) throw new Error(`Runtime config ${name} must be a valid URL.`);
  if (!allowedProtocols.has(url.protocol)) {
    throw new Error(`Runtime config ${name} uses an unsupported protocol.`);
  }
  if (isSupabaseHost(url.hostname)) {
    throw new Error(`Runtime config ${name} must point to the owned SafeRide backend, not Supabase.`);
  }

  const releaseLike = appConfig.releaseEndpointPolicy.releaseLike || RELEASE_ENVIRONMENTS.has(environment);
  if (!releaseLike) return;

  const requiredProtocol = allowedProtocols.has('wss:') ? 'wss:' : 'https:';
  if (url.protocol !== requiredProtocol) {
    throw new Error(`Runtime config ${name} must use ${requiredProtocol.replace(':', '')} in ${environment}.`);
  }
  if (isLocalOrPrivateHost(url.hostname)) {
    throw new Error(`Runtime config ${name} must use a public remote hostname in ${environment}.`);
  }

  const allowedHosts = releaseHostsForEndpoint(name);
  if (!allowedHosts.includes(normalizeHostname(url.hostname))) {
    throw new Error(`Runtime config ${name} host is not in the configured release host allowlist.`);
  }
}

function releaseHostsForEndpoint(name: EndpointName): string[] {
  return name === 'storageBaseUrl'
    ? appConfig.releaseEndpointPolicy.storageHosts
    : appConfig.releaseEndpointPolicy.endpointHosts;
}

function notifySubscribers() {
  subscribers.forEach(callback => {
    try {
      callback(activeRuntimeConfig);
    } catch {
      console.warn('Runtime config subscriber failed.');
    }
  });
}
