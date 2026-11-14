/**
 * JPEG: keep only what a decoder needs, copied byte for byte, so the pixels
 * of the derivative are exactly the original's (no re-encode).
 *
 * Kept: SOI, a rebuilt JFIF APP0 without thumbnail, an exact Adobe APP14
 * (needed for CMYK/YCCK colour transforms), DQT, DHT, DAC, SOFn, DRI, SOS
 * with its entropy-coded data, DNL, DHP, EXP, EOI.
 * Dropped: APP1 EXIF/XMP, APP2 ICC/MPF/FlashPix, APP13 Photoshop/IPTC, every
 * other APPn, COM, and anything after EOI (MPF secondary images, phone
 * trailers, appended video).
 *
 * Orientation decision: the original's EXIF Orientation (2-8) is kept as a
 * freshly built EXIF block holding that one tag and nothing else. Applying
 * the rotation instead would mean decoding and re-encoding the evidence,
 * which changes its pixels and needs a codec; keeping the tag preserves the
 * pixels exactly and every mainstream viewer honours it.
 */
import { createHash } from 'node:crypto';

import {
  buildOrientationOnlyExif,
  EXIF_HEADER,
  inspectTiff,
  inspectXmp,
  readCanonicalOrientationExif,
} from './exif.js';
import {
  DerivativeValidationError,
  EvidenceParseError,
  type RemovedCategory,
  ResourceLimitError,
  sortedCategories,
} from './types.js';

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const APP0 = 0xe0;
const APP1 = 0xe1;
const APP2 = 0xe2;
const APP13 = 0xed;
const APP14 = 0xee;
const COM = 0xfe;

/** Segments that carry image coding data; copied verbatim and compared in validation. */
const CODING_MARKERS = new Set([
  0xdb, // DQT
  0xc4, // DHT
  0xcc, // DAC
  0xdd, // DRI
  0xdc, // DNL
  0xde, // DHP
  0xdf, // EXP
  SOS,
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf, // SOFn
]);
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** Real JPEGs have tens of segments; a flood of tiny ones is refused before it costs memory. */
const MAX_SEGMENTS = 10_000;

const XMP_ID = 'http://ns.adobe.com/xap/1.0/\0';
const XMP_EXTENSION_ID = 'http://ns.adobe.com/xmp/extension/\0';
const JFIF_ID = 'JFIF\0';
const ADOBE_ID = 'Adobe';

type Segment = {
  marker: number;
  /** Offset of the 0xFF that starts the marker. */
  start: number;
  /** Exclusive end; for SOS this includes the entropy-coded data. */
  end: number;
  /** Payload after the 2-byte length field (marker segments only). */
  payload: Buffer;
};

type ParsedJpeg = { segments: Segment[]; trailing: Buffer };

function payloadStartsWith(payload: Buffer, id: string): boolean {
  return payload.length >= id.length && payload.toString('latin1', 0, id.length) === id;
}

/** Walks the marker structure. Throws EvidenceParseError for anything not well formed. */
function parseJpeg(buf: Buffer): ParsedJpeg {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== SOI) throw new EvidenceParseError('JPEG does not start with SOI');
  const segments: Segment[] = [{ marker: SOI, start: 0, end: 2, payload: Buffer.alloc(0) }];
  let pos = 2;
  for (;;) {
    if (segments.length >= MAX_SEGMENTS) throw new ResourceLimitError('too many JPEG segments');
    if (pos >= buf.length || buf[pos] !== 0xff) throw new EvidenceParseError('JPEG marker expected');
    // Fill bytes (0xFF) may precede a marker.
    let markerAt = pos;
    while (markerAt + 1 < buf.length && buf[markerAt + 1] === 0xff) markerAt += 1;
    if (markerAt + 1 >= buf.length) throw new EvidenceParseError('JPEG truncated at marker');
    const marker = buf[markerAt + 1];
    if (marker === EOI) {
      segments.push({ marker, start: markerAt, end: markerAt + 2, payload: Buffer.alloc(0) });
      return { segments, trailing: buf.subarray(markerAt + 2) };
    }
    if (marker === SOI || marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
      throw new EvidenceParseError('JPEG has a misplaced standalone marker');
    }
    if (markerAt + 4 > buf.length) throw new EvidenceParseError('JPEG truncated at segment length');
    const length = buf.readUInt16BE(markerAt + 2);
    const segmentEnd = markerAt + 2 + length;
    if (length < 2 || segmentEnd > buf.length) throw new EvidenceParseError('JPEG segment length out of range');
    const payload = buf.subarray(markerAt + 4, segmentEnd);
    if (marker !== SOS) {
      segments.push({ marker, start: markerAt, end: segmentEnd, payload });
      pos = segmentEnd;
      continue;
    }
    // Entropy-coded data runs to the next marker that is not a stuffed 0x00 or RSTn.
    let scan = segmentEnd;
    for (;;) {
      if (scan + 1 >= buf.length) throw new EvidenceParseError('JPEG truncated in scan data');
      if (buf[scan] !== 0xff) {
        scan += 1;
        continue;
      }
      const next = buf[scan + 1];
      if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
        scan += 2;
        continue;
      }
      if (next === 0xff) {
        scan += 1;
        continue;
      }
      break;
    }
    segments.push({ marker, start: markerAt, end: scan, payload });
    pos = scan;
  }
}

/** Categories a non-coding segment represents. Used by stripping and, independently, by validation. */
function segmentCategories(segment: Segment): RemovedCategory[] {
  const { marker, payload } = segment;
  if (marker === COM) return ['comments'];
  if (marker === APP1) {
    if (payload.subarray(0, 6).equals(EXIF_HEADER)) return [...inspectTiff(payload.subarray(6)).categories];
    if (payloadStartsWith(payload, XMP_ID) || payloadStartsWith(payload, XMP_EXTENSION_ID)) return inspectXmp(payload.toString('latin1'));
    return ['vendor_metadata'];
  }
  if (marker === APP2) {
    if (payloadStartsWith(payload, 'ICC_PROFILE\0')) return ['icc_profile'];
    if (payloadStartsWith(payload, 'MPF\0')) return ['secondary_images'];
    return ['vendor_metadata'];
  }
  if (marker === APP13) return payloadStartsWith(payload, 'Photoshop 3.0\0') ? ['iptc'] : ['vendor_metadata'];
  if (marker === APP0) {
    if (payloadStartsWith(payload, JFIF_ID)) return payload.length > 14 ? ['thumbnails'] : [];
    if (payloadStartsWith(payload, 'JFXX\0')) return ['thumbnails'];
    return ['vendor_metadata'];
  }
  if (marker >= 0xe0 && marker <= 0xef) return ['vendor_metadata'];
  return ['vendor_metadata'];
}

/**
 * A kept coding segment must be exactly the structure it declares: no
 * trailing bytes in DQT, DHT, SOFn, SOS, DRI and the rest, where extra data
 * could otherwise ride along into the derivative.
 */
function assertCodingStructure(segment: Segment): void {
  const { marker, payload } = segment;
  const fail = () => {
    throw new EvidenceParseError('JPEG coding segment has an unexpected structure');
  };
  if (marker === 0xdb) { // DQT
    let pos = 0;
    if (payload.length === 0) fail();
    while (pos < payload.length) {
      const precision = payload[pos] >> 4;
      if (precision > 1 || (payload[pos] & 0x0f) > 3) fail();
      pos += 1 + 64 * (precision + 1);
    }
    if (pos !== payload.length) fail();
  } else if (marker === 0xc4) { // DHT
    let pos = 0;
    if (payload.length === 0) fail();
    while (pos < payload.length) {
      if (pos + 17 > payload.length || payload[pos] >> 4 > 1 || (payload[pos] & 0x0f) > 3) fail();
      let symbols = 0;
      for (let index = 1; index <= 16; index += 1) symbols += payload[pos + index];
      if (symbols > 256) fail();
      pos += 17 + symbols;
    }
    if (pos !== payload.length) fail();
  } else if (SOF_MARKERS.has(marker) || marker === 0xde) { // SOFn, DHP
    if (payload.length < 6 || payload[5] === 0 || payload.length !== 6 + 3 * payload[5]) fail();
  } else if (marker === SOS) {
    if (payload.length < 1 || payload[0] < 1 || payload[0] > 4 || payload.length !== 1 + 2 * payload[0] + 3) fail();
  } else if (marker === 0xdd || marker === 0xdc) { // DRI, DNL
    if (payload.length !== 2) fail();
  } else if (marker === 0xdf) { // EXP
    if (payload.length !== 1) fail();
  } else if (marker === 0xcc) { // DAC
    if (payload.length === 0 || payload.length % 2 !== 0) fail();
  }
}

function canonicalJfif(payload: Buffer): Buffer {
  // FF E0, length 16, "JFIF\0", version, units, densities, no thumbnail.
  const out = Buffer.alloc(18);
  out.writeUInt16BE(0xffe0, 0);
  out.writeUInt16BE(16, 2);
  out.write(JFIF_ID, 4, 'latin1');
  payload.copy(out, 9, 5, 12);
  out[16] = 0;
  out[17] = 0;
  return out;
}

function isCanonicalJfif(segment: Segment): boolean {
  return segment.marker === APP0 && segment.end - segment.start === 18 && payloadStartsWith(segment.payload, JFIF_ID) &&
    segment.payload[12] === 0 && segment.payload[13] === 0;
}

function isExactAdobe(segment: Segment): boolean {
  return segment.marker === APP14 && segment.payload.length === 12 && payloadStartsWith(segment.payload, ADOBE_ID);
}

function wrapApp1(payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16BE(0xffe1, 0);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

function originalOrientation(parsed: ParsedJpeg): number | null {
  for (const segment of parsed.segments) {
    if (segment.marker === APP1 && segment.payload.subarray(0, 6).equals(EXIF_HEADER)) {
      return inspectTiff(segment.payload.subarray(6)).orientation;
    }
  }
  return null;
}

function codingDigest(buf: Buffer, parsed: ParsedJpeg): string {
  const hash = createHash('sha256');
  for (const segment of parsed.segments) {
    if (CODING_MARKERS.has(segment.marker) || isExactAdobe(segment)) hash.update(buf.subarray(segment.start, segment.end));
  }
  return hash.digest('hex');
}

function frameDimensions(parsed: ParsedJpeg): { width: number; height: number } | null {
  const sof = parsed.segments.find(segment => SOF_MARKERS.has(segment.marker));
  if (!sof || sof.payload.length < 6) return null;
  return { height: sof.payload.readUInt16BE(1), width: sof.payload.readUInt16BE(3) };
}

export function stripJpeg(input: Buffer): { output: Buffer; removed: RemovedCategory[] } {
  const parsed = parseJpeg(input);
  if (!frameDimensions(parsed)) throw new EvidenceParseError('JPEG has no frame header');
  if (!parsed.segments.some(segment => segment.marker === SOS)) throw new EvidenceParseError('JPEG has no scan');

  const removed = new Set<RemovedCategory>();
  const orientation = originalOrientation(parsed);
  const parts: Buffer[] = [];
  let orientationWritten = false;
  const writeOrientation = () => {
    if (!orientationWritten && orientation !== null && orientation !== 1) {
      parts.push(wrapApp1(buildOrientationOnlyExif(orientation)));
    }
    orientationWritten = true;
  };

  for (const segment of parsed.segments) {
    const bytes = input.subarray(segment.start, segment.end);
    if (segment.marker === SOI) {
      parts.push(bytes);
      continue;
    }
    if (segment.marker === APP0 && payloadStartsWith(segment.payload, JFIF_ID) && segment.payload.length >= 14 && parts.length === 1) {
      parts.push(canonicalJfif(segment.payload));
      for (const category of segmentCategories(segment)) removed.add(category);
      writeOrientation();
      continue;
    }
    if (CODING_MARKERS.has(segment.marker) || isExactAdobe(segment) || segment.marker === EOI) {
      if (CODING_MARKERS.has(segment.marker)) assertCodingStructure(segment);
      writeOrientation();
      parts.push(bytes);
      continue;
    }
    for (const category of segmentCategories(segment)) removed.add(category);
  }
  if (parsed.trailing.length > 0) {
    removed.add('trailing_data');
    // An appended JPEG after EOI is an MPF secondary image or similar.
    if (parsed.trailing.includes(Buffer.from([0xff, 0xd8, 0xff]))) removed.add('secondary_images');
  }
  return { output: Buffer.concat(parts), removed: sortedCategories(removed) };
}

/**
 * Re-parses the derivative on its own terms: only allow-listed segments, at
 * most one canonical orientation EXIF, nothing after EOI, and image coding
 * segments identical to the original's.
 */
export function validateJpegDerivative(original: Buffer, derivative: Buffer): void {
  let parsed: ParsedJpeg;
  try {
    parsed = parseJpeg(derivative);
  } catch {
    throw new DerivativeValidationError('JPEG derivative does not parse');
  }
  if (parsed.trailing.length > 0) throw new DerivativeValidationError('JPEG derivative has data after EOI');

  const leftovers = new Set<RemovedCategory>();
  let exifBlocks = 0;
  let keptOrientation: number | null = null;
  for (const segment of parsed.segments) {
    if (CODING_MARKERS.has(segment.marker)) {
      try {
        assertCodingStructure(segment);
      } catch {
        throw new DerivativeValidationError('JPEG derivative has a malformed coding segment');
      }
      continue;
    }
    if (segment.marker === SOI || segment.marker === EOI) continue;
    if (isExactAdobe(segment) || isCanonicalJfif(segment)) continue;
    if (segment.marker === APP1 && exifBlocks === 0) {
      keptOrientation = readCanonicalOrientationExif(segment.payload);
      exifBlocks += 1;
      if (keptOrientation !== null) continue;
    }
    for (const category of segmentCategories(segment)) leftovers.add(category);
    leftovers.add('vendor_metadata');
  }
  if (leftovers.size > 0) {
    throw new DerivativeValidationError(`JPEG derivative still holds: ${sortedCategories(leftovers).join(', ')}`);
  }

  const source = parseJpeg(original);
  const sourceOrientation = originalOrientation(source);
  const expectedOrientation = sourceOrientation !== null && sourceOrientation !== 1 ? sourceOrientation : null;
  if (keptOrientation !== expectedOrientation) throw new DerivativeValidationError('JPEG derivative orientation differs');

  const before = frameDimensions(source);
  const after = frameDimensions(parsed);
  if (!before || !after || before.width !== after.width || before.height !== after.height) {
    throw new DerivativeValidationError('JPEG derivative dimensions differ');
  }
  if (codingDigest(original, source) !== codingDigest(derivative, parsed)) {
    throw new DerivativeValidationError('JPEG derivative image data differs');
  }
}

export function jpegDimensions(buf: Buffer): { width: number; height: number } | null {
  try {
    return frameDimensions(parseJpeg(buf));
  } catch {
    return null;
  }
}
