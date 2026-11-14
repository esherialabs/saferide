/**
 * PNG: an allow-list of chunks, each copied byte for byte (CRC included), so
 * the derivative decodes to exactly the original's pixels.
 *
 * Kept: IHDR, PLTE, IDAT, IEND and the numeric rendering chunks tRNS, gAMA,
 * cHRM, sRGB, cICP, mDCv, cLLi, sBIT, bKGD, pHYs, hIST, plus the APNG
 * animation chunks acTL, fcTL, fdAT.
 * Dropped: eXIf, tEXt, zTXt, iTXt (XMP lives here), tIME, iCCP, sPLT, every
 * other ancillary or private chunk, and anything after IEND.
 */
import { createHash } from 'node:crypto';

import { inspectTiff, inspectXmp } from './exif.js';
import {
  DerivativeValidationError,
  EvidenceParseError,
  type RemovedCategory,
  ResourceLimitError,
  sortedCategories,
} from './types.js';

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const KEPT_CHUNKS = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND',
  'tRNS', 'gAMA', 'cHRM', 'sRGB', 'cICP', 'mDCv', 'cLLi', 'sBIT', 'bKGD', 'pHYs', 'hIST',
  'acTL', 'fcTL', 'fdAT',
]);

/** Encoders split image data into a few thousand IDAT chunks at most. */
const MAX_CHUNKS = 250_000;

/** Exact data lengths of fixed-layout kept chunks; a padded chunk could carry anything. */
const FIXED_LENGTHS: Record<string, number> = {
  IHDR: 13, gAMA: 4, cHRM: 32, sRGB: 1, cICP: 4, mDCv: 24, cLLi: 8, pHYs: 9, acTL: 8, fcTL: 26, IEND: 0,
};
/** Per colour type (0 grey, 2 RGB, 3 palette, 4 grey+alpha, 6 RGBA). */
const SBIT_LENGTHS: Record<number, number> = { 0: 1, 2: 3, 3: 3, 4: 2, 6: 4 };
const BKGD_LENGTHS: Record<number, number> = { 0: 2, 2: 6, 3: 1, 4: 2, 6: 6 };

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

type Chunk = { type: string; start: number; end: number; data: Buffer };
type ParsedPng = { chunks: Chunk[]; trailing: Buffer };

function parsePng(buf: Buffer): ParsedPng {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new EvidenceParseError('PNG signature missing');
  const chunks: Chunk[] = [];
  let pos = 8;
  while (pos < buf.length) {
    if (chunks.length >= MAX_CHUNKS) throw new ResourceLimitError('too many PNG chunks');
    if (pos + 12 > buf.length) throw new EvidenceParseError('PNG truncated at chunk header');
    const length = buf.readUInt32BE(pos);
    const end = pos + 12 + length;
    if (length > 0x7fffffff || end > buf.length) throw new EvidenceParseError('PNG chunk length out of range');
    const type = buf.toString('latin1', pos + 4, pos + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new EvidenceParseError('PNG chunk type is invalid');
    if (crc32(buf.subarray(pos + 4, pos + 8 + length)) !== buf.readUInt32BE(pos + 8 + length)) {
      throw new EvidenceParseError('PNG chunk CRC mismatch');
    }
    chunks.push({ type, start: pos, end, data: buf.subarray(pos + 8, pos + 8 + length) });
    pos = end;
    if (type === 'IEND') return { chunks, trailing: buf.subarray(pos) };
  }
  throw new EvidenceParseError('PNG has no IEND');
}

function textKeyword(data: Buffer): string {
  const nul = data.indexOf(0);
  return data.toString('latin1', 0, nul === -1 ? Math.min(data.length, 79) : nul);
}

function chunkCategories(chunk: Chunk): RemovedCategory[] {
  switch (chunk.type) {
    case 'eXIf':
      return [...inspectTiff(chunk.data).categories];
    case 'tIME':
      return ['capture_timestamps'];
    case 'iCCP':
      return ['icc_profile'];
    case 'tEXt':
    case 'zTXt':
    case 'iTXt': {
      const keyword = textKeyword(chunk.data);
      if (keyword === 'XML:com.adobe.xmp') {
        // Compressed iTXt XMP is still dropped; it is just not inspected for sub-categories.
        const compressed = chunk.type === 'iTXt' && chunk.data[keyword.length + 1] === 1;
        return compressed ? ['xmp'] : inspectXmp(chunk.data.toString('latin1'));
      }
      const found: RemovedCategory[] = ['text_metadata'];
      if (/^Raw profile type (exif|APP1)$/i.test(keyword)) found.push('exif');
      if (/^Raw profile type (iptc|8bim)$/i.test(keyword)) found.push('iptc');
      if (/^Raw profile type xmp$/i.test(keyword)) found.push('xmp');
      if (keyword === 'Creation Time') found.push('capture_timestamps');
      if (keyword === 'Software') found.push('software');
      if (keyword === 'Comment') found.push('comments');
      return found;
    }
    default:
      return ['vendor_metadata'];
  }
}

/** Kept chunks must have exactly the length their type and the image header allow. */
function assertKeptChunkShapes(parsed: ParsedPng): void {
  const fail = (type: string): never => {
    throw new EvidenceParseError(`PNG ${type} chunk has an unexpected length`);
  };
  const colourType = parsed.chunks[0].data[9];
  const palette = parsed.chunks.find(chunk => chunk.type === 'PLTE');
  const paletteEntries = palette ? palette.data.length / 3 : 0;
  for (const chunk of parsed.chunks) {
    const length = chunk.data.length;
    const fixed = FIXED_LENGTHS[chunk.type];
    if (fixed !== undefined && length !== fixed) fail(chunk.type);
    if (chunk.type === 'PLTE' && (length === 0 || length % 3 !== 0 || length > 768)) fail(chunk.type);
    if (chunk.type === 'sBIT' && length !== SBIT_LENGTHS[colourType]) fail(chunk.type);
    if (chunk.type === 'bKGD' && length !== BKGD_LENGTHS[colourType]) fail(chunk.type);
    if (chunk.type === 'hIST' && length !== paletteEntries * 2) fail(chunk.type);
    if (chunk.type === 'tRNS') {
      const allowed = colourType === 0 ? length === 2 : colourType === 2 ? length === 6 : colourType === 3 ? length <= paletteEntries : false;
      if (!allowed) fail(chunk.type);
    }
    if (chunk.type === 'fdAT' && length < 4) fail(chunk.type);
  }
}

function keptDigest(parsed: ParsedPng, buf: Buffer): string {
  const hash = createHash('sha256');
  for (const chunk of parsed.chunks) {
    if (KEPT_CHUNKS.has(chunk.type)) hash.update(buf.subarray(chunk.start, chunk.end));
  }
  return hash.digest('hex');
}

function ihdrDimensions(parsed: ParsedPng): { width: number; height: number } | null {
  const ihdr = parsed.chunks[0];
  if (!ihdr || ihdr.type !== 'IHDR' || ihdr.data.length !== 13) return null;
  return { width: ihdr.data.readUInt32BE(0), height: ihdr.data.readUInt32BE(4) };
}

export function stripPng(input: Buffer): { output: Buffer; removed: RemovedCategory[] } {
  const parsed = parsePng(input);
  if (!ihdrDimensions(parsed)) throw new EvidenceParseError('PNG does not start with a valid IHDR');
  if (!parsed.chunks.some(chunk => chunk.type === 'IDAT')) throw new EvidenceParseError('PNG has no image data');
  assertKeptChunkShapes({ chunks: parsed.chunks.filter(chunk => KEPT_CHUNKS.has(chunk.type)), trailing: parsed.trailing });

  const removed = new Set<RemovedCategory>();
  const parts: Buffer[] = [PNG_SIGNATURE];
  for (const chunk of parsed.chunks) {
    if (KEPT_CHUNKS.has(chunk.type)) {
      parts.push(input.subarray(chunk.start, chunk.end));
    } else {
      for (const category of chunkCategories(chunk)) removed.add(category);
    }
  }
  if (parsed.trailing.length > 0) removed.add('trailing_data');
  return { output: Buffer.concat(parts), removed: sortedCategories(removed) };
}

/** Re-parses the derivative: allow-listed chunks only, valid CRCs, nothing after IEND, identical image chunks. */
export function validatePngDerivative(original: Buffer, derivative: Buffer): void {
  let parsed: ParsedPng;
  try {
    parsed = parsePng(derivative);
  } catch {
    throw new DerivativeValidationError('PNG derivative does not parse');
  }
  if (parsed.trailing.length > 0) throw new DerivativeValidationError('PNG derivative has data after IEND');
  const leftovers = new Set<RemovedCategory>();
  for (const chunk of parsed.chunks) {
    if (!KEPT_CHUNKS.has(chunk.type)) for (const category of chunkCategories(chunk)) leftovers.add(category);
  }
  if (leftovers.size > 0) {
    throw new DerivativeValidationError(`PNG derivative still holds: ${sortedCategories(leftovers).join(', ')}`);
  }
  try {
    if (!ihdrDimensions(parsed)) throw new EvidenceParseError('no IHDR');
    assertKeptChunkShapes(parsed);
  } catch {
    throw new DerivativeValidationError('PNG derivative has a malformed chunk');
  }
  const source = parsePng(original);
  const before = ihdrDimensions(source);
  const after = ihdrDimensions(parsed);
  if (!before || !after || before.width !== after.width || before.height !== after.height) {
    throw new DerivativeValidationError('PNG derivative dimensions differ');
  }
  if (keptDigest(source, original) !== keptDigest(parsed, derivative)) {
    throw new DerivativeValidationError('PNG derivative image data differs');
  }
}
