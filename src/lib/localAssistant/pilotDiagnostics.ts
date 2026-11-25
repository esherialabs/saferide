/**
 * Local AI pilot diagnostics: content-free, encrypted on device, QA pilot builds only.
 *
 * Every stored field is an enum, a boolean, a bounded number, a validated
 * manifest/checksum identity, or a sanitized hardware label. Prompts, replies,
 * transcripts, chat history, and error messages are never stored: reply text is
 * read in memory only to derive two booleans, and errors are reduced to an
 * allowlisted code before anything is written. Nothing is uploaded; a tester
 * can export a JSON summary only after explicit consent (see Settings).
 */
import { z } from 'zod';

import { env } from '../../config/env';
import { localAssistantConfig } from '../../config/localAssistant';
import { encryptedAsyncStorage } from '../encryptedAsyncStorage';
import { AI_PILOT_DIAGNOSTICS_KEY, AI_PILOT_INFLIGHT_KEY } from '../../utils/storageKeys';
import type { SafeRideLiteRtLmBridgeStatus } from './liteRtLmBridge';
import type { LocalModelConfig } from './modelRegistry';
import {
  LOCAL_AI_FREE_STORAGE_BUCKETS,
  LOCAL_AI_MIN_RAM_GB,
  LOCAL_AI_RAM_BUCKETS,
  deviceClassForRamBucket,
  getCachedLocalAiDeviceFacts,
  loadLocalAiDeviceFacts,
  readLocalAiFreeStorageBucket,
  type LocalAiFreeStorageBucket,
  type LocalAiRamBucket,
} from './pilotDeviceProfile';
import {
  LOCAL_AI_FAILURE_CATEGORIES,
  LOCAL_AI_FAILURE_CODES,
  categorizeLocalAiFailure,
  classifyLocalAiFailure,
  type LocalAiFailureCategory,
  type LocalAiFailureCode,
} from './pilotFailureReasons';
import {
  TUNED_ARTIFACT_DEVICE_CLASSES,
  TUNED_ARTIFACT_QA_BACKENDS,
  TUNED_ARTIFACT_QA_PHASES,
  TUNED_ARTIFACT_QA_RESULT_STATUSES,
  createTunedArtifactQaDiagnostic,
  type TunedArtifactQaDiagnostic,
  type TunedArtifactQaPhase,
} from './qaDiagnostics';

export const AI_PILOT_DIAGNOSTICS_SCHEMA = 'com.saferide.ai-pilot-diagnostics';
export const AI_PILOT_EXPORT_SCHEMA = 'com.saferide.ai-pilot-diagnostics-export';
export const AI_PILOT_EXPORT_CONSENT_VERSION = 'ai-pilot-export-consent.v3';
export const AI_PILOT_RETENTION_DAYS = 30;
const AI_PILOT_RETENTION_MS = AI_PILOT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
export const AI_PILOT_MAX_EVENTS = 500;
export const AI_PILOT_EXPORT_RECENT_EVENTS = 200;
const TIME_BUCKET_MS = 60_000;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const APPROX_CHARS_PER_TOKEN = 4;

/** Must list exactly what buildAiPilotDiagnosticsExport emits; tests check the export shape. */
export const AI_PILOT_EXPORT_INCLUDED_FIELDS = [
  'phone manufacturer and model name, Android version, and API level',
  'memory (RAM) and free-storage size ranges',
  'app version, environment, build profile, and AI model ID and checksum',
  'download network type (Wi-Fi or mobile data)',
  'download, verification, model start, and reply durations and outcomes, estimated reply length and speed, and the processor used (GPU or CPU)',
  'download pause and resume counts',
  'whether you continued or declined after the low-memory (RAM) warning',
  'failure reason codes',
  'markers showing the app closed or crashed during an AI step',
  'total counts of refusal-style and emergency-guidance-style replies, not which replies they were',
  'your helpful or not-helpful taps',
  'the date (day only, no time of day) of each recorded step, of this export, and of your consent',
] as const;

export const AI_PILOT_EXPORT_EXCLUDED_FIELDS = [
  'what you typed or what the AI replied',
  'chat history',
  'reports or evidence',
  'error messages',
  'file paths',
  'your location',
  'device name',
  'names, phone numbers, account details',
  'the time of day',
] as const;

export const AI_PILOT_PHASES = ['download', 'verify', ...TUNED_ARTIFACT_QA_PHASES] as const;
export type AiPilotPhase = typeof AI_PILOT_PHASES[number];

const DOWNLOAD_OUTCOMES = ['started', 'resumed', 'paused', 'completed', 'failed', 'cancelled'] as const;
const VERIFY_OUTCOMES = ['passed', 'failed', 'read-error'] as const;
const RAM_CHECK_OUTCOMES = ['meets-minimum', 'warning-proceeded', 'warning-declined', 'unknown'] as const;
const FEEDBACK_VALUES = ['helpful', 'not-helpful'] as const;
const NETWORK_TYPES = ['wifi', 'metered', 'unknown'] as const;

const isoBucket = z.string().datetime();
const durationMs = z.number().int().nonnegative().max(MAX_DURATION_MS).nullable();
const nullableNonNegative = z.number().nonnegative().max(1_000_000_000).nullable();
const failureCode = z.enum(LOCAL_AI_FAILURE_CODES);
const failureCategory = z.enum(LOCAL_AI_FAILURE_CATEGORIES);
const hardwareLabel = (max: number) => z.string().regex(new RegExp(`^[A-Za-z0-9 ._()+-]{1,${max}}$`)).nullable();

const qaDiagnosticSchema = z.object({
  schema: z.literal('com.saferide.tuned-artifact-qa-diagnostic'),
  schemaVersion: z.literal(2),
  manifestId: z.string().regex(/^[A-Za-z0-9._-]{1,160}$/),
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
  phase: z.enum(TUNED_ARTIFACT_QA_PHASES),
  runtimeState: z.enum(['unavailable', 'idle', 'prepared', 'loaded', 'generating', 'error']),
  artifactValidated: z.boolean(),
  realRuntimeLoaded: z.boolean(),
  backend: z.enum(TUNED_ARTIFACT_QA_BACKENDS).nullable(),
  deviceClass: z.enum(TUNED_ARTIFACT_DEVICE_CLASSES),
  timings: z.object({
    loadMs: nullableNonNegative,
    firstTokenMs: nullableNonNegative,
    totalGenerationMs: nullableNonNegative,
  }).strict(),
  throughput: z.object({
    estimatedOutputTokens: nullableNonNegative,
    estimatedTokensPerSecond: nullableNonNegative,
  }).strict(),
  result: z.object({
    status: z.enum(TUNED_ARTIFACT_QA_RESULT_STATUSES),
    errorCode: failureCode.nullable(),
  }).strict(),
  capturedAt: z.string().datetime(),
}).strict();

const eventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('download'),
    at: isoBucket,
    outcome: z.enum(DOWNLOAD_OUTCOMES),
    networkType: z.enum(NETWORK_TYPES).nullable(),
    freeStorageBucket: z.enum(LOCAL_AI_FREE_STORAGE_BUCKETS).nullable(),
    startPercent: z.number().int().min(0).max(100).nullable(),
    durationMs,
    failureCode: failureCode.nullable(),
  }).strict(),
  z.object({
    kind: z.literal('verify'),
    at: isoBucket,
    outcome: z.enum(VERIFY_OUTCOMES),
    durationMs,
  }).strict(),
  z.object({
    kind: z.literal('qa'),
    at: isoBucket,
    diagnostic: qaDiagnosticSchema,
    failureCode: failureCode.nullable(),
    failureCategory: failureCategory.nullable(),
    replySignals: z.object({
      refusalLike: z.boolean(),
      emergencyGuidanceLike: z.boolean(),
    }).strict().nullable(),
  }).strict(),
  z.object({
    kind: z.literal('fallback'),
    at: isoBucket,
    failureCode,
    failureCategory,
    attemptedLocal: z.boolean(),
  }).strict(),
  z.object({
    kind: z.literal('ram-check'),
    at: isoBucket,
    outcome: z.enum(RAM_CHECK_OUTCOMES),
    ramBucket: z.enum(LOCAL_AI_RAM_BUCKETS),
  }).strict(),
  z.object({
    kind: z.literal('interrupted'),
    at: isoBucket,
    phase: z.enum(AI_PILOT_PHASES),
    startedAt: isoBucket,
  }).strict(),
  z.object({
    kind: z.literal('feedback'),
    at: isoBucket,
    value: z.enum(FEEDBACK_VALUES),
  }).strict(),
]);

const deviceSnapshotSchema = z.object({
  manufacturer: hardwareLabel(40),
  model: hardwareLabel(40),
  androidVersion: hardwareLabel(16),
  apiLevel: z.number().int().positive().max(999).nullable(),
  ramClassGb: z.number().positive().max(256).nullable(),
  ramBucket: z.enum(LOCAL_AI_RAM_BUCKETS),
  deviceClass: z.enum(TUNED_ARTIFACT_DEVICE_CLASSES),
  // The SafeRide LiteRT-LM native module does not expose thermal state.
  thermalState: z.literal('not-exposed'),
  capturedAt: isoBucket,
}).strict();

const storeSchema = z.object({
  schema: z.literal(AI_PILOT_DIAGNOSTICS_SCHEMA),
  schemaVersion: z.literal(1),
  device: deviceSnapshotSchema.nullable(),
  events: z.array(eventSchema).max(AI_PILOT_MAX_EVENTS),
}).strict();

const inFlightSchema = z.object({
  schemaVersion: z.literal(1),
  entries: z.partialRecord(z.enum(AI_PILOT_PHASES), z.object({
    processId: z.string().regex(/^[a-z0-9-]{1,48}$/),
    startedAt: isoBucket,
  }).strict()),
}).strict();

export type AiPilotEvent = z.infer<typeof eventSchema>;
export type AiPilotDeviceSnapshot = z.infer<typeof deviceSnapshotSchema>;
export type AiPilotDiagnosticsStore = z.infer<typeof storeSchema>;
type InFlightState = z.infer<typeof inFlightSchema>;

type Runtime = {
  enabledOverride?: boolean;
  now: () => Date;
};

const runtime: Runtime = { now: () => new Date() };
const processId = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
let writeQueue: Promise<unknown> = Promise.resolve();
let interruptionsChecked = false;

function emptyStore(): AiPilotDiagnosticsStore {
  return { schema: AI_PILOT_DIAGNOSTICS_SCHEMA, schemaVersion: 1, device: null, events: [] };
}

function bucketIso(date: Date): string {
  return new Date(Math.floor(date.getTime() / TIME_BUCKET_MS) * TIME_BUCKET_MS).toISOString();
}

function nowBucket(): string {
  return bucketIso(runtime.now());
}

function safeDuration(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.min(Math.round(value), MAX_DURATION_MS);
}

/**
 * Pilot diagnostics run only in staging builds that select the QA tuned
 * artifact (the EAS `preview` profile and profiles that extend it).
 */
export function evaluateAiPilotDiagnosticsGate(input: {
  localAiEnabled: boolean;
  qaTunedArtifactManifestId?: string | null;
  environment?: string | null;
}): boolean {
  return Boolean(input.localAiEnabled && input.qaTunedArtifactManifestId && input.environment === 'staging');
}

export function isAiPilotDiagnosticsEnabled(): boolean {
  if (runtime.enabledOverride !== undefined) return runtime.enabledOverride;
  return evaluateAiPilotDiagnosticsGate({
    localAiEnabled: localAssistantConfig.enabled,
    qaTunedArtifactManifestId: localAssistantConfig.qaTunedArtifactManifestId,
    environment: env.environment,
  });
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = writeQueue.catch(() => undefined).then(operation);
  writeQueue = result.catch(() => undefined);
  return result;
}

/** Drops events and device snapshots older than the retention window and caps the event count. */
function applyRetention(store: AiPilotDiagnosticsStore, now: Date): AiPilotDiagnosticsStore {
  const cutoff = now.getTime() - AI_PILOT_RETENTION_MS;
  return {
    ...store,
    device: store.device && new Date(store.device.capturedAt).getTime() >= cutoff ? store.device : null,
    events: store.events
      .filter(event => new Date(event.at).getTime() >= cutoff)
      .slice(-AI_PILOT_MAX_EVENTS),
  };
}

/**
 * Reads the store with retention applied, and deletes expired records from
 * storage rather than only hiding them. A store that cannot be decrypted (for
 * example, the device key was destroyed by "delete local data" while a pilot
 * write was in flight) is discarded instead of blocking every later write.
 */
async function readStore(): Promise<AiPilotDiagnosticsStore> {
  let raw: string | null;
  try {
    raw = await encryptedAsyncStorage.getItem(AI_PILOT_DIAGNOSTICS_KEY);
  } catch {
    await encryptedAsyncStorage.removeItem(AI_PILOT_DIAGNOSTICS_KEY).catch(() => undefined);
    return emptyStore();
  }
  if (!raw) return emptyStore();
  let stored: AiPilotDiagnosticsStore;
  try {
    const parsed = storeSchema.safeParse(JSON.parse(raw));
    stored = parsed.success ? parsed.data : emptyStore();
  } catch {
    stored = emptyStore();
  }
  const retained = applyRetention(stored, runtime.now());
  if (retained.events.length !== stored.events.length || retained.device !== stored.device) {
    try {
      if (retained.events.length === 0 && !retained.device) {
        await encryptedAsyncStorage.removeItem(AI_PILOT_DIAGNOSTICS_KEY);
      } else {
        await encryptedAsyncStorage.setItem(AI_PILOT_DIAGNOSTICS_KEY, JSON.stringify(retained));
      }
    } catch {
      // The in-memory result is still pruned; the next write replaces the stored copy.
    }
  }
  return retained;
}

async function currentDeviceSnapshot(): Promise<AiPilotDeviceSnapshot> {
  const facts = await loadLocalAiDeviceFacts();
  return deviceSnapshotSchema.parse({
    manufacturer: facts.manufacturer,
    model: facts.model,
    androidVersion: facts.androidVersion,
    apiLevel: facts.apiLevel,
    ramClassGb: facts.ramClassGb,
    ramBucket: facts.ramBucket,
    deviceClass: deviceClassForRamBucket(facts.ramBucket),
    thermalState: 'not-exposed',
    capturedAt: nowBucket(),
  });
}

async function readInFlight(): Promise<InFlightState> {
  let raw: string | null;
  try {
    raw = await encryptedAsyncStorage.getItem(AI_PILOT_INFLIGHT_KEY);
  } catch {
    await encryptedAsyncStorage.removeItem(AI_PILOT_INFLIGHT_KEY).catch(() => undefined);
    return { schemaVersion: 1, entries: {} };
  }
  if (!raw) return { schemaVersion: 1, entries: {} };
  try {
    const parsed = inFlightSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : { schemaVersion: 1, entries: {} };
  } catch {
    return { schemaVersion: 1, entries: {} };
  }
}

async function writeInFlight(state: InFlightState): Promise<void> {
  if (Object.keys(state.entries).length === 0) {
    await encryptedAsyncStorage.removeItem(AI_PILOT_INFLIGHT_KEY);
    return;
  }
  await encryptedAsyncStorage.setItem(AI_PILOT_INFLIGHT_KEY, JSON.stringify(state));
}

/**
 * A phase marker left by an earlier process means that process ended while
 * the step was running: a native crash, an out-of-memory kill, a force-close
 * after an unresponsive screen, or the user swiping SafeRide away. JavaScript
 * cannot tell these apart, so they are recorded together as "interrupted".
 */
async function collectInterruptions(): Promise<AiPilotEvent[]> {
  if (interruptionsChecked) return [];
  interruptionsChecked = true;
  const state = await readInFlight();
  const interrupted: AiPilotEvent[] = [];
  const remaining: InFlightState = { schemaVersion: 1, entries: {} };
  for (const phase of AI_PILOT_PHASES) {
    const entry = state.entries[phase];
    if (!entry) continue;
    if (entry.processId === processId) {
      remaining.entries[phase] = entry;
    } else {
      interrupted.push({ kind: 'interrupted', at: nowBucket(), phase, startedAt: entry.startedAt });
    }
  }
  if (interrupted.length > 0) await writeInFlight(remaining);
  return interrupted;
}

async function appendEvents(events: AiPilotEvent[]): Promise<void> {
  const interruptions = await collectInterruptions();
  const validated = [...interruptions, ...events].flatMap(event => {
    const parsed = eventSchema.safeParse(event);
    return parsed.success ? [parsed.data] : [];
  });
  if (validated.length === 0) return;
  const store = await readStore();
  const next: AiPilotDiagnosticsStore = applyRetention({
    ...store,
    device: await currentDeviceSnapshot().catch(() => store.device),
    events: [...store.events, ...validated],
  }, runtime.now());
  await encryptedAsyncStorage.setItem(AI_PILOT_DIAGNOSTICS_KEY, JSON.stringify(storeSchema.parse(next)));
}

function record(events: AiPilotEvent[]): void {
  if (!isAiPilotDiagnosticsEnabled()) return;
  void enqueue(() => appendEvents(events)).catch(() => undefined);
}

export function recordAiPilotDownloadEvent(input: {
  outcome: typeof DOWNLOAD_OUTCOMES[number];
  networkType?: typeof NETWORK_TYPES[number] | null;
  freeStorageBucket?: LocalAiFreeStorageBucket | null;
  startPercent?: number | null;
  durationMs?: number | null;
  error?: unknown;
}): void {
  const startPercent = typeof input.startPercent === 'number' && Number.isFinite(input.startPercent)
    ? Math.max(0, Math.min(100, Math.round(input.startPercent)))
    : null;
  record([{
    kind: 'download',
    at: nowBucket(),
    outcome: input.outcome,
    networkType: input.networkType ?? null,
    freeStorageBucket: input.freeStorageBucket ?? null,
    startPercent,
    durationMs: safeDuration(input.durationMs),
    failureCode: input.outcome === 'failed' ? classifyLocalAiFailure(input.error) : null,
  }]);
}

export function recordAiPilotVerifyEvent(input: {
  outcome: typeof VERIFY_OUTCOMES[number];
  durationMs?: number | null;
}): void {
  record([{ kind: 'verify', at: nowBucket(), outcome: input.outcome, durationMs: safeDuration(input.durationMs) }]);
}

const REFUSAL_PATTERN =
  /\b(i can(?:not|'t|’t)|i am (?:not able|unable) to|i'm (?:not able|unable) to|i won(?:'|’)t|i will not|i must decline|i'm sorry, but|siwezi)\b/i;
const EMERGENCY_GUIDANCE_PATTERN = /(\b(1195|999|112|116)\b|\bemergency\b|\bhotline\b|\bhelpline\b|\bdharura\b)/i;

/** Derives two booleans from a reply in memory; the text itself is never stored or returned. */
export function classifyAssistantReplySignals(text: string): { refusalLike: boolean; emergencyGuidanceLike: boolean } {
  return {
    refusalLike: REFUSAL_PATTERN.test(text),
    emergencyGuidanceLike: EMERGENCY_GUIDANCE_PATTERN.test(text),
  };
}

function primaryArtifactSha256(modelConfig: LocalModelConfig): string | null {
  const runtimeFileName = 'modelFileName' in modelConfig.runtime ? modelConfig.runtime.modelFileName : undefined;
  const file = modelConfig.files.find(entry => entry.fileName === runtimeFileName) ?? modelConfig.files[0];
  return file?.sha256 && /^[a-f0-9]{64}$/i.test(file.sha256) ? file.sha256 : null;
}

export function recordAiPilotQaDiagnostic(input: {
  modelConfig: LocalModelConfig;
  phase: TunedArtifactQaPhase;
  durationMs: number;
  bridgeStatus?: SafeRideLiteRtLmBridgeStatus | null;
  error?: unknown;
  replyText?: string | null;
}): void {
  if (!isAiPilotDiagnosticsEnabled()) return;
  try {
    const artifactSha256 = primaryArtifactSha256(input.modelConfig);
    if (!input.modelConfig.manifestId || !artifactSha256) return;
    const failed = input.error !== undefined;
    const code = failed ? classifyLocalAiFailure(input.error) : null;
    const cancelled = code === 'GENERATION_CANCELLED';
    const facts = getCachedLocalAiDeviceFacts();
    const duration = safeDuration(input.durationMs);
    const reply = !failed && input.phase === 'generation' && typeof input.replyText === 'string'
      ? input.replyText
      : null;
    const estimatedOutputTokens = reply === null ? null : Math.ceil(reply.length / APPROX_CHARS_PER_TOKEN);
    const estimatedTokensPerSecond = estimatedOutputTokens !== null && duration
      ? estimatedOutputTokens / (duration / 1000)
      : null;
    const diagnostic: TunedArtifactQaDiagnostic = createTunedArtifactQaDiagnostic({
      manifestId: input.modelConfig.manifestId,
      artifactSha256,
      bridgeStatus: input.bridgeStatus ?? {
        state: failed && !cancelled ? 'error' : 'loaded',
        nativeAvailable: true,
        runtimeAvailable: true,
        mockMode: false,
      },
      deviceClass: deviceClassForRamBucket(facts?.ramBucket ?? 'unknown'),
      phase: input.phase,
      timings: {
        loadMs: input.phase === 'load' ? duration : null,
        firstTokenMs: null,
        totalGenerationMs: input.phase === 'load' ? null : duration,
      },
      throughput: { estimatedOutputTokens, estimatedTokensPerSecond },
      resultStatus: cancelled ? 'cancelled' : failed ? 'failed' : 'passed',
      // Only the allowlisted code is kept; bridge lastErrorCode/message are dropped.
      errorCode: code,
      capturedAt: new Date(nowBucket()),
    });
    record([{
      kind: 'qa',
      at: nowBucket(),
      diagnostic: { ...diagnostic, result: { ...diagnostic.result, errorCode: code } },
      failureCode: code,
      failureCategory: code ? categorizeLocalAiFailure(code, { ramClassGb: facts?.ramClassGb ?? null }) : null,
      replySignals: reply === null ? null : classifyAssistantReplySignals(reply),
    }]);
  } catch {
    // Diagnostics must never affect the assistant path.
  }
}

export function recordAiPilotFallback(input: { failureCode: LocalAiFailureCode; attemptedLocal: boolean }): void {
  const ramClassGb = getCachedLocalAiDeviceFacts()?.ramClassGb ?? null;
  record([{
    kind: 'fallback',
    at: nowBucket(),
    failureCode: input.failureCode,
    failureCategory: categorizeLocalAiFailure(input.failureCode, { ramClassGb }),
    attemptedLocal: input.attemptedLocal,
  }]);
}

export function recordAiPilotRamCheck(input: {
  outcome: typeof RAM_CHECK_OUTCOMES[number];
  ramBucket: LocalAiRamBucket;
}): void {
  record([{ kind: 'ram-check', at: nowBucket(), outcome: input.outcome, ramBucket: input.ramBucket }]);
}

export function recordAiPilotFeedback(value: typeof FEEDBACK_VALUES[number]): void {
  record([{ kind: 'feedback', at: nowBucket(), value }]);
}

async function markInFlight(phase: AiPilotPhase): Promise<void> {
  await enqueue(async () => {
    // Record a previous process's marker for this phase before overwriting it.
    await appendEvents([]);
    const state = await readInFlight();
    state.entries[phase] = { processId, startedAt: nowBucket() };
    await writeInFlight(state);
  });
}

async function clearInFlight(phase: AiPilotPhase): Promise<void> {
  await enqueue(async () => {
    const state = await readInFlight();
    if (state.entries[phase]?.processId !== processId) return;
    delete state.entries[phase];
    await writeInFlight(state);
  });
}

/**
 * Runs a heavy step behind a persisted in-flight marker so a crash or kill is
 * visible on the next launch. Outside pilot builds the operation runs directly.
 */
export function runWithAiPilotInFlight<T>(phase: AiPilotPhase, operation: () => Promise<T>): Promise<T> {
  if (!isAiPilotDiagnosticsEnabled()) return operation();
  return (async () => {
    await markInFlight(phase).catch(() => undefined);
    try {
      return await operation();
    } finally {
      void clearInFlight(phase).catch(() => undefined);
    }
  })();
}

/** Records interruptions left by a previous process, if any. Safe to call at startup. */
export function checkAiPilotInterruptions(): void {
  record([]);
}

export async function flushAiPilotDiagnosticsWrites(): Promise<void> {
  await writeQueue.catch(() => undefined);
}

export async function getAiPilotDiagnosticsStore(): Promise<AiPilotDiagnosticsStore> {
  return enqueue(readStore);
}

export async function deleteAiPilotDiagnostics(): Promise<void> {
  await enqueue(async () => {
    await encryptedAsyncStorage.multiRemove([AI_PILOT_DIAGNOSTICS_KEY, AI_PILOT_INFLIGHT_KEY]);
  });
}

type CountMap = Record<string, number>;

function increment(counts: CountMap, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return Math.round(sorted[index] * 10) / 10;
}

function qaPhaseSummary(events: Extract<AiPilotEvent, { kind: 'qa' }>[], phase: TunedArtifactQaPhase) {
  const phaseEvents = events.filter(event => event.diagnostic.phase === phase);
  const durations = phaseEvents
    .filter(event => event.diagnostic.result.status === 'passed')
    .map(event => event.diagnostic.timings.loadMs ?? event.diagnostic.timings.totalGenerationMs)
    .filter((value): value is number => typeof value === 'number');
  const failureCodes: CountMap = {};
  const backends: CountMap = {};
  for (const event of phaseEvents) {
    if (event.failureCode && event.failureCode !== 'GENERATION_CANCELLED') increment(failureCodes, event.failureCode);
    if (event.diagnostic.backend) increment(backends, event.diagnostic.backend);
  }
  return {
    attempts: phaseEvents.length,
    passed: phaseEvents.filter(event => event.diagnostic.result.status === 'passed').length,
    failed: phaseEvents.filter(event => event.diagnostic.result.status === 'failed').length,
    cancelled: phaseEvents.filter(event => event.diagnostic.result.status === 'cancelled').length,
    medianMs: percentile(durations, 0.5),
    p90Ms: percentile(durations, 0.9),
    failureCodes,
    backends,
  };
}

export type AiPilotDiagnosticsExport = ReturnType<typeof buildAiPilotDiagnosticsExport>;

/** Day-level date (YYYY-MM-DD, UTC); exports never carry a time of day. */
function dayOf(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/**
 * Explicit allowlist of what one event looks like in an export: a day-level
 * date instead of a timestamp, and no per-reply refusal or emergency flags
 * (those appear only as totals in the summary).
 */
function toExportEvent(event: AiPilotEvent) {
  const date = dayOf(event.at);
  switch (event.kind) {
    case 'download':
      return {
        kind: event.kind,
        date,
        outcome: event.outcome,
        networkType: event.networkType,
        freeStorageBucket: event.freeStorageBucket,
        startPercent: event.startPercent,
        durationMs: event.durationMs,
        failureCode: event.failureCode,
      };
    case 'verify':
      return { kind: event.kind, date, outcome: event.outcome, durationMs: event.durationMs };
    case 'qa': {
      const diagnostic = event.diagnostic;
      return {
        kind: event.kind,
        date,
        diagnostic: {
          schema: diagnostic.schema,
          schemaVersion: diagnostic.schemaVersion,
          manifestId: diagnostic.manifestId,
          artifactSha256: diagnostic.artifactSha256,
          phase: diagnostic.phase,
          runtimeState: diagnostic.runtimeState,
          artifactValidated: diagnostic.artifactValidated,
          realRuntimeLoaded: diagnostic.realRuntimeLoaded,
          backend: diagnostic.backend,
          deviceClass: diagnostic.deviceClass,
          timings: diagnostic.timings,
          throughput: diagnostic.throughput,
          result: diagnostic.result,
        },
        failureCode: event.failureCode,
        failureCategory: event.failureCategory,
      };
    }
    case 'fallback':
      return {
        kind: event.kind,
        date,
        failureCode: event.failureCode,
        failureCategory: event.failureCategory,
        attemptedLocal: event.attemptedLocal,
      };
    case 'ram-check':
      return { kind: event.kind, date, outcome: event.outcome, ramBucket: event.ramBucket };
    case 'interrupted':
      return { kind: event.kind, date, phase: event.phase, startedOn: dayOf(event.startedAt) };
    case 'feedback':
      return { kind: event.kind, date, value: event.value };
  }
}

function toExportDevice(device: AiPilotDeviceSnapshot) {
  return {
    manufacturer: device.manufacturer,
    model: device.model,
    androidVersion: device.androidVersion,
    apiLevel: device.apiLevel,
    ramClassGb: device.ramClassGb,
    ramBucket: device.ramBucket,
    deviceClass: device.deviceClass,
    thermalState: device.thermalState,
    capturedOn: dayOf(device.capturedAt),
  };
}

export function buildAiPilotDiagnosticsExport(
  store: AiPilotDiagnosticsStore,
  context: {
    now: Date;
    consentConfirmedAt: Date;
    appVersion: string | null;
    environment: string | null;
    buildProfile: string | null;
    manifestId: string | null;
    artifactSha256: string | null;
    freeStorageBucket: LocalAiFreeStorageBucket;
  },
) {
  // Retention is enforced here too, so an export never carries expired records.
  const retained = applyRetention(store, context.now);
  const events = retained.events;
  const downloads = events.filter((event): event is Extract<AiPilotEvent, { kind: 'download' }> => event.kind === 'download');
  const verifies = events.filter((event): event is Extract<AiPilotEvent, { kind: 'verify' }> => event.kind === 'verify');
  const qa = events.filter((event): event is Extract<AiPilotEvent, { kind: 'qa' }> => event.kind === 'qa');
  const fallbacks = events.filter((event): event is Extract<AiPilotEvent, { kind: 'fallback' }> => event.kind === 'fallback');
  const interruptions = events.filter((event): event is Extract<AiPilotEvent, { kind: 'interrupted' }> => event.kind === 'interrupted');
  const ramChecks = events.filter((event): event is Extract<AiPilotEvent, { kind: 'ram-check' }> => event.kind === 'ram-check');
  const feedback = events.filter((event): event is Extract<AiPilotEvent, { kind: 'feedback' }> => event.kind === 'feedback');

  const downloadOutcomes: CountMap = {};
  const downloadFailureCodes: CountMap = {};
  const downloadNetworks: CountMap = {};
  let activeDownloadMs = 0;
  for (const event of downloads) {
    increment(downloadOutcomes, event.outcome);
    if (event.failureCode) increment(downloadFailureCodes, event.failureCode);
    if (event.networkType && (event.outcome === 'started' || event.outcome === 'resumed')) {
      increment(downloadNetworks, event.networkType);
    }
    if (event.durationMs !== null && event.outcome !== 'started' && event.outcome !== 'resumed') {
      activeDownloadMs += event.durationMs;
    }
  }
  const completedDownloads = downloads.filter(event => event.outcome === 'completed');

  const verifyOutcomes: CountMap = {};
  for (const event of verifies) increment(verifyOutcomes, event.outcome);
  const verifyDurations = verifies
    .filter(event => event.outcome === 'passed' || event.outcome === 'failed')
    .map(event => event.durationMs)
    .filter((value): value is number => value !== null);

  const generations = qa.filter(event => event.diagnostic.phase === 'generation');
  const passedGenerations = generations.filter(event => event.diagnostic.result.status === 'passed');
  const tokensPerSecond = passedGenerations
    .map(event => event.diagnostic.throughput.estimatedTokensPerSecond)
    .filter((value): value is number => value !== null);
  const outputTokens = passedGenerations
    .map(event => event.diagnostic.throughput.estimatedOutputTokens)
    .filter((value): value is number => value !== null);

  const fallbackCodes: CountMap = {};
  const fallbackCategories: CountMap = {};
  for (const event of fallbacks) {
    increment(fallbackCodes, event.failureCode);
    increment(fallbackCategories, event.failureCategory);
  }
  const interruptionPhases: CountMap = {};
  for (const event of interruptions) increment(interruptionPhases, event.phase);
  const ramCheckOutcomes: CountMap = {};
  for (const event of ramChecks) increment(ramCheckOutcomes, event.outcome);

  return {
    schema: AI_PILOT_EXPORT_SCHEMA,
    schemaVersion: 2 as const,
    contentFree: true as const,
    generatedOn: dayOf(context.now.toISOString()),
    consent: {
      version: AI_PILOT_EXPORT_CONSENT_VERSION,
      confirmedOn: dayOf(context.consentConfirmedAt.toISOString()),
      included: [...AI_PILOT_EXPORT_INCLUDED_FIELDS],
      excluded: [...AI_PILOT_EXPORT_EXCLUDED_FIELDS],
      automaticUpload: false as const,
    },
    app: {
      appVersion: context.appVersion,
      environment: context.environment,
      buildProfile: context.buildProfile,
      manifestId: context.manifestId,
      artifactSha256: context.artifactSha256,
    },
    device: retained.device
      ? {
          ...toExportDevice(retained.device),
          freeStorageBucketAtExport: context.freeStorageBucket,
          minimumRamGb: LOCAL_AI_MIN_RAM_GB,
        }
      : null,
    retention: { days: AI_PILOT_RETENTION_DAYS, maxEvents: AI_PILOT_MAX_EVENTS, storedEvents: events.length },
    summary: {
      download: {
        outcomes: downloadOutcomes,
        pauses: downloadOutcomes.paused ?? 0,
        resumes: downloadOutcomes.resumed ?? 0,
        failureCodes: downloadFailureCodes,
        networkTypes: downloadNetworks,
        activeDurationMs: activeDownloadMs,
        lastCompletedAttemptMs: completedDownloads.at(-1)?.durationMs ?? null,
        note: 'Attempt durations include the final checksum verification.',
      },
      verify: {
        outcomes: verifyOutcomes,
        medianMs: percentile(verifyDurations, 0.5),
      },
      load: qaPhaseSummary(qa, 'load'),
      readinessProbe: qaPhaseSummary(qa, 'readiness-probe'),
      generation: {
        ...qaPhaseSummary(qa, 'generation'),
        timeToFirstTokenMs: 'not-exposed: the LiteRT-LM bridge returns whole replies',
        medianEstimatedTokensPerSecond: percentile(tokensPerSecond, 0.5),
        p10EstimatedTokensPerSecond: percentile(tokensPerSecond, 0.1),
        medianEstimatedOutputTokens: percentile(outputTokens, 0.5),
        refusalLikeReplies: passedGenerations.filter(event => event.replySignals?.refusalLike).length,
        emergencyGuidanceLikeReplies: passedGenerations.filter(event => event.replySignals?.emergencyGuidanceLike).length,
        signalNote: 'Totals only: keyword heuristics on replies. Reply text and per-reply flags are not exported.',
      },
      fallbacks: { total: fallbacks.length, byCode: fallbackCodes, byCategory: fallbackCategories },
      interruptions: {
        total: interruptions.length,
        byPhase: interruptionPhases,
        note: 'The app ended during this step: crash, out-of-memory kill, force-close, or swipe-away.',
      },
      ramChecks: ramCheckOutcomes,
      feedback: {
        helpful: feedback.filter(event => event.value === 'helpful').length,
        notHelpful: feedback.filter(event => event.value === 'not-helpful').length,
      },
      thermal: 'not-exposed: the native module does not report thermal state',
    },
    recentEvents: events.slice(-AI_PILOT_EXPORT_RECENT_EVENTS).map(toExportEvent),
  };
}

export async function createAiPilotDiagnosticsExport(params: {
  consentConfirmedAt: Date;
  appVersion: string | null;
  manifestId: string | null;
  artifactSha256: string | null;
}): Promise<string> {
  const freeStorageBucket = await readLocalAiFreeStorageBucket();
  await enqueue(() => appendEvents([]));
  const store = await getAiPilotDiagnosticsStore();
  const device = store.device ?? await currentDeviceSnapshot().catch(() => null);
  const payload = buildAiPilotDiagnosticsExport({ ...store, device }, {
    now: runtime.now(),
    consentConfirmedAt: params.consentConfirmedAt,
    appVersion: params.appVersion,
    environment: env.environment ?? null,
    buildProfile: env.buildProfile ?? null,
    manifestId: params.manifestId,
    artifactSha256: params.artifactSha256,
    freeStorageBucket,
  });
  return JSON.stringify(payload, null, 2);
}

export function __configureAiPilotDiagnosticsForTests(options: {
  enabled?: boolean;
  now?: () => Date;
} = {}): void {
  runtime.enabledOverride = options.enabled;
  runtime.now = options.now ?? (() => new Date());
}

export function __resetAiPilotDiagnosticsForTests(): void {
  runtime.enabledOverride = undefined;
  runtime.now = () => new Date();
  writeQueue = Promise.resolve();
  interruptionsChecked = false;
}

export const __aiPilotProcessIdForTests = processId;
