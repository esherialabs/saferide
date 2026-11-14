import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('v0.5.1 mitigation adjudication and dataset schemas compile in strict mode', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, formats: { 'date-time': true } });
  for (const name of [
    'ai-v051-mitigation-adjudication-package.schema.json',
    'ai-v051-mitigation-adjudication-review.schema.json',
    'ai-v051-experimental-governance-amendment.schema.json',
    'ai-v051-system-prompt.schema.json',
    'ai-v051-mitigation-plan.schema.json',
    'ai-v051-mitigation-authoring-source.schema.json',
    'ai-v051-mitigation-example.schema.json',
    'ai-v051-mitigation-review.schema.json',
    'ai-v051-mitigation-semantic-request.schema.json',
    'ai-v051-mitigation-semantic-report.schema.json',
    'ai-v051-semantic-separation-policy.schema.json',
    'ai-v051-prompt-source-embedding-manifest.schema.json',
    'ai-v051-prompt-semantic-summary.schema.json',
    'ai-v051-semantic-remediation.schema.json',
    'ai-v051-diversity-remediation.schema.json',
    'ai-v051-mitigation-manifest.schema.json',
  ]) {
    const schema = JSON.parse(fs.readFileSync(path.join(root, 'schemas', name), 'utf8'));
    assert.doesNotThrow(() => ajv.compile(schema), name);
  }
});

test('v0.5.1 prompt-only semantic policy validates against its strict schema', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'schemas', 'ai-v051-semantic-separation-policy.schema.json'), 'utf8'));
  const policy = JSON.parse(fs.readFileSync(path.join(root, 'config', 'ai', 'datasets', 'saferide-gemma4-v051-semantic-separation-policy.json'), 'utf8'));
  const validate = ajv.compile(schema);
  assert.equal(validate(policy), true, JSON.stringify(validate.errors));
});
