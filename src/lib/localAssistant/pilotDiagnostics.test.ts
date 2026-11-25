import AsyncStorage from '@react-native-async-storage/async-storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __resetEncryptedAsyncStorageForTests,
  destroyDeviceBoundLocalEncryptionKey,
  encryptedAsyncStorage,
  isEncryptedAsyncStorageEnvelope,
} from '../encryptedAsyncStorage';
import { AI_PILOT_DIAGNOSTICS_KEY, AI_PILOT_INFLIGHT_KEY } from '../../utils/storageKeys';
import { getLocalAiPilotCopy } from '../../i18n/localAiPilotCopy';
import type { LocalModelConfig } from './modelRegistry';
import { __setLocalAiDeviceProvidersForTests, loadLocalAiDeviceFacts } from './pilotDeviceProfile';
import {
  AI_PILOT_EXPORT_CONSENT_VERSION,
  AI_PILOT_MAX_EVENTS,
  __aiPilotProcessIdForTests,
  __configureAiPilotDiagnosticsForTests,
  __resetAiPilotDiagnosticsForTests,
  buildAiPilotDiagnosticsExport,
  checkAiPilotInterruptions,
  classifyAssistantReplySignals,
  createAiPilotDiagnosticsExport,
  deleteAiPilotDiagnostics,
  evaluateAiPilotDiagnosticsGate,
  flushAiPilotDiagnosticsWrites,
  getAiPilotDiagnosticsStore,
  isAiPilotDiagnosticsEnabled,
  recordAiPilotDownloadEvent,
  recordAiPilotFallback,
  recordAiPilotFeedback,
  recordAiPilotQaDiagnostic,
  recordAiPilotRamCheck,
  recordAiPilotVerifyEvent,
  runWithAiPilotInFlight,
} from './pilotDiagnostics';

const GIB = 1024 ** 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-21T09:30:42.123Z');
const SHA = 'c'.repeat(64);
// Synthetic only: stands in for the kinds of text that must never be stored.
const SECRET_PROMPT = 'SYNTHETIC-SECRET-PROMPT he followed me home from Kilimani stage, call me on 0700000001';
const SECRET_REPLY = 'SYNTHETIC-SECRET-REPLY I cannot share that. In an emergency call 999 or the 1195 helpline.';
const SECRET_FRAGMENTS = ['SYNTHETIC-SECRET', 'Kilimani', '0700000001', 'followed me', 'file:///', 'Synthetic Person'];
const FORBIDDEN_KEYS = new Set([
  'prompt',
  'prompts',
  'content',
  'message',
  'messages',
  'text',
  'replytext',
  'transcript',
  'completion',
  'output',
  'input',
  'lasterrormessage',
  'devicename',
  'location',
  'path',
]);

const modelConfig = {
  id: 'esherialabs/synthetic-pilot-model',
  label: 'Synthetic pilot model',
  manifestId: 'synthetic-pilot-manifest-2026-10-21.1',
  runtime: { kind: 'litert-lm', modelFileName: 'synthetic.litertlm' },
  files: [{ fileName: 'synthetic.litertlm', sizeBytes: 5_071_837_136, sha256: SHA }],
} as unknown as LocalModelConfig;

function collectKeys(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach(item => collectKeys(item, keys));
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      keys.push(key);
      collectKeys(child, keys);
    }
  }
  return keys;
}

function collectStrings(value: unknown, strings: string[] = []): string[] {
  if (typeof value === 'string') {
    strings.push(value);
  } else if (Array.isArray(value)) {
    value.forEach(item => collectStrings(item, strings));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach(child => collectStrings(child, strings));
  }
  return strings;
}

function expectContentFree(serialized: string): void {
  for (const fragment of SECRET_FRAGMENTS) {
    expect(serialized).not.toContain(fragment);
  }
  for (const key of collectKeys(JSON.parse(serialized))) {
    expect(FORBIDDEN_KEYS.has(key.toLowerCase())).toBe(false);
  }
}

describe('local AI pilot diagnostics recorder', () => {
  beforeEach(() => {
    __resetEncryptedAsyncStorageForTests();
    __resetAiPilotDiagnosticsForTests();
    __configureAiPilotDiagnosticsForTests({ enabled: true, now: () => NOW });
    __setLocalAiDeviceProvidersForTests({
      deviceFacts: async () => ({
        manufacturer: 'Synthetic',
        modelName: 'Pilot Phone 6',
        osVersion: '14',
        platformApiLevel: 34,
        totalMemory: 5.5 * GIB,
        deviceName: 'Synthetic Person phone',
      } as never),
      freeStorage: async () => 7e9,
    });
  });

  afterEach(() => {
    __resetAiPilotDiagnosticsForTests();
    __setLocalAiDeviceProvidersForTests();
  });

  it('records only in staging builds that select the QA tuned artifact', () => {
    const qaTunedArtifactManifestId = 'synthetic-pilot-manifest-2026-10-21.1';
    expect(evaluateAiPilotDiagnosticsGate({ localAiEnabled: true, qaTunedArtifactManifestId, environment: 'staging' }))
      .toBe(true);
    for (const environment of ['production', 'development', 'local', 'test', undefined, null]) {
      expect(evaluateAiPilotDiagnosticsGate({ localAiEnabled: true, qaTunedArtifactManifestId, environment }))
        .toBe(false);
    }
    expect(evaluateAiPilotDiagnosticsGate({ localAiEnabled: true, qaTunedArtifactManifestId: null, environment: 'staging' }))
      .toBe(false);
    expect(evaluateAiPilotDiagnosticsGate({ localAiEnabled: false, qaTunedArtifactManifestId, environment: 'staging' }))
      .toBe(false);
  });

  it('is off by default outside QA tuned-artifact pilot builds and records nothing then', async () => {
    __resetAiPilotDiagnosticsForTests();
    expect(isAiPilotDiagnosticsEnabled()).toBe(false);

    recordAiPilotFeedback('helpful');
    recordAiPilotFallback({ failureCode: 'MODEL_START_FAILED', attemptedLocal: true });
    await expect(runWithAiPilotInFlight('generation', async () => 'ran')).resolves.toBe('ran');
    await flushAiPilotDiagnosticsWrites();

    await expect(AsyncStorage.getItem(AI_PILOT_DIAGNOSTICS_KEY)).resolves.toBeNull();
    await expect(AsyncStorage.getItem(AI_PILOT_INFLIGHT_KEY)).resolves.toBeNull();
  });

  it('never stores prompts, replies, error text, paths, or the device name', async () => {
    await loadLocalAiDeviceFacts();
    recordAiPilotDownloadEvent({ outcome: 'started', networkType: 'wifi', freeStorageBucket: '6-8gb', startPercent: 0 });
    recordAiPilotDownloadEvent({
      outcome: 'failed',
      networkType: 'wifi',
      durationMs: 1234,
      error: new Error(`Incomplete download for file:///data/models/x.litertlm ${SECRET_PROMPT}`),
    });
    recordAiPilotVerifyEvent({ outcome: 'passed', durationMs: 98_765 });
    recordAiPilotQaDiagnostic({ modelConfig, phase: 'load', durationMs: 4321, bridgeStatus: {
      state: 'loaded',
      nativeAvailable: true,
      runtimeAvailable: true,
      mockMode: false,
      artifactValidated: true,
      realRuntimeLoaded: true,
      activeBackend: 'gpu',
      lastErrorCode: SECRET_PROMPT,
      lastErrorMessage: SECRET_PROMPT,
    } });
    recordAiPilotQaDiagnostic({ modelConfig, phase: 'generation', durationMs: 2000, replyText: SECRET_REPLY });
    recordAiPilotQaDiagnostic({
      modelConfig,
      phase: 'generation',
      durationMs: 600_000,
      error: Object.assign(new Error(`Local assistant reply timed out. ${SECRET_PROMPT}`), { prompt: SECRET_PROMPT }),
    });
    recordAiPilotFallback({ failureCode: 'GENERATION_TIMEOUT', attemptedLocal: true });
    // Untyped callers cannot smuggle text through enum fields.
    recordAiPilotRamCheck({ outcome: 'warning-proceeded', ramBucket: SECRET_PROMPT as never });
    recordAiPilotFeedback(SECRET_PROMPT as never);
    recordAiPilotFeedback('not-helpful');
    await flushAiPilotDiagnosticsWrites();

    const raw = await AsyncStorage.getItem(AI_PILOT_DIAGNOSTICS_KEY);
    expect(isEncryptedAsyncStorageEnvelope(raw)).toBe(true);
    expect(raw).not.toContain('download');

    const decrypted = await encryptedAsyncStorage.getItem(AI_PILOT_DIAGNOSTICS_KEY);
    expectContentFree(decrypted ?? '{}');

    const store = await getAiPilotDiagnosticsStore();
    expect(store.events.map(event => event.kind)).toEqual([
      'download', 'download', 'verify', 'qa', 'qa', 'qa', 'fallback', 'feedback',
    ]);
    expect(store.device).toMatchObject({
      manufacturer: 'Synthetic',
      model: 'Pilot Phone 6',
      androidVersion: '14',
      ramBucket: '6-8gb',
      deviceClass: 'android-6-8gb',
      thermalState: 'not-exposed',
    });
    const [, failedDownload, , load, reply, failedReply] = store.events;
    expect(failedDownload).toMatchObject({ outcome: 'failed', failureCode: 'DOWNLOAD_INCOMPLETE', durationMs: 1234 });
    expect(load).toMatchObject({
      diagnostic: {
        phase: 'load',
        backend: 'gpu',
        deviceClass: 'android-6-8gb',
        timings: { loadMs: 4321, firstTokenMs: null },
        result: { status: 'passed', errorCode: null },
      },
    });
    expect(reply).toMatchObject({
      diagnostic: {
        phase: 'generation',
        timings: { totalGenerationMs: 2000, firstTokenMs: null },
        throughput: { estimatedOutputTokens: Math.ceil(SECRET_REPLY.length / 4) },
        result: { status: 'passed' },
      },
      replySignals: { refusalLike: true, emergencyGuidanceLike: true },
    });
    expect(failedReply).toMatchObject({
      failureCode: 'GENERATION_TIMEOUT',
      failureCategory: 'reply-failed',
      replySignals: null,
      diagnostic: { result: { status: 'failed', errorCode: 'GENERATION_TIMEOUT' } },
    });
    // Coarse time buckets only.
    expect(store.events.every(event => event.at === '2026-10-21T09:30:00.000Z')).toBe(true);
  });

  it('derives reply signals in memory without returning any text', () => {
    expect(classifyAssistantReplySignals('I can’t help with tracking someone, but you can call 1195.')).toEqual({
      refusalLike: true,
      emergencyGuidanceLike: true,
    });
    expect(classifyAssistantReplySignals('You can ask the Gender Desk about a P3 form.')).toEqual({
      refusalLike: false,
      emergencyGuidanceLike: false,
    });
  });

  it('records a crash, kill, or force-close left by an earlier process as an interruption', async () => {
    await encryptedAsyncStorage.setItem(AI_PILOT_INFLIGHT_KEY, JSON.stringify({
      schemaVersion: 1,
      entries: {
        generation: { processId: 'p-earlier-process', startedAt: '2026-10-21T09:00:00.000Z' },
        download: { processId: 'p-earlier-process', startedAt: '2026-10-21T08:00:00.000Z' },
      },
    }));

    checkAiPilotInterruptions();
    await flushAiPilotDiagnosticsWrites();

    const store = await getAiPilotDiagnosticsStore();
    expect(store.events).toEqual([
      { kind: 'interrupted', at: '2026-10-21T09:30:00.000Z', phase: 'download', startedAt: '2026-10-21T08:00:00.000Z' },
      { kind: 'interrupted', at: '2026-10-21T09:30:00.000Z', phase: 'generation', startedAt: '2026-10-21T09:00:00.000Z' },
    ]);
    await expect(AsyncStorage.getItem(AI_PILOT_INFLIGHT_KEY)).resolves.toBeNull();
  });

  it('keeps an in-flight marker only while a heavy step runs in this process', async () => {
    let markerDuringRun: string | null = null;
    await runWithAiPilotInFlight('load', async () => {
      markerDuringRun = await encryptedAsyncStorage.getItem(AI_PILOT_INFLIGHT_KEY);
    });
    await flushAiPilotDiagnosticsWrites();

    expect(JSON.parse(markerDuringRun ?? '{}')).toMatchObject({
      entries: { load: { processId: __aiPilotProcessIdForTests } },
    });
    await expect(AsyncStorage.getItem(AI_PILOT_INFLIGHT_KEY)).resolves.toBeNull();

    await expect(runWithAiPilotInFlight('generation', async () => {
      throw new Error('synthetic failure');
    })).rejects.toThrow('synthetic failure');
    await flushAiPilotDiagnosticsWrites();
    await expect(AsyncStorage.getItem(AI_PILOT_INFLIGHT_KEY)).resolves.toBeNull();
  });

  it('caps stored events and deletes everything on request', async () => {
    await encryptedAsyncStorage.setItem(AI_PILOT_DIAGNOSTICS_KEY, JSON.stringify({
      schema: 'com.saferide.ai-pilot-diagnostics',
      schemaVersion: 1,
      device: null,
      events: Array.from({ length: AI_PILOT_MAX_EVENTS }, () => ({
        kind: 'feedback',
        at: '2026-10-21T09:00:00.000Z',
        value: 'helpful',
      })),
    }));
    for (let index = 0; index < 5; index += 1) recordAiPilotFeedback('not-helpful');
    await flushAiPilotDiagnosticsWrites();
    const capped = (await getAiPilotDiagnosticsStore()).events;
    expect(capped).toHaveLength(AI_PILOT_MAX_EVENTS);
    expect(capped.slice(-5).every(event => event.kind === 'feedback' && event.value === 'not-helpful')).toBe(true);

    await deleteAiPilotDiagnostics();
    await expect(AsyncStorage.getItem(AI_PILOT_DIAGNOSTICS_KEY)).resolves.toBeNull();
    expect((await getAiPilotDiagnosticsStore()).events).toEqual([]);
  });

  it('enforces retention on read and deletes expired records from storage', async () => {
    recordAiPilotFeedback('helpful');
    await flushAiPilotDiagnosticsWrites();
    expect((await getAiPilotDiagnosticsStore()).events).toHaveLength(1);

    __configureAiPilotDiagnosticsForTests({ enabled: true, now: () => new Date(NOW.getTime() + 31 * DAY_MS) });
    expect(await getAiPilotDiagnosticsStore()).toMatchObject({ device: null, events: [] });
    await expect(AsyncStorage.getItem(AI_PILOT_DIAGNOSTICS_KEY)).resolves.toBeNull();
  });

  it('recovers when the store was written with a key that local-data deletion destroyed', async () => {
    recordAiPilotFeedback('helpful');
    await flushAiPilotDiagnosticsWrites();
    // A marker written just before the key is destroyed, as in a delete during a download.
    await encryptedAsyncStorage.setItem(AI_PILOT_INFLIGHT_KEY, JSON.stringify({
      schemaVersion: 1,
      entries: { download: { processId: 'p-earlier-process', startedAt: '2026-10-21T09:00:00.000Z' } },
    }));
    await destroyDeviceBoundLocalEncryptionKey();
    __resetEncryptedAsyncStorageForTests();
    await expect(encryptedAsyncStorage.getItem(AI_PILOT_DIAGNOSTICS_KEY)).rejects.toThrow();

    await expect(getAiPilotDiagnosticsStore()).resolves.toMatchObject({ events: [] });
    recordAiPilotFeedback('not-helpful');
    await expect(runWithAiPilotInFlight('generation', async () => 'ran')).resolves.toBe('ran');
    await flushAiPilotDiagnosticsWrites();

    expect((await getAiPilotDiagnosticsStore()).events).toEqual([
      { kind: 'feedback', at: '2026-10-21T09:30:00.000Z', value: 'not-helpful' },
    ]);
    await expect(AsyncStorage.getItem(AI_PILOT_INFLIGHT_KEY)).resolves.toBeNull();
  });

  it('drops events older than the retention window', async () => {
    __configureAiPilotDiagnosticsForTests({ enabled: true, now: () => new Date('2026-09-01T00:00:00.000Z') });
    recordAiPilotFeedback('helpful');
    await flushAiPilotDiagnosticsWrites();
    __configureAiPilotDiagnosticsForTests({ enabled: true, now: () => NOW });
    recordAiPilotFeedback('not-helpful');
    await flushAiPilotDiagnosticsWrites();

    expect((await getAiPilotDiagnosticsStore()).events).toEqual([
      { kind: 'feedback', at: '2026-10-21T09:30:00.000Z', value: 'not-helpful' },
    ]);
  });
});

describe('local AI pilot diagnostics export', () => {
  beforeEach(() => {
    __resetEncryptedAsyncStorageForTests();
    __resetAiPilotDiagnosticsForTests();
    __configureAiPilotDiagnosticsForTests({ enabled: true, now: () => NOW });
    __setLocalAiDeviceProvidersForTests({
      deviceFacts: async () => ({ manufacturer: 'Synthetic', modelName: 'Pilot Phone 4', osVersion: '13', totalMemory: 3.6 * GIB }),
      freeStorage: async () => 5.5e9,
    });
  });

  afterEach(() => {
    __resetAiPilotDiagnosticsForTests();
    __setLocalAiDeviceProvidersForTests();
  });

  it('summarizes download, load, reply, fallback, interruption, and feedback outcomes', async () => {
    await loadLocalAiDeviceFacts();
    recordAiPilotRamCheck({ outcome: 'warning-proceeded', ramBucket: '4gb' });
    recordAiPilotDownloadEvent({ outcome: 'started', networkType: 'metered', startPercent: 0 });
    recordAiPilotDownloadEvent({ outcome: 'paused', networkType: 'metered', durationMs: 60_000 });
    recordAiPilotDownloadEvent({ outcome: 'resumed', networkType: 'wifi', startPercent: 42 });
    recordAiPilotDownloadEvent({ outcome: 'completed', networkType: 'wifi', durationMs: 90_000 });
    recordAiPilotVerifyEvent({ outcome: 'passed', durationMs: 30_000 });
    recordAiPilotQaDiagnostic({ modelConfig, phase: 'load', durationMs: 8_000 });
    recordAiPilotQaDiagnostic({ modelConfig, phase: 'readiness-probe', durationMs: 1_500 });
    recordAiPilotQaDiagnostic({ modelConfig, phase: 'generation', durationMs: 4_000, replyText: 'x'.repeat(400) });
    recordAiPilotQaDiagnostic({ modelConfig, phase: 'generation', durationMs: 2_000, replyText: 'I cannot help with that.' });
    recordAiPilotQaDiagnostic({
      modelConfig,
      phase: 'generation',
      durationMs: 100,
      error: Object.assign(new Error('stopped'), { code: 'ERR_LITERT_CANCELLED' }),
    });
    recordAiPilotFallback({ failureCode: 'MODEL_START_FAILED', attemptedLocal: true });
    recordAiPilotFallback({ failureCode: 'MODEL_NOT_DOWNLOADED', attemptedLocal: false });
    recordAiPilotFeedback('helpful');
    recordAiPilotFeedback('not-helpful');
    recordAiPilotFeedback('helpful');
    await flushAiPilotDiagnosticsWrites();

    const json = await createAiPilotDiagnosticsExport({
      consentConfirmedAt: NOW,
      appVersion: '1.0.3',
      manifestId: modelConfig.manifestId ?? null,
      artifactSha256: SHA,
    });
    expectContentFree(json);
    const exported = JSON.parse(json);

    expect(exported).toMatchObject({
      schema: 'com.saferide.ai-pilot-diagnostics-export',
      contentFree: true,
      consent: { version: AI_PILOT_EXPORT_CONSENT_VERSION, automaticUpload: false },
      app: { appVersion: '1.0.3', manifestId: modelConfig.manifestId, artifactSha256: SHA },
      device: {
        manufacturer: 'Synthetic',
        model: 'Pilot Phone 4',
        ramBucket: '4gb',
        deviceClass: 'android-4gb',
        freeStorageBucketAtExport: '5-6gb',
        thermalState: 'not-exposed',
        minimumRamGb: 8,
      },
    });
    expect(exported.consent.included).toContain('failure reason codes');
    expect(exported.consent.excluded).toEqual(expect.arrayContaining([
      'what you typed or what the AI replied',
      'your location',
      'device name',
    ]));
    expect(exported.summary.download).toMatchObject({
      pauses: 1,
      resumes: 1,
      networkTypes: { metered: 1, wifi: 1 },
      activeDurationMs: 150_000,
      lastCompletedAttemptMs: 90_000,
    });
    expect(exported.summary.verify).toMatchObject({ outcomes: { passed: 1 }, medianMs: 30_000 });
    expect(exported.summary.load).toMatchObject({ attempts: 1, passed: 1, medianMs: 8_000 });
    expect(exported.summary.readinessProbe).toMatchObject({ attempts: 1, passed: 1 });
    expect(exported.summary.generation).toMatchObject({
      attempts: 3,
      passed: 2,
      cancelled: 1,
      failed: 0,
      medianMs: 2_000,
      p90Ms: 4_000,
      refusalLikeReplies: 1,
      emergencyGuidanceLikeReplies: 0,
      medianEstimatedTokensPerSecond: 3,
    });
    expect(exported.summary.generation.timeToFirstTokenMs).toMatch(/^not-exposed/);
    expect(exported.summary.fallbacks).toEqual({
      total: 2,
      byCode: { MODEL_START_FAILED: 1, MODEL_NOT_DOWNLOADED: 1 },
      byCategory: { memory: 1, 'not-ready': 1 },
    });
    expect(exported.summary.ramChecks).toEqual({ 'warning-proceeded': 1 });
    expect(exported.summary.feedback).toEqual({ helpful: 2, notHelpful: 1 });
    expect(exported.summary.thermal).toMatch(/^not-exposed/);
    expect(exported.recentEvents).toHaveLength(16);
  });

  it('exports day-level dates only and no per-reply refusal or emergency flags', async () => {
    await encryptedAsyncStorage.setItem(AI_PILOT_INFLIGHT_KEY, JSON.stringify({
      schemaVersion: 1,
      entries: { generation: { processId: 'p-earlier-process', startedAt: '2026-10-21T08:59:00.000Z' } },
    }));
    await loadLocalAiDeviceFacts();
    checkAiPilotInterruptions();
    recordAiPilotDownloadEvent({ outcome: 'started', networkType: 'wifi', startPercent: 0 });
    recordAiPilotRamCheck({ outcome: 'warning-declined', ramBucket: '6-8gb' });
    recordAiPilotQaDiagnostic({ modelConfig, phase: 'load', durationMs: 8_000 });
    recordAiPilotQaDiagnostic({ modelConfig, phase: 'generation', durationMs: 3_000, replyText: SECRET_REPLY });
    recordAiPilotQaDiagnostic({ modelConfig, phase: 'generation', durationMs: 3_000, replyText: 'Use the Gender Desk.' });
    recordAiPilotFallback({ failureCode: 'GENERATION_TIMEOUT', attemptedLocal: true });
    recordAiPilotFeedback('helpful');
    await flushAiPilotDiagnosticsWrites();

    const json = await createAiPilotDiagnosticsExport({
      consentConfirmedAt: NOW,
      appVersion: '1.0.3',
      manifestId: modelConfig.manifestId ?? null,
      artifactSha256: SHA,
    });
    const exported = JSON.parse(json);

    // No time of day anywhere: every string is free of hh:mm and ISO 'T' times.
    for (const value of collectStrings(exported)) {
      expect(value).not.toMatch(/\d{1,2}:\d{2}/);
      expect(value).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    }
    const keys = new Set(collectKeys(exported));
    for (const key of [
      'at', 'startedAt', 'capturedAt', 'generatedAt', 'confirmedAt', 'replySignals', 'refusalLike', 'emergencyGuidanceLike',
    ]) {
      expect(keys.has(key)).toBe(false);
    }
    expect(exported.recentEvents.length).toBeGreaterThan(0);
    for (const event of exported.recentEvents) {
      expect(event.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(exported.recentEvents).toContainEqual({
      kind: 'interrupted',
      date: '2026-10-21',
      phase: 'generation',
      startedOn: '2026-10-21',
    });
    expect(exported.device.capturedOn).toBe('2026-10-21');
    // Reply signals survive only as totals.
    expect(exported.summary.generation).toMatchObject({ refusalLikeReplies: 1, emergencyGuidanceLikeReplies: 1 });
    // The consent text names the day-level dates it exports.
    expect(exported.consent.included.join(' ')).toMatch(/date \(day only, no time of day\)/);
    expect(exported.consent.excluded).toContain('the time of day');
    // The export includes RAM-warning choices, so the consent must name them.
    expect(exported.recentEvents).toContainEqual({
      kind: 'ram-check',
      date: '2026-10-21',
      outcome: 'warning-declined',
      ramBucket: '6-8gb',
    });
    expect(exported.consent.included.join(' ')).toMatch(/continued or declined after the low-memory \(RAM\) warning/);
    const message = getLocalAiPilotCopy('en').export.consentMessage;
    expect(message).toContain('whether you continued or declined after the low-memory (RAM) warning');
    expect(message).toContain(
      'It never includes what you typed or what the AI replied, chat history, reports or evidence, error messages, '
      + 'file paths, your location, device name, names, phone numbers, account details, or the time of day. '
      + 'Nothing is uploaded automatically.',
    );
  });

  it('exports nothing older than the retention window, even 50 days later', async () => {
    await loadLocalAiDeviceFacts();
    recordAiPilotDownloadEvent({ outcome: 'completed', networkType: 'wifi', durationMs: 90_000 });
    recordAiPilotQaDiagnostic({ modelConfig, phase: 'generation', durationMs: 3_000, replyText: SECRET_REPLY });
    recordAiPilotFeedback('helpful');
    await flushAiPilotDiagnosticsWrites();
    expect((await getAiPilotDiagnosticsStore()).events).toHaveLength(3);

    const later = new Date(NOW.getTime() + 50 * DAY_MS);
    __configureAiPilotDiagnosticsForTests({ enabled: true, now: () => later });
    const exported = JSON.parse(await createAiPilotDiagnosticsExport({
      consentConfirmedAt: later,
      appVersion: '1.0.3',
      manifestId: modelConfig.manifestId ?? null,
      artifactSha256: SHA,
    }));

    expect(exported.recentEvents).toEqual([]);
    expect(exported.retention.storedEvents).toBe(0);
    expect(exported.summary.download.outcomes).toEqual({});
    expect(exported.summary.generation).toMatchObject({ attempts: 0, refusalLikeReplies: 0, emergencyGuidanceLikeReplies: 0 });
    expect(exported.summary.feedback).toEqual({ helpful: 0, notHelpful: 0 });
    expect(exported.generatedOn).toBe('2026-12-10');
    expect(exported.device.capturedOn).toBe('2026-12-10');
    await expect(AsyncStorage.getItem(AI_PILOT_DIAGNOSTICS_KEY)).resolves.toBeNull();

    // The pure builder applies retention to whatever it is given.
    const stale = buildAiPilotDiagnosticsExport(
      {
        schema: 'com.saferide.ai-pilot-diagnostics',
        schemaVersion: 1,
        device: null,
        events: [{ kind: 'feedback', at: NOW.toISOString(), value: 'helpful' }],
      },
      {
        now: later,
        consentConfirmedAt: later,
        appVersion: null,
        environment: 'staging',
        buildProfile: 'preview',
        manifestId: null,
        artifactSha256: null,
        freeStorageBucket: 'unknown',
      },
    );
    expect(stale.recentEvents).toEqual([]);
    expect(stale.summary.feedback.helpful).toBe(0);
  });

  it('builds an empty, content-free summary when nothing was recorded', () => {
    const exported = buildAiPilotDiagnosticsExport(
      { schema: 'com.saferide.ai-pilot-diagnostics', schemaVersion: 1, device: null, events: [] },
      {
        now: NOW,
        consentConfirmedAt: NOW,
        appVersion: null,
        environment: 'staging',
        buildProfile: 'preview',
        manifestId: null,
        artifactSha256: null,
        freeStorageBucket: 'unknown',
      },
    );
    expect(exported.device).toBeNull();
    expect(exported.summary.generation).toMatchObject({ attempts: 0, medianMs: null });
    expect(exported.summary.download.pauses).toBe(0);
    expect(exported.consent.confirmedOn).toBe('2026-10-21');
    expect(exported.generatedOn).toBe('2026-10-21');
  });
});
