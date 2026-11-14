/**
 * MP3: the derivative is the original's MPEG audio frames and nothing else.
 *
 * Dropped: ID3v2 tags (leading, or appended with a 3DI footer), ID3v1 and
 * TAG+ at the end, APEv2, Lyrics3, any bytes between or after frames that
 * are not a valid frame, and the Xing/Info/VBRI header frame (a silent frame
 * that carries the encoder name and version, for example LAME). Without it
 * the audio decodes the same; players estimate VBR duration from the frames
 * and lose LAME's gapless padding hints. Free-format streams are unsupported.
 *
 * Not removed: an encoder may also pad unused bits inside ordinary audio
 * frames with its name (LAME writes "LAMEx.yy" there). Removing that needs
 * a bitstream parse of every frame; it names software, never a device.
 */
import { createHash } from 'node:crypto';

import {
  DerivativeValidationError,
  EvidenceParseError,
  type RemovedCategory,
  sortedCategories,
  UnsupportedVariantError,
} from './types.js';

const BITRATES_KBPS: Record<string, number[]> = {
  'v1-l1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  'v1-l2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  'v1-l3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  'v2-l1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  'v2-l2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  'v2-l3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG-1
  2: [22050, 24000, 16000], // MPEG-2
  0: [11025, 12000, 8000], // MPEG-2.5
};

/** Length of the MPEG audio frame at `pos`: 0 if there is none, -1 for a free-format header. */
export function mpegFrameLength(buf: Buffer, pos: number): number {
  if (pos + 4 > buf.length || buf[pos] !== 0xff || (buf[pos + 1] & 0xe0) !== 0xe0) return 0;
  const version = (buf[pos + 1] >> 3) & 0x03;
  const layerBits = (buf[pos + 1] >> 1) & 0x03;
  const bitrateIndex = buf[pos + 2] >> 4;
  const rateIndex = (buf[pos + 2] >> 2) & 0x03;
  const padding = (buf[pos + 2] >> 1) & 0x01;
  if (version === 1 || layerBits === 0 || bitrateIndex === 15 || rateIndex === 3) return 0;
  if (bitrateIndex === 0) return -1;
  const layer = 4 - layerBits;
  const table = `${version === 3 ? 'v1' : 'v2'}-l${layer}`;
  const bitrate = BITRATES_KBPS[table][bitrateIndex] * 1000;
  const sampleRate = SAMPLE_RATES[version][rateIndex];
  if (layer === 1) return (Math.floor((12 * bitrate) / sampleRate) + padding) * 4;
  if (layer === 3 && version !== 3) return Math.floor((72 * bitrate) / sampleRate) + padding;
  return Math.floor((144 * bitrate) / sampleRate) + padding;
}

function id3v2Length(buf: Buffer, pos: number): number {
  if (pos + 10 > buf.length || buf[pos] !== 0x49 || buf[pos + 1] !== 0x44 || buf[pos + 2] !== 0x33) return 0;
  const size = ((buf[pos + 6] & 0x7f) << 21) | ((buf[pos + 7] & 0x7f) << 14) | ((buf[pos + 8] & 0x7f) << 7) | (buf[pos + 9] & 0x7f);
  const footer = buf[pos + 5] & 0x10 ? 10 : 0;
  return 10 + size + footer;
}

/** A frame start is trusted only if the next frame (or the end of the stream) follows it. */
function frameAt(buf: Buffer, pos: number): number {
  const length = mpegFrameLength(buf, pos);
  if (length <= 0 || pos + length > buf.length) return 0;
  const next = pos + length;
  if (next === buf.length || mpegFrameLength(buf, next) > 0) return length;
  // Tags may follow the last frame.
  const tail = buf.toString('latin1', next, Math.min(buf.length, next + 8));
  return /^(TAG|ID3|APETAGEX|LYRICSBE|3DI)/.test(tail) ? length : 0;
}

function skippedCategories(bytes: Buffer): RemovedCategory[] {
  const text = bytes.toString('latin1');
  const found: RemovedCategory[] = [];
  if (/ID3|3DI|TAG/.test(text)) found.push('id3_tags');
  if (text.includes('APETAGEX')) found.push('ape_tags');
  if (/LYRICS(BEGIN|200|END)/.test(text)) found.push('text_metadata');
  if (found.length === 0) found.push('trailing_data');
  return found;
}

/** Frame byte ranges as flat arrays; never one object per frame. */
type Frames = {
  starts: number[];
  ends: number[];
  /** Categories of everything dropped (tags, junk), named while parsing. */
  dropped: Set<RemovedCategory>;
  freeFormat: boolean;
  headerFrame: boolean;
};

/** True if the frame at `pos` is a Xing/Info or VBRI header frame rather than audio. */
function isHeaderFrame(buf: Buffer, pos: number, end: number): boolean {
  const version = (buf[pos + 1] >> 3) & 0x03;
  const mono = buf[pos + 3] >> 6 === 3;
  const crc = (buf[pos + 1] & 0x01) === 0 ? 2 : 0;
  const sideInfo = version === 3 ? (mono ? 17 : 32) : (mono ? 9 : 17);
  const tagAt = pos + 4 + crc + sideInfo;
  const tag = tagAt + 4 <= end ? buf.toString('latin1', tagAt, tagAt + 4) : '';
  const vbri = pos + 40 <= end ? buf.toString('latin1', pos + 36, pos + 40) : '';
  return tag === 'Xing' || tag === 'Info' || vbri === 'VBRI';
}

function parseFrames(buf: Buffer): Frames {
  const frames: Frames = { starts: [], ends: [], dropped: new Set(), freeFormat: false, headerFrame: false };
  const drop = (start: number, end: number) => {
    for (const category of skippedCategories(buf.subarray(start, end))) frames.dropped.add(category);
  };
  let synced = false;
  let pos = 0;
  while (pos < buf.length) {
    const tag = id3v2Length(buf, pos);
    if (tag > 0) {
      const end = Math.min(buf.length, pos + tag);
      drop(pos, end);
      pos = end;
      synced = false;
      continue;
    }
    // Inside a run of frames a valid header that fits is enough; after a gap the next frame must confirm it.
    const header = mpegFrameLength(buf, pos);
    const length = synced ? (header > 0 && pos + header <= buf.length ? header : 0) : frameAt(buf, pos);
    if (length > 0) {
      if (frames.starts.length === 0 && !frames.headerFrame && isHeaderFrame(buf, pos, pos + length)) {
        frames.headerFrame = true;
        frames.dropped.add('software');
      } else {
        frames.starts.push(pos);
        frames.ends.push(pos + length);
      }
      pos += length;
      synced = true;
      continue;
    }
    if (frames.starts.length === 0 && header === -1) frames.freeFormat = true;
    synced = false;
    // Resynchronise on the next confirmed frame; everything in between is dropped.
    let next = pos + 1;
    while (next < buf.length && !(buf[next] === 0xff && frameAt(buf, next) > 0) && id3v2Length(buf, next) === 0) next += 1;
    drop(pos, next);
    pos = next;
  }
  return frames;
}

function framesDigest(buf: Buffer, frames: Frames): string {
  const hash = createHash('sha256');
  for (let index = 0; index < frames.starts.length; index += 1) hash.update(buf.subarray(frames.starts[index], frames.ends[index]));
  return hash.digest('hex');
}

export function stripMp3(input: Buffer): { output: Buffer; removed: RemovedCategory[] } {
  const frames = parseFrames(input);
  if (frames.starts.length === 0) {
    if (frames.freeFormat) throw new UnsupportedVariantError('free-format MP3');
    throw new EvidenceParseError('no MPEG audio frames');
  }
  let total = 0;
  for (let index = 0; index < frames.starts.length; index += 1) total += frames.ends[index] - frames.starts[index];
  const output = Buffer.allocUnsafe(total);
  let at = 0;
  for (let index = 0; index < frames.starts.length; index += 1) {
    at += input.copy(output, at, frames.starts[index], frames.ends[index]);
  }
  return { output, removed: sortedCategories(frames.dropped) };
}

/**
 * The derivative must be contiguous MPEG frames from byte 0 to the end, with
 * no Xing/Info/VBRI header frame, equal to the original's audio frames.
 */
export function validateMp3Derivative(original: Buffer, derivative: Buffer): void {
  let pos = 0;
  if (derivative.length === 0) throw new DerivativeValidationError('MP3 derivative is empty');
  while (pos < derivative.length) {
    const length = mpegFrameLength(derivative, pos);
    if (length <= 0 || pos + length > derivative.length) throw new DerivativeValidationError('MP3 derivative has non-frame data');
    if (pos === 0 && isHeaderFrame(derivative, pos, pos + length)) throw new DerivativeValidationError('MP3 derivative keeps an encoder header frame');
    pos += length;
  }
  if (framesDigest(original, parseFrames(original)) !== createHash('sha256').update(derivative).digest('hex')) {
    throw new DerivativeValidationError('MP3 derivative audio differs');
  }
}
