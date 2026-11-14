import fs from 'node:fs';
import path from 'node:path';

export function resolveBuildProfile(eas, name, visited = new Set()) {
  if (visited.has(name)) throw new Error('Cyclic EAS profile inheritance.');
  const child = eas.build?.[name];
  if (!child) throw new Error('Missing EAS build profile.');
  visited.add(name);
  const parent = child.extends ? resolveBuildProfile(eas, child.extends, visited) : {};
  return { ...parent, ...child, env: { ...parent.env, ...child.env }, android: { ...parent.android, ...child.android } };
}

export function validateLineageConfiguration({ contract, app, eas, baseline, easIgnore }) {
  const errors = [];
  const check = (ok, message) => { if (!ok) errors.push(message); };
  check(contract.schemaVersion === 1, 'Unknown Android lineage contract version.');
  check(contract.currentDelivery?.buildExecutor === 'local-gradle' && contract.currentDelivery?.downloadHost === 'github-releases', 'Current owner-selected delivery path is local Gradle builds with GitHub Releases downloads.');
  check(contract.currentDelivery?.testingRepository === 'esherialabs/saferide-internal' && contract.currentDelivery?.testingVisibility === 'private' && contract.currentDelivery?.draftFirst === true && contract.currentDelivery?.tagPrefix === 'android-internal-', 'Internal testing downloads must use draft-first private GitHub releases and the reviewed tag namespace.');
  check(app.android?.package === contract.packageId, 'Android package differs from the release lineage.');
  check(app.extra?.eas?.projectId === contract.easProjectId, 'EAS project differs from the release lineage.');
  check(app.runtimeVersion?.policy === 'appVersion', 'Runtime policy must be reviewed before changing appVersion isolation.');
  check(typeof app.version === 'string' && /^\d+\.\d+\.\d+$/.test(app.version), 'Source app version must be a reviewed three-part version.');
  check(Number.isSafeInteger(app.android?.versionCode) && app.android.versionCode > 0, 'Source fallback Android version code must be a positive integer.');
  check(eas.cli?.appVersionSource === 'remote', 'EAS version source must remain remote.');
  check(baseline.releaseArtifacts?.signingCertificate?.sha256 === contract.publishedBaseline.certificateSha256, 'Baseline signing certificate does not match recorded release evidence.');
  check(baseline.releaseArtifacts?.apk?.sha256 === contract.publishedBaseline.apkSha256, 'Baseline APK hash does not match recorded release evidence.');
  check(baseline.releaseArtifacts?.sourceCommit === contract.publishedBaseline.sourceCommit && baseline.releaseArtifacts?.versionName === contract.publishedBaseline.appVersion && baseline.releaseArtifacts?.versionCode === contract.publishedBaseline.versionCode && baseline.releaseArtifacts?.packageName === contract.packageId, 'Baseline source/package/version identity differs from recorded release evidence.');
  check(baseline.model?.modelId === contract.model.id && baseline.model?.manifestId === contract.model.manifestId && baseline.model?.artifactSha256 === contract.model.sha256 && baseline.model?.artifactSizeBytes === contract.model.sizeBytes && baseline.model?.runtimeDependency === `com.google.ai.edge.litertlm:litertlm-android:${contract.model.runtime}`, 'Model artifact/runtime contract differs from recorded release evidence.');
  const rules = easIgnore.split(/\r?\n/).map(line => line.trim());
  check(rules.includes('/android/') && rules.includes('/ios/') && !rules.includes('android/') && !rules.includes('ios/'), 'Anchor native archive exclusions at the project root; nested plugin templates must be uploaded.');
  const profiles = new Map();
  for (const name of new Set(Object.values(contract.profiles))) {
    let profile;
    try { profile = resolveBuildProfile(eas, name); } catch { errors.push(`Cannot resolve profile ${name}.`); continue; }
    profiles.set(name, profile);
    check(profile.channel === 'preview' && profile.environment === 'preview', `${name} must use the preview channel/environment.`);
    check(profile.autoIncrement === true, `${name} must allocate a new EAS version code.`);
    check(profile.env?.EXPO_PUBLIC_ENVIRONMENT === 'staging', `${name} must preserve staging environment selection.`);
    check(profile.env?.EXPO_PUBLIC_LOCAL_ASSISTANT_MODEL_ID === contract.model.id, `${name} model ID differs from reviewed lineage.`);
    check(profile.env?.EXPO_PUBLIC_LOCAL_ASSISTANT_QA_TUNED_MANIFEST_ID === contract.model.manifestId, `${name} manifest ID differs from reviewed lineage.`);
    check(profile.env?.SAFERIDE_LITERTLM_VERSION === contract.model.runtime, `${name} native runtime differs from reviewed lineage.`);
    check(profile.env?.EXPO_PUBLIC_OPENAI_ENABLED === 'false', `${name} must keep direct OpenAI disabled.`);
    check(profile.env?.EXPO_PUBLIC_AZURE_OPENAI_TRANSCRIPTION_ENABLED === 'false', `${name} must keep remote transcription disabled.`);
    check(profile.env?.EXPO_PUBLIC_LOCAL_ASSISTANT_ENABLED === 'true' && profile.env?.EXPO_PUBLIC_LOCAL_ASSISTANT_PREFER_ON_DEVICE === 'true' && profile.env?.EXPO_PUBLIC_LOCAL_ASSISTANT_ALLOW_REAL_LITERTLM_RUNTIME === 'true' && profile.env?.SAFERIDE_LITERTLM_ENABLED === 'true', `${name} must preserve the reviewed on-device runtime flags.`);
  }
  const apk = profiles.get(contract.profiles['canonical-preview']);
  const aab = profiles.get(contract.profiles['play-internal']);
  check(apk?.distribution === 'internal' && apk?.android?.buildType === 'apk', 'Direct-install profile must produce an internal APK.');
  check(aab?.distribution === 'store' && aab?.android?.buildType === 'app-bundle', 'Play profile must produce a store AAB.');
  check(eas.submit?.[contract.profiles['play-internal']]?.android?.track === 'internal', 'Play submit profile must target internal testing.');
  return errors;
}

export function validateAndroidCandidate({ candidate, contract, purpose, expectedSource, versionFloors }) {
  const errors = [], warnings = [];
  const check = (ok, message) => { if (!ok) errors.push(message); };
  check(Object.hasOwn(contract.profiles, purpose), 'Select ui-test, canonical-preview or play-internal explicitly.');
  check(/^[a-f0-9]{40}$/.test(expectedSource ?? ''), 'An exact approved source commit is required.');
  check(candidate.sourceCommit === expectedSource, 'Artifact source differs from the approved source commit.');
  check(candidate.packageId === contract.packageId, 'Artifact package differs from the release lineage.');
  check(candidate.buildProfile === contract.profiles[purpose], 'Artifact profile differs from the selected distribution path.');
  check(candidate.signatureVerified === true && /^[a-f0-9]{64}$/.test(candidate.certificateSha256 ?? ''), 'Verified artifact signature and certificate SHA-256 are required.');
  check(/^[a-f0-9]{64}$/.test(candidate.sha256 ?? '') && Number.isSafeInteger(candidate.sizeBytes) && candidate.sizeBytes > 0, 'Artifact hash and byte size are required.');
  check(typeof candidate.appVersion === 'string' && /^\d+\.\d+\.\d+$/.test(candidate.appVersion), 'Artifact app version must be recorded.');
  check(Number.isSafeInteger(candidate.versionCode) && candidate.versionCode > 0, 'Artifact Android version code must be recorded.');
  check(candidate.runtimeVersion === candidate.appVersion, 'Embedded OTA runtime must match the recorded app version.');
  check(candidate.environment === 'staging' && candidate.channel === 'preview', 'Embedded staging environment and preview update channel are required.');
  check(candidate.modelId === contract.model.id && candidate.manifestId === contract.model.manifestId && candidate.realRuntimeAllowed === true, 'Embedded model/manifest/runtime tuple differs from the reviewed candidate.');
  check(candidate.modelRuntime === contract.model.runtime, 'Native model runtime version differs from the reviewed candidate.');
  const signingMatches = candidate.certificateSha256 === contract.publishedBaseline.certificateSha256;
  const upgradeIdentityCompatible = signingMatches && candidate.packageId === contract.packageId && candidate.versionCode > contract.publishedBaseline.versionCode;
  if (!signingMatches) warnings.push('Certificate differs from the published preview. This artifact cannot replace that installed APK through an ordinary in-place update; do not uninstall or clear user data to bypass this.');
  if (candidate.appVersion === contract.publishedBaseline.appVersion) warnings.push(`This binary shares OTA runtime ${contract.publishedBaseline.appVersion} with the previous preview. Do not publish an OTA update across unverified native generations.`);
  if (purpose !== 'ui-test') {
    check(signingMatches, 'Canonical/store candidate must use the established upload certificate. A key migration is a separate reviewed release operation.');
    check(Array.isArray(candidate.abis) && candidate.abis.length === 1 && candidate.abis[0] === 'arm64-v8a', 'Established canonical/store lane is arm64-v8a only.');
    check(typeof candidate.nativeInputsChanged === 'boolean', 'Record whether native dependencies/configuration changed since the published baseline.');
    check(candidate.nativeInputsChanged !== true || candidate.appVersion !== contract.publishedBaseline.appVersion, 'Native changes require a new reviewed appVersion/runtime before canonical publication.');
    const version = String(candidate.appVersion ?? '').split('.').map(Number);
    const baselineVersion = contract.publishedBaseline.appVersion.split('.').map(Number);
    const differentPart = version.findIndex((part, index) => part !== baselineVersion[index]);
    check(version.length === 3 && version.every(Number.isSafeInteger) && (differentPart === -1 || version[differentPart] > baselineVersion[differentPart]), 'App version must not decrease from the published baseline.');
    check(Number.isSafeInteger(versionFloors?.eas) && versionFloors.eas >= 0, 'Record the EAS version-code floor before candidate allocation.');
    check(versionFloors?.play === undefined || (Number.isSafeInteger(versionFloors.play) && versionFloors.play >= 0), 'An applicable Play version-code floor must be a non-negative integer.');
    const floor = Math.max(contract.publishedBaseline.versionCode, versionFloors?.eas ?? 0, versionFloors?.play ?? 0);
    check(candidate.versionCode > floor, 'Candidate version code must exceed published, pre-allocation EAS and applicable Play floors. Failed/canceled allocations are not reused.');
    check(candidate.backendVerified === true, 'Connected candidate requires current backend smoke evidence.');
    const testedApk = purpose === 'play-internal' ? candidate.testedApkSha256 : candidate.sha256;
    check(/^[a-f0-9]{64}$/.test(testedApk ?? '') && candidate.deviceEvidence?.cleanInstall === true && candidate.deviceEvidence?.upgrade === true && candidate.deviceEvidence?.installedApkSha256 === testedApk, 'Fresh clean-install, same-certificate upgrade and installed-APK hash proof are required.');
    if (purpose === 'canonical-preview') check(candidate.artifactType === 'apk', 'Canonical direct download requires an APK.');
    if (purpose === 'play-internal') {
      check(candidate.artifactType === 'aab', 'Google Play requires the approved AAB, not the UI-test APK.');
      check(Number.isSafeInteger(versionFloors?.play) && versionFloors.play >= 0, 'Record the highest Play Console version code before submission.');
      check(candidate.playUploadCertificateAccepted === true, 'Confirm Play has accepted the upload certificate.');
      check(candidate.testedApkSourceCommit === candidate.sourceCommit && candidate.testedApkVersionCode === candidate.versionCode && candidate.testedApkAppVersion === candidate.appVersion && candidate.testedApkCertificateSha256 === candidate.certificateSha256, 'Device-tested APK must match the AAB source, version and upload certificate.');
    }
  } else {
    check(candidate.artifactType === 'apk', 'UI-test lane requires an APK.');
    warnings.push('UI-test verification is not canonical download publication, device acceptance or Google Play submission authority.');
  }
  return { ok: errors.length === 0, errors, warnings, upgradeIdentityCompatible };
}

export function loadLineageInputs(root) {
  const json = relative => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8').replace(/^\uFEFF/, ''));
  const contract = json('config/release/android-release-lineage.v1.json');
  return { contract, app: json('app.json').expo, eas: json('eas.json'), baseline: json(contract.publishedBaseline.evidence), easIgnore: fs.readFileSync(path.join(root, '.easignore'), 'utf8') };
}
