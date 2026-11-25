/**
 * Minimal TIFF/EXIF reading for two jobs only:
 *  - naming which categories an EXIF block held (for the derivative record),
 *    best effort and never throwing, so a malformed block is still dropped;
 *  - building and checking the one EXIF block a JPEG derivative may keep,
 *    which holds the Orientation tag and nothing else.
 */
import { type RemovedCategory } from './types.js';

export const EXIF_HEADER = Buffer.from('Exif\0\0', 'latin1');

const TAG_ORIENTATION = 0x0112;
const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_INTEROP_IFD = 0xa005;

const TAG_CATEGORIES = new Map<number, RemovedCategory>([
  [0x010f, 'device_make_model'], // Make
  [0x0110, 'device_make_model'], // Model
  [0xa433, 'device_make_model'], // LensMake
  [0xa434, 'device_make_model'], // LensModel
  [0xa430, 'device_serial'], // CameraOwnerName
  [0xa431, 'device_serial'], // BodySerialNumber
  [0xa435, 'device_serial'], // LensSerialNumber
  [0xa420, 'device_serial'], // ImageUniqueID
  [0x0131, 'software'], // Software
  [0x0132, 'capture_timestamps'], // DateTime
  [0x9003, 'capture_timestamps'], // DateTimeOriginal
  [0x9004, 'capture_timestamps'], // DateTimeDigitized
  [0x9010, 'capture_timestamps'], // OffsetTime
  [0x9011, 'capture_timestamps'], // OffsetTimeOriginal
  [0x9012, 'capture_timestamps'], // OffsetTimeDigitized
  [0x9290, 'capture_timestamps'], // SubSecTime
  [0x9291, 'capture_timestamps'], // SubSecTimeOriginal
  [0x9292, 'capture_timestamps'], // SubSecTimeDigitized
  [0x927c, 'maker_notes'], // MakerNote
  [0x9286, 'comments'], // UserComment
  [0x010e, 'text_metadata'], // ImageDescription
  [0x013b, 'text_metadata'], // Artist
  [0x8298, 'text_metadata'], // Copyright
  [0x9c9b, 'text_metadata'], // XPTitle
  [0x9c9c, 'comments'], // XPComment
  [0x9c9d, 'text_metadata'], // XPAuthor
  [0x9c9e, 'text_metadata'], // XPKeywords
  [0x9c9f, 'text_metadata'], // XPSubject
]);

type Endian = 'II' | 'MM';

function readU16(buf: Buffer, offset: number, endian: Endian): number {
  return endian === 'II' ? buf.readUInt16LE(offset) : buf.readUInt16BE(offset);
}

function readU32(buf: Buffer, offset: number, endian: Endian): number {
  return endian === 'II' ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset);
}

function tiffEndian(tiff: Buffer): Endian | null {
  if (tiff.length < 8) return null;
  const order = tiff.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return null;
  return readU16(tiff, 2, order) === 42 ? order : null;
}

export type TiffInspection = {
  categories: Set<RemovedCategory>;
  /** IFD0 Orientation (1-8) when present and valid. */
  orientation: number | null;
};

/**
 * Names what a TIFF structure (EXIF payload without the "Exif\0\0" prefix,
 * or a PNG eXIf chunk) contains. Malformed input yields what was readable.
 */
export function inspectTiff(tiff: Buffer): TiffInspection {
  const categories = new Set<RemovedCategory>(['exif']);
  let orientation: number | null = null;
  const endian = tiffEndian(tiff);
  if (!endian) return { categories, orientation };

  const visited = new Set<number>();
  const queue: Array<{ offset: number; kind: 'ifd0' | 'ifd1' | 'sub' }> = [
    { offset: readU32(tiff, 4, endian), kind: 'ifd0' },
  ];
  while (queue.length > 0 && visited.size < 8) {
    const { offset, kind } = queue.shift()!;
    if (offset < 8 || offset + 2 > tiff.length || visited.has(offset)) continue;
    visited.add(offset);
    if (kind === 'ifd1') categories.add('thumbnails');
    const count = readU16(tiff, offset, endian);
    if (count > 1000) continue;
    for (let index = 0; index < count; index += 1) {
      const entry = offset + 2 + index * 12;
      if (entry + 12 > tiff.length) break;
      const tag = readU16(tiff, entry, endian);
      const category = TAG_CATEGORIES.get(tag);
      if (category) categories.add(category);
      if (tag === TAG_GPS_IFD) categories.add('gps_location');
      if (tag === TAG_ORIENTATION && kind === 'ifd0' && readU16(tiff, entry + 2, endian) === 3) {
        const value = readU16(tiff, entry + 8, endian);
        if (value >= 1 && value <= 8) orientation = value;
      }
      if (tag === TAG_EXIF_IFD || tag === TAG_GPS_IFD || tag === TAG_INTEROP_IFD) {
        queue.push({ offset: readU32(tiff, entry + 8, endian), kind: 'sub' });
      }
    }
    const nextOffsetAt = offset + 2 + count * 12;
    if (kind === 'ifd0' && nextOffsetAt + 4 <= tiff.length) {
      const next = readU32(tiff, nextOffsetAt, endian);
      if (next !== 0) queue.push({ offset: next, kind: 'ifd1' });
    }
  }
  return { categories, orientation };
}

/** Names what an XMP packet holds, from its property names only. */
export function inspectXmp(text: string): RemovedCategory[] {
  const found: RemovedCategory[] = ['xmp'];
  if (/GPS(Latitude|Longitude|Altitude|Position)|exif:GPS/i.test(text)) found.push('gps_location');
  if (/tiff:(Make|Model)|aux:Lens(Info|Model)?\b|exifEX:Lens(Make|Model)/.test(text)) found.push('device_make_model');
  if (/SerialNumber|aux:ImageNumber|exifEX:CameraOwnerName/.test(text)) found.push('device_serial');
  if (/(xmp:(Create|Modify|Metadata)Date|photoshop:DateCreated|exif:DateTime)/.test(text)) found.push('capture_timestamps');
  if (/xmp:CreatorTool|tiff:Software/.test(text)) found.push('software');
  return found;
}

/**
 * The only EXIF block a JPEG derivative keeps: big-endian TIFF, IFD0 with a
 * single Orientation SHORT, no next IFD. 32 bytes including "Exif\0\0".
 */
export function buildOrientationOnlyExif(orientation: number): Buffer {
  if (!Number.isInteger(orientation) || orientation < 2 || orientation > 8) {
    throw new RangeError('orientation-only EXIF is written only for orientations 2-8');
  }
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8); // one entry
  tiff.writeUInt16BE(TAG_ORIENTATION, 10);
  tiff.writeUInt16BE(3, 12); // SHORT
  tiff.writeUInt32BE(1, 14); // count
  tiff.writeUInt16BE(orientation, 18); // value, left-justified in the 4-byte field
  tiff.writeUInt32BE(0, 22); // no next IFD
  return Buffer.concat([EXIF_HEADER, tiff]);
}

/**
 * Validation side: an APP1 payload is acceptable only if it is byte-for-byte
 * the canonical orientation-only block. Returns the orientation it carries.
 */
export function readCanonicalOrientationExif(payload: Buffer): number | null {
  if (payload.length !== 32 || !payload.subarray(0, 6).equals(EXIF_HEADER)) return null;
  const orientation = payload.readUInt16BE(6 + 18);
  if (orientation < 2 || orientation > 8) return null;
  return payload.equals(buildOrientationOnlyExif(orientation)) ? orientation : null;
}
