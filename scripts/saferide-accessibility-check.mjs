#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const REQUIRED_REQUIREMENT_IDS = [
  'A11Y-001',
  'A11Y-002',
  'A11Y-003',
  'A11Y-004',
  'A11Y-005',
  'A11Y-006',
  'A11Y-007',
  'A11Y-008',
];

export const REQUIRED_DEVICE_SCENARIOS = [
  'talkback-home',
  'talkback-report-selection',
  'consent-gate',
  'evidence-annotation',
  'dynamic-type',
  'focus-modals',
  'touch-targets',
  'high-contrast',
  'reduced-motion',
  'landscape',
  'small-screen',
  'chat-large-history',
  'case-large-list',
  'local-assistant-impact',
  'offline-reconnect',
];

const SOURCE_PATHS = {
  tokens: 'src/theme/tokens.ts',
  button: 'src/components/ui/Button.tsx',
  checkbox: 'src/components/ui/Checkbox.tsx',
  switch: 'src/components/ui/Switch.tsx',
  appShell: 'src/components/ui/AppShell.tsx',
  safetyAction: 'src/components/ui/SystemStates.tsx',
  consent: 'src/screens/ConsentGate.tsx',
  incident: 'src/screens/WhatHappened.tsx',
  annotation: 'src/components/ui/PhotoAnnotationOverlay.tsx',
  annotationHelper: 'src/utils/photoAnnotation.ts',
  languageAccessibility: 'src/screens/LanguageAccessibility.tsx',
  themeProvider: 'src/theme/SimpleThemeProvider.tsx',
  chat: 'src/screens/ChatLegalAid.tsx',
  assistantService: 'src/services/localAssistantService.ts',
  modelStorage: 'src/lib/localAssistant/modelStorage.ts',
};

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const FORBIDDEN_EVIDENCE_KEYS = new Set([
  'narrative',
  'incidentNarrative',
  'evidenceContent',
  'exactLocation',
  'coordinates',
  'latitude',
  'longitude',
  'contact',
  'phone',
  'email',
  'token',
  'prompt',
  'completion',
  'participantName',
  'deviceSerial',
]);

let deviceEvidenceShapeValidator;

function getDeviceEvidenceShapeValidator() {
  if (!deviceEvidenceShapeValidator) {
    const schema = JSON.parse(fs.readFileSync(
      path.join(REPOSITORY_ROOT, 'schemas/accessibility-device-evidence.schema.json'),
      'utf8',
    ));
    const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
    deviceEvidenceShapeValidator = ajv.compile(schema);
  }
  return deviceEvidenceShapeValidator;
}

function addGate(gates, id, passed, detail) {
  gates.push({ id, passed: Boolean(passed), detail });
}

function has(source, pattern) {
  return typeof pattern === 'string' ? source.includes(pattern) : pattern.test(source);
}

export function readAccessibilitySources(root = REPOSITORY_ROOT) {
  return Object.fromEntries(Object.entries(SOURCE_PATHS).map(([key, relativePath]) => [
    key,
    fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/\r\n/g, '\n'),
  ]));
}

export function validateAccessibilitySources(sources) {
  const gates = [];

  addGate(gates, 'touch-target-token', has(sources.tokens, /minimum:\s*48\b/), 'Shared minimum touch target is 48dp.');
  addGate(gates, 'button-touch-targets', !has(sources.button, /height:\s*(?:[0-3]?\d|4[0-7])\b/), 'Every shared button size is at least 48dp.');
  addGate(gates, 'checkbox-touch-target', has(sources.checkbox, 'minHeight: touchTargets.minimum') && has(sources.checkbox, 'minWidth: touchTargets.minimum'), 'Checkbox hit target uses the shared minimum.');
  addGate(gates, 'switch-touch-target', has(sources.switch, 'minHeight: touchTargets.minimum') && has(sources.switch, 'minWidth: touchTargets.minimum'), 'Switch hit target uses the shared minimum.');

  addGate(gates, 'consent-checkbox-label', has(sources.consent, 'label={consentSummary.consentStatement}') && has(sources.consent, 'accessibilityHint="Required before confirming this pathway"'), 'Consent control exposes its full statement and consequence.');
  addGate(gates, 'consent-pathway-radio', has(sources.consent, 'accessibilityRole="radiogroup"') && has(sources.consent, 'accessibilityRole="radio"'), 'Consent pathways use one-of-many semantics.');
  addGate(gates, 'consent-expanded-state', has(sources.consent, 'accessibilityState={{ expanded: expandedItems.has(key) }}') && has(sources.consent, 'accessibilityState={{ expanded: showKeyPoints }}'), 'Consent disclosures expose expanded state.');

  addGate(gates, 'incident-checkbox-semantics', has(sources.incident, 'accessibilityRole="checkbox"') && has(sources.incident, 'accessibilityState={{ checked: isSelected }}'), 'Incident patterns expose multi-select semantics.');
  addGate(gates, 'impact-radio-semantics', has(sources.incident, 'accessibilityLabel="Choose one impact level"') && has(sources.incident, 'accessibilityRole="radio"'), 'Impact level exposes one-of-many semantics.');

  addGate(gates, 'annotation-non-coordinate-fallback', has(sources.annotation, 'Accessible placement') && has(sources.annotation, 'createPresetAnnotation') && has(sources.annotationHelper, 'createPresetAnnotation'), 'Photo annotation includes a keyboard/screen-reader placement path.');
  addGate(gates, 'annotation-modal-focus', has(sources.annotation, 'accessibilityViewIsModal') && has(sources.annotation, 'AccessibilityManager.focusElement(modalTitleRef)'), 'Photo annotation traps context and moves initial focus to its heading.');
  addGate(gates, 'annotation-controls-labeled', has(sources.annotation, 'accessibilityLabel="Close photo annotation"') && has(sources.annotation, 'accessibilityRole="radiogroup"') && has(sources.annotation, '`Remove ${describeAnnotation(annotation)}`'), 'Annotation close, tools, and removal actions are labeled.');

  addGate(gates, 'critical-header-wrap', !has(sources.appShell, /headerTitle[\s\S]{0,180}numberOfLines=\{1\}/) && has(sources.appShell, 'numberOfLines={2}'), 'Critical shell headings permit two lines.');
  addGate(gates, 'button-font-scaling', !has(sources.button, 'adjustsFontSizeToFit'), 'Shared buttons do not shrink system-scaled text to fit.');
  addGate(gates, 'safety-action-context', has(sources.safetyAction, 'defaultAccessibilityLabel') && has(sources.safetyAction, "isDisabled ? 'Unavailable' : null"), 'Safety actions announce description, status, and disabled state.');

  addGate(gates, 'global-high-contrast', has(sources.languageAccessibility, "setTheme(enabled ? 'highContrast' : 'system')") && has(sources.themeProvider, 'Storage.saveSettings({ theme: nextTheme })'), 'High contrast changes and persists the application theme.');
  const restoration = sources.chat.match(/const restoreDownloadedLocalAssistant = useCallback\(async \([\s\S]*?\}, \[handleLocalAssistantProgress\]\);/)?.[0] ?? '';
  const automaticPreparation = sources.assistantService?.match(/export async function startAutomaticLocalAssistantPreparation\([\s\S]*?(?=export type LocalAssistantResponse)/)?.[0] ?? '';
  addGate(gates, 'chat-restoration-no-implicit-download',
    has(restoration, "if (payload?.state !== 'downloaded' || !payload.modelDownloaded) return;")
      && has(restoration, 'await startAutomaticLocalAssistantPreparation(handleLocalAssistantProgress)')
      && !has(restoration, /(?:await|void)\s+prepareLocalAssistant\(/)
      && has(automaticPreparation, 'if (!localAssistantForegroundActive')
      && has(automaticPreparation, 'if (!availability.downloaded) {\n    return false;')
      && has(sources.modelStorage, 'assertLargeDownloadAuthorized(config, file, authorization);'),
    'Chat may restore already downloaded local files in the foreground; missing or partial files require explicit download authorization.');

  return gates;
}

function findForbiddenEvidencePath(value, currentPath = '$') {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findForbiddenEvidencePath(value[index], `${currentPath}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;

  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_EVIDENCE_KEYS.has(key)) return `${currentPath}.${key}`;
    const found = findForbiddenEvidencePath(child, `${currentPath}.${key}`);
    if (found) return found;
  }
  return null;
}

export function validateAccessibilityManifest(manifest) {
  const errors = [];
  const requirementIds = Array.isArray(manifest?.requirements)
    ? manifest.requirements.map(item => item?.id)
    : [];

  for (const id of REQUIRED_REQUIREMENT_IDS) {
    if (requirementIds.filter(candidate => candidate === id).length !== 1) {
      errors.push(`manifest must contain ${id} exactly once`);
    }
  }
  if (manifest?.checkpointCapabilityEnabled !== false) {
    errors.push('checkpointCapabilityEnabled must remain false until device and independent review evidence passes');
  }
  if (manifest?.releaseStatus !== 'blocked_external_evidence') {
    errors.push('releaseStatus must be blocked_external_evidence in repository-only evidence');
  }
  if (!Array.isArray(manifest?.screens) || manifest.screens.length === 0) {
    errors.push('screen-by-screen gates are required');
  } else {
    for (const screen of manifest.screens) {
      if (!screen?.screenId || !screen?.staticStatus || !screen?.deviceStatus) {
        errors.push('every screen gate requires screenId, staticStatus, and deviceStatus');
      }
      if (screen?.deviceStatus !== 'pending_external_device_evidence') {
        errors.push(`${screen?.screenId ?? 'unknown screen'} must not imply fabricated device evidence`);
      }
    }
  }
  return errors;
}

export function getAccessibilityReleaseBlockers(evidence) {
  const blockers = [];
  if (!evidence || typeof evidence !== 'object') return ['device evidence must be a JSON object'];

  const validateShape = getDeviceEvidenceShapeValidator();
  if (!validateShape(evidence)) {
    for (const error of validateShape.errors ?? []) {
      blockers.push(`schema ${error.instancePath || '$'} ${error.message ?? 'validation failed'}`);
    }
  }

  const forbiddenPath = findForbiddenEvidencePath(evidence);
  if (forbiddenPath) blockers.push(`forbidden sensitive field at ${forbiddenPath}`);
  if (evidence.schemaVersion !== '1.0.0') blockers.push('schemaVersion must be 1.0.0');
  if (!COMMIT_PATTERN.test(evidence.sourceRevision ?? '')) blockers.push('sourceRevision must be a full lowercase commit SHA');
  if (!SHA256_PATTERN.test(evidence?.build?.artifactSha256 ?? '')) blockers.push('build.artifactSha256 must be a SHA-256');
  if (evidence?.build?.platform !== 'android') blockers.push('build.platform must be android');
  if (evidence.syntheticOnly !== true || evidence.contentFree !== true || evidence.noParticipantData !== true) {
    blockers.push('evidence must be synthetic-only, content-free, and contain no participant data');
  }

  const devices = Array.isArray(evidence.devices) ? evidence.devices : [];
  const deviceClasses = new Set(devices.map(device => device?.deviceClass));
  if (!deviceClasses.has('small-low-end')) blockers.push('small-low-end device evidence is required');
  if (!deviceClasses.has('standard')) blockers.push('standard device evidence is required');
  for (const device of devices) {
    if (!device?.androidVersion || !device?.evidenceHash || !SHA256_PATTERN.test(device.evidenceHash)) {
      blockers.push(`device ${device?.deviceId ?? 'unknown'} requires Android version and an evidence SHA-256`);
    }
  }

  const scenarios = Array.isArray(evidence.scenarios) ? evidence.scenarios : [];
  for (const scenarioId of REQUIRED_DEVICE_SCENARIOS) {
    const matches = scenarios.filter(scenario => scenario?.scenarioId === scenarioId);
    if (matches.length !== 1) {
      blockers.push(`scenario ${scenarioId} must appear exactly once`);
    } else if (matches[0].status !== 'pass') {
      blockers.push(`scenario ${scenarioId} must pass`);
    } else if (!SHA256_PATTERN.test(matches[0].evidenceHash ?? '')) {
      blockers.push(`scenario ${scenarioId} requires an evidence SHA-256`);
    }
  }

  if (evidence?.approval?.status !== 'approved') blockers.push('independent approval must be approved');
  if (evidence?.approval?.independent !== true) blockers.push('approval must be independent');
  if (!evidence?.executedBy || !evidence?.approval?.reviewerId) blockers.push('executor and reviewer pseudonymous IDs are required');
  if (evidence?.executedBy && evidence?.executedBy === evidence?.approval?.reviewerId) {
    blockers.push('executor and independent reviewer must differ');
  }
  if (!evidence?.approval?.reviewedAt) blockers.push('approval.reviewedAt is required');

  return [...new Set(blockers)];
}

function readJson(relativeOrAbsolutePath) {
  const resolved = path.resolve(REPOSITORY_ROOT, relativeOrAbsolutePath);
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

function parseArguments(argv) {
  const options = {
    release: false,
    manifest: 'docs/qa/saferide-accessibility-gate.json',
    deviceEvidence: 'docs/qa/saferide-accessibility-device-evidence.pending.json',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--release') options.release = true;
    else if (argument === '--manifest') options.manifest = argv[++index];
    else if (argument === '--device-evidence') options.deviceEvidence = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

export function runAccessibilityCheck(options = {}) {
  const sources = options.sources ?? readAccessibilitySources(options.root);
  const manifest = options.manifest ?? readJson(options.manifestPath ?? 'docs/qa/saferide-accessibility-gate.json');
  const sourceGates = validateAccessibilitySources(sources);
  const errors = [
    ...sourceGates.filter(gate => !gate.passed).map(gate => `${gate.id}: ${gate.detail}`),
    ...validateAccessibilityManifest(manifest),
  ];

  let releaseBlockers = [];
  if (options.release) {
    const evidence = options.deviceEvidence ?? readJson(options.deviceEvidencePath ?? 'docs/qa/saferide-accessibility-device-evidence.pending.json');
    releaseBlockers = getAccessibilityReleaseBlockers(evidence);
    errors.push(...releaseBlockers.map(blocker => `release blocker: ${blocker}`));
  }
  return { sourceGates, releaseBlockers, errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = runAccessibilityCheck({
      release: options.release,
      manifestPath: options.manifest,
      deviceEvidencePath: options.deviceEvidence,
    });
    if (result.errors.length > 0) {
      console.error(`Accessibility check failed (${result.errors.length}):`);
      result.errors.forEach(error => console.error(`- ${error}`));
      process.exitCode = 1;
    } else {
      console.log(`Accessibility check passed (${result.sourceGates.length} source gates).`);
    }
  } catch (error) {
    console.error(`Accessibility check could not run: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
