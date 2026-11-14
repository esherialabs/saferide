import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(repoRoot, 'scripts/build-signed-android-local.sh');
const SECRET = ['fake', 'store', 'password', 'do', 'not', 'print'].join('-');

function run(env) {
  const result = spawnSync('bash', [script, '--check'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test('refuses to run without a keystore', () => {
  const { status, output } = run({});
  assert.notEqual(status, 0);
  assert.match(output, /SAFERIDE_ANDROID_KEYSTORE_PATH is required/);
});

test('refuses a debug keystore and never prints the password', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'saferide-ks-'));
  const debug = path.join(dir, 'debug.keystore');
  writeFileSync(debug, 'not a real keystore');
  const { status, output } = run({
    SAFERIDE_ANDROID_KEYSTORE_PATH: debug,
    SAFERIDE_ANDROID_KEYSTORE_PASSWORD: SECRET,
    SAFERIDE_ANDROID_KEY_ALIAS: 'upload',
  });
  assert.notEqual(status, 0);
  assert.match(output, /debug keystore/);
  assert.ok(!output.includes(SECRET));
});

test('refuses a keystore inside the repository', () => {
  const { status, output } = run({
    SAFERIDE_ANDROID_KEYSTORE_PATH: path.join(repoRoot, 'android/app/debug.keystore'),
    SAFERIDE_ANDROID_KEYSTORE_PASSWORD: SECRET,
    SAFERIDE_ANDROID_KEY_ALIAS: 'upload',
  });
  assert.notEqual(status, 0);
  assert.ok(!output.includes(SECRET));
});

test('requires a password and an alias', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'saferide-ks-'));
  const ks = path.join(dir, 'upload.jks');
  writeFileSync(ks, 'placeholder');
  assert.match(run({ SAFERIDE_ANDROID_KEYSTORE_PATH: ks }).output, /KEYSTORE_PASSWORD/);
  assert.match(
    run({ SAFERIDE_ANDROID_KEYSTORE_PATH: ks, SAFERIDE_ANDROID_KEYSTORE_PASSWORD: SECRET }).output,
    /KEY_ALIAS is required/,
  );
});

// A throwaway git repository holding a copy of the script, with stub tools, so the whole
// --check path runs without a real JDK, SDK or clean checkout.
function fixture({ javaBanner = 'openjdk version "17.0.20.1" 2026-07-21', withJava = true, withSdk = true } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'saferide-fx-'));
  mkdirSync(path.join(dir, 'repo/scripts'), { recursive: true });
  const copy = path.join(dir, 'repo/scripts/build-signed-android-local.sh');
  copyFileSync(script, copy);
  spawnSync('git', ['init', '-q'], { cwd: path.join(dir, 'repo') });
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], { cwd: path.join(dir, 'repo') });
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x'], { cwd: path.join(dir, 'repo') });
  const jdk = path.join(dir, 'jdk');
  mkdirSync(path.join(jdk, 'bin'), { recursive: true });
  if (withJava) {
    writeFileSync(path.join(jdk, 'bin/java'), `#!/bin/sh\necho '${javaBanner}' >&2\necho 'OpenJDK Runtime Environment' >&2\n`);
    chmodSync(path.join(jdk, 'bin/java'), 0o755);
  }
  const sdk = path.join(dir, 'sdk');
  mkdirSync(path.join(sdk, 'build-tools/35.0.0'), { recursive: true });
  mkdirSync(path.join(sdk, 'build-tools/34.0.0'), { recursive: true });
  if (withSdk) {
    for (const v of ['34.0.0', '35.0.0']) {
      for (const tool of ['apksigner', 'aapt']) {
        writeFileSync(path.join(sdk, 'build-tools', v, tool), '#!/bin/sh\n');
        chmodSync(path.join(sdk, 'build-tools', v, tool), 0o755);
      }
    }
  }
  const keystore = path.join(dir, 'upload.jks');
  writeFileSync(keystore, 'placeholder');
  return {
    dir,
    copy,
    env: {
      SAFERIDE_ANDROID_KEYSTORE_PATH: keystore,
      SAFERIDE_ANDROID_KEYSTORE_PASSWORD: SECRET,
      SAFERIDE_ANDROID_KEY_ALIAS: 'upload',
      JAVA_HOME: jdk,
      ANDROID_HOME: sdk,
    },
  };
}

function runIn(fx, { args = ['--check'], bashFlags = [], env = {} } = {}) {
  const result = spawnSync('bash', [...bashFlags, fx.copy, ...args], {
    cwd: path.dirname(path.dirname(fx.copy)),
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...fx.env, ...env },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test('--check passes with a JDK that prints a 17.0.x banner', () => {
  const { status, output } = runIn(fixture());
  assert.equal(status, 0, output);
  assert.match(output, /inputs ok/);
  assert.match(output, /build-tools: 35\.0\.0/);
});

test('--check rejects other JDK versions by number', () => {
  for (const banner of ['openjdk version "21.0.4" 2026-01-01', 'java version "1.8.0_402"']) {
    const { status, output } = runIn(fixture({ javaBanner: banner }));
    assert.notEqual(status, 0);
    assert.match(output, /JDK 17 is required \(found (21|1)\)/);
  }
});

test('--check names a missing JAVA_HOME or ANDROID_HOME', () => {
  const noJava = runIn(fixture(), { env: { JAVA_HOME: '' } });
  assert.notEqual(noJava.status, 0);
  assert.match(noJava.output, /JAVA_HOME \(JDK 17\) is required/);
  const noSdk = runIn(fixture(), { env: { ANDROID_HOME: '' } });
  assert.notEqual(noSdk.status, 0);
  assert.match(noSdk.output, /ANDROID_HOME is required/);
  const noTools = runIn(fixture({ withSdk: false }));
  assert.notEqual(noTools.status, 0);
  assert.match(noTools.output, /build-tools \(apksigner, aapt\) not found/);
});

test('a pinned build-tools or platform version must exist', () => {
  const fx = fixture();
  const tools = runIn(fx, { env: { SAFERIDE_BUILD_TOOLS_VERSION: '33.0.2' } });
  assert.notEqual(tools.status, 0);
  assert.match(tools.output, /build-tools 33\.0\.2 not found/);
  const pinned = runIn(fx, { env: { SAFERIDE_BUILD_TOOLS_VERSION: '34.0.0' } });
  assert.equal(pinned.status, 0, pinned.output);
  assert.match(pinned.output, /build-tools: 34\.0\.0/);
  const platform = runIn(fx, { env: { SAFERIDE_ANDROID_PLATFORM: 'android-35' } });
  assert.notEqual(platform.status, 0);
  assert.match(platform.output, /platform android-35 not found/);
});

test('a keystore symlinked into the repository is refused', () => {
  const fx = fixture();
  const inside = path.join(path.dirname(path.dirname(fx.copy)), 'inside.jks');
  symlinkSync(fx.env.SAFERIDE_ANDROID_KEYSTORE_PATH, inside);
  // The link lives in the repo but points outside: allowed, because the real file is outside.
  assert.equal(runIn(fx, { env: { SAFERIDE_ANDROID_KEYSTORE_PATH: inside } }).status, 0);
  // A link outside the repo that points into it is refused.
  const real = path.join(path.dirname(path.dirname(fx.copy)), 'real.jks');
  writeFileSync(real, 'placeholder');
  const outside = path.join(fx.dir, 'link.jks');
  symlinkSync(real, outside);
  const { status, output } = runIn(fx, { env: { SAFERIDE_ANDROID_KEYSTORE_PATH: outside } });
  assert.notEqual(status, 0);
  assert.match(output, /outside the repository/);
});

test('passwords never appear in a bash -x trace, from the environment or from files', () => {
  const fx = fixture();
  const fileSecret = 'fake-file-password-do-not-print';
  const secretFile = path.join(fx.dir, 'store.pw');
  writeFileSync(secretFile, fileSecret);
  const keyFile = path.join(fx.dir, 'key.pw');
  writeFileSync(keyFile, `${fileSecret}-key`);
  for (const env of [
    {},
    { SAFERIDE_ANDROID_KEYSTORE_PASSWORD: '', SAFERIDE_ANDROID_KEYSTORE_PASSWORD_FILE: secretFile, SAFERIDE_ANDROID_KEY_PASSWORD_FILE: keyFile },
    { SAFERIDE_ANDROID_KEY_PASSWORD: `${SECRET}-key` },
  ]) {
    const { status, output } = runIn(fx, { bashFlags: ['-x'], env });
    assert.equal(status, 0, output);
    assert.ok(output.includes('+ '), 'the run was really traced');
    for (const secret of [SECRET, `${SECRET}-key`, fileSecret, `${fileSecret}-key`]) {
      assert.ok(!output.includes(secret), `a secret leaked into the trace: ${secret}`);
    }
  }
});

test('the signing secrets are exported only to the Gradle step', async () => {
  const { readFileSync } = await import('node:fs');
  const text = readFileSync(script, 'utf8');
  const npm = text.indexOf('npm ci');
  const exportLine = text.indexOf('export SAFERIDE_ANDROID_KEYSTORE_PASSWORD SAFERIDE_ANDROID_KEY_PASSWORD');
  assert.ok(npm > 0 && exportLine > npm, 'secrets are exported after npm ci, inside the Gradle subshell');
  assert.match(text, /--max-workers="\$workers"/);
  assert.match(text, /trap 'rm -rf "\$work"' EXIT/);
});
