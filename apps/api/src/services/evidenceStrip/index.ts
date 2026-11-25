/**
 * Entry point of the evidence metadata-stripping pipeline (pure functions, no
 * I/O). The format comes from the bytes; the client's declared MIME type must
 * agree with it. Every stripped output is re-parsed by a format validator
 * before it is returned, and anything that cannot be stripped and proven
 * clean comes back `unsupported` or `failed`: never shareable.
 *
 * | Format            | Phase 1                                             |
 * |-------------------|-----------------------------------------------------|
 * | JPEG              | stripped (segment allow-list, orientation kept)     |
 * | PNG               | stripped (chunk allow-list)                         |
 * | MP4 / MOV / M4A / 3GP | stripped in place (box neutralisation)          |
 * | MP3               | stripped (frames only)                              |
 * | WAV               | stripped (fmt/fact/data only)                       |
 * | HEIC / HEIF / AVIF | unsupported                                        |
 * | PDF, GIF, WebP, other | unsupported                                     |
 */
import { stripIsobmff, validateIsobmffDerivative } from './isobmff.js';
import { stripJpeg, validateJpegDerivative } from './jpeg.js';
import { mpegFrameLength, stripMp3, validateMp3Derivative } from './mp3.js';
import { PNG_SIGNATURE, stripPng, validatePngDerivative } from './png.js';
import {
  DerivativeValidationError,
  EvidenceParseError,
  type RemovedCategory,
  ResourceLimitError,
  type SourceFormat,
  type StripMethod,
  type StripOutcome,
  UnsupportedVariantError,
} from './types.js';
import { stripWav, validateWavDerivative } from './wav.js';

export * from './types.js';

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1', 'mif2', 'avif', 'avis']);
const LEGACY_QUICKTIME_FIRST_BOX = new Set(['moov', 'mdat', 'wide', 'free', 'skip', 'pnot']);

/** Declared MIME type -> the container family it must be. */
const MIME_FAMILIES: Record<string, SourceFormat> = {
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/pjpeg': 'jpeg',
  'image/png': 'png',
  'video/mp4': 'isobmff',
  'video/quicktime': 'isobmff',
  'video/x-m4v': 'isobmff',
  'video/3gpp': 'isobmff',
  'audio/mp4': 'isobmff',
  'audio/m4a': 'isobmff',
  'audio/x-m4a': 'isobmff',
  'audio/3gpp': 'isobmff',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/vnd.wave': 'wav',
  'image/heic': 'heif',
  'image/heif': 'heif',
  'image/heic-sequence': 'heif',
  'image/heif-sequence': 'heif',
  'image/avif': 'heif',
  'application/pdf': 'pdf',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const UNSUPPORTED_FORMATS = new Set<SourceFormat>(['heif', 'pdf', 'gif', 'webp', 'unknown']);

export function sniffEvidenceFormat(buf: Buffer): SourceFormat {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  const head = buf.toString('latin1', 0, Math.min(buf.length, 16));
  if (/^GIF8[79]a/.test(head)) return 'gif';
  if (/^(RIFF|RF64|BW64)/.test(head) && head.slice(8, 12) === 'WAVE') return 'wav';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'webp';
  if (buf.subarray(0, 1024).includes('%PDF-')) return 'pdf';
  if (head.slice(4, 8) === 'ftyp') {
    return HEIF_BRANDS.has(head.slice(8, 12)) ? 'heif' : 'isobmff';
  }
  if (buf.length >= 8 && LEGACY_QUICKTIME_FIRST_BOX.has(head.slice(4, 8))) return 'isobmff';
  if (head.startsWith('ID3')) return 'mp3';
  const first = mpegFrameLength(buf, 0);
  if (first > 0 && mpegFrameLength(buf, first) > 0) return 'mp3';
  return 'unknown';
}

type Stripper = {
  method: StripMethod;
  strip: (input: Buffer) => { output: Buffer; removed: RemovedCategory[]; mimeType?: string };
  validate: (original: Buffer, derivative: Buffer) => void;
  mimeType: string;
};

const STRIPPERS: Partial<Record<SourceFormat, Stripper>> = {
  jpeg: { method: 'jpeg-segment-allowlist.v1', strip: stripJpeg, validate: validateJpegDerivative, mimeType: 'image/jpeg' },
  png: { method: 'png-chunk-allowlist.v1', strip: stripPng, validate: validatePngDerivative, mimeType: 'image/png' },
  isobmff: { method: 'isobmff-neutralize.v1', strip: stripIsobmff, validate: validateIsobmffDerivative, mimeType: 'video/mp4' },
  mp3: { method: 'mp3-frame-extract.v1', strip: stripMp3, validate: validateMp3Derivative, mimeType: 'audio/mpeg' },
  wav: { method: 'wav-chunk-allowlist.v1', strip: stripWav, validate: validateWavDerivative, mimeType: 'audio/wav' },
};

/**
 * Strips metadata from one evidence file and proves the result clean.
 * `declaredMimeType` is the attachment's recorded MIME type; only
 * `application/octet-stream` defers entirely to the bytes.
 */
export function stripEvidenceMetadata(input: Buffer, declaredMimeType: string | null): StripOutcome {
  const format = sniffEvidenceFormat(input);
  if (UNSUPPORTED_FORMATS.has(format)) return { outcome: 'unsupported', format, reason: 'unsupported_format' };

  const declared = (declaredMimeType ?? 'application/octet-stream').trim().toLowerCase();
  if (declared !== 'application/octet-stream' && MIME_FAMILIES[declared] !== format) {
    return { outcome: 'failed', format, reason: 'type_mismatch' };
  }

  const stripper = STRIPPERS[format];
  if (!stripper) return { outcome: 'unsupported', format, reason: 'unsupported_format' };

  let stripped: ReturnType<Stripper['strip']>;
  try {
    stripped = stripper.strip(input);
  } catch (error) {
    if (error instanceof ResourceLimitError) return { outcome: 'failed', format, reason: 'resource_limit' };
    if (error instanceof UnsupportedVariantError) return { outcome: 'unsupported', format, reason: 'unsupported_variant' };
    if (error instanceof EvidenceParseError || error instanceof RangeError) return { outcome: 'failed', format, reason: 'parse_error' };
    throw error;
  }

  try {
    stripper.validate(input, stripped.output);
  } catch (error) {
    if (error instanceof ResourceLimitError) return { outcome: 'failed', format, reason: 'resource_limit' };
    if (
      error instanceof DerivativeValidationError || error instanceof EvidenceParseError ||
      error instanceof UnsupportedVariantError || error instanceof RangeError
    ) {
      return { outcome: 'failed', format, reason: 'validation_failed' };
    }
    throw error;
  }

  return {
    outcome: 'stripped',
    format,
    method: stripper.method,
    mimeType: stripped.mimeType ?? stripper.mimeType,
    output: stripped.output,
    removed: stripped.removed,
  };
}
