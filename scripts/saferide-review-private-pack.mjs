#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(rootDir, 'tools/saferide-reviewer');
const exactRunDir = path.join(rootDir, '.ai-smoke/gemma4-v058-litertlm-safety/runs/saferide-v058-litertlm-full-20260814');
const bundlePath = path.join(exactRunDir, 'private-synthetic-generations.jsonl');
const expectedBundleSha256 = 'cc3cef541f693975add0a135d7a55f13ce833affcbcf670c8c72c4bd89fa6d4e';

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const outputDir = path.resolve(option('--output') ?? path.join(exactRunDir, 'reviewer-packs'));

const forms = [
  {
    reviewerRole: 'product-safeguarding',
    pageTitle: 'SafeRide Product & Safeguarding Review — Ready Pack',
    assignmentPath: path.join(rootDir, 'docs/qa/saferide-v058-tuned-mobile-review-assignment-product-safeguarding-2026-08-14.json'),
    assignmentFile: 'saferide-v058-tuned-mobile-review-assignment-product-safeguarding-2026-08-14.json',
    assignmentSha256: '25c78c6924bdae1bda86fa29c91126dc5da41b53b0b8467678dbb2613d0259d0',
    outputFile: '1_Product_Safeguarding_Review_READY.html',
    launcherTitle: 'Product & Safeguarding reviewer',
    launcherDescription: 'Review survivor safety, tone, agency and product truth.',
  },
  {
    reviewerRole: 'technical-ml',
    pageTitle: 'SafeRide Technical & ML Review — Ready Pack',
    assignmentPath: path.join(rootDir, 'docs/qa/saferide-v058-tuned-mobile-review-assignment-technical-ml-2026-08-14.json'),
    assignmentFile: 'saferide-v058-tuned-mobile-review-assignment-technical-ml-2026-08-14.json',
    assignmentSha256: '4034c9ccd4a6b36c4081abc45a83839593f6b0a4c4b76f2431c1b91aed0be02e',
    outputFile: '2_Technical_ML_Review_READY.html',
    launcherTitle: 'Technical & ML reviewer',
    launcherDescription: 'Review factuality, prompt resistance and model safety boundaries.',
  },
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function readSource(relativePath) {
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
  for (const [name, value] of Object.entries(values)) output = output.replaceAll(`{{${name}}}`, value);
  const unresolved = [...output.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map(match => match[1]);
  if (unresolved.length > 0) throw new Error(`Unresolved reviewer-pack placeholders: ${unresolved.join(', ')}`);
  return output.endsWith('\n') ? output : `${output}\n`;
}

function launcherHtml(generatedForms) {
  const cards = generatedForms.map(form => `
      <a class="role-card" href="./${form.outputFile}">
        <span class="number">${form.reviewerRole === 'product-safeguarding' ? '1' : '2'}</span>
        <span><strong>${escapeHtmlText(form.launcherTitle)}</strong><small>${escapeHtmlText(form.launcherDescription)}</small></span>
        <span class="open">Open review →</span>
      </a>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; object-src 'none'">
  <title>SafeRide reviewer pack — Start here</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #17233c; background: #f3f6f9; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; }
    main { width: min(820px, 100%); padding: 34px; border: 1px solid #dce4eb; border-radius: 22px; background: white; box-shadow: 0 24px 70px rgba(23, 35, 60, .12); }
    .eyebrow { margin: 0 0 8px; color: #137869; font-size: 12px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
    h1 { margin: 0; font-size: clamp(30px, 5vw, 48px); letter-spacing: -.04em; }
    .intro { max-width: 680px; margin: 12px 0 24px; color: #5c6878; font-size: 16px; line-height: 1.6; }
    .notice { margin-bottom: 18px; padding: 13px 15px; border: 1px solid #f0d99b; border-radius: 12px; background: #fff9e8; color: #6f5310; font-size: 13px; line-height: 1.5; }
    .roles { display: grid; gap: 12px; }
    .role-card { display: grid; grid-template-columns: 44px 1fr auto; align-items: center; gap: 14px; padding: 18px; color: inherit; border: 1px solid #dce4eb; border-radius: 15px; text-decoration: none; transition: transform 140ms cubic-bezier(.23,1,.32,1), border-color 140ms ease, box-shadow 140ms ease; }
    .role-card:active { transform: scale(.985); }
    .role-card:hover { border-color: #1f8c7b; box-shadow: 0 10px 28px rgba(31, 140, 123, .12); }
    .number { display: grid; width: 44px; height: 44px; place-items: center; border-radius: 12px; color: white; background: #1f8c7b; font-weight: 900; }
    .role-card strong, .role-card small { display: block; }
    .role-card strong { font-size: 16px; }
    .role-card small { margin-top: 4px; color: #687484; line-height: 1.4; }
    .open { color: #137869; font-size: 12px; font-weight: 800; }
    ol { margin: 24px 0 0; padding-left: 22px; color: #4e5b6c; line-height: 1.7; }
    @media (max-width: 620px) { main { padding: 22px; } .role-card { grid-template-columns: 44px 1fr; } .open { grid-column: 2; } }
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">SafeRide independent review</p>
    <h1>Start here</h1>
    <p class="intro">Choose the reviewer role below. The correct assignment and all 120 responses are already included—there are no files to select and nothing to upload.</p>
    <div class="notice"><strong>Restricted reviewer pack.</strong> Keep these HTML files in the approved workspace and share them only through the approved secure channel.</div>
    <div class="roles">${cards}
    </div>
    <ol>
      <li>Read the prompt, expected behavior and model response.</li>
      <li>Click <strong>Yes — approve</strong> or <strong>No — flag it</strong>.</li>
      <li>At the end, enter the supplied reviewer ID and confirmation reference, then download the two final JSON files.</li>
    </ol>
  </main>
</body>
</html>
`;
}

if (!fs.existsSync(bundlePath)) throw new Error(`Restricted exact-run bundle was not found at ${bundlePath}`);
const bundleBytes = fs.readFileSync(bundlePath);
const bundleSha256 = sha256(bundleBytes);
if (bundleSha256 !== expectedBundleSha256) throw new Error(`Restricted bundle SHA-256 mismatch: ${bundleSha256}`);

const template = readSource('reviewer-template.html');
const style = readSource('reviewer-app.css').trim();
const coreScript = escapeInlineScript(readSource('reviewer-core.js').trim());
const appScript = escapeInlineScript(readSource('reviewer-app.js').trim());

fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
const generated = [];
for (const form of forms) {
  const assignmentBytes = fs.readFileSync(form.assignmentPath);
  const assignmentSha256 = sha256(assignmentBytes);
  if (assignmentSha256 !== form.assignmentSha256) throw new Error(`${form.reviewerRole} assignment SHA-256 mismatch: ${assignmentSha256}`);
  const rendered = render(template, {
    PAGE_TITLE: escapeHtmlText(form.pageTitle),
    DATA_MODE: 'embedded',
    REVIEWER_ROLE: form.reviewerRole,
    ASSIGNMENT_SHA256: form.assignmentSha256,
    BUNDLE_SHA256: expectedBundleSha256,
    ASSIGNMENT_FILE: form.assignmentFile,
    EMBEDDED_ASSIGNMENT_BASE64: assignmentBytes.toString('base64'),
    EMBEDDED_BUNDLE_BASE64: bundleBytes.toString('base64'),
    STYLE: style,
    CORE_SCRIPT: coreScript,
    APP_SCRIPT: appScript,
  });
  const destination = path.join(outputDir, form.outputFile);
  fs.writeFileSync(destination, rendered, { encoding: 'utf8', mode: 0o600 });
  generated.push({ ...form, sha256: sha256(rendered) });
}

const launcherPath = path.join(outputDir, 'START_HERE.html');
fs.writeFileSync(launcherPath, launcherHtml(generated), { encoding: 'utf8', mode: 0o600 });
const manifest = {
  schema: 'com.saferide.ai.private-reviewer-pack',
  schemaVersion: 1,
  restricted: true,
  evaluationRunId: 'saferide-v058-litertlm-full-20260814',
  privateBundleSha256: expectedBundleSha256,
  files: generated.map(form => ({
    reviewerRole: form.reviewerRole,
    file: form.outputFile,
    sha256: form.sha256,
    assignmentSha256: form.assignmentSha256,
  })),
};
fs.writeFileSync(path.join(outputDir, 'PACK_MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

console.log(`Ready-to-review private pack created: ${outputDir}`);
console.log('Open START_HERE.html. No assignment or bundle selection is required.');
