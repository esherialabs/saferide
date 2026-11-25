// Static export only: nginx serves out/ (P7). There is no Next server, so
// response headers (CSP and the rest) are set by nginx; see README.md.
// `next build --webpack` is used because the webpack pages build emits no
// inline scripts, so the CSP can be `script-src 'self'` with no hashes.

import fs from 'node:fs';

// HURIA logo slot (see src/components/brand/PartnerLogo.tsx and README.md):
// the file HURIA provides, dropped into public/brand/, is found at build
// time. Without it the dashboard shows a text wordmark.
const LOGO_TYPES = ['svg', 'png', 'webp'];
function brandFile(base) {
  const type = LOGO_TYPES.find(ext => fs.existsSync(new URL(`./public/brand/${base}.${ext}`, import.meta.url)));
  return type ? `/brand/${base}.${type}` : '';
}
const partnerLogo = brandFile('huria-logo');
const partnerLogoDark = partnerLogo ? brandFile('huria-logo-dark') : '';

// The only origin evidence download links may point at (P3's presigned
// storage host). Tests build with the mock's storage origin (npm run build:e2e).
const DEFAULT_EVIDENCE_ORIGIN = 'https://storage.saferide.esheria.org';
const evidenceOrigin = process.env.PARTNER_EVIDENCE_ORIGIN?.trim() || DEFAULT_EVIDENCE_ORIGIN;
{
  const url = new URL(evidenceOrigin);
  const localHttp = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (url.origin !== evidenceOrigin || (url.protocol !== 'https:' && !localHttp)) {
    throw new Error('PARTNER_EVIDENCE_ORIGIN must be a bare https origin (http only for localhost)');
  }
}

/** @type {import('next').NextConfig} */
const config = {
  env: { PARTNER_EVIDENCE_ORIGIN: evidenceOrigin, PARTNER_LOGO: partnerLogo, PARTNER_LOGO_DARK: partnerLogoDark },
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  poweredByHeader: false,
  reactStrictMode: true,
  productionBrowserSourceMaps: false,
};

export default config;
