#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { buildCoverageReport, CoverageSummaryError } from './lib/saferide-coverage-summary.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  process.stdout.write(buildCoverageReport({ rootDir }));
} catch (error) {
  console.error(
    error instanceof CoverageSummaryError ? error.message : String(error),
  );
  process.exitCode = 1;
}
