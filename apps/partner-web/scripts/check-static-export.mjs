// Fails the build if the static export could break the strict CSP, load
// anything from another origin or navigate on its own: inline scripts,
// inline styles, event-handler attributes, third-party URLs in HTML (src,
// href, action, formaction, poster, srcset) or CSS, <base>, meta refresh, or
// source maps, and SVGs that script, handle events or reference other
// origins. Also checks every route the app (and the enrolment link) needs.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const REQUIRED_FILES = ['index.html', '404.html', 'sign-in/index.html', 'enroll/index.html', 'cases/index.html', 'case/index.html', 'change-password/index.html'];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const EXTERNAL_ATTR = /\s(?:src|href|action|formaction|poster|data)\s*=\s*["']?\s*(?:https?:)?\/\//i;
const SRCSET_ATTR = /\s(?:srcset|imagesrcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

/** True when any candidate in a srcset/imagesrcset list points at another origin. */
function externalSrcset(html) {
  for (const match of html.matchAll(SRCSET_ATTR)) {
    const value = match[1] ?? match[2] ?? match[3] ?? '';
    if (value.split(',').some(candidate => /^(?:https?:)?\/\//i.test(candidate.trim()))) return true;
  }
  return false;
}

const META_REFRESH = /<meta\b[^>]*http-equiv\s*=\s*["']?\s*refresh/i;

/** Problems in one HTML document (exported for tests). */
export function htmlProblems(html, name = 'page') {
  const problems = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const [, attrs, body] = match;
    const dataOnly = /type\s*=\s*["']application\/json["']/i.test(attrs);
    if (body.trim() && !dataOnly) problems.push(`${name}: inline script`);
  }
  if (/<style\b/i.test(html)) problems.push(`${name}: <style> element`);
  if (/\sstyle\s*=/i.test(html)) problems.push(`${name}: style attribute`);
  if (/\son[a-z]+\s*=/i.test(html)) problems.push(`${name}: event-handler attribute`);
  if (EXTERNAL_ATTR.test(html)) problems.push(`${name}: third-party URL`);
  if (externalSrcset(html)) problems.push(`${name}: third-party URL in srcset`);
  if (META_REFRESH.test(html)) problems.push(`${name}: meta refresh`);
  if (/<base\b/i.test(html)) problems.push(`${name}: <base> element`);
  return problems;
}

/** Problems in one stylesheet (exported for tests). */
export function cssProblems(css, name = 'stylesheet') {
  return /@import|url\(\s*["']?(?:https?:)?\/\//i.test(css) ? [`${name}: external CSS resource`] : [];
}

const SVG_EXTERNAL_REF = /\s(?:xlink:)?href\s*=\s*["']?\s*(?:(?:https?:)?\/\/|data:|javascript:)/i;

/**
 * Problems in one SVG file (exported for tests): served SVGs (the favicon,
 * brand files in public/brand/) must not script, handle events, or pull in
 * anything from elsewhere.
 */
export function svgProblems(svg, name = 'image.svg') {
  const problems = [];
  if (/<script\b/i.test(svg)) problems.push(`${name}: script in SVG`);
  if (/<foreignObject\b/i.test(svg)) problems.push(`${name}: foreignObject in SVG`);
  if (/\son[a-z]+\s*=/i.test(svg)) problems.push(`${name}: event-handler attribute in SVG`);
  if (SVG_EXTERNAL_REF.test(svg) || /url\(\s*["']?(?:(?:https?:)?\/\/|data:)/i.test(svg) || /@import/i.test(svg)) {
    problems.push(`${name}: external reference in SVG`);
  }
  return problems;
}

/** Every problem in an export directory; empty when it is clean. */
export function findProblems(outDir) {
  const problems = [];
  for (const file of REQUIRED_FILES) {
    if (!fs.existsSync(path.join(outDir, file))) problems.push(`missing ${file}`);
  }
  const files = fs.existsSync(outDir) ? walk(outDir) : [];
  for (const file of files) {
    const relative = path.relative(outDir, file);
    if (file.endsWith('.html')) problems.push(...htmlProblems(fs.readFileSync(file, 'utf8'), relative));
    else if (file.endsWith('.css')) problems.push(...cssProblems(fs.readFileSync(file, 'utf8'), relative));
    else if (file.endsWith('.svg')) problems.push(...svgProblems(fs.readFileSync(file, 'utf8'), relative));
    else if (file.endsWith('.map')) problems.push(`${relative}: source map in the export`);
  }
  return { problems, fileCount: files.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const outDir = path.resolve(process.argv[2] ?? 'out');
  const { problems, fileCount } = findProblems(outDir);
  if (problems.length > 0) {
    console.error(`Static export check failed (${outDir}):\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`Static export check passed: ${fileCount} files, no inline scripts or styles, no third-party URLs, no meta refresh, SVGs inert.`);
}
