/**
 * The strip sandbox: a worker thread with a time and heap budget. Fake
 * stripper modules (written to a temporary directory here) hang, exhaust the
 * heap or crash; the real stripper runs through tsx from the sources.
 * Synthetic data only.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

import { afterAll, describe, expect, it } from 'vitest';

import { stripInSandbox } from '../evidenceStrip/sandbox.js';

const dir = mkdtempSync(join(tmpdir(), 'evidence-sandbox-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fakeStripper(name: string, body: string): string {
  const file = join(dir, `${name}.mjs`);
  writeFileSync(file, `export function stripEvidenceMetadata(input, mimeType) {\n${body}\n}\n`);
  return pathToFileURL(file).href;
}

function pngChunk(type: string, data: Buffer | string): Buffer {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), body])) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0])),
  pngChunk('tEXt', 'Comment\0SYNTH-SANDBOX-MARKER'),
  pngChunk('IDAT', deflateSync(Buffer.from([0, 9]))),
  pngChunk('IEND', Buffer.alloc(0)),
]);

const u32 = (value: number) => {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value >>> 0, 0);
  return out;
};
const box = (type: string, ...parts: Array<Buffer | string>) => {
  const body = Buffer.concat(parts.map(part => (typeof part === 'string' ? Buffer.from(part, 'latin1') : part)));
  return Buffer.concat([u32(body.length + 8), Buffer.from(type, 'latin1'), body]);
};
const full = (type: string, versionFlags: number, ...parts: Array<Buffer | string>) => box(type, u32(versionFlags), ...parts);

/** The reviewer's shape: a constant sample size and a claimed 2^32-1 samples in every track. */
function hugeSampleCountMovie(tracks: number): Buffer {
  const trak = box('trak', full('tkhd', 0, Buffer.alloc(80)), box('mdia', full('mdhd', 0, Buffer.alloc(20)),
    full('hdlr', 0, u32(0), 'vide', Buffer.alloc(12), '\0'),
    box('minf', full('vmhd', 1, Buffer.alloc(8)), box('stbl', full('stsd', 0, u32(0)), full('stco', 0, u32(1), u32(0)),
      full('stsc', 0, u32(1), u32(1), u32(0xffffffff), u32(1)), full('stsz', 0, u32(1), u32(0xffffffff))))));
  return Buffer.concat([box('ftyp', 'isom', u32(0), 'isom'), box('moov', full('mvhd', 0, Buffer.alloc(96)), ...Array(tracks).fill(trak)), box('mdat', 'x')]);
}

describe('strip sandbox', () => {
  it('runs the real stripper in a worker and hands back its output', async () => {
    const result = await stripInSandbox(PNG, 'image/png');
    expect(result).toMatchObject({ outcome: 'stripped', format: 'png', method: 'png-chunk-allowlist.v1', removed: ['comments', 'text_metadata'] });
    if (result.outcome !== 'stripped') throw new Error('expected stripped');
    expect(result.output.toString('latin1')).not.toContain('SYNTH-SANDBOX-MARKER');
    expect(await stripInSandbox(Buffer.from('%PDF-1.7 synthetic', 'latin1'), 'application/pdf'))
      .toEqual({ outcome: 'unsupported', format: 'pdf', reason: 'unsupported_format' });
  });

  it('stops a strip that runs past its time budget', async () => {
    const moduleUrl = fakeStripper('hang', 'for (;;) {}');
    const started = Date.now();
    expect(await stripInSandbox(PNG, 'image/png', { moduleUrl, budget: { timeoutMs: 300 } }))
      .toEqual({ outcome: 'failed', format: 'png', reason: 'resource_limit' });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('stops a strip that exceeds its heap budget', async () => {
    const moduleUrl = fakeStripper('hog', "const kept = []; for (;;) kept.push({ index: kept.length, pad: 'x'.repeat(64) + kept.length });");
    expect(await stripInSandbox(PNG, 'image/png', { moduleUrl, budget: { maxHeapMb: 16, timeoutMs: 20_000 } }))
      .toEqual({ outcome: 'failed', format: 'png', reason: 'resource_limit' });
  });

  it('fails closed when the stripper crashes or returns nothing usable', async () => {
    expect(await stripInSandbox(PNG, 'image/png', { moduleUrl: fakeStripper('crash', "throw new Error('synthetic');") }))
      .toEqual({ outcome: 'failed', format: 'png', reason: 'parse_error' });
    expect(await stripInSandbox(PNG, 'image/png', { moduleUrl: fakeStripper('exit', 'process.exit(3);') }))
      .toEqual({ outcome: 'failed', format: 'png', reason: 'parse_error' });
  });

  it('takes over the input without copying when the caller gives it up', async () => {
    const input = Buffer.alloc(64 * 1024);
    Buffer.from('%PDF-1.7', 'latin1').copy(input);
    expect(await stripInSandbox(input, 'application/pdf', { transferInput: true })).toMatchObject({ outcome: 'unsupported' });
    expect(input.length).toBe(0); // detached: the worker had the only copy
    const kept = Buffer.from(PNG);
    await stripInSandbox(kept, 'image/png');
    expect(kept.equals(PNG)).toBe(true);
  });

  it('fails the reviewer\'s 2^32-sample movies fast, one or five tracks', async () => {
    for (const tracks of [1, 5]) {
      const started = Date.now();
      expect(await stripInSandbox(hugeSampleCountMovie(tracks), 'video/mp4')).toMatchObject({ outcome: 'failed' });
      expect(Date.now() - started).toBeLessThan(5000);
    }
  });
});
