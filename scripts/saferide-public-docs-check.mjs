#!/usr/bin/env node

/**
 * Link and accessibility gate for the public documentation.
 *
 * Runs offline: every rule is decided from files on disk, so the verdict is the
 * same on a runner with no network as it is locally.
 *
 * Usage:
 *   node scripts/saferide-public-docs-check.mjs
 *   node scripts/saferide-public-docs-check.mjs --root path/to/fixture
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { formatFindings, runPublicDocsCheck } from './lib/saferide-public-docs.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseRoot(argv) {
  const index = argv.indexOf('--root');
  if (index === -1) return REPOSITORY_ROOT;
  const value = argv[index + 1];
  if (!value) {
    console.error('--root needs a directory');
    process.exit(2);
  }
  return path.resolve(value);
}

function main(argv) {
  const rootDir = parseRoot(argv);
  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
    console.error(`public docs check: root is not a directory: ${rootDir}`);
    return 2;
  }
  const { checkedMarkdown, checkedPages, findings } = runPublicDocsCheck(rootDir);

  if (findings.length === 0) {
    console.log(
      `public docs check: ${checkedMarkdown} markdown file(s) and ${checkedPages} page(s) OK`,
    );
    return 0;
  }

  console.error(
    `public docs check: ${findings.length} finding(s) across ` +
      `${checkedMarkdown} markdown file(s) and ${checkedPages} page(s)`,
  );
  console.error(formatFindings(findings));
  return 1;
}

process.exit(main(process.argv.slice(2)));
