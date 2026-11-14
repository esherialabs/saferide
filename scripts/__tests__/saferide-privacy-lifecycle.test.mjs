import assert from 'node:assert/strict';
import test from 'node:test';

import { validatePrivacyLifecycle } from '../saferide-privacy-lifecycle-check.mjs';

test('privacy lifecycle controls and fail-closed source gates validate', async () => {
  const result = await validatePrivacyLifecycle();
  assert.equal(result.controlVersion, 'privacy-controls.2026-07-30.2');
  assert.equal(result.documentCount, 2);
  assert.equal(result.retentionPolicyCount, 6);
  assert.ok(result.checks >= 28);
});
