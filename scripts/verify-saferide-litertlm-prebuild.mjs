import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceArgument = process.argv.find((argument) => argument.startsWith('--source-root='));
const sourceRoot = sourceArgument
  ? path.resolve(sourceArgument.slice('--source-root='.length))
  : repoRoot;
assert.ok(existsSync(path.join(sourceRoot, 'app.config.js')), 'Source app.config.js is missing.');
const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'saferide-android-prebuild-'));
const keepGenerated = process.argv.includes('--keep-generated');
const excludedRoots = new Set(['.git', 'android', 'ios', 'node_modules', 'outputs', 'artifacts', '.models', '.ai-smoke', '.venv-ai']);

function shouldCopy(sourcePath) {
  const relativePath = path.relative(sourceRoot, sourcePath);
  if (!relativePath) return true;
  const [rootName] = relativePath.split(path.sep);
  if (excludedRoots.has(rootName)) return false;
  // Nested workspace dependencies and Git metadata are not prebuild source.
  // In particular, never copy a nested dependency junction into this tree.
  if (['node_modules', '.git', '__pycache__'].includes(path.basename(sourcePath))) return false;
  return !path.basename(sourcePath).startsWith('.env');
}

function readGenerated(relativePath) {
  const generatedPath = path.join(temporaryRoot, relativePath);
  assert.ok(existsSync(generatedPath), `Missing generated file: ${relativePath}`);
  return readFileSync(generatedPath, 'utf8');
}

try {
  cpSync(sourceRoot, temporaryRoot, {
    recursive: true,
    filter: shouldCopy,
  });
  symlinkSync(
    path.join(repoRoot, 'node_modules'),
    path.join(temporaryRoot, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  const eas = JSON.parse(readFileSync(path.join(sourceRoot, 'eas.json'), 'utf8'));
  const previewEnv = eas?.build?.preview?.env;
  assert.ok(previewEnv && typeof previewEnv === 'object', 'EAS preview environment is missing.');

  const expoCli = path.join(repoRoot, 'node_modules', 'expo', 'bin', 'cli');
  const result = spawnSync(
    process.execPath,
    [expoCli, 'prebuild', '--platform', 'android', '--no-install'],
    {
      cwd: temporaryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...previewEnv,
        CI: '1',
      },
    },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    throw new Error(`Clean Android prebuild failed with exit code ${result.status ?? 'unknown'}.`);
  }

  const kotlinRoot = 'android/app/src/main/java/com/esheria/saferide/app/localai';
  const moduleSource = readGenerated(`${kotlinRoot}/SafeRideLiteRtLmModule.kt`);
  readGenerated(`${kotlinRoot}/SafeRideLiteRtLmPackage.kt`);
  assert.match(moduleSource, /esherialabs\/saferide-gemma-4-e2b-v058-original-419806-litertlm/);
  assert.match(moduleSource, /5_071_837_136L/);
  assert.match(moduleSource, /8b73fd844464f220955eeedc474c30f39e621458c7a6b092de5afa2c3d027fcd/);

  const mainApplication = readGenerated(
    'android/app/src/main/java/com/esheria/saferide/app/MainApplication.kt',
  );
  assert.match(mainApplication, /import com\.esheria\.saferide\.app\.localai\.SafeRideLiteRtLmPackage/);
  assert.match(mainApplication, /add\(SafeRideLiteRtLmPackage\(\)\)/);

  const appGradle = readGenerated('android/app/build.gradle');
  assert.match(appGradle, /SAFERIDE_LITERTLM_REAL_RUNTIME_ALLOWED/);
  assert.match(appGradle, /litertlm:litertlm-android:\$\{safeRideLiteRtLmVersion\}/);
  const sourceAppVersion = JSON.parse(readFileSync(path.join(sourceRoot, 'app.json'), 'utf8')).expo.version;
  assert.ok(appGradle.includes(`versionName "${sourceAppVersion}"`), 'Generated version differs from reviewed source app.json.');

  const gradleProperties = readGenerated('android/gradle.properties');
  assert.match(gradleProperties, /saferide\.litertlm\.version=0\.16\.0/);
  assert.match(gradleProperties, /saferide\.litertlm\.enabled=true/);
  assert.match(gradleProperties, /saferide\.litertlm\.realRuntimeAllowed=true/);
  assert.match(gradleProperties, /android\.packagingOptions\.doNotStrip=.*liblitertlm/);

  const manifest = readGenerated('android/app/src/main/AndroidManifest.xml');
  assert.match(manifest, /android:name="libvndksupport\.so"/);
  assert.match(manifest, /android:name="libOpenCL\.so"/);

  const proguard = readGenerated('android/app/proguard-rules.pro');
  assert.match(proguard, /-keep class com\.google\.ai\.edge\.litertlm\.\*\*/);

  console.log(`Clean Android prebuild regenerated and wired the SafeRide LiteRT-LM bridge from ${sourceRoot}.`);
} finally {
  // Windows junction cleanup can traverse the shared dependency target. Retain
  // the verification tree until its links have been detached independently.
  if (keepGenerated || process.platform === 'win32') {
    console.log(`Generated Android verification project retained at ${temporaryRoot}`);
    if (process.platform === 'win32' && !keepGenerated) {
      console.log('Windows junction safety: automatic recursive cleanup is disabled.');
    }
  } else {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
}
