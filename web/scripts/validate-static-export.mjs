import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const outDir = path.join(root, 'out');
const requiredFiles = [
  'index.html',
  '404.html',
  'robots.txt',
  'sitemap.xml',
  'site.webmanifest',
  'what-we-do/index.html',
  'privacy-safety-trust/index.html',
  'privacy/index.html',
  'terms/index.html',
  'blog/private-reporting-control/index.html',
];

const errors = [];

const missing = requiredFiles.filter((file) => !fs.existsSync(path.join(outDir, file)));

if (!fs.existsSync(path.join(outDir, '_next', 'static'))) {
  missing.push('_next/static');
}

if (missing.length > 0) {
  console.error(`Static export is incomplete. Missing: ${missing.join(', ')}`);
  process.exit(1);
}

const files = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      walk(fullPath);
      continue;
    }

    files.push(fullPath);
  }
};

walk(outDir);

if (files.length < 20) {
  console.error(`Static export looks too small: only ${files.length} files.`);
  process.exit(1);
}

// --- SEO assertions over the exported artifact (web/SEO_REMEDIATION_PLAN.md P4-1) ---

const PRODUCTION_ORIGIN = 'https://saferide.esheria.org';
const configuredUrl = (process.env.NEXT_PUBLIC_SITE_URL ?? PRODUCTION_ORIGIN).replace(/\/+$/, '');
const isProductionBuild = configuredUrl === PRODUCTION_ORIGIN;
const siteOrigin = configuredUrl;

// Robots gate: a production-targeted build must never ship `Disallow: /` (P1-5).
const robotsTxt = fs.readFileSync(path.join(outDir, 'robots.txt'), 'utf8');

if (isProductionBuild) {
  if (!/^Allow: \/$/m.test(robotsTxt) || /^Disallow: \/$/m.test(robotsTxt)) {
    errors.push('Production build robots.txt must allow crawling. Got:\n' + robotsTxt);
  }

  if (!robotsTxt.includes(`Sitemap: ${PRODUCTION_ORIGIN}/sitemap.xml`)) {
    errors.push('Production build robots.txt is missing the production sitemap line.');
  }
} else if (!/^Disallow: \/$/m.test(robotsTxt)) {
  errors.push('Non-production build robots.txt must disallow crawling. Got:\n' + robotsTxt);
}

// Sitemap: every <loc> ends with a trailing slash and resolves to an exported file.
const sitemapXml = fs.readFileSync(path.join(outDir, 'sitemap.xml'), 'utf8');
const locs = [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

if (locs.length === 0) {
  errors.push('sitemap.xml contains no <loc> entries.');
}

if (locs.length !== 19) {
  errors.push(`sitemap.xml must contain the 19 reviewed canonical routes, found ${locs.length}.`);
}

const sitemapByPath = new Map();

for (const loc of locs) {
  if (!loc.startsWith(`${siteOrigin}/`)) {
    errors.push(`Sitemap loc has unexpected origin: ${loc}`);
    continue;
  }

  if (!loc.endsWith('/')) {
    errors.push(`Sitemap loc is not in canonical trailing-slash form: ${loc}`);
    continue;
  }

  const relPath = loc.slice(siteOrigin.length + 1); // strip origin + leading slash
  const htmlFile = path.join(outDir, relPath, 'index.html');

  if (!fs.existsSync(htmlFile)) {
    errors.push(`Sitemap loc has no exported page: ${loc} -> ${path.relative(outDir, htmlFile)}`);
    continue;
  }

  // Next 16.3 emitted `<route>__PAGE__.txt`; 16.4 emits `index.txt` for the
  // same route payload. Accept both so the validator follows the pinned
  // Next version instead of treating a framework rename as a missing page.
  const routePayloads = fs
    .readdirSync(path.dirname(htmlFile))
    .filter((name) => name.endsWith('__PAGE__.txt') || name === 'index.txt');

  if (routePayloads.length === 0) {
    errors.push(`${relPath || '/'}: exported route is missing its route payload.`);
  }

  sitemapByPath.set(htmlFile, loc);
}

const allHtml = [...sitemapByPath.keys()]
  .map((htmlFile) => fs.readFileSync(htmlFile, 'utf8'))
  .join('\n');

if (/https:\/\/github\.com\/esherialabs\/saferider(?:[/?#"'\s<]|$)/.test(allHtml)) {
  errors.push('Export still links to the retired esherialabs/saferider repository.');
}

const homeHtml = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');

const visibleParentLinks = [...homeHtml.matchAll(/<a\b[^>]*href="https:\/\/esheria\.org\/?"[^>]*>([\s\S]*?)<\/a>/g)];

if (visibleParentLinks.length < 4 || visibleParentLinks.some(([, text]) => !/Esheria/i.test(text))) {
  errors.push('Homepage must contain at least four visible, descriptive links to https://esheria.org/.');
}

if (visibleParentLinks.some(([anchor]) => /rel="[^"]*(?:nofollow|ugc|sponsored|noreferrer)/i.test(anchor))) {
  errors.push('Esheria parent links must remain followed and preserve referral attribution.');
}

if (
  !homeHtml.includes('https://esheria.org/#organization') ||
  !homeHtml.includes('"@type":"Brand"') ||
  !homeHtml.includes('"brand":{"@id":"https://saferide.esheria.org/#brand"}')
) {
  errors.push('Homepage structured data must connect the SafeRide Brand to https://esheria.org/#organization.');
}

if (homeHtml.includes('aria-label="Loading"') || homeHtml.includes('<div hidden id="S:0">')) {
  errors.push('Homepage HTML is hidden behind a global loading boundary, which delays crawlable content and LCP.');
}

if (!homeHtml.includes('fetchPriority="high"') || !homeHtml.includes('matatu-interior-640.webp 640w')) {
  errors.push('Homepage LCP image is missing high fetch priority or its responsive source set.');
}

const privateGuideHtml = fs.readFileSync(
  path.join(outDir, 'blog', 'private-reporting-control', 'index.html'),
  'utf8',
);

for (const requiredArticleMetadata of [
  '<meta property="og:type" content="article"',
  'property="article:published_time"',
  'property="article:modified_time"',
  'property="article:author"',
]) {
  if (!privateGuideHtml.includes(requiredArticleMetadata)) {
    errors.push(`Blog article is missing ${requiredArticleMetadata}.`);
  }
}

const supportGuideHtml = fs.readFileSync(
  path.join(outDir, 'blog', 'kenya-support-pathways', 'index.html'),
  'utf8',
);

if (!supportGuideHtml.includes('gender.go.ke/resources/news/')) {
  errors.push('Kenya support guide is missing its official Government of Kenya source.');
}

const blogIndexHtml = fs.readFileSync(path.join(outDir, 'blog', 'index.html'), 'utf8');

if (blogIndexHtml.includes('That distinction matters on public transport')) {
  errors.push('/blog duplicates long-form article body copy instead of linking to the guide.');
}

// Per-page assertions: canonical matches sitemap loc, one h1, description and
// title within limits, JSON-LD parses and uses canonical-form URLs.
const decodeEntities = (value) =>
  value
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

const assetExtension = /\.(png|jpe?g|webp|svg|ico|apk|woff2?)$/i;

for (const [htmlFile, loc] of sitemapByPath) {
  const rel = path.relative(outDir, htmlFile);
  const html = fs.readFileSync(htmlFile, 'utf8');

  const canonical = (html.match(/<link rel="canonical" href="([^"]+)"/) ?? [])[1];

  if (canonical !== loc) {
    errors.push(`${rel}: canonical (${canonical}) does not match sitemap loc (${loc}).`);
  }

  const h1Count = (html.match(/<h1[\s>]/g) ?? []).length;

  if (h1Count !== 1) {
    errors.push(`${rel}: expected exactly one <h1>, found ${h1Count}.`);
  }

  const description = (html.match(/<meta name="description" content="([^"]*)"/) ?? [])[1];

  if (!description || description.length < 50 || description.length > 170) {
    errors.push(`${rel}: meta description missing or outside 50-170 chars (${description?.length ?? 0}).`);
  }

  const title = decodeEntities((html.match(/<title>([^<]*)<\/title>/) ?? [])[1] ?? '');

  if (!title || title.length > 65) {
    errors.push(`${rel}: <title> missing or longer than 65 chars (${title.length}): ${title}`);
  }

  for (const block of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>(.*?)<\/script>/gs)) {
    let data;

    try {
      data = JSON.parse(block[1]);
    } catch {
      errors.push(`${rel}: JSON-LD block does not parse.`);
      continue;
    }

    JSON.stringify(data, (key, value) => {
      if (typeof value === 'string' && value.startsWith(siteOrigin)) {
        const noFragment = value.split('#')[0];

        if (!noFragment.endsWith('/') && !assetExtension.test(noFragment)) {
          errors.push(`${rel}: JSON-LD URL not in canonical form: ${value}`);
        }
      }

      return value;
    });
  }
}

// 404 page must be noindexed and must not claim a canonical URL.
const notFoundHtml = fs.readFileSync(path.join(outDir, '404.html'), 'utf8');

if (!/<meta name="robots" content="[^"]*noindex/.test(notFoundHtml)) {
  errors.push('404.html is missing a noindex robots meta tag.');
}

if (/<link rel="canonical"/.test(notFoundHtml)) {
  errors.push('404.html must not declare a canonical URL.');
}

if (errors.length > 0) {
  console.error(`Static export failed ${errors.length} SEO assertion(s):`);
  for (const error of errors) {
    console.error(`  - ${error}`);
  }
  process.exit(1);
}

console.log(
  `Validated static export in ${outDir}: ${files.length} files, ${sitemapByPath.size} sitemap pages with route payloads, robots gate OK, SEO assertions OK.`,
);
