/**
 * Deterministic link and accessibility checks for the public documentation.
 *
 * Two surfaces, one pass: the Markdown under `docs/open-source/` and the static
 * site in `docs/open-source/site/`.
 *
 * Every rule here is answerable from files on disk. Nothing resolves an
 * external host, so the same tree gives the same verdict on a runner with no
 * network -- which is what makes it usable as a gate rather than a flake.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Where the checked surfaces live, relative to the repository root. */
export const DOCS_DIR = 'docs/open-source';
export const SITE_DIR = 'docs/open-source/site';

/**
 * Link text that tells a screen-reader user nothing.
 *
 * Someone tabbing a page hears the links out of context, so "click here" three
 * times is three identical destinations as far as they can tell.
 */
const MEANINGLESS_LINK_TEXT = new Set([
  'click here',
  'here',
  'link',
  'this',
  'this link',
  'read more',
  'more',
  'learn more',
  'go',
  'download',
]);

const MARKDOWN_LINK = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const HTML_ANCHOR = /<a\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;

function finding(file, message, line) {
  return line ? { file, line, message } : { file, message };
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

/** Every Markdown file under `docs/open-source`, excluding the built site. */
export function listMarkdownFiles(rootDir) {
  const base = path.join(rootDir, DOCS_DIR);
  if (!fs.existsSync(base)) return [];
  const found = [];
  const walk = (dir) => {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'site') walk(full);
      } else if (entry.name.endsWith('.md')) {
        found.push(path.relative(rootDir, full).split(path.sep).join('/'));
      }
    }
  };
  walk(base);
  return found;
}

/**
 * Whether a href points somewhere this check can and should resolve.
 *
 * External URLs, mailto:, and bare fragments are all out: the first would need
 * the network, and the last is an in-page anchor rather than a file.
 */
function isInternalFileLink(href) {
  if (!href) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return false; // http:, https:, mailto:, tel:
  if (href.startsWith('//')) return false; // protocol-relative
  if (href.startsWith('#')) return false; // same-page anchor
  return true;
}

/** Strip the fragment and query so the filesystem check sees a path. */
function targetPath(href) {
  return href.split('#')[0].split('?')[0];
}

/** Broken internal links in one Markdown or HTML file. */
export function checkLinks(rootDir, relativePath) {
  const full = path.join(rootDir, relativePath);
  const text = fs.readFileSync(full, 'utf8');
  const fromDir = path.dirname(full);
  const findings = [];
  const seen = new Set();

  const consider = (href, index) => {
    if (!isInternalFileLink(href)) return;
    const target = targetPath(href);
    if (!target) return; // href was a bare fragment after all
    const key = `${relativePath}::${target}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (!fs.existsSync(path.resolve(fromDir, target))) {
      findings.push(finding(relativePath, `broken link: ${href}`, lineOf(text, index)));
    }
  };

  for (const match of text.matchAll(MARKDOWN_LINK)) consider(match[2], match.index ?? 0);
  for (const match of text.matchAll(HTML_ANCHOR)) consider(match[1], match.index ?? 0);

  return findings;
}

/** Link text that would be useless read out of context. */
export function checkLinkText(rootDir, relativePath) {
  const full = path.join(rootDir, relativePath);
  const text = fs.readFileSync(full, 'utf8');
  const findings = [];

  const consider = (label, index) => {
    const plain = label
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    // An empty label is a separate problem: an image link carries its meaning
    // in the alt text, which the site check covers.
    if (!plain) return;
    if (MEANINGLESS_LINK_TEXT.has(plain.replace(/[.!?:,]+$/, ''))) {
      findings.push(
        finding(relativePath, `link text says nothing out of context: "${plain}"`, lineOf(text, index)),
      );
    }
  };

  for (const match of text.matchAll(MARKDOWN_LINK)) consider(match[1], match.index ?? 0);
  for (const match of text.matchAll(HTML_ANCHOR)) consider(match[2], match.index ?? 0);

  return findings;
}

/**
 * How many elements in a page are a main landmark.
 *
 * Counted per element, not per match: `<main role="main">` is one landmark
 * that says so twice, while `<main>` beside a `<div role="main">` is two.
 */
export function countMainLandmarks(html) {
  let count = 0;
  for (const tag of html.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi)) {
    if (tag[1].toLowerCase() === 'main' || /\brole\s*=\s*["']main["']/i.test(tag[2])) count += 1;
  }
  return count;
}

/**
 * Landmark and metadata rules for one HTML page.
 *
 * Deliberately a small, stable set rather than a general accessibility audit:
 * each of these is a regression a documentation edit can plausibly cause, and
 * each is decidable from the markup alone.
 */
export function checkHtmlAccessibility(rootDir, relativePath) {
  const html = fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
  const findings = [];

  const mainCount = countMainLandmarks(html);
  if (mainCount === 0) {
    findings.push(finding(relativePath, 'no main landmark: a keyboard user cannot skip to the content'));
  } else if (mainCount > 1) {
    findings.push(
      finding(relativePath, `${mainCount} main landmarks: exactly one page region can be the main one`),
    );
  }

  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (!title || !title[1].trim()) {
    findings.push(finding(relativePath, 'no page title: the tab and the browser history read as the URL'));
  }

  const htmlTag = html.match(/<html\b([^>]*)>/i);
  const lang = htmlTag && htmlTag[1].match(/\blang\s*=\s*["']([^"']+)["']/i);
  if (!lang || !lang[1].trim()) {
    findings.push(finding(relativePath, 'no lang on <html>: a screen reader guesses the pronunciation'));
  }

  for (const img of html.matchAll(/<img\b[^>]*>/gi)) {
    if (!/\balt\s*=/i.test(img[0])) {
      findings.push(finding(relativePath, 'image with no alt attribute', lineOf(html, img.index ?? 0)));
    }
  }

  return findings;
}

/** Every HTML file in the static site directory. */
export function listSiteHtml(rootDir) {
  const base = path.join(rootDir, SITE_DIR);
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base)
    .filter((name) => name.endsWith('.html'))
    .sort()
    .map((name) => `${SITE_DIR}/${name}`);
}

/**
 * Run every check over both surfaces.
 *
 * Returns findings rather than throwing or printing, so the same function
 * serves the CLI and the tests.
 */
export function runPublicDocsCheck(rootDir) {
  const markdown = listMarkdownFiles(rootDir);
  const pages = listSiteHtml(rootDir);
  const findings = [];

  // A wrong --root, or a deleted docs tree, would otherwise check nothing and
  // pass. Both surfaces are required, so an empty one is itself a finding.
  if (markdown.length === 0) {
    findings.push(finding(DOCS_DIR, 'no Markdown files found: the documentation surface is missing'));
  }
  if (pages.length === 0) {
    findings.push(finding(SITE_DIR, 'no HTML pages found: the site surface is missing'));
  }

  for (const file of [...markdown, ...pages]) {
    findings.push(...checkLinks(rootDir, file));
    findings.push(...checkLinkText(rootDir, file));
  }
  for (const page of pages) {
    findings.push(...checkHtmlAccessibility(rootDir, page));
  }

  return {
    checkedMarkdown: markdown.length,
    checkedPages: pages.length,
    findings,
  };
}

export function formatFindings(findings) {
  return findings.map((f) => `  ${f.file}${f.line ? `:${f.line}` : ''} - ${f.message}`).join('\n');
}
