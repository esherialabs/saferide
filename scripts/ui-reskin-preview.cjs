// Local synthetic UI preview; never imported by the production app.
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Metro = require('@expo/metro/metro');
const { getDefaultConfig } = require('expo/metro-config');

const root = path.resolve(__dirname, '..');
const port = Number(process.argv[2] || 8091);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Use a port from 1024 to 65535.');
process.env.EXPO_NO_DOTENV = '1';
const config = getDefaultConfig(root);
config.server.port = port;
config.watchFolders = [...new Set([root, ...config.watchFolders])];
config.maxWorkers = 2;
config.resetCache = true;
// Separate preview caches from other workers and never reuse a stale bundle.
config.cacheVersion = `saferide-ui-${port}-${process.pid}`;
config.cacheStores = [];
config.fileMapCacheDirectory = path.join(require('node:os').tmpdir(), `saferide-ui-${port}-${process.pid}`);
require('node:fs').mkdirSync(config.fileMapCacheDirectory, { recursive: true });
config.resolver.platforms.push('web');
config.resolver.useWatchman = false;
config.reporter = { update: event => {
  if (['initialize_done', 'bundle_build_done', 'bundle_build_failed'].includes(event.type)) console.log(event.type);
  if (event.type === 'bundling_error') console.error(event.error?.message);
} };
config.resolver.sourceExts.push('wasm');
const originalResolver = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, name, platform) => {
  if (platform === 'web') context = { ...context, preferNativePlatform: false };
  const origin = context.originModulePath.replaceAll('\\', '/');
  // SDK57's web font loader eagerly imports a Node-only server context.
  // Its browser calls use the package's matching no-op implementation.
  if (platform === 'web' && origin.includes('/expo-font/build/') && name === './serverContext') {
    return { type: 'sourceFile', filePath: path.join(path.dirname(context.originModulePath), 'serverContext.js') };
  }
  if (name === '@react-navigation/native') {
    return { type: 'sourceFile', filePath: path.join(root, 'scripts/ui-reskin-preview/screen-contexts.ts') };
  }
  if (['/context/AuthProvider', '/context/OnboardingProvider', '/context/LanguageProvider', '/hooks/useStealthMode'].some(suffix => name.endsWith(suffix))) {
    return { type: 'sourceFile', filePath: path.join(root, 'scripts/ui-reskin-preview/screen-contexts.ts') };
  }
  if (['/utils/draftStorage', '/services/draftService', '/services/caseService', '/utils/offlineSync', '/lib/catalog', '/lib/measurement/localEventStore', '/lib/measurement/measurementConfig'].some(suffix => name.endsWith(suffix)) || name === '@react-native-async-storage/async-storage') {
    return { type: 'sourceFile', filePath: path.join(root, 'scripts/ui-reskin-preview/services.ts') };
  }
  if (['/utils/chatErrorHandling', '/services/chatService', '/config/localAssistant', '/services/localAssistantService', '/lib/localAssistant', '/utils/chatLocalSession'].some(suffix => name.endsWith(suffix))) {
    return { type: 'sourceFile', filePath: path.join(root, 'scripts/ui-reskin-preview/chat-services.ts') };
  }
  if (['/hooks/useDraftState', '/hooks/useReportDraftIdentity', '/hooks/useCompletedReportRedirect'].some(suffix => name.endsWith(suffix))) {
    return { type: 'sourceFile', filePath: path.join(root, 'scripts/ui-reskin-preview/draft-hooks.ts') };
  }
  if (platform === 'web' && /^react-native-web\/dist\/(cjs\/)?exports\/useWindowDimensions(\/index(\.js)?)?$/.test(name)) {
    return { type: 'sourceFile', filePath: path.join(root, 'scripts/ui-reskin-preview/use-window-dimensions.js') };
  }
  if (platform === 'web' && name === 'react-native') {
    return { type: 'sourceFile', filePath: path.join(root, 'scripts/ui-reskin-preview/react-native.js') };
  }
  if (name === './scripts/ui-reskin-preview/entry') {
    return { type: 'sourceFile', filePath: path.join(root, 'scripts/ui-reskin-preview/entry.tsx') };
  }
  if (origin.endsWith('/src/theme/SimpleThemeProvider.tsx') && name === '../lib/storage') {
    return { type: 'sourceFile', filePath: path.join(root, 'scripts/ui-reskin-preview/storage.ts') };
  }
  if (name === 'expo-sqlite') {
    return { type: 'sourceFile', filePath: path.join(root, 'scripts/ui-reskin-preview/sqlite.ts') };
  }
  if (name === 'expo-constants') {
    return { type: 'sourceFile', filePath: path.join(root, 'scripts/ui-reskin-preview/constants.ts') };
  }
  if (name.endsWith('/context/OnlineProvider')) {
    return { type: 'sourceFile', filePath: path.join(root, 'scripts/ui-reskin-preview/online.ts') };
  }
  return originalResolver ? originalResolver(context, name, platform) : context.resolveRequest(context, name, platform);
};
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
config.server.enhanceMiddleware = middleware => (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.url === '/' || req.url.startsWith('/?')) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const url = new URL(req.url, 'http://127.0.0.1');
    const frameWidth = Number(url.searchParams.get('frame'));
    if ([320, 360, 390, 430].includes(frameWidth)) {
      url.searchParams.delete('frame');
      const title = `SafeRide browser layout · ${frameWidth} × 844 · synthetic data`;
      res.end(`<!doctype html><html><head><title>${title}</title><style>body{margin:0;background:#e2d2c4;font:14px system-ui}header{padding:12px;color:#2D211B}iframe{display:block;width:${frameWidth}px;height:844px;border:0;margin:0 12px 12px;border-radius:24px;box-shadow:0 6px 24px #2d211b20}</style></head><body><header>${title}</header><iframe title="SafeRide mobile layout" src="${url.pathname + url.search}"></iframe></body></html>`);
      return;
    }
    res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>SafeRide synthetic UI preview</title><style>html,body,#root{height:100%;margin:0}#root{display:flex}*{box-sizing:border-box}</style></head><body><div id="root"></div><script>window.__UI_PREVIEW_SHA__=${JSON.stringify(sha)}</script><script src="/scripts/ui-reskin-preview/entry.bundle?platform=web&dev=true&minify=false"></script></body></html>`);
    return;
  }
  return middleware(req, res, next);
};
Metro.runServer(config, { host: '127.0.0.1', watch: false, waitForBundler: true }).then(server => {
  console.log(`Synthetic UI preview: http://127.0.0.1:${port} (source ${sha})`);
  const stop = () => server.close(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}).catch(error => { console.error(error.message); process.exitCode = 1; });
