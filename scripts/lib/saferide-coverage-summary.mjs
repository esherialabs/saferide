/**
 * Turn Vitest coverage-summary JSON into a deterministic Markdown table.
 *
 * The generator is read-only and reports what the existing gates already
 * produced. It never asserts a threshold, so it cannot weaken the 15% global
 * or 80% critical gates in config/release/coverage-policy.v1.json.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Suites in the order they are reported, with the summary each one writes. */
export const COVERAGE_SUMMARY_SOURCES = Object.freeze([
  Object.freeze({ label: 'All source', file: 'coverage/all-source/coverage-summary.json' }),
  Object.freeze({
    label: 'Critical safety and privacy',
    file: 'coverage/critical-safety-privacy/coverage-summary.json',
  }),
]);

/** Metric order is fixed so the table is byte-identical across runs. */
export const COVERAGE_METRICS = Object.freeze(['statements', 'branches', 'functions', 'lines']);

export class CoverageSummaryError extends Error {}

function assertMetric(value, metric, file) {
  if (value === null || typeof value !== 'object') {
    throw new CoverageSummaryError(`${file}: total.${metric} is missing`);
  }
  for (const key of ['covered', 'total', 'pct']) {
    if (typeof value[key] !== 'number' || Number.isNaN(value[key])) {
      throw new CoverageSummaryError(`${file}: total.${metric}.${key} is not a number`);
    }
  }
}

/**
 * Read one coverage-summary.json and return its `total` block.
 *
 * Throws CoverageSummaryError -- not a bare SyntaxError or ENOENT -- so the
 * CLI can report which file was wrong rather than a stack trace.
 */
export function readCoverageSummary(absolutePath) {
  let raw;
  try {
    raw = fs.readFileSync(absolutePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new CoverageSummaryError(
        `${absolutePath}: not found -- run npm run coverage:check:public first`,
      );
    }
    throw new CoverageSummaryError(`${absolutePath}: ${error.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CoverageSummaryError(`${absolutePath}: not valid JSON (${error.message})`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CoverageSummaryError(`${absolutePath}: expected a JSON object`);
  }
  const total = parsed.total;
  if (total === null || typeof total !== 'object' || Array.isArray(total)) {
    throw new CoverageSummaryError(`${absolutePath}: missing a "total" object`);
  }
  for (const metric of COVERAGE_METRICS) {
    assertMetric(total[metric], metric, absolutePath);
  }
  return total;
}

/** One percentage, always two decimal places, so runs diff cleanly. */
export function formatPercent(pct) {
  return `${pct.toFixed(2)}%`;
}

/** The Markdown table for a single suite's `total` block. */
export function formatSummaryTable(total) {
  const rows = COVERAGE_METRICS.map((metric) => {
    const { covered, total: count, pct } = total[metric];
    const name = metric[0].toUpperCase() + metric.slice(1);
    return `| ${name} | ${covered} | ${count} | ${formatPercent(pct)} |`;
  });
  return ['| Metric | Covered | Total | Percent |', '| --- | ---: | ---: | ---: |', ...rows].join('\n');
}

/**
 * Build the full report for every configured suite.
 *
 * `sources` is injectable so tests do not depend on a coverage run.
 */
export function buildCoverageReport({
  rootDir,
  sources = COVERAGE_SUMMARY_SOURCES,
  heading = 'Coverage summary',
} = {}) {
  if (typeof rootDir !== 'string' || rootDir.length === 0) {
    throw new CoverageSummaryError('rootDir is required');
  }
  const sections = sources.map(({ label, file }) => {
    const total = readCoverageSummary(path.join(rootDir, file));
    return [`## ${label}`, '', `Source: \`${file}\``, '', formatSummaryTable(total)].join('\n');
  });
  return [`# ${heading}`, ...sections].join('\n\n').concat('\n');
}
