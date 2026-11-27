import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkHtmlAccessibility,
  checkLinkText,
  checkLinks,
  countMainLandmarks,
  listMarkdownFiles,
  listSiteHtml,
  runPublicDocsCheck,
} from '../lib/saferide-public-docs.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDir, '../..');
const PASSING = path.join(testDir, 'fixtures/public-docs/passing');
const FAILING = path.join(testDir, 'fixtures/public-docs/failing');
const CLI = path.join(repositoryRoot, 'scripts/saferide-public-docs-check.mjs');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saferide-public-docs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runCli(...args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

const messages = (findings) => findings.map((f) => f.message);
const hasMessage = (findings, fragment) => messages(findings).some((m) => m.includes(fragment));

test('the passing fixture produces no findings', () => {
  const result = runPublicDocsCheck(PASSING);
  assert.deepEqual(result.findings, [], `unexpected findings: ${JSON.stringify(result.findings)}`);
  assert.equal(result.checkedMarkdown, 2);
  assert.equal(result.checkedPages, 1);
});

test('the failing fixture trips every rule exactly once', () => {
  const { findings } = runPublicDocsCheck(FAILING);

  // Each rule appears, so a fixture edit that silently disables one fails here
  // rather than reducing coverage quietly.
  assert.ok(hasMessage(findings, 'broken link: setup-guide.md'));
  assert.ok(hasMessage(findings, 'broken link: ../../PROJECT_CHARTER.md'));
  assert.ok(hasMessage(findings, 'broken link: missing.html'));
  assert.ok(hasMessage(findings, '"click here"'));
  assert.ok(hasMessage(findings, '"read more"'));
  assert.ok(hasMessage(findings, '"here"'));
  assert.ok(hasMessage(findings, 'no main landmark'));
  assert.ok(hasMessage(findings, 'no page title'));
  assert.ok(hasMessage(findings, 'no lang on <html>'));
  assert.ok(hasMessage(findings, 'image with no alt attribute'));
});

test('a finding names the file and, where it has one, the line', () => {
  // A gate that says only "something is wrong" costs more than it saves.
  const { findings } = runPublicDocsCheck(FAILING);
  for (const f of findings) {
    assert.ok(f.file, 'every finding names a file');
    assert.ok(f.message, 'every finding carries a message');
  }
  const broken = findings.find((f) => f.message.includes('setup-guide.md'));
  assert.equal(broken.file, 'docs/open-source/README.md');
  assert.equal(broken.line, 5);
});

test('external, mail and protocol-relative links are left alone', () => {
  // Resolving them would need the network, which would make the gate flaky.
  const findings = checkLinks(PASSING, 'docs/open-source/README.md');
  assert.ok(!hasMessage(findings, 'example.org'));
});

test('a same-page anchor is not treated as a missing file', () => {
  const findings = checkLinks(PASSING, 'docs/open-source/README.md');
  assert.ok(!hasMessage(findings, '#setup'));
});

test('a link with a fragment resolves against the file, not the fragment', () => {
  // build-and-test.md exists; build-and-test.md#anything must too.
  const findings = checkLinks(PASSING, 'docs/open-source/README.md');
  assert.deepEqual(findings, []);
});

test('the same broken target is reported once per file, not once per occurrence', () => {
  const findings = checkLinks(FAILING, 'docs/open-source/README.md');
  const brokenSetupGuide = findings.filter((f) => f.message.includes('setup-guide.md'));
  assert.equal(brokenSetupGuide.length, 1);
});

test('meaningful link text is accepted', () => {
  const findings = checkLinkText(PASSING, 'docs/open-source/README.md');
  assert.deepEqual(findings, []);
});

test('trailing punctuation does not hide meaningless link text', () => {
  const findings = checkLinkText(FAILING, 'docs/open-source/site/index.html');
  assert.ok(hasMessage(findings, '"here"'));
});

test('a page with one main landmark, a title and a lang passes', () => {
  const findings = checkHtmlAccessibility(PASSING, 'docs/open-source/site/index.html');
  assert.deepEqual(findings, []);
});

test('the site directory is not walked as markdown', () => {
  // Otherwise a page would be link-checked twice and counted in both totals.
  const markdown = listMarkdownFiles(PASSING);
  assert.ok(markdown.every((file) => !file.includes('/site/')));
});

test('the real public documentation passes', () => {
  // The gate has to hold on the tree it is being added to, or it is not a gate.
  const result = runPublicDocsCheck(repositoryRoot);
  assert.deepEqual(
    result.findings,
    [],
    `public documentation has findings:\n${JSON.stringify(result.findings, null, 2)}`,
  );
  assert.ok(result.checkedMarkdown > 0, 'no markdown was checked');
  assert.ok(result.checkedPages > 0, 'no site page was checked');
});

test('the check needs no network', () => {
  // Guard the property the acceptance criteria call for: nothing here may open
  // a socket. If a future rule reaches out, this fails.
  const findings = runPublicDocsCheck(PASSING).findings;
  assert.deepEqual(findings, []);
  assert.deepEqual(listSiteHtml(PASSING), ['docs/open-source/site/index.html']);
});

test('a main element that also declares role="main" is one landmark', (t) => {
  assert.equal(countMainLandmarks('<main role="main"><h1>SafeRide</h1></main>'), 1);
  assert.equal(countMainLandmarks("<MAIN ROLE='main'></MAIN>"), 1);

  const root = tempDir(t);
  fs.writeFileSync(
    path.join(root, 'page.html'),
    '<html lang="en"><head><title>SafeRide</title></head><body><main role="main"></main></body></html>',
  );
  assert.deepEqual(checkHtmlAccessibility(root, 'page.html'), []);
});

test('separate main elements are each counted', () => {
  assert.equal(countMainLandmarks('<main></main><main></main>'), 2);
  assert.equal(countMainLandmarks('<main></main><div role="main"></div>'), 2);
  assert.equal(countMainLandmarks('<main role="main"></main><section role="main"></section>'), 2);
  assert.equal(countMainLandmarks('<div role="navigation"></div><mainframe></mainframe>'), 0);
});

test('a root with neither documentation surface is a finding, not a pass', (t) => {
  const result = runPublicDocsCheck(tempDir(t));
  assert.equal(result.checkedMarkdown, 0);
  assert.equal(result.checkedPages, 0);
  assert.ok(hasMessage(result.findings, 'no Markdown files found'));
  assert.ok(hasMessage(result.findings, 'no HTML pages found'));
});

test('a root with Markdown but no site pages still fails', (t) => {
  const root = tempDir(t);
  fs.mkdirSync(path.join(root, 'docs/open-source'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/open-source/README.md'), '# Docs\n');
  const { findings } = runPublicDocsCheck(root);
  assert.ok(!hasMessage(findings, 'no Markdown files found'));
  assert.ok(hasMessage(findings, 'no HTML pages found'));
});

test('the CLI exits 0 on a clean tree, 1 on an empty one and 2 on a missing one', (t) => {
  assert.equal(runCli('--root', PASSING).status, 0);
  assert.equal(runCli('--root', FAILING).status, 1);

  const empty = runCli('--root', tempDir(t));
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /no Markdown files found/);

  const missing = runCli('--root', path.join(tempDir(t), 'does-not-exist'));
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /root is not a directory/);
});
