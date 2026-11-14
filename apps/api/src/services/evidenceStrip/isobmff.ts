/**
 * MP4 / MOV / M4A / 3GP (ISO base media and QuickTime): neutralise in place.
 *
 * Every box keeps its size, so no chunk offset (stco/co64) moves and the
 * media bytes stay exactly where the sample tables say they are. A box that
 * goes is renamed `free` and its payload zeroed; `free` is valid at any level.
 * Everything is allow-listed; anything not listed is neutralised.
 *
 * - Top level: the first ftyp is kept and normalised (minor version zeroed,
 *   unknown brands replaced by the major brand); moov and mdat are kept;
 *   free/skip/wide payloads are zeroed; everything else (a second ftyp, uuid
 *   XMP, meta, vendor trailers) is neutralised.
 * - moov keeps mvhd and audio/video traks. trak keeps tkhd, tref, edts, mdia;
 *   mdia keeps mdhd, hdlr, minf; minf keeps vmhd/smhd, dinf, stbl, hdlr. So
 *   udta (©xyz, ©mak, ©mod, loci), meta (mdta location keys), uuid, iods,
 *   tapt, load, elng, gmhd and anything unknown are neutralised.
 * - stbl keeps stsd, stts, ctts, cslg, stss, stps, stsc, stsz, stz2, stco,
 *   co64; bytes after each table's declared entries are zeroed.
 * - Sample entries: the visual vendor/quality fields and compressor name and
 *   the audio revision/vendor fields are zeroed; their extension boxes are
 *   allow-listed (codec configuration only). A malformed extension area fails.
 * - Fixed-size boxes (mvhd, tkhd, mdhd, vmhd, smhd, elst) must have their
 *   exact size; creation/modification times and reserved fields are zeroed;
 *   hdlr manufacturer and name are zeroed; self-contained dref entries are
 *   emptied.
 * - Tracks whose handler is not `vide` or `soun` (timed metadata such as
 *   Apple mebx, GoPro GPMF, camm, subtitles, timecode) are neutralised and
 *   their samples zeroed. If a kept track references one (tref), the file is
 *   unsupported.
 * - mdat: every byte not inside a kept track's sample is zeroed.
 *
 * Unsupported (never shareable): fragmented files (moof/mvex), compressed
 * movie headers (cmov), external data references, PCM or QuickTime v1/v2
 * constant-size audio (sample sizes are not byte sizes there), and HEIF.
 * Resource caps (boxes per container, tracks, chunks, sample bytes) fail
 * the file before any large loop or allocation.
 * Not inspected: metadata a codec carries inside its own bitstream (for
 * example H.264/HEVC SEI user data). Phone cameras do not write location
 * there; some dashcams and drones do.
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

type Box = {
  type: string;
  start: number;
  /** size + type (+ largesize); the uuid usertype counts as payload here. */
  headerSize: number;
  end: number;
};

const MAX_DEPTH = 16;
const MAX_BOXES_PER_CONTAINER = 4096;
const MAX_TRACKS = 32;
/** All chunks of all kept tracks. A 100 MiB phone video has a few thousand. */
const MAX_CHUNKS = 500_000;
const MAX_FTYP_BRANDS = 32;

const KEPT_HANDLERS = new Set(['vide', 'soun']);
const PCM_SAMPLE_ENTRIES = new Set([
  'raw ', 'twos', 'sowt', 'in24', 'in32', 'fl32', 'fl64', 'lpcm', 'ulaw', 'alaw', 'ima4', 'NONE',
]);
const FRAGMENT_TOP_LEVEL = new Set(['moof', 'mfra', 'sidx', 'ssix', 'styp', 'emsg', 'prft']);
const FREE_TYPES = new Set(['free', 'skip']);

/** Children a kept container may hold; anything else is neutralised. */
const KEPT_CHILDREN: Record<string, ReadonlySet<string>> = {
  moov: new Set(['mvhd', 'trak']),
  trak: new Set(['tkhd', 'tref', 'edts', 'mdia']),
  mdia: new Set(['mdhd', 'hdlr', 'minf']),
  minf: new Set(['vmhd', 'smhd', 'dinf', 'stbl', 'hdlr']),
  dinf: new Set(['dref']),
  edts: new Set(['elst']),
  stbl: new Set(['stsd', 'stts', 'ctts', 'cslg', 'stss', 'stps', 'stsc', 'stsz', 'stz2', 'stco', 'co64']),
};

/** Codec configuration boxes a sample entry may carry. */
const VISUAL_EXTENSIONS = new Set([
  'avcC', 'hvcC', 'av1C', 'vpcC', 'dvcC', 'dvvC', 'dvwC', 'esds', 'd263', 'glbl',
  'colr', 'pasp', 'clap', 'btrt', 'fiel', 'gama', 'mdcv', 'clli', 'st3d',
]);
const AUDIO_EXTENSIONS = new Set([
  'esds', 'dOps', 'dfLa', 'alac', 'chan', 'chnl', 'btrt', 'damr', 'dac3', 'dec3', 'dac4', 'wave',
]);
const WAVE_CHILDREN = new Set(['frma', 'mp4a', 'esds', 'enda', 'chan', 'alac', '\0\0\0\0']);
/** Four-byte vendor codes at the start of these boxes' payloads. */
const VENDOR_FIELD_BOXES = new Set(['d263', 'damr']);

const KNOWN_BRANDS = new Set([
  'isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso7', 'iso8', 'iso9', 'mp41', 'mp42', 'mp71',
  'avc1', 'avc2', 'hvc1', 'hev1', 'av01', 'dby1', 'M4A ', 'M4B ', 'M4P ', 'M4V ', 'M4VH', 'M4VP', 'qt  ',
  '3gp4', '3gp5', '3gp6', '3gp7', '3gp8', '3gp9', '3g2a', '3g2b', '3g2c', '3ge6', '3ge7', '3gg6',
  'mmp4', 'msnv', 'MSNV', 'dash', 'cmfc', 'cmf2', 'XAVC', 'f4v ', 'kddi', 'caqv', 'CAEP',
]);

/** Exact payload sizes (after the box header) of fixed-layout boxes, by version 0 / 1. */
const FIXED_PAYLOAD: Record<string, [number, number]> = {
  mvhd: [100, 112],
  tkhd: [84, 96],
  mdhd: [24, 36],
  vmhd: [12, 12],
  smhd: [8, 8],
};

/** Payload ranges to zero (times, reserved and pre-defined fields), by version 0 / 1. */
const ZEROED_FIELDS: Record<string, [Array<[number, number]>, Array<[number, number]>]> = {
  mvhd: [[[4, 12], [26, 36], [72, 96]], [[4, 20], [38, 48], [84, 108]]],
  tkhd: [[[4, 12], [16, 20], [24, 32], [38, 40]], [[4, 20], [24, 28], [36, 44], [50, 52]]],
  mdhd: [[[4, 12], [22, 24]], [[4, 20], [34, 36]]],
  smhd: [[[6, 8]], [[6, 8]]],
};

const LOCATION_PATTERN = /[+-]\d{1,2}(\.\d{1,12})?[+-]\d{1,3}(\.\d{1,12})?([+-]\d{1,8}(\.\d{1,12})?)?(CRS[^/]{0,64})?\//;

function readBoxes(buf: Buffer, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  let pos = start;
  while (pos < end) {
    if (boxes.length >= MAX_BOXES_PER_CONTAINER) throw new ResourceLimitError('too many boxes in one container');
    if (end - pos < 8) {
      // QuickTime allows a 4-byte zero terminator at the end of some containers.
      if (end - pos === 4 && buf.readUInt32BE(pos) === 0) break;
      throw new EvidenceParseError('box header truncated');
    }
    let size = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    let headerSize = 8;
    if (size === 1) {
      if (end - pos < 16) throw new EvidenceParseError('largesize box truncated');
      const large = buf.readBigUInt64BE(pos + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw new EvidenceParseError('box too large');
      size = Number(large);
      headerSize = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < headerSize || pos + size > end) throw new EvidenceParseError('box size out of range');
    boxes.push({ type, start: pos, headerSize, end: pos + size });
    pos += size;
  }
  return boxes;
}

function payloadStart(box: Box): number {
  return box.start + box.headerSize;
}

function payloadLength(box: Box): number {
  return box.end - payloadStart(box);
}

function children(buf: Buffer, box: Box, offset = 0): Box[] {
  if (offset > payloadLength(box)) throw new EvidenceParseError(`${box.type} truncated`);
  return readBoxes(buf, payloadStart(box) + offset, box.end);
}

function child(buf: Buffer, box: Box, type: string, offset = 0): Box | undefined {
  return children(buf, box, offset).find(candidate => candidate.type === type);
}

function need(box: Box, offset: number, bytes: number): number {
  const at = payloadStart(box) + offset;
  if (bytes < 0 || at + bytes > box.end) throw new EvidenceParseError(`${box.type} truncated`);
  return at;
}

function isZero(buf: Buffer, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) if (buf[index] !== 0) return false;
  return true;
}

function fullBoxVersion(buf: Buffer, box: Box): number {
  return buf[need(box, 0, 4)];
}

/** Categories for a box being removed, from its type and the key names it holds. */
function categoriesOf(buf: Buffer, box: Box): RemovedCategory[] {
  const text = buf.toString('latin1', box.start, box.end);
  const found: RemovedCategory[] = ['container_metadata'];
  if (/\xa9xyz|loci|location|ISO6709|gpmd|camm/.test(text) || LOCATION_PATTERN.test(text)) found.push('gps_location');
  if (/\xa9mak|\xa9mod|\.make\b|\.model\b|manufacturer|smta/.test(text)) found.push('device_make_model');
  if (/serial/i.test(text)) found.push('device_serial');
  if (/\xa9day|creationdate/i.test(text)) found.push('capture_timestamps');
  if (/\xa9swr|\xa9too|\.software\b/i.test(text)) found.push('software');
  if (box.type === 'XMP_' || /x:xmpmeta|ns\.adobe\.com\/xap/.test(text)) found.push('xmp');
  return found;
}

/**
 * One walker for both directions. In `strip` mode it rewrites the buffer and
 * records what went; in `check` mode (validation of a derivative) anything
 * that would still need rewriting is a validation failure.
 */
class Pass {
  readonly removed = new Set<RemovedCategory>();

  constructor(readonly buf: Buffer, readonly mode: 'strip' | 'check') {}

  fail(what: string): never {
    throw new DerivativeValidationError(`movie derivative still holds ${what}`);
  }

  /** Zeroes [start, end); `category` is recorded only if bytes were non-zero. */
  zero(start: number, end: number, category: RemovedCategory, what: string): void {
    if (start >= end || isZero(this.buf, start, end)) return;
    if (this.mode === 'check') this.fail(what);
    this.buf.fill(0, start, end);
    this.removed.add(category);
  }

  /** Renames a box to `free` and zeroes everything after its size/type fields. */
  neutralise(box: Box, categories?: RemovedCategory[]): void {
    if (this.mode === 'check') this.fail(`box ${JSON.stringify(box.type)}`);
    for (const category of categories ?? categoriesOf(this.buf, box)) this.removed.add(category);
    this.buf.write('free', box.start + 4, 'latin1');
    this.buf.fill(0, box.start + (box.headerSize === 16 ? 16 : 8), box.end);
  }
}

function handlerType(buf: Buffer, trak: Box): string {
  const mdia = child(buf, trak, 'mdia');
  const hdlr = mdia && child(buf, mdia, 'hdlr');
  if (!hdlr) throw new EvidenceParseError('track has no handler');
  return buf.toString('latin1', need(hdlr, 8, 4), need(hdlr, 8, 4) + 4);
}

function trackId(buf: Buffer, tkhd: Box): number {
  return buf.readUInt32BE(need(tkhd, fullBoxVersion(buf, tkhd) === 1 ? 20 : 12, 4));
}

type TrackTables = { stbl: Box; stsd: Box; handler: string };

function trackTables(buf: Buffer, trak: Box): TrackTables {
  const mdia = child(buf, trak, 'mdia');
  const minf = mdia && child(buf, mdia, 'minf');
  const stbl = minf && child(buf, minf, 'stbl');
  const stsd = stbl && child(buf, stbl, 'stsd');
  if (!stbl || !stsd) throw new EvidenceParseError('track has no sample table');
  return { stbl, stsd, handler: handlerType(buf, trak) };
}

function sampleEntries(buf: Buffer, stsd: Box): Box[] {
  return children(buf, stsd, 8); // full box header (4) + entry_count (4)
}

/** Chunk byte ranges as flat arrays (start/end pairs), never one object per chunk. */
type Ranges = { starts: number[]; ends: number[] };

function chunkCount(buf: Buffer, stbl: Box): number {
  const boxes = children(buf, stbl);
  const offsetBox = boxes.find(box => box.type === 'stco') ?? boxes.find(box => box.type === 'co64');
  if (!offsetBox) throw new EvidenceParseError('sample table incomplete');
  return buf.readUInt32BE(need(offsetBox, 4, 4));
}

/**
 * Byte ranges of every chunk of samples, from stco/co64, stsc and stsz/stz2.
 * Every loop is bounded by a table that is physically present, and constant
 * sample sizes are multiplied, never iterated; the total sample bytes may not
 * exceed the media data.
 */
function chunkRanges(buf: Buffer, stbl: Box, mediaBytes: number): Ranges {
  const boxes = children(buf, stbl);
  const offsetBox = boxes.find(box => box.type === 'stco') ?? boxes.find(box => box.type === 'co64');
  const stsc = boxes.find(box => box.type === 'stsc');
  const stsz = boxes.find(box => box.type === 'stsz');
  const stz2 = boxes.find(box => box.type === 'stz2');
  if (!offsetBox || !stsc || (!stsz && !stz2)) throw new EvidenceParseError('sample table incomplete');

  const offsetWidth = offsetBox.type === 'stco' ? 4 : 8;
  const chunks = buf.readUInt32BE(need(offsetBox, 4, 4));
  if (chunks > MAX_CHUNKS) throw new ResourceLimitError('too many chunks');
  const offsetsAt = need(offsetBox, 8, chunks * offsetWidth);
  const chunkOffset = (index: number): number => (offsetWidth === 4
    ? buf.readUInt32BE(offsetsAt + index * 4)
    : Number(buf.readBigUInt64BE(offsetsAt + index * 8)));

  let sampleCount: number;
  let constant = 0;
  let sampleSize: (index: number) => number = () => 0;
  if (stsz) {
    constant = buf.readUInt32BE(need(stsz, 4, 4));
    sampleCount = buf.readUInt32BE(need(stsz, 8, 4));
    if (constant !== 0) {
      if (sampleCount * constant > mediaBytes) throw new EvidenceParseError('samples exceed the media data');
    } else {
      const sizesAt = need(stsz, 12, sampleCount * 4);
      sampleSize = index => buf.readUInt32BE(sizesAt + index * 4);
    }
  } else {
    const fieldSize = buf[need(stz2!, 7, 1)];
    sampleCount = buf.readUInt32BE(need(stz2!, 8, 4));
    if (![4, 8, 16].includes(fieldSize)) throw new EvidenceParseError('compact sample sizes invalid');
    const sizesAt = need(stz2!, 12, Math.ceil((sampleCount * fieldSize) / 8));
    sampleSize = index => {
      if (fieldSize === 16) return buf.readUInt16BE(sizesAt + index * 2);
      if (fieldSize === 8) return buf[sizesAt + index];
      const byte = buf[sizesAt + (index >> 1)];
      return index % 2 === 0 ? byte >> 4 : byte & 0x0f;
    };
  }

  const runCount = buf.readUInt32BE(need(stsc, 4, 4));
  const runsAt = need(stsc, 8, runCount * 12);
  const ranges: Ranges = { starts: [], ends: [] };
  let sample = 0;
  let run = -1;
  let perChunk = 0;
  let total = 0;
  for (let chunk = 1; chunk <= chunks; chunk += 1) {
    while (run + 1 < runCount && buf.readUInt32BE(runsAt + (run + 1) * 12) <= chunk) {
      run += 1;
      perChunk = buf.readUInt32BE(runsAt + run * 12 + 4);
    }
    if (perChunk > sampleCount - sample) throw new EvidenceParseError('sample tables disagree');
    let length = 0;
    if (constant !== 0) {
      length = perChunk * constant;
    } else {
      for (let index = 0; index < perChunk; index += 1) length += sampleSize(sample + index);
    }
    sample += perChunk;
    total += length;
    if (total > mediaBytes) throw new EvidenceParseError('samples exceed the media data');
    if (length > 0) {
      ranges.starts.push(chunkOffset(chunk - 1));
      ranges.ends.push(chunkOffset(chunk - 1) + length);
    }
  }
  if (sample !== sampleCount) throw new EvidenceParseError('sample tables disagree');
  return ranges;
}

type Layout = {
  moov: Box;
  mdats: Box[];
  mediaBytes: number;
  top: Box[];
  keptTracks: Box[];
  removedTracks: Box[];
};

function layout(buf: Buffer): Layout {
  const top = readBoxes(buf, 0, buf.length);
  if (top.some(box => FRAGMENT_TOP_LEVEL.has(box.type))) throw new UnsupportedVariantError('fragmented movie');
  const moovs = top.filter(box => box.type === 'moov');
  if (moovs.length !== 1) throw new EvidenceParseError('movie needs exactly one moov');
  const moov = moovs[0];
  const moovChildren = children(buf, moov);
  if (moovChildren.some(box => box.type === 'mvex')) throw new UnsupportedVariantError('fragmented movie');
  if (moovChildren.some(box => box.type === 'cmov')) throw new UnsupportedVariantError('compressed movie header');
  const tracks = moovChildren.filter(box => box.type === 'trak');
  if (tracks.length > MAX_TRACKS) throw new ResourceLimitError('too many tracks');
  const kept = new Set(tracks.filter(trak => KEPT_HANDLERS.has(handlerType(buf, trak))));
  if (kept.size === 0) throw new UnsupportedVariantError('no audio or video track');
  const mdats = top.filter(box => box.type === 'mdat');
  const plan: Layout = {
    moov,
    mdats,
    mediaBytes: mdats.reduce((sum, mdat) => sum + payloadLength(mdat), 0),
    top,
    keptTracks: [...kept],
    removedTracks: tracks.filter(trak => !kept.has(trak)),
  };
  let chunks = 0;
  for (const trak of plan.keptTracks) chunks += chunkCount(buf, trackTables(buf, trak).stbl);
  if (chunks > MAX_CHUNKS) throw new ResourceLimitError('too many chunks');
  return plan;
}

/** Sample ranges of the kept tracks, checked to sit inside an mdat and not overlap; sorted by start. */
function keptSampleRanges(buf: Buffer, plan: Layout): Ranges {
  const starts: number[] = [];
  const ends: number[] = [];
  for (const trak of plan.keptTracks) {
    const ranges = chunkRanges(buf, trackTables(buf, trak).stbl, plan.mediaBytes);
    for (let index = 0; index < ranges.starts.length; index += 1) {
      starts.push(ranges.starts[index]);
      ends.push(ranges.ends[index]);
    }
  }
  const order = Uint32Array.from(starts.keys()).sort((a, b) => starts[a] - starts[b]);
  const sorted: Ranges = { starts: [], ends: [] };
  for (let rank = 0; rank < order.length; rank += 1) {
    const start = starts[order[rank]];
    const end = ends[order[rank]];
    if (!plan.mdats.some(mdat => start >= payloadStart(mdat) && end <= mdat.end)) {
      throw new EvidenceParseError('sample data outside mdat');
    }
    if (rank > 0 && start < sorted.ends[rank - 1]) throw new EvidenceParseError('sample data overlaps');
    sorted.starts.push(start);
    sorted.ends.push(end);
  }
  return sorted;
}

function mediaDigest(buf: Buffer, plan: Layout): string {
  const hash = createHash('sha256');
  for (const trak of plan.keptTracks) {
    const tables = trackTables(buf, trak);
    const tkhd = child(buf, trak, 'tkhd')!;
    hash.update(`${tables.handler}:${buf.subarray(tkhd.end - 8, tkhd.end).toString('hex')}|`);
    const ranges = chunkRanges(buf, tables.stbl, plan.mediaBytes);
    for (let index = 0; index < ranges.starts.length; index += 1) {
      hash.update(`${ranges.starts[index]}-${ranges.ends[index]}|`);
      hash.update(buf.subarray(ranges.starts[index], ranges.ends[index]));
    }
  }
  return hash.digest('hex');
}

function unreferencedMedia(pass: Pass, plan: Layout, kept: Ranges): void {
  for (const mdat of plan.mdats) {
    let cursor = payloadStart(mdat);
    for (let index = 0; index < kept.starts.length; index += 1) {
      const start = kept.starts[index];
      const end = kept.ends[index];
      if (end <= cursor || start >= mdat.end) continue;
      if (start > cursor) pass.zero(cursor, start, 'unreferenced_media_data', 'unreferenced media data');
      cursor = Math.max(cursor, end);
    }
    if (cursor < mdat.end) pass.zero(cursor, mdat.end, 'unreferenced_media_data', 'unreferenced media data');
  }
}

/** Bytes a table declares, after the box header; anything after it is zeroed. */
function tableLength(buf: Buffer, box: Box): number {
  const count = () => buf.readUInt32BE(need(box, 4, 4));
  switch (box.type) {
    case 'stts':
    case 'ctts':
      return 8 + count() * 8;
    case 'stss':
    case 'stps':
    case 'stco':
      return 8 + count() * 4;
    case 'stsc':
      return 8 + count() * 12;
    case 'co64':
      return 8 + count() * 8;
    case 'stsz':
      return 12 + (buf.readUInt32BE(need(box, 4, 4)) === 0 ? buf.readUInt32BE(need(box, 8, 4)) * 4 : 0);
    case 'stz2':
      return 12 + Math.ceil((buf.readUInt32BE(need(box, 8, 4)) * buf[need(box, 7, 1)]) / 8);
    case 'cslg':
      return fullBoxVersion(buf, box) === 1 ? 44 : 24;
    default:
      return payloadLength(box);
  }
}

function walkFixed(pass: Pass, box: Box): void {
  const version = fullBoxVersion(pass.buf, box);
  const sizes = FIXED_PAYLOAD[box.type];
  if (version > 1 || payloadLength(box) !== sizes[version]) throw new EvidenceParseError(`${box.type} has an unexpected size`);
  // The first zeroed range of mvhd, tkhd and mdhd is creation and modification time.
  (ZEROED_FIELDS[box.type]?.[version] ?? []).forEach(([from, to], index) => {
    const category = index === 0 && box.type !== 'smhd' ? 'capture_timestamps' : 'container_metadata';
    pass.zero(payloadStart(box) + from, payloadStart(box) + to, category, `${box.type} fields`);
  });
}

function walkHdlr(pass: Pass, hdlr: Box): void {
  need(hdlr, 0, 12);
  // Keep version/flags, pre_defined and handler_type; zero manufacturer, flags, mask and name.
  pass.zero(payloadStart(hdlr) + 12, hdlr.end, 'container_metadata', 'handler manufacturer or name');
}

function walkDref(pass: Pass, dref: Box): void {
  for (const entry of children(pass.buf, dref, 8)) {
    const flags = pass.buf.readUInt32BE(need(entry, 0, 4)) & 0xffffff;
    if ((flags & 1) !== 1) throw new UnsupportedVariantError('track media is in an external file');
    // Self-contained: nothing after the full box header is needed.
    pass.zero(payloadStart(entry) + 4, entry.end, 'container_metadata', 'data reference payload');
  }
}

function walkElst(pass: Pass, elst: Box): void {
  const entrySize = fullBoxVersion(pass.buf, elst) === 1 ? 20 : 12;
  if (payloadLength(elst) !== 8 + pass.buf.readUInt32BE(need(elst, 4, 4)) * entrySize) {
    throw new EvidenceParseError('elst has an unexpected size');
  }
}

function walkExtensions(pass: Pass, entry: Box, from: number, allowed: ReadonlySet<string>, depth: number): void {
  if (from > entry.end) throw new EvidenceParseError('sample entry truncated');
  // Malformed extension areas fail: nothing here is skipped unread.
  for (const extension of readBoxes(pass.buf, from, entry.end)) {
    if (FREE_TYPES.has(extension.type)) {
      pass.zero(payloadStart(extension), extension.end, 'free_space', 'free space in a sample entry');
      continue;
    }
    if (!allowed.has(extension.type)) {
      pass.neutralise(extension);
      continue;
    }
    if (VENDOR_FIELD_BOXES.has(extension.type)) {
      pass.zero(payloadStart(extension), Math.min(payloadStart(extension) + 4, extension.end), 'container_metadata', 'codec vendor');
    }
    if (extension.type === 'wave') {
      if (depth > 2) throw new EvidenceParseError('sample entry nested too deeply');
      walkExtensions(pass, extension, payloadStart(extension), WAVE_CHILDREN, depth + 1);
    }
  }
}

function walkSampleEntries(pass: Pass, tables: TrackTables): void {
  const { buf } = pass;
  const stsdCount = buf.readUInt32BE(need(tables.stsd, 4, 4));
  const entries = sampleEntries(buf, tables.stsd);
  if (entries.length !== stsdCount) throw new EvidenceParseError('sample description count disagrees');
  for (const entry of entries) {
    if (tables.handler === 'vide') {
      // VisualSampleEntry: version/revision/vendor/qualities at 16-32, compressorname at 50-82.
      if (entry.end - entry.start < 86) throw new EvidenceParseError('visual sample entry truncated');
      pass.zero(entry.start + 16, entry.start + 32, 'container_metadata', 'visual entry vendor fields');
      pass.zero(entry.start + 50, entry.start + 82, 'container_metadata', 'compressor name');
      walkExtensions(pass, entry, entry.start + 86, VISUAL_EXTENSIONS, 0);
    } else {
      // AudioSampleEntry (QuickTime sound description): version at 16; revision and vendor at 18-24.
      if (entry.end - entry.start < 36) throw new EvidenceParseError('audio sample entry truncated');
      const version = buf.readUInt16BE(entry.start + 16);
      const extensionsAt = version === 0 ? 36 : version === 1 ? 52 : version === 2 ? 72 : -1;
      if (extensionsAt < 0) throw new UnsupportedVariantError('unknown sound description version');
      pass.zero(entry.start + 18, entry.start + 24, 'container_metadata', 'audio entry vendor fields');
      walkExtensions(pass, entry, entry.start + extensionsAt, AUDIO_EXTENSIONS, 0);
    }
  }
}

/** Walks a kept container, keeping allow-listed children and neutralising the rest. */
function walkContainer(pass: Pass, box: Box, depth: number): void {
  if (depth > MAX_DEPTH) throw new EvidenceParseError('boxes nested too deeply');
  const allowed = KEPT_CHILDREN[box.type];
  for (const item of children(pass.buf, box)) {
    if (FREE_TYPES.has(item.type)) {
      pass.zero(payloadStart(item), item.end, 'free_space', 'free space with data');
      continue;
    }
    if (!allowed.has(item.type)) {
      pass.neutralise(item);
      continue;
    }
    if (FIXED_PAYLOAD[item.type]) walkFixed(pass, item);
    else if (item.type === 'hdlr') walkHdlr(pass, item);
    else if (item.type === 'dref') walkDref(pass, item);
    else if (item.type === 'elst') walkElst(pass, item);
    else if (KEPT_CHILDREN[item.type]) walkContainer(pass, item, depth + 1);
    else if (box.type === 'stbl' && item.type !== 'stsd') {
      const declared = tableLength(pass.buf, item);
      if (declared > payloadLength(item)) throw new EvidenceParseError(`${item.type} truncated`);
      pass.zero(payloadStart(item) + declared, item.end, 'vendor_metadata', `bytes after ${item.type}`);
    }
  }
}

/** Keeps only the first ftyp: minor version zeroed, unknown brands replaced by the major brand. */
function walkFtyp(pass: Pass, ftyp: Box): void {
  const { buf } = pass;
  const length = payloadLength(ftyp);
  if (length < 8 || length % 4 !== 0 || length > 8 + MAX_FTYP_BRANDS * 4) throw new EvidenceParseError('ftyp has an unexpected size');
  const major = buf.toString('latin1', payloadStart(ftyp), payloadStart(ftyp) + 4);
  if (!/^[\x20-\x7e]{4}$/.test(major)) throw new EvidenceParseError('ftyp major brand is not a brand code');
  pass.zero(payloadStart(ftyp) + 4, payloadStart(ftyp) + 8, 'container_metadata', 'ftyp minor version');
  for (let at = payloadStart(ftyp) + 8; at < ftyp.end; at += 4) {
    const brand = buf.toString('latin1', at, at + 4);
    if (brand === major || KNOWN_BRANDS.has(brand)) continue;
    if (pass.mode === 'check') pass.fail('an unknown ftyp brand');
    buf.write(major, at, 'latin1');
    pass.removed.add('container_metadata');
  }
}

function walkTopLevel(pass: Pass, plan: Layout): void {
  let ftypSeen = false;
  for (const box of plan.top) {
    if (box.type === 'mdat') continue;
    if (box.type === 'ftyp' && !ftypSeen) {
      ftypSeen = true;
      walkFtyp(pass, box);
      continue;
    }
    if (box.type === 'moov') {
      for (const trak of plan.removedTracks) {
        if (pass.mode === 'check') pass.fail('a non-audio/video track');
        const categories = categoriesOf(pass.buf, trak).filter(category => category !== 'container_metadata');
        categories.push(handlerType(pass.buf, trak) === 'meta' ? 'timed_metadata_tracks' : 'vendor_metadata');
        pass.neutralise(trak, categories);
      }
      walkContainer(pass, box, 0);
      for (const trak of plan.keptTracks) walkSampleEntries(pass, trackTables(pass.buf, trak));
      continue;
    }
    if (FREE_TYPES.has(box.type) || box.type === 'wide') {
      pass.zero(payloadStart(box), box.end, 'free_space', 'top-level free space with data');
      continue;
    }
    pass.neutralise(box);
  }
}

function assertTrackReferences(buf: Buffer, plan: Layout): void {
  const keptIds = new Set<number>();
  for (const trak of plan.keptTracks) {
    const tkhd = child(buf, trak, 'tkhd');
    if (!tkhd) throw new EvidenceParseError('track has no header');
    keptIds.add(trackId(buf, tkhd));
  }
  for (const trak of plan.keptTracks) {
    const tref = child(buf, trak, 'tref');
    if (!tref) continue;
    for (const reference of children(buf, tref)) {
      if (payloadLength(reference) % 4 !== 0) throw new EvidenceParseError('track reference has an unexpected size');
      for (let at = payloadStart(reference); at < reference.end; at += 4) {
        if (!keptIds.has(buf.readUInt32BE(at))) throw new UnsupportedVariantError('kept track references a removed or missing track');
      }
    }
  }
}

function assertByteSizedSamples(buf: Buffer, tables: TrackTables): void {
  if (tables.handler !== 'soun') return;
  const stsz = child(buf, tables.stbl, 'stsz');
  const constant = stsz ? buf.readUInt32BE(need(stsz, 4, 4)) : 0;
  for (const entry of sampleEntries(buf, tables.stsd)) {
    if (PCM_SAMPLE_ENTRIES.has(entry.type)) throw new UnsupportedVariantError('PCM audio in a movie container');
    const version = entry.end - entry.start >= 18 ? buf.readUInt16BE(entry.start + 16) : 0;
    if (constant !== 0 && version !== 0) throw new UnsupportedVariantError('QuickTime constant-size audio');
  }
}

export function isobmffMimeType(buf: Buffer, hasVideo: boolean): string {
  const major = buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp' ? buf.toString('latin1', 8, 12) : 'qt  ';
  if (major === 'qt  ') return 'video/quicktime';
  if (major.startsWith('3g')) return hasVideo ? 'video/3gpp' : 'audio/3gpp';
  return hasVideo ? 'video/mp4' : 'audio/mp4';
}

export function stripIsobmff(input: Buffer): { output: Buffer; removed: RemovedCategory[]; mimeType: string } {
  const plan = layout(input);
  for (const trak of plan.keptTracks) {
    const tables = trackTables(input, trak);
    assertByteSizedSamples(input, tables);
  }
  assertTrackReferences(input, plan);
  const kept = keptSampleRanges(input, plan);

  const pass = new Pass(Buffer.from(input), 'strip');
  walkTopLevel(pass, plan);
  unreferencedMedia(pass, plan, kept);
  const hasVideo = plan.keptTracks.some(trak => handlerType(input, trak) === 'vide');
  return { output: pass.buf, removed: sortedCategories(pass.removed), mimeType: isobmffMimeType(input, hasVideo) };
}

/**
 * Re-parses the derivative and runs the same walk in check mode: anything the
 * strip would still change is a failure. Then: no location or device strings
 * left in the movie header, the same size, and identical kept samples.
 */
export function validateIsobmffDerivative(original: Buffer, derivative: Buffer): void {
  if (original.length !== derivative.length) throw new DerivativeValidationError('movie derivative changed size');
  let plan: Layout;
  try {
    plan = layout(derivative);
    assertTrackReferences(derivative, plan);
    const pass = new Pass(derivative, 'check');
    walkTopLevel(pass, plan);
    unreferencedMedia(pass, plan, keptSampleRanges(derivative, plan));
    const header = derivative.toString('latin1', plan.moov.start, plan.moov.end);
    if (/\xa9xyz|loci|ISO6709|\xa9mak|\xa9mod|XMP_/.test(header) || LOCATION_PATTERN.test(header)) {
      throw new DerivativeValidationError('movie derivative header still names location or device');
    }
  } catch (error) {
    if (error instanceof DerivativeValidationError || error instanceof ResourceLimitError) throw error;
    throw new DerivativeValidationError('movie derivative does not parse');
  }
  const source = layout(original);
  if (source.keptTracks.length !== plan.keptTracks.length || mediaDigest(original, source) !== mediaDigest(derivative, plan)) {
    throw new DerivativeValidationError('movie derivative media differs');
  }
}
