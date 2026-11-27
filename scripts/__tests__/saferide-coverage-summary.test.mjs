import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  COVERAGE_METRICS,
  COVERAGE_SUMMARY_SOURCES,
  CoverageSummaryError,
  buildCoverageReport,
  formatPercent,
  formatSummaryTable,
  readCoverageSummary,
} from '../lib/saferide-coverage-summary.mjs';

function metric(covered, total, pct) {
  return { covered, total, skipped: 0, pct };
}

function totalBlock() {
  return {
    statements: metric(120, 400, 30),
    branches: metric(40, 200, 20),
    functions: metric(15, 60, 25),
    lines: metric(118, 395, 29.87),
  };
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'saferide-coverage-'));
}

function writeSummary(rootDir, relativePath, contents) {
  const target = path.join(rootDir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return target;
}

test('reads the total block from a well-formed summary', () => {
  const root = tempRoot();
  const file = writeSummary(root, 'coverage/all-source/coverage-summary.json', {
    total: totalBlock(),
    '/repo/src/a.ts': { lines: metric(1, 1, 100) },
  });
  const total = readCoverageSummary(file);
  assert.equal(total.statements.covered, 120);
  assert.equal(total.branches.total, 200);
});

test('a missing file names the file and the command that creates it', () => {
  const root = tempRoot();
  assert.throws(
    () => readCoverageSummary(path.join(root, 'coverage/all-source/coverage-summary.json')),
    (error) => error instanceof CoverageSummaryError && /not found/.test(error.message),
  );
});

test('malformed JSON is reported as such, not as a SyntaxError', () => {
  const root = tempRoot();
  const file = writeSummary(root, 'coverage/all-source/coverage-summary.json', '{ not json');
  assert.throws(
    () => readCoverageSummary(file),
    (error) => error instanceof CoverageSummaryError && /not valid JSON/.test(error.message),
  );
});

test('a JSON array is rejected', () => {
  const root = tempRoot();
  const file = writeSummary(root, 'coverage/all-source/coverage-summary.json', []);
  assert.throws(() => readCoverageSummary(file), CoverageSummaryError);
});

test('a summary without a total block is rejected', () => {
  const root = tempRoot();
  const file = writeSummary(root, 'coverage/all-source/coverage-summary.json', { '/a.ts': {} });
  assert.throws(
    () => readCoverageSummary(file),
    (error) => error instanceof CoverageSummaryError && /missing a "total" object/.test(error.message),
  );
});

for (const missing of COVERAGE_METRICS) {
  test(`a total block missing ${missing} is rejected`, () => {
    const root = tempRoot();
    const block = totalBlock();
    delete block[missing];
    const file = writeSummary(root, 'coverage/all-source/coverage-summary.json', { total: block });
    assert.throws(
      () => readCoverageSummary(file),
      (error) => error instanceof CoverageSummaryError && error.message.includes(missing),
    );
  });
}

test('a non-numeric percentage is rejected', () => {
  const root = tempRoot();
  const block = totalBlock();
  block.lines.pct = 'unknown';
  const file = writeSummary(root, 'coverage/all-source/coverage-summary.json', { total: block });
  assert.throws(
    () => readCoverageSummary(file),
    (error) => error instanceof CoverageSummaryError && /lines\.pct/.test(error.message),
  );
});

test('percentages always carry two decimals', () => {
  assert.equal(formatPercent(30), '30.00%');
  assert.equal(formatPercent(29.871), '29.87%');
  assert.equal(formatPercent(0), '0.00%');
  assert.equal(formatPercent(100), '100.00%');
});

test('the table lists statements, branches, functions, lines in that order', () => {
  const rows = formatSummaryTable(totalBlock()).split('\n');
  assert.equal(rows[0], '| Metric | Covered | Total | Percent |');
  assert.match(rows[2], /^\| Statements \| 120 \| 400 \| 30\.00% \|$/);
  assert.match(rows[3], /^\| Branches \| 40 \| 200 \| 20\.00% \|$/);
  assert.match(rows[4], /^\| Functions \| 15 \| 60 \| 25\.00% \|$/);
  assert.match(rows[5], /^\| Lines \| 118 \| 395 \| 29\.87% \|$/);
});

test('the report covers both configured suites and is deterministic', () => {
  const root = tempRoot();
  for (const { file } of COVERAGE_SUMMARY_SOURCES) {
    writeSummary(root, file, { total: totalBlock() });
  }
  const first = buildCoverageReport({ rootDir: root });
  const second = buildCoverageReport({ rootDir: root });

  assert.equal(first, second, 'two runs over the same input must be byte-identical');
  assert.match(first, /^# Coverage summary\n/);
  for (const { label, file } of COVERAGE_SUMMARY_SOURCES) {
    assert.ok(first.includes(`## ${label}`), `missing section for ${label}`);
    assert.ok(first.includes(`\`${file}\``), `missing source path for ${label}`);
  }
  assert.ok(first.endsWith('\n'));
});

test('the report fails if either suite has not been run', () => {
  const root = tempRoot();
  writeSummary(root, COVERAGE_SUMMARY_SOURCES[0].file, { total: totalBlock() });
  assert.throws(() => buildCoverageReport({ rootDir: root }), CoverageSummaryError);
});

test('rootDir is required', () => {
  assert.throws(() => buildCoverageReport({}), CoverageSummaryError);
});
