const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '../..');
const Metro = require(path.join(root, 'node_modules/@expo/metro/metro'));
const { getDefaultConfig } = require(path.join(root, 'node_modules/expo/metro-config'));
process.env.EXPO_NO_DOTENV = '1';
const config = getDefaultConfig(root);
const port = Number(process.env.REPORT_CASES_PREVIEW_PORT || 8115);
config.server.port = port;
config.maxWorkers = 2;
config.watchFolders = [...new Set([root, ...config.watchFolders, fs.realpathSync(path.join(root, 'node_modules'))])];
config.cacheVersion = `report-cases-${process.pid}`;
config.resolver.useWatchman = false;
const original = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, name, platform) => {
  if (name === './scripts/report-cases-regression/entry') return { type:'sourceFile', filePath:path.join(__dirname,'entry.tsx') };
  if (name === '@react-navigation/native') return { type:'sourceFile', filePath:path.join(root,'node_modules/@react-navigation/core/lib/module/index.js') };
  return original ? original(context, name, platform) : context.resolveRequest(context, name, platform);
};
config.reporter = { update: event => { if (event.type === 'bundling_error') console.error(event.error?.message); } };
config.server.enhanceMiddleware = middleware => (req, res, next) => {
  if (req.url === '/' || req.url.startsWith('/?')) {
    res.setHeader('content-type','text/html; charset=utf-8');res.setHeader('cache-control','no-store');
    res.end('<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{background:#FCF6EE;color:#2D211B;font:16px system-ui;margin:16px}button{background:#FFFDFA;border:1px solid #B58C72;border-radius:12px;min-height:48px;padding:12px;margin:4px}pre{overflow-wrap:anywhere;white-space:pre-wrap}h1{font-size:24px}</style></head><body><div id="root"></div><script src="/scripts/report-cases-regression/entry.bundle?platform=web&dev=true&minify=false"></script></body></html>');return;
  }
  return middleware(req,res,next);
};
Metro.runServer(config,{host:'127.0.0.1',port,watch:false}).then(()=>console.log(`Navigation regression harness http://127.0.0.1:${port}`)).catch(error=>{console.error(error.message);process.exitCode=1;});

