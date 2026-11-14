// Preview-only stand-in for expo-constants. Hosts use the reserved .invalid TLD and
// remote features are disabled, so the synthetic preview never reaches a service.
const extra = {
  runtime: { environment: 'test', buildProfile: 'synthetic-preview', releaseLike: false, openAIEnabled: false },
  api: { baseUrl: 'https://api.saferide-preview.invalid', timeoutMs: 1000 },
  websocket: { baseUrl: 'wss://ws.saferide-preview.invalid' },
  auth: { baseUrl: 'https://auth.saferide-preview.invalid' },
  storage: { baseUrl: 'https://storage.saferide-preview.invalid' },
  remoteConfig: { refreshSeconds: 3600 },
  localAssistant: { enabled: false, preferOnDevice: true, modelId: 'synthetic-preview-model' },
  measurement: { moderatedTestMode: false },
  azureOpenAI: { transcriptionEnabled: false },
};
const Constants = { expoConfig: { name: 'SafeRide preview', slug: 'saferide-preview', extra }, manifest: null, executionEnvironment: 'storeClient' };
export const ExecutionEnvironment = { Bare: 'bare', Standalone: 'standalone', StoreClient: 'storeClient' };
export default Constants;
