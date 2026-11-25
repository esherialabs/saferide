// Serves web/out the way CloudFront serves production (see
// infra/web/aws/cloudfront-viewer-request.js and bootstrap.sh):
// slash-less page URLs 301 to the trailing-slash form, trailing-slash URLs
// serve index.html, /privacy-safety redirects, unknown routes get 404.html
// with a real 404 status, and the security headers policy is replicated.
// Used by `npm run e2e:export` so Playwright tests the artifact that ships.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const outDir = path.join(process.cwd(), 'out');
const port = Number(process.env.PORT ?? 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS = {
  'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
  // Must match infra/selfhost/web/security-headers.conf, which nginx serves in
  // production, and the CSP in next.config.mjs used by `next start`.
  'content-security-policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self'; font-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self' https:; frame-src https://www.facebook.com; frame-ancestors 'none'; upgrade-insecure-requests",
  'permissions-policy':
    'accelerometer=(), autoplay=(self "https://www.facebook.com"), camera=(), display-capture=(), encrypted-media=(), fullscreen=(self "https://www.facebook.com"), geolocation=(), gyroscope=(), interest-cohort=(), magnetometer=(), microphone=(), midi=(), payment=(), publickey-credentials-get=(), usb=(), xr-spatial-tracking=()',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
};

function send(res, status, filePath, extraHeaders = {}) {
  const body = fs.readFileSync(filePath);
  res.writeHead(status, {
    'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
    ...SECURITY_HEADERS,
    ...extraHeaders,
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const uri = decodeURIComponent(new URL(req.url, `http://127.0.0.1:${port}`).pathname);

  if (uri === '/privacy-safety' || uri === '/privacy-safety/') {
    res.writeHead(301, { location: '/privacy-safety-trust/', ...SECURITY_HEADERS });
    res.end();
    return;
  }

  if (!uri.includes('.') && uri !== '/' && !uri.endsWith('/')) {
    res.writeHead(301, { location: `${uri}/`, ...SECURITY_HEADERS });
    res.end();
    return;
  }

  const candidate = uri.endsWith('/') ? path.join(outDir, uri, 'index.html') : path.join(outDir, uri);
  const resolved = path.resolve(candidate);

  if (resolved.startsWith(outDir) && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    send(res, 200, resolved);
    return;
  }

  send(res, 404, path.join(outDir, '404.html'));
});

server.listen(port, () => {
  console.log(`Serving static export from ${outDir} at http://127.0.0.1:${port} (CloudFront simulation)`);
});
