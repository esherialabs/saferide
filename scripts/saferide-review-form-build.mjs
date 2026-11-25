#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(rootDir, 'tools/saferide-reviewer');
const outputDir = path.join(rootDir, 'docs/qa/reviewer-forms');
const checkOnly = process.argv.includes('--check');

const BUNDLE_SHA256 = 'cc3cef541f693975add0a135d7a55f13ce833affcbcf670c8c72c4bd89fa6d4e';

const forms = [
  {
    reviewerRole: 'product-safeguarding',
    pageTitle: 'SafeRide Product & Safeguarding Review',
    assignmentFile: 'saferide-v058-tuned-mobile-review-assignment-product-safeguarding-2026-08-14.json',
    assignmentSha256: '25c78c6924bdae1bda86fa29c91126dc5da41b53b0b8467678dbb2613d0259d0',
    outputFile: 'saferide-v058-product-safeguarding-review-form.html',
  },
  {
    reviewerRole: 'technical-ml',
    pageTitle: 'SafeRide Technical & ML Safety Review',
    assignmentFile: 'saferide-v058-tuned-mobile-review-assignment-technical-ml-2026-08-14.json',
    assignmentSha256: '4034c9ccd4a6b36c4081abc45a83839593f6b0a4c4b76f2431c1b91aed0be02e',
    outputFile: 'saferide-v058-technical-ml-review-form.html',
  },
];

function read(relativePath) {
  return fs.readFileSync(path.join(sourceDir, relativePath), 'utf8');
}

function escapeInlineScript(source) {
  return source.replaceAll('</script', '<\\/script');
}

function escapeHtmlText(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function render(template, values) {
  let output = template;
  for (const [name, value] of Object.entries(values)) {
    output = output.replaceAll(`{{${name}}}`, value);
  }
  const unresolved = [...output.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map(match => match[1]);
  if (unresolved.length > 0) throw new Error(`Unresolved reviewer-form placeholders: ${unresolved.join(', ')}`);
  return output.endsWith('\n') ? output : `${output}\n`;
}

const template = read('reviewer-template.html');
const style = read('reviewer-app.css').trim();
const coreScript = escapeInlineScript(read('reviewer-core.js').trim());
const appScript = escapeInlineScript(read('reviewer-app.js').trim());

let failures = 0;
for (const form of forms) {
  const rendered = render(template, {
    PAGE_TITLE: escapeHtmlText(form.pageTitle),
    DATA_MODE: 'file',
    REVIEWER_ROLE: form.reviewerRole,
    ASSIGNMENT_SHA256: form.assignmentSha256,
    BUNDLE_SHA256,
    ASSIGNMENT_FILE: form.assignmentFile,
    EMBEDDED_ASSIGNMENT_BASE64: '',
    EMBEDDED_BUNDLE_BASE64: '',
    STYLE: style,
    CORE_SCRIPT: coreScript,
    APP_SCRIPT: appScript,
  });
  const destination = path.join(outputDir, form.outputFile);
  if (checkOnly) {
    if (!fs.existsSync(destination) || fs.readFileSync(destination, 'utf8') !== rendered) {
      console.error(`Reviewer form is stale: ${path.relative(rootDir, destination)}`);
      failures += 1;
    }
  } else {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(destination, rendered, 'utf8');
    console.log(`Generated ${path.relative(rootDir, destination)}`);
  }
}

if (failures > 0) {
  console.error('Run node scripts/saferide-review-form-build.mjs and review the generated HTML.');
  process.exitCode = 1;
} else if (checkOnly) {
  console.log(`SafeRide reviewer forms are current (${forms.length} standalone HTML files).`);
}
