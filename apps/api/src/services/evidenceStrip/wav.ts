/**
 * WAV (RIFF/WAVE): keep `fmt `, `fact` and `data` chunks byte for byte and
 * rebuild the RIFF header around them.
 *
 * Dropped: LIST/INFO (artist, comment, creation date, software), bext
 * (Broadcast WAV originator and timestamps), iXML, axml, XMP, id3, cart,
 * cue/label chunks, padding chunks, vendor chunks, and bytes after the RIFF
 * body. RF64/BW64 (files over 4 GiB) are unsupported.
 */
import { createHash } from 'node:crypto';

import {
  DerivativeValidationError,
  EvidenceParseError,
  type RemovedCategory,
  ResourceLimitError,
  sortedCategories,
  UnsupportedVariantError,
} from './types.js';

const KEPT_CHUNKS = new Set(['fmt ', 'fact', 'data']);
/** Real WAV files have a handful of chunks. */
const MAX_CHUNKS = 10_000;
/** WAVE_FORMAT_PCM, IEEE_FLOAT, ALAW, MULAW: no codec-specific extra bytes. */
const PLAIN_FORMATS = new Set([1, 3, 6, 7]);
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;
/** KSDATAFORMAT_SUBTYPE_* GUID after its leading 2-byte format code. */
const SUBFORMAT_GUID_TAIL = Buffer.from('000000001000800000aa00389b71', 'hex');

type Chunk = { id: string; start: number; end: number; data: Buffer };

function parseWav(buf: Buffer): { chunks: Chunk[]; trailing: Buffer } {
  if (buf.length < 12) throw new EvidenceParseError('WAV header truncated');
  const riff = buf.toString('latin1', 0, 4);
  if (riff === 'RF64' || riff === 'BW64') throw new UnsupportedVariantError('64-bit RIFF');
  if (riff !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') throw new EvidenceParseError('not a RIFF/WAVE file');
  const riffEnd = 8 + buf.readUInt32LE(4);
  if (riffEnd > buf.length || riffEnd < 12) throw new EvidenceParseError('RIFF size out of range');
  const chunks: Chunk[] = [];
  let pos = 12;
  while (pos < riffEnd) {
    if (chunks.length >= MAX_CHUNKS) throw new ResourceLimitError('too many WAV chunks');
    if (pos + 8 > riffEnd) throw new EvidenceParseError('WAV chunk header truncated');
    const size = buf.readUInt32LE(pos + 4);
    const dataEnd = pos + 8 + size;
    if (dataEnd > riffEnd) throw new EvidenceParseError('WAV chunk size out of range');
    const end = Math.min(riffEnd, dataEnd + (size % 2));
    chunks.push({ id: buf.toString('latin1', pos, pos + 4), start: pos, end, data: buf.subarray(pos + 8, dataEnd) });
    pos = end;
  }
  return { chunks, trailing: buf.subarray(riffEnd) };
}

function chunkCategories(chunk: Chunk): RemovedCategory[] {
  switch (chunk.id) {
    case 'LIST': {
      const found: RemovedCategory[] = ['riff_info'];
      const text = chunk.data.toString('latin1');
      if (text.includes('ICRD')) found.push('capture_timestamps');
      if (text.includes('ISFT')) found.push('software');
      if (text.includes('ICMT')) found.push('comments');
      if (/IART|INAM|ICOP|IENG|ITCH|ISBJ|IKEY/.test(text)) found.push('text_metadata');
      return found;
    }
    case 'bext':
      return ['broadcast_wave', 'capture_timestamps', 'text_metadata'];
    case 'iXML':
    case 'axml':
    case 'cart':
      return ['text_metadata'];
    case 'XMP ':
    case '_PMX':
      return ['xmp'];
    case 'id3 ':
    case 'ID3 ':
      return ['id3_tags'];
    case 'JUNK':
    case 'junk':
    case 'PAD ':
    case 'FLLR':
      return chunk.data.some(byte => byte !== 0) ? ['free_space'] : [];
    default:
      return ['vendor_metadata'];
  }
}

/**
 * Only uncompressed or G.711 audio, with exactly the format fields that
 * describe it: a codec's extra bytes or a padded fact chunk could carry
 * anything, so they are refused rather than copied.
 */
function assertKeptChunkShapes(chunks: Chunk[]): void {
  for (const chunk of chunks) {
    if (chunk.id === 'fact' && chunk.data.length !== 4) throw new EvidenceParseError('WAV fact chunk has an unexpected length');
    if (chunk.id !== 'fmt ') continue;
    const { data } = chunk;
    if (data.length < 16) throw new EvidenceParseError('WAV fmt chunk truncated');
    const format = data.readUInt16LE(0);
    const extra = data.length >= 18 ? data.readUInt16LE(16) : 0;
    if (PLAIN_FORMATS.has(format)) {
      if (!(data.length === 16 || (data.length === 18 && extra === 0))) throw new EvidenceParseError('WAV fmt chunk has extra bytes');
    } else if (format === WAVE_FORMAT_EXTENSIBLE) {
      if (data.length !== 40 || extra !== 22) throw new EvidenceParseError('WAV extensible fmt chunk has an unexpected length');
      if (!PLAIN_FORMATS.has(data.readUInt16LE(24)) || !data.subarray(26, 40).equals(SUBFORMAT_GUID_TAIL)) {
        throw new UnsupportedVariantError('WAV sub-format is not plain audio');
      }
    } else {
      throw new UnsupportedVariantError('compressed WAV audio');
    }
  }
}

function keptDigest(buf: Buffer, chunks: Chunk[]): string {
  const hash = createHash('sha256');
  for (const chunk of chunks) if (KEPT_CHUNKS.has(chunk.id)) hash.update(buf.subarray(chunk.start, chunk.end));
  return hash.digest('hex');
}

export function stripWav(input: Buffer): { output: Buffer; removed: RemovedCategory[] } {
  const { chunks, trailing } = parseWav(input);
  const fmtIndex = chunks.findIndex(chunk => chunk.id === 'fmt ');
  const dataIndex = chunks.findIndex(chunk => chunk.id === 'data');
  if (fmtIndex === -1 || dataIndex === -1 || fmtIndex > dataIndex) throw new EvidenceParseError('WAV needs fmt before data');
  assertKeptChunkShapes(chunks.filter(chunk => KEPT_CHUNKS.has(chunk.id)));
  const removed = new Set<RemovedCategory>();
  const body: Buffer[] = [];
  for (const chunk of chunks) {
    if (KEPT_CHUNKS.has(chunk.id)) {
      body.push(input.subarray(chunk.start, chunk.end));
      // A kept chunk with an odd size at the very end of the RIFF body may lack its pad byte.
      if ((chunk.end - chunk.start) % 2 === 1) body.push(Buffer.alloc(1));
    } else {
      for (const category of chunkCategories(chunk)) removed.add(category);
    }
  }
  if (trailing.length > 0) removed.add('trailing_data');
  const bodyBytes = Buffer.concat(body);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(bodyBytes.length + 4, 4);
  header.write('WAVE', 8, 'latin1');
  return { output: Buffer.concat([header, bodyBytes]), removed: sortedCategories(removed) };
}

/** Re-parses the derivative: only fmt/fact/data, exact RIFF length, identical audio chunks. */
export function validateWavDerivative(original: Buffer, derivative: Buffer): void {
  let parsed: ReturnType<typeof parseWav>;
  try {
    parsed = parseWav(derivative);
  } catch {
    throw new DerivativeValidationError('WAV derivative does not parse');
  }
  if (parsed.trailing.length > 0) throw new DerivativeValidationError('WAV derivative has data after RIFF body');
  try {
    assertKeptChunkShapes(parsed.chunks);
  } catch {
    throw new DerivativeValidationError('WAV derivative has a malformed format chunk');
  }
  const leftovers = parsed.chunks.filter(chunk => !KEPT_CHUNKS.has(chunk.id));
  if (leftovers.length > 0) {
    const categories = sortedCategories(leftovers.flatMap(chunkCategories).concat('vendor_metadata'));
    throw new DerivativeValidationError(`WAV derivative still holds: ${categories.join(', ')}`);
  }
  const source = parseWav(original);
  const normalise = (buf: Buffer, chunks: Chunk[]) => keptDigest(buf, chunks.map(chunk => ({
    ...chunk,
    // Compare chunk contents and sizes, not a pad byte the original may have lacked at its end.
    end: chunk.start + 8 + chunk.data.length,
  })));
  if (normalise(original, source.chunks) !== normalise(derivative, parsed.chunks)) {
    throw new DerivativeValidationError('WAV derivative audio differs');
  }
}
