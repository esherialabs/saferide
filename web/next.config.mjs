import path from 'node:path';
import { fileURLToPath } from 'node:url';

const isDev = process.env.NODE_ENV !== 'production';
const isStaticExport = process.env.NEXT_OUTPUT === 'export';
const projectRoot = path.dirname(fileURLToPath(import.meta.url));

const CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self' https:",
  // The Spice FM clip is a click-to-load Facebook player. Nothing is requested
  // from either host until a visitor presses play (see src/lib/media.ts).
  "frame-src https://www.facebook.com",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join('; ');

const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // autoplay and fullscreen are limited to this origin and the one host that
  // needs them: the click-to-load Spice FM player (src/lib/media.ts).
  { key: 'Permissions-Policy', value: 'accelerometer=(), autoplay=(self "https://www.facebook.com"), camera=(), display-capture=(), encrypted-media=(), fullscreen=(self "https://www.facebook.com"), geolocation=(), gyroscope=(), interest-cohort=(), magnetometer=(), microphone=(), midi=(), payment=(), publickey-credentials-get=(), usb=(), xr-spatial-tracking=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'Content-Security-Policy', value: CSP },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
  { key: 'Origin-Agent-Cluster', value: '?1' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
];

/** @type {import('next').NextConfig} */
const config = {
  turbopack: {
    root: projectRoot,
  },

  ...(isStaticExport
    ? {
        output: 'export',
        trailingSlash: true,
        images: {
          unoptimized: true,
        },
      }
    : {
        async redirects() {
          return [
            {
              source: '/privacy-safety',
              destination: '/privacy-safety-trust',
              permanent: true,
            },
          ];
        },

        async headers() {
          return [
            {
              source: '/(.*)',
              headers: securityHeaders,
            },
          ];
        },
      }),
};

export default config;
