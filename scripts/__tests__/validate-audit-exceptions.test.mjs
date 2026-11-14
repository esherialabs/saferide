import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Synthetic npm audit reports shaped like the real ones; no network, no lockfile.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(root, 'scripts/validate-mobile-audit.mjs');

function vuln(name, { ids = [], effects = [], isDirect = false, node = `node_modules/${name}`, via = [] } = {}) {
  return {
    name,
    isDirect,
    nodes: [node],
    effects,
    via: [...ids.map(source => ({ source, name, severity: 'moderate' })), ...via],
  };
}

function mobileReport() {
  return {
    vulnerabilities: {
      deepmerge: vuln('deepmerge', { ids: [1243505], effects: ['@expo/config'] }),
      '@expo/config': vuln('@expo/config', { via: ['deepmerge', 'glob'] }),
      glob: vuln('glob', { ids: [1244013], effects: ['@expo/cli', '@expo/config', '@expo/config-plugins', '@expo/fingerprint', '@expo/metro-config', 'expo-updates'] }),
      minimatch: vuln('minimatch', { ids: [1244623], effects: ['@expo/fingerprint', 'glob'] }),
      '@expo/fingerprint': vuln('@expo/fingerprint', { effects: ['expo'] }),
      expo: vuln('expo', { isDirect: true }),
      'expo-updates': vuln('expo-updates', { isDirect: true }),
      uuid: vuln('uuid', { ids: [1119441], effects: ['xcode'] }),
      xcode: vuln('xcode', { effects: ['@expo/config-plugins'] }),
      zod: vuln('zod', { ids: [1243066], effects: ['@expo/cli'], node: 'node_modules/expo/node_modules/zod' }),
    },
    metadata: { vulnerabilities: { critical: 0, high: 1, moderate: 4 } },
  };
}

function apiReport() {
  return {
    vulnerabilities: {
      'decode-uri-component': vuln('decode-uri-component', { ids: [1147955, 1243857], effects: ['query-string'] }),
      'query-string': vuln('query-string', { effects: ['minio'], via: ['decode-uri-component'] }),
      'stream-json': vuln('stream-json', { ids: [1164823, 1241262, 1241263], effects: ['minio'] }),
      minio: vuln('minio', { isDirect: true, via: ['query-string', 'stream-json'] }),
    },
    metadata: { vulnerabilities: { critical: 0, high: 2, moderate: 3 } },
  };
}

function run(policyFile, report) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saferide-audit-exceptions-'));
  try {
    // Keep the date gate out of these cases: they are about dependency shape.
    const policy = JSON.parse(fs.readFileSync(path.join(root, policyFile), 'utf8'));
    policy.expiresOn = '2999-12-31';
    fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify(policy));
    fs.writeFileSync(path.join(dir, 'audit.json'), JSON.stringify(report));
    const result = spawnSync(process.execPath, [script, '--policy', path.join(dir, 'policy.json'), '--input', path.join(dir, 'audit.json')], { encoding: 'utf8' });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const MOBILE = 'config/release/mobile-audit-exceptions.v1.json';
const API = 'config/release/api-audit-exceptions.v1.json';

test('the reviewed mobile and API shapes pass', () => {
  assert.equal(run(MOBILE, mobileReport()).status, 0);
  assert.equal(run(API, apiReport()).status, 0);
});

test('fails when an excused mobile package (deepmerge) becomes a direct dependency', () => {
  const report = mobileReport();
  report.vulnerabilities.deepmerge.isDirect = true;
  const { status, output } = run(MOBILE, report);
  assert.notEqual(status, 0);
  assert.match(output, /deepmerge is now a direct dependency/);
});

test('fails when an API dependent (query-string) becomes a direct dependency', () => {
  const report = apiReport();
  report.vulnerabilities['query-string'].isDirect = true;
  const { status, output } = run(API, report);
  assert.notEqual(status, 0);
  assert.match(output, /dependent query-string is a direct dependency that was not reviewed/);
});

test('fails on a new dependent or a new install path', () => {
  const extra = apiReport();
  extra.vulnerabilities['stream-json'].effects.push('new-dependent');
  assert.match(run(API, extra).output, /unreviewed dependent new-dependent/);
  const moved = mobileReport();
  moved.vulnerabilities.zod.nodes = ['node_modules/zod'];
  assert.match(run(MOBILE, moved).output, /unreviewed path node_modules\/zod/);
});
