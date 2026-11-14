const fs = require('fs');
const path = require('path');

const appJson = require('./app.json');

const ENV_FILES = ['.env', '.env.development', '.env.local'];
const PLACEHOLDER_PATTERN = /^(replace|change|your|todo|example|placeholder|xxx)/i;
const ALLOWED_ENVIRONMENTS = new Set(['local', 'development', 'staging', 'production', 'test']);
const RELEASE_ENVIRONMENTS = new Set(['staging', 'production']);
const ANDROID_TUNED_MODEL_BUILD_PROFILES = new Set([
  'preview',
  'android-release-apk',
  'android-internal-ai',
]);
const STAGING_BUILD_PROFILES = new Set([
  ...ANDROID_TUNED_MODEL_BUILD_PROFILES,
  'prerelease',
]);
const RELEASE_BUILD_PROFILES = new Set([...STAGING_BUILD_PROFILES, 'production']);
const QA_LITERT_RUNTIME_BUILD_PROFILES = ANDROID_TUNED_MODEL_BUILD_PROFILES;
const WEB_PROTOCOLS = new Set(['http:', 'https:']);
const WS_PROTOCOLS = new Set(['ws:', 'wss:']);
const RELEASE_ENDPOINT_HOSTS_ENV = 'EXPO_PUBLIC_RELEASE_ENDPOINT_HOSTS';
const RELEASE_STORAGE_HOSTS_ENV = 'EXPO_PUBLIC_RELEASE_STORAGE_HOSTS';
const LOCAL_ASSISTANT_MODEL_ID_ENV = 'EXPO_PUBLIC_LOCAL_ASSISTANT_MODEL_ID';
const LOCAL_ASSISTANT_GGUF_FILE_NAME_ENV = 'EXPO_PUBLIC_LOCAL_ASSISTANT_GGUF_FILE_NAME';
const LOCAL_ASSISTANT_GGUF_URL_ENV = 'EXPO_PUBLIC_LOCAL_ASSISTANT_GGUF_URL';
const LOCAL_ASSISTANT_GGUF_SHA256_ENV = 'EXPO_PUBLIC_LOCAL_ASSISTANT_GGUF_SHA256';
const LOCAL_ASSISTANT_GGUF_SIZE_BYTES_ENV = 'EXPO_PUBLIC_LOCAL_ASSISTANT_GGUF_SIZE_BYTES';
const LOCAL_ASSISTANT_CONTEXT_WINDOW_ENV = 'EXPO_PUBLIC_LOCAL_ASSISTANT_CONTEXT_WINDOW';
const LOCAL_ASSISTANT_GPU_LAYERS_ENV = 'EXPO_PUBLIC_LOCAL_ASSISTANT_GPU_LAYERS';
const LOCAL_ASSISTANT_VRAM_REQUIRED_MB_ENV = 'EXPO_PUBLIC_LOCAL_ASSISTANT_VRAM_REQUIRED_MB';
const LOCAL_ASSISTANT_ALLOW_REAL_LITERTLM_RUNTIME_ENV = 'EXPO_PUBLIC_LOCAL_ASSISTANT_ALLOW_REAL_LITERTLM_RUNTIME';
const LOCAL_ASSISTANT_QA_TUNED_MANIFEST_ID_ENV = 'EXPO_PUBLIC_LOCAL_ASSISTANT_QA_TUNED_MANIFEST_ID';
const MODERATED_TEST_MODE_ENV = 'EXPO_PUBLIC_MODERATED_TEST_MODE';
const MODERATED_TEST_CONTROL_VERSION_ENV = 'EXPO_PUBLIC_MODERATED_TEST_CONTROL_VERSION';
const MODERATED_TEST_BUILD_PROFILES = new Set(['preview', 'test']);
const SAFERIDE_GEMMA_4_E2B_MODEL_IDS = new Set([
  'litert-community/gemma-4-e2b-it-litert-lm',
  'gemma-4-e2b-it',
  'gemma-4-e2b-it-litert-lm',
  'https://huggingface.co/litert-community/gemma-4-e2b-it-litert-lm',
]);
const SAFERIDE_V058_MODEL_ID = 'esherialabs/saferide-gemma-4-e2b-v058-original-419806-litertlm';
const SAFERIDE_V058_MANIFEST_ID =
  'saferide-gemma4-e2b-v058-original-419806-litertlm-artifact-produced-2026-08-10.1';

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const equalsIndex = trimmed.indexOf('=');
  if (equalsIndex === -1) return null;

  const key = trimmed.slice(0, equalsIndex).trim();
  let value = trimmed.slice(equalsIndex + 1).trim();

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return key ? [key, value] : null;
}

function loadLocalEnv() {
  if (process.env.EXPO_NO_DOTENV === '1') return;
  const loaded = {};

  for (const file of ENV_FILES) {
    const filePath = path.join(__dirname, file);
    if (!fs.existsSync(filePath)) continue;
    const contents = fs.readFileSync(filePath, 'utf8');
    for (const line of contents.split(/\r?\n/)) {
      const parsed = parseEnvLine(line);
      if (!parsed) continue;
      const [key, value] = parsed;
      loaded[key] = value;
    }
  }

  for (const [key, value] of Object.entries(loaded)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value || PLACEHOLDER_PATTERN.test(value)) {
    throw new Error(`Missing required Expo environment variable: ${name}`);
  }
  return value;
}

function requiredBooleanEnv(name) {
  const value = requiredEnv(name).toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Environment variable ${name} must be true or false.`);
}

function optionalBooleanEnv(name, defaultValue = false) {
  const value = optionalEnv(name);
  if (value === undefined) return defaultValue;
  const normalized = value.toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`Environment variable ${name} must be true or false.`);
}

function optionalEnv(name) {
  const value = process.env[name]?.trim();
  if (!value || PLACEHOLDER_PATTERN.test(value)) return undefined;
  return value;
}

function numberEnv(name) {
  const rawValue = requiredEnv(name);
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive number.`);
  }
  return value;
}

function optionalPositiveIntegerEnv(name) {
  const rawValue = optionalEnv(name);
  if (!rawValue) return undefined;
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer.`);
  }
  return value;
}

function optionalNonNegativeIntegerEnv(name) {
  const rawValue = optionalEnv(name);
  if (!rawValue) return undefined;
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Environment variable ${name} must be a non-negative integer.`);
  }
  return value;
}

function optionalSha256Env(name) {
  const value = optionalEnv(name);
  if (!value) return undefined;
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`Environment variable ${name} must be a 64-character SHA-256 hex digest.`);
  }
  return value.toLowerCase();
}

function normalizeHostname(hostname) {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function isLocalOrPrivateHost(hostname) {
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

function isSupabaseHost(hostname) {
  const host = normalizeHostname(hostname);
  return host === 'supabase.co' || host.endsWith('.supabase.co');
}

function parseReleaseHostList(name) {
  const value = optionalEnv(name);
  if (!value) return [];

  const hosts = value
    .split(',')
    .map(host => normalizeHostname(host.trim()))
    .filter(Boolean);

  for (const host of hosts) {
    if (
      host.includes('://') ||
      host.includes('/') ||
      host.includes('?') ||
      host.includes('#') ||
      host.includes(':')
    ) {
      throw new Error(`Environment variable ${name} must list hostnames only, not full URLs or ports.`);
    }
    if (isLocalOrPrivateHost(host)) {
      throw new Error(`Environment variable ${name} must not include local or private hosts.`);
    }
    if (isSupabaseHost(host)) {
      throw new Error(`Environment variable ${name} must list owned SafeRide hosts, not Supabase.`);
    }
  }

  return Array.from(new Set(hosts));
}

function runtimeContext() {
  const environment = requiredEnv('EXPO_PUBLIC_ENVIRONMENT');
  if (!ALLOWED_ENVIRONMENTS.has(environment)) {
    throw new Error(
      `EXPO_PUBLIC_ENVIRONMENT must be one of: ${Array.from(ALLOWED_ENVIRONMENTS).join(', ')}.`,
    );
  }

  const buildProfile = process.env.EAS_BUILD_PROFILE?.trim();
  const buildPlatform = process.env.EAS_BUILD_PLATFORM?.trim();
  const releaseLike =
    RELEASE_ENVIRONMENTS.has(environment) ||
    (buildProfile ? RELEASE_BUILD_PROFILES.has(buildProfile) : false);
  const releaseEndpointHosts = parseReleaseHostList(RELEASE_ENDPOINT_HOSTS_ENV);
  const releaseStorageHosts = parseReleaseHostList(RELEASE_STORAGE_HOSTS_ENV);

  if (buildProfile && STAGING_BUILD_PROFILES.has(buildProfile) && environment !== 'staging') {
    throw new Error(`EAS ${buildProfile} builds must set EXPO_PUBLIC_ENVIRONMENT=staging.`);
  }
  if (buildProfile === 'production' && environment !== 'production') {
    throw new Error('EAS production builds must set EXPO_PUBLIC_ENVIRONMENT=production.');
  }
  if (
    buildProfile &&
    ANDROID_TUNED_MODEL_BUILD_PROFILES.has(buildProfile) &&
    buildPlatform &&
    buildPlatform !== 'android'
  ) {
    throw new Error(`EAS ${buildProfile} is Android-only until the iOS Swift runtime is implemented.`);
  }

  if (releaseLike && releaseEndpointHosts.length === 0) {
    throw new Error(
      `${RELEASE_ENDPOINT_HOSTS_ENV} must list the expected owned API/auth/websocket/runtime-config hostnames for release-like builds.`,
    );
  }
  if (releaseLike && releaseStorageHosts.length === 0) {
    throw new Error(
      `${RELEASE_STORAGE_HOSTS_ENV} must list the expected staging storage hostnames for release-like builds.`,
    );
  }

  return {
    environment,
    buildProfile,
    buildPlatform,
    releaseLike,
    releaseEndpointHosts,
    releaseStorageHosts,
  };
}

function releaseContextLabel(context) {
  const profile = context.buildProfile ? `EAS profile "${context.buildProfile}"` : null;
  return [profile, `environment "${context.environment}"`].filter(Boolean).join(' with ');
}

function releaseHostListForRole(context, role) {
  return role === 'storage' ? context.releaseStorageHosts : context.releaseEndpointHosts;
}

function validateEndpointValue(name, value, allowedProtocols, context, options = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Environment variable ${name} must be a valid URL.`);
  }

  if (!allowedProtocols.has(url.protocol)) {
    throw new Error(
      `Environment variable ${name} must use one of: ${Array.from(allowedProtocols).join(', ')}.`,
    );
  }

  if (isSupabaseHost(url.hostname)) {
    throw new Error(`Environment variable ${name} must point to the owned SafeRide backend, not Supabase.`);
  }

  if (!context.releaseLike) return value;

  const requiredProtocol = allowedProtocols.has('wss:') ? 'wss:' : 'https:';
  if (url.protocol !== requiredProtocol) {
    throw new Error(
      `Environment variable ${name} must use ${requiredProtocol.replace(':', '')} for ${releaseContextLabel(
        context,
      )}.`,
    );
  }

  if (isLocalOrPrivateHost(url.hostname)) {
    throw new Error(
      `Environment variable ${name} must use a public remote hostname for ${releaseContextLabel(context)}.`,
    );
  }

  const allowedHosts = releaseHostListForRole(context, options.role);
  if (!allowedHosts.includes(normalizeHostname(url.hostname))) {
    const envName = options.role === 'storage' ? RELEASE_STORAGE_HOSTS_ENV : RELEASE_ENDPOINT_HOSTS_ENV;
    throw new Error(`Environment variable ${name} host must be listed in ${envName} for ${releaseContextLabel(context)}.`);
  }

  return value;
}

function requiredEndpointEnv(name, allowedProtocols, context, options) {
  return validateEndpointValue(name, requiredEnv(name), allowedProtocols, context, options);
}

function optionalEndpointEnv(name, allowedProtocols, context, options = {}) {
  const value = optionalEnv(name);
  if (!value) {
    if (context.releaseLike && options.requiredForRelease) {
      throw new Error(`Environment variable ${name} is required for ${releaseContextLabel(context)}.`);
    }
    return undefined;
  }
  return validateEndpointValue(name, value, allowedProtocols, context, options);
}

function optionalPublicDownloadUrlEnv(name) {
  const value = optionalEnv(name);
  if (!value) return undefined;

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Environment variable ${name} must be a valid URL.`);
  }

  if (url.protocol !== 'https:') {
    throw new Error(`Environment variable ${name} must use https.`);
  }
  if (isLocalOrPrivateHost(url.hostname)) {
    throw new Error(`Environment variable ${name} must use a public remote hostname.`);
  }
  if (isSupabaseHost(url.hostname)) {
    throw new Error(`Environment variable ${name} must not point to Supabase.`);
  }

  return value;
}

function localAssistantModelIdEnv(context, qaTunedManifestId) {
  const modelId = requiredEnv(LOCAL_ASSISTANT_MODEL_ID_ENV).replace(/\/+$/, '');
  const normalizedModelId = modelId.toLowerCase();

  if (qaTunedManifestId && normalizedModelId !== SAFERIDE_V058_MODEL_ID) {
    throw new Error(
      `${LOCAL_ASSISTANT_MODEL_ID_ENV} must be ${SAFERIDE_V058_MODEL_ID} when ` +
      `${LOCAL_ASSISTANT_QA_TUNED_MANIFEST_ID_ENV} selects the v0.5.8 QA artifact.`,
    );
  }

  if (
    context.releaseLike &&
    !qaTunedManifestId &&
    !SAFERIDE_GEMMA_4_E2B_MODEL_IDS.has(normalizedModelId)
  ) {
    throw new Error(
      `${LOCAL_ASSISTANT_MODEL_ID_ENV} must be litert-community/gemma-4-E2B-it-litert-lm for release-like SafeRide builds. ` +
      'Qwen, Gemma 2, Gemma 3n, and generic GGUF entries are retired and must fail closed to Gemma 4 E2B.',
    );
  }

  return modelId;
}

function qaTunedArtifactManifestIdEnv(context, allowRealLiteRtLmRuntime) {
  const manifestId = optionalEnv(LOCAL_ASSISTANT_QA_TUNED_MANIFEST_ID_ENV);
  if (!manifestId) return undefined;
  if (manifestId !== SAFERIDE_V058_MANIFEST_ID) {
    throw new Error(
      `${LOCAL_ASSISTANT_QA_TUNED_MANIFEST_ID_ENV} must select the bundled v0.5.8 manifest exactly.`,
    );
  }
  const qaRuntimeBuild =
    context.environment === 'staging' &&
    context.buildProfile &&
    QA_LITERT_RUNTIME_BUILD_PROFILES.has(context.buildProfile) &&
    allowRealLiteRtLmRuntime;
  if (!qaRuntimeBuild) {
    throw new Error(
      `${LOCAL_ASSISTANT_QA_TUNED_MANIFEST_ID_ENV} is allowed only for an approved staging Android tuned-model build ` +
      `with ${LOCAL_ASSISTANT_ALLOW_REAL_LITERTLM_RUNTIME_ENV}=true.`,
    );
  }
  return manifestId;
}

function requireAllOrNone(groupName, values) {
  const entries = Object.entries(values);
  const provided = entries.filter(([, value]) => value !== undefined && value !== '');
  if (provided.length === 0) return false;
  const missing = entries
    .filter(([, value]) => value === undefined || value === '')
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`${groupName} is incomplete. Missing: ${missing.join(', ')}.`);
  }
  return true;
}

function localAssistantArtifactEnv(context) {
  const model = {
    fileName: optionalEnv(LOCAL_ASSISTANT_GGUF_FILE_NAME_ENV),
    downloadUrl: optionalPublicDownloadUrlEnv(LOCAL_ASSISTANT_GGUF_URL_ENV),
    sha256: optionalSha256Env(LOCAL_ASSISTANT_GGUF_SHA256_ENV),
    sizeBytes: optionalPositiveIntegerEnv(LOCAL_ASSISTANT_GGUF_SIZE_BYTES_ENV),
  };
  const hasModelArtifact = requireAllOrNone('Local assistant GGUF artifact configuration', {
    [LOCAL_ASSISTANT_GGUF_FILE_NAME_ENV]: model.fileName,
    [LOCAL_ASSISTANT_GGUF_URL_ENV]: model.downloadUrl,
    [LOCAL_ASSISTANT_GGUF_SHA256_ENV]: model.sha256,
    [LOCAL_ASSISTANT_GGUF_SIZE_BYTES_ENV]: model.sizeBytes,
  });

  if (!hasModelArtifact) {
    return undefined;
  }

  throw new Error(
    'Local assistant GGUF artifact configuration is retired after the Gemma 4 E2B LiteRT-LM pivot. ' +
    'Use the Gemma 4 local AI app-download manifest instead.',
  );

  // Unreachable, but keeps the function shape explicit for static readers.
  return undefined;
}

function allowRealLiteRtLmRuntimeEnv(context) {
  const allowed = optionalBooleanEnv(LOCAL_ASSISTANT_ALLOW_REAL_LITERTLM_RUNTIME_ENV, false);
  const qaRuntimeBuild =
    context.environment === 'staging' &&
    context.buildProfile &&
    QA_LITERT_RUNTIME_BUILD_PROFILES.has(context.buildProfile);

  if (allowed && context.releaseLike && !qaRuntimeBuild) {
    throw new Error(
      `${LOCAL_ASSISTANT_ALLOW_REAL_LITERTLM_RUNTIME_ENV} is allowed only for approved staging Android tuned-model builds, not production or generic prerelease builds.`,
    );
  }
  return allowed;
}

function moderatedTestRuntimeEnv(context) {
  const enabled = optionalBooleanEnv(MODERATED_TEST_MODE_ENV, false);
  const controlVersion = optionalEnv(MODERATED_TEST_CONTROL_VERSION_ENV);
  const allowedContext =
    (context.environment === 'staging' || context.environment === 'test') &&
    context.buildProfile &&
    MODERATED_TEST_BUILD_PROFILES.has(context.buildProfile);

  if (enabled && !allowedContext) {
    throw new Error(
      `${MODERATED_TEST_MODE_ENV} is allowed only for explicit test or staging-preview builds.`,
    );
  }
  if (enabled && !controlVersion) {
    throw new Error(`${MODERATED_TEST_CONTROL_VERSION_ENV} is required when moderated test mode is enabled.`);
  }
  return { enabled, controlVersion };
}

// Over-the-air updates stay off: the app must not contact u.expo.dev. Releases ship as signed builds.
function updatesForBuildProfile() {
  return { enabled: false, checkAutomatically: 'NEVER' };
}

loadLocalEnv();

module.exports = ({ config } = {}) => {
  const base = {
    ...appJson.expo,
    ...(config ?? {}),
    extra: {
      ...(appJson.expo.extra ?? {}),
      ...(config?.extra ?? {}),
    },
  };
  const context = runtimeContext();
  const measurement = moderatedTestRuntimeEnv(context);
  const allowRealLiteRtLmRuntime = allowRealLiteRtLmRuntimeEnv(context);
  const qaTunedArtifactManifestId = qaTunedArtifactManifestIdEnv(
    context,
    allowRealLiteRtLmRuntime,
  );

  return {
    ...base,
    updates: updatesForBuildProfile(),
    extra: {
      ...(base.extra ?? {}),
      runtime: {
        environment: context.environment,
        buildProfile: context.buildProfile,
        releaseLike: context.releaseLike,
        releaseEndpointHosts: context.releaseEndpointHosts,
        releaseStorageHosts: context.releaseStorageHosts,
        openAIEnabled: requiredBooleanEnv('EXPO_PUBLIC_OPENAI_ENABLED'),
      },
      api: {
        baseUrl: requiredEndpointEnv('EXPO_PUBLIC_API_BASE_URL', WEB_PROTOCOLS, context),
        timeoutMs: numberEnv('EXPO_PUBLIC_API_TIMEOUT_MS'),
      },
      websocket: {
        baseUrl: requiredEndpointEnv('EXPO_PUBLIC_WS_BASE_URL', WS_PROTOCOLS, context),
      },
      auth: {
        baseUrl: requiredEndpointEnv('EXPO_PUBLIC_AUTH_BASE_URL', WEB_PROTOCOLS, context),
      },
      storage: {
        baseUrl: requiredEndpointEnv('EXPO_PUBLIC_STORAGE_BASE_URL', WEB_PROTOCOLS, context, {
          role: 'storage',
        }),
      },
      remoteConfig: {
        url: optionalEndpointEnv('EXPO_PUBLIC_RUNTIME_CONFIG_URL', WEB_PROTOCOLS, context, {
          requiredForRelease: true,
        }),
        refreshSeconds: numberEnv('EXPO_PUBLIC_CONFIG_REFRESH_SECONDS'),
      },
      localAssistant: {
        enabled: requiredBooleanEnv('EXPO_PUBLIC_LOCAL_ASSISTANT_ENABLED'),
        preferOnDevice: requiredBooleanEnv('EXPO_PUBLIC_LOCAL_ASSISTANT_PREFER_ON_DEVICE'),
        modelId: localAssistantModelIdEnv(context, qaTunedArtifactManifestId),
        allowRealLiteRtLmRuntime,
        qaTunedArtifactManifestId,
        artifact: localAssistantArtifactEnv(context),
      },
      measurement: {
        moderatedTestMode: measurement.enabled,
        controlVersion: measurement.controlVersion,
      },
      azureOpenAI: {
        transcriptionEnabled: requiredBooleanEnv('EXPO_PUBLIC_AZURE_OPENAI_TRANSCRIPTION_ENABLED'),
        endpoint: optionalEnv('EXPO_PUBLIC_AZURE_OPENAI_ENDPOINT'),
        deployment: optionalEnv('EXPO_PUBLIC_AZURE_OPENAI_DEPLOYMENT'),
        apiVersion: optionalEnv('EXPO_PUBLIC_AZURE_OPENAI_API_VERSION'),
      },
    },
  };
};
