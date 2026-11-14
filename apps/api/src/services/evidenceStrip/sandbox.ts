/**
 * Runs one strip in a worker thread with a wall-time and heap budget, so a
 * crafted file can neither stall the job nor exhaust its memory. A file that
 * exceeds either budget, or crashes the worker, comes back `failed`
 * (`resource_limit` or `parse_error`): never shareable, never retried.
 *
 * The heap budget bounds JavaScript objects (box, chunk, segment and frame
 * bookkeeping). The input and output byte buffers live outside it and are
 * bounded by the 100 MiB evidence cap.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import { sniffEvidenceFormat } from './index.js';
import type { StripOutcome } from './types.js';

export type StripBudget = { timeoutMs: number; maxHeapMb: number };
export const DEFAULT_STRIP_BUDGET: StripBudget = { timeoutMs: 30_000, maxHeapMb: 256 };

// CommonJS worker body: load the stripper (through tsx when running from
// TypeScript sources), strip, and hand the output bytes back by transfer.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  if (workerData.tsxApiUrl) (await import(workerData.tsxApiUrl)).register();
  const { stripEvidenceMetadata } = await import(workerData.moduleUrl);
  const result = stripEvidenceMetadata(Buffer.from(workerData.input), workerData.mimeType);
  if (result.outcome !== 'stripped') return parentPort.postMessage({ result });
  const out = result.output;
  const owned = out.byteOffset === 0 && out.byteLength === out.buffer.byteLength;
  const bytes = owned ? out.buffer : out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
  parentPort.postMessage({ result: { ...result, output: null }, bytes }, [bytes]);
})().catch(() => parentPort.postMessage({ crashed: true }));
`;

function defaultStripModule(): { moduleUrl: string; tsxApiUrl: string | null } {
  if (!import.meta.url.endsWith('.ts')) return { moduleUrl: new URL('./index.js', import.meta.url).href, tsxApiUrl: null };
  // Running from sources (tests, `tsx watch`): the worker needs tsx to load TypeScript.
  const require = createRequire(import.meta.url);
  return { moduleUrl: new URL('./index.ts', import.meta.url).href, tsxApiUrl: pathToFileURL(require.resolve('tsx/esm/api')).href };
}

/** An ArrayBuffer holding exactly `input`, transferred without a copy when the caller gives it up. */
function transferable(input: Buffer, giveUp: boolean): ArrayBuffer {
  const owned = input.byteOffset === 0 && input.byteLength === input.buffer.byteLength && input.buffer instanceof ArrayBuffer;
  if (giveUp && owned) return input.buffer as ArrayBuffer;
  const copy = new ArrayBuffer(input.length);
  new Uint8Array(copy).set(input);
  return copy;
}

/**
 * Strips `input` in a worker under `budget`. With `transferInput` the caller
 * hands over the buffer (it is detached afterwards), so the bytes are not
 * copied. `moduleUrl` replaces the stripper module (tests only).
 */
export function stripInSandbox(
  input: Buffer,
  declaredMimeType: string | null,
  options: { budget?: Partial<StripBudget>; transferInput?: boolean; moduleUrl?: string } = {},
): Promise<StripOutcome> {
  const budget = { ...DEFAULT_STRIP_BUDGET, ...options.budget };
  const format = sniffEvidenceFormat(input);
  const { moduleUrl, tsxApiUrl } = options.moduleUrl ? { moduleUrl: options.moduleUrl, tsxApiUrl: null } : defaultStripModule();
  const spawn = (bytes: ArrayBuffer) => new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { input: bytes, mimeType: declaredMimeType, moduleUrl, tsxApiUrl },
    transferList: [bytes],
    resourceLimits: { maxOldGenerationSizeMb: budget.maxHeapMb, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
  });

  return new Promise(resolve => {
    let worker: Worker;
    try {
      worker = spawn(transferable(input, options.transferInput === true));
    } catch {
      // An untransferable buffer: fall back to a private copy.
      worker = spawn(transferable(input, false));
    }
    let settled = false;
    const finish = (outcome: StripOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ outcome: 'failed', format, reason: 'resource_limit' }), budget.timeoutMs);
    worker.once('message', (message: { result?: StripOutcome; bytes?: ArrayBuffer; crashed?: boolean }) => {
      if (!message.result) return finish({ outcome: 'failed', format, reason: 'parse_error' });
      if (message.result.outcome === 'stripped') {
        if (!message.bytes) return finish({ outcome: 'failed', format, reason: 'parse_error' });
        return finish({ ...message.result, output: Buffer.from(message.bytes) });
      }
      return finish(message.result);
    });
    worker.once('error', (error: Error & { code?: string }) => {
      finish({ outcome: 'failed', format, reason: error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'resource_limit' : 'parse_error' });
    });
    worker.once('exit', () => finish({ outcome: 'failed', format, reason: 'parse_error' }));
  });
}
