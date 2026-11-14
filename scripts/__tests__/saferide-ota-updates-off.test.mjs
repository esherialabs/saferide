import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file) => readFileSync(path.join(repoRoot, file), 'utf8');

const stagingEnv = {
  EAS_BUILD_PLATFORM: 'android',
  EXPO_PUBLIC_ENVIRONMENT: 'staging',
  EXPO_PUBLIC_API_BASE_URL: 'https://qa.saferide.invalid/api',
  EXPO_PUBLIC_AUTH_BASE_URL: 'https://qa.saferide.invalid/auth',
  EXPO_PUBLIC_WS_BASE_URL: 'wss://qa.saferide.invalid',
  EXPO_PUBLIC_STORAGE_BASE_URL: 'https://storage.saferide.invalid/models',
  EXPO_PUBLIC_RUNTIME_CONFIG_URL: 'https://qa.saferide.invalid/api/config/runtime',
  EXPO_PUBLIC_API_TIMEOUT_MS: '10000',
  EXPO_PUBLIC_CONFIG_REFRESH_SECONDS: '60',
  EXPO_PUBLIC_OPENAI_ENABLED: 'false',
  EXPO_PUBLIC_LOCAL_ASSISTANT_ENABLED: 'false',
  EXPO_PUBLIC_LOCAL_ASSISTANT_MODEL_ID: 'litert-community/gemma-4-E2B-it-litert-lm',
  EXPO_PUBLIC_LOCAL_ASSISTANT_PREFER_ON_DEVICE: 'false',
  EXPO_PUBLIC_AZURE_OPENAI_TRANSCRIPTION_ENABLED: 'false',
  EXPO_PUBLIC_RELEASE_ENDPOINT_HOSTS: 'qa.saferide.invalid',
  EXPO_PUBLIC_RELEASE_STORAGE_HOSTS: 'storage.saferide.invalid',
};

function resolvedUpdates(buildProfile) {
  const result = spawnSync(
    process.execPath,
    ['-e', "process.stdout.write(JSON.stringify(require('./app.config.js')({}).updates))"],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, ...stagingEnv, EAS_BUILD_PROFILE: buildProfile },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

for (const profile of ['preview', 'prerelease']) {
  test(`resolved config keeps over-the-air updates off for ${profile}`, () => {
    assert.deepEqual(resolvedUpdates(profile), { enabled: false, checkAutomatically: 'NEVER' });
  });
}

test('app.json has no update URL', () => {
  const { updates } = JSON.parse(read('app.json')).expo;
  assert.equal(updates.enabled, false);
  assert.equal(updates.url, undefined);
});

test('native projects disable the updater and name no update host', () => {
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  assert.match(manifest, /expo\.modules\.updates\.ENABLED" android:value="false"/);
  assert.match(manifest, /EXPO_UPDATES_CHECK_ON_LAUNCH" android:value="NEVER"/);
  assert.doesNotMatch(manifest, /u\.expo\.dev|EXPO_UPDATE_URL/);
  const plist = read('ios/SafeRide/Supporting/Expo.plist');
  assert.match(plist, /<key>EXUpdatesEnabled<\/key>\s*<false\/>/);
  assert.match(plist, /<key>EXUpdatesCheckOnLaunch<\/key>\s*<string>NEVER<\/string>/);
  assert.doesNotMatch(plist, /u\.expo\.dev/);
});
