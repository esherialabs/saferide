import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveReleaseRecord, resolveSourceBranch } from '../lib/public-mirror-provenance.mjs';

const base = { policyBranch: 'main', allowNonMain: false, headShort: 'abc123def456' };

test('records main for a checked-out main or a detached HEAD at origin/main', () => {
  assert.equal(resolveSourceBranch({ ...base, headBranches: ['main'] }), 'main');
  assert.equal(resolveSourceBranch({ ...base, headBranches: ['feature', 'main'] }), 'main');
});

test('refuses a non-main HEAD unless --allow-non-main is passed', () => {
  assert.throws(() => resolveSourceBranch({ ...base, headBranches: ['codex/fix'] }), /not main/);
  assert.throws(() => resolveSourceBranch({ ...base, headBranches: [] }), /detached@abc123def456/);
  assert.equal(resolveSourceBranch({ ...base, allowNonMain: true, headBranches: ['codex/fix'] }), 'codex/fix');
  assert.equal(resolveSourceBranch({ ...base, allowNonMain: true, headBranches: [] }), 'detached@abc123def456');
});

test('rejects a --source-branch that HEAD is not on', () => {
  assert.throws(() => resolveSourceBranch({ ...base, headBranches: ['main'], explicit: 'release' }), /does not match HEAD/);
  assert.throws(() => resolveSourceBranch({ ...base, allowNonMain: true, headBranches: [], explicit: 'main' }), /does not match HEAD/);
  assert.equal(resolveSourceBranch({ ...base, headBranches: ['main', 'other'], explicit: 'main' }), 'main');
});

test('resolves the release record the website imports and requires it to ship', () => {
  const importerPath = 'web/src/lib/android-release.ts';
  const importerText = "import release from '../../public/releases/saferide-1.0.4-code23-android.json';\n";
  const record = 'web/public/releases/saferide-1.0.4-code23-android.json';
  assert.equal(resolveReleaseRecord({ importerPath, importerText, published: new Set([record]) }), record);
  assert.throws(() => resolveReleaseRecord({ importerPath, importerText, published: new Set() }), /not part of the public snapshot/);
  assert.throws(() => resolveReleaseRecord({ importerPath, importerText: 'export {};', published: new Set([record]) }), /Cannot find/);
});
