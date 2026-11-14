/**
 * Real synthetic files, generated here: a baseline JPEG from a tiny encoder,
 * a deflated PNG, an MP4/MOV box tree, MP3 frames and a RIFF/WAVE file, each
 * loaded with known GPS, device make/model, serial and other markers. No real
 * photo, recording or device data is used.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync, inflateSync } from 'node:zlib';

import { afterAll, describe, expect, it } from 'vitest';

import { stripEvidenceMetadata, sniffEvidenceFormat } from '../evidenceStrip/index.js';
import { validateIsobmffDerivative } from '../evidenceStrip/isobmff.js';
import { validateJpegDerivative } from '../evidenceStrip/jpeg.js';
import { validateMp3Derivative } from '../evidenceStrip/mp3.js';
import { validatePngDerivative } from '../evidenceStrip/png.js';
import { validateWavDerivative } from '../evidenceStrip/wav.js';

// --- synthetic markers -------------------------------------------------------

const MARK = {
  make: 'SynthMakeCo',
  model: 'SynthModel-9',
  serial: 'SYNTH-SERIAL-0042',
  software: 'SynthSoftware 1.0',
  lens: 'SynthLens 50mm',
  owner: 'SynthOwnerName',
  datetime: '2026:10:21 09:15:00',
  iso6709: '+12.3456+065.4321/',
  xmp: 'SYNTH-XMP-PACKET',
  iptc: 'SYNTH-IPTC-BYLINE',
  comment: 'SYNTH-COMMENT-MARKER',
  icc: 'SYNM',
  trailer: 'SYNTH-TRAILER-MARKER',
  leftover: 'SYNTH-LEFTOVER-MARKER',
  handler: 'SynthHandlerName',
  compressor: 'SynthCam AVC',
  uuid: 'SYNTH-UUID-MARKER',
  gpsTrack: 'SYNTH-GPS-TRACK-SAMPLE',
  ape: 'SYNTH-APE-ARTIST',
  id3v1: 'SYNTH-ID3V1-TITLE',
  riff: 'SYNTH-RIFF-ARTIST',
  bext: 'SynthOriginator',
};

function expectNoMarkers(buf: Buffer, markers: string[]): void {
  const text = buf.toString('latin1');
  for (const marker of markers) expect(text.includes(marker), `marker ${marker} must be gone`).toBe(false);
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

// --- TIFF / EXIF builder -------------------------------------------------------

type Entry =
  | { tag: number; ascii: string }
  | { tag: number; short: number[] }
  | { tag: number; long: number[] }
  | { tag: number; rational: Array<[number, number]> };

function entryValue(entry: Entry): { type: number; count: number; bytes: Buffer } {
  if ('ascii' in entry) {
    const bytes = Buffer.from(`${entry.ascii}\0`, 'latin1');
    return { type: 2, count: bytes.length, bytes };
  }
  if ('short' in entry) {
    const bytes = Buffer.alloc(entry.short.length * 2);
    entry.short.forEach((value, index) => bytes.writeUInt16LE(value, index * 2));
    return { type: 3, count: entry.short.length, bytes };
  }
  if ('long' in entry) {
    const bytes = Buffer.alloc(entry.long.length * 4);
    entry.long.forEach((value, index) => bytes.writeUInt32LE(value, index * 4));
    return { type: 4, count: entry.long.length, bytes };
  }
  const bytes = Buffer.alloc(entry.rational.length * 8);
  entry.rational.forEach(([num, den], index) => {
    bytes.writeUInt32LE(num, index * 8);
    bytes.writeUInt32LE(den, index * 8 + 4);
  });
  return { type: 5, count: entry.rational.length, bytes };
}

function ifdSize(entries: Entry[]): number {
  const outOfLine = entries.map(entryValue).reduce((sum, value) => sum + (value.bytes.length > 4 ? value.bytes.length + (value.bytes.length % 2) : 0), 0);
  return 2 + entries.length * 12 + 4 + outOfLine;
}

/** Little-endian TIFF: IFD0 (+ Exif and GPS sub-IFDs, + IFD1 thumbnail directory). */
function buildTiff(ifd0: Entry[], subs: { exif?: Entry[]; gps?: Entry[]; ifd1?: Entry[] } = {}): Buffer {
  const main = [...ifd0];
  if (subs.exif) main.push({ tag: 0x8769, long: [0] });
  if (subs.gps) main.push({ tag: 0x8825, long: [0] });
  main.sort((a, b) => a.tag - b.tag);
  const order: Array<{ name: string; entries: Entry[] }> = [{ name: 'ifd0', entries: main }];
  if (subs.exif) order.push({ name: 'exif', entries: subs.exif });
  if (subs.gps) order.push({ name: 'gps', entries: subs.gps });
  if (subs.ifd1) order.push({ name: 'ifd1', entries: subs.ifd1 });
  const offsets = new Map<string, number>();
  let cursor = 8;
  for (const ifd of order) {
    offsets.set(ifd.name, cursor);
    cursor += ifdSize(ifd.entries);
  }
  const out = Buffer.alloc(cursor);
  out.write('II', 0, 'latin1');
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(8, 4);
  for (const ifd of order) {
    const start = offsets.get(ifd.name)!;
    out.writeUInt16LE(ifd.entries.length, start);
    let valueCursor = start + 2 + ifd.entries.length * 12 + 4;
    ifd.entries.forEach((entry, index) => {
      const at = start + 2 + index * 12;
      let { type, count, bytes } = entryValue(entry);
      if (entry.tag === 0x8769 && 'long' in entry) bytes = Buffer.from(Uint32Array.of(offsets.get('exif')!).buffer);
      if (entry.tag === 0x8825 && 'long' in entry) bytes = Buffer.from(Uint32Array.of(offsets.get('gps')!).buffer);
      out.writeUInt16LE(entry.tag, at);
      out.writeUInt16LE(type, at + 2);
      out.writeUInt32LE(count, at + 4);
      if (bytes.length <= 4) {
        bytes.copy(out, at + 8);
      } else {
        out.writeUInt32LE(valueCursor, at + 8);
        bytes.copy(out, valueCursor);
        valueCursor += bytes.length + (bytes.length % 2);
      }
    });
    const next = ifd.name === 'ifd0' && subs.ifd1 ? offsets.get('ifd1')! : 0;
    out.writeUInt32LE(next, start + 2 + ifd.entries.length * 12);
  }
  return out;
}

function syntheticExifTiff(orientation: number | null): Buffer {
  const ifd0: Entry[] = [
    { tag: 0x010f, ascii: MARK.make },
    { tag: 0x0110, ascii: MARK.model },
    { tag: 0x0131, ascii: MARK.software },
    { tag: 0x0132, ascii: MARK.datetime },
  ];
  if (orientation !== null) ifd0.push({ tag: 0x0112, short: [orientation] });
  return buildTiff(ifd0, {
    exif: [
      { tag: 0x9003, ascii: MARK.datetime },
      { tag: 0xa430, ascii: MARK.owner },
      { tag: 0xa431, ascii: MARK.serial },
      { tag: 0xa434, ascii: MARK.lens },
    ],
    gps: [
      { tag: 0x0001, ascii: 'N' },
      { tag: 0x0002, rational: [[12, 1], [20, 1], [4416, 100]] },
      { tag: 0x0003, ascii: 'E' },
      { tag: 0x0004, rational: [[65, 1], [25, 1], [5556, 100]] },
    ],
    ifd1: [{ tag: 0x0103, short: [6] }],
  });
}

function xmpPacket(): string {
  return `<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description ` +
    `exif:GPSLatitude="12,20.736N" exif:GPSLongitude="65,25.926E" tiff:Make="${MARK.make}" tiff:Model="${MARK.model}" ` +
    `aux:SerialNumber="${MARK.serial}" xmp:CreateDate="2026-10-21T09:15:00" dc:description="${MARK.xmp}"/>` +
    '</rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
}

// --- JPEG: a tiny baseline encoder (grayscale, flat 8x8 blocks) and a DC-only decoder ---

const DC_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_BITS = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const AC_VALUES = [0x00]; // EOB only: every block is flat

function huffmanCodes(bits: number[], values: number[]): Map<number, { code: number; length: number }> {
  const codes = new Map<number, { code: number; length: number }>();
  let code = 0;
  let k = 0;
  for (let length = 1; length <= 16; length += 1) {
    for (let index = 0; index < bits[length - 1]; index += 1) codes.set(values[k++], { code: code++, length });
    code <<= 1;
  }
  return codes;
}

function segment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xff00 | marker, 0);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

function blockLevel(bx: number, by: number): number {
  return (bx * 37 + by * 91 + 40) % 256;
}

function encodeGrayJpeg(width: number, height: number): Buffer {
  const dc = huffmanCodes(DC_BITS, DC_VALUES);
  const ac = huffmanCodes(AC_BITS, AC_VALUES);
  const bytes: number[] = [];
  let acc = 0;
  let count = 0;
  const put = (value: number, length: number) => {
    for (let bit = length - 1; bit >= 0; bit -= 1) {
      acc = (acc << 1) | ((value >> bit) & 1);
      count += 1;
      if (count === 8) {
        bytes.push(acc);
        if (acc === 0xff) bytes.push(0x00);
        acc = 0;
        count = 0;
      }
    }
  };
  let previous = 0;
  for (let by = 0; by < height / 8; by += 1) {
    for (let bx = 0; bx < width / 8; bx += 1) {
      const coefficient = 8 * (blockLevel(bx, by) - 128);
      const diff = coefficient - previous;
      previous = coefficient;
      const magnitude = Math.abs(diff);
      const category = magnitude === 0 ? 0 : Math.floor(Math.log2(magnitude)) + 1;
      const symbol = dc.get(category)!;
      put(symbol.code, symbol.length);
      if (category > 0) put(diff >= 0 ? diff : diff + (1 << category) - 1, category);
      const eob = ac.get(0x00)!;
      put(eob.code, eob.length);
    }
  }
  if (count > 0) put((1 << (8 - count)) - 1, 8 - count);

  const jfif = Buffer.from([0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 72, 0, 72, 0, 0]);
  const dqt = Buffer.concat([Buffer.from([0x00]), Buffer.alloc(64, 1)]);
  const sof = Buffer.alloc(9);
  sof[0] = 8;
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  sof[5] = 1;
  sof[6] = 1;
  sof[7] = 0x11;
  sof[8] = 0;
  const dhtDc = Buffer.concat([Buffer.from([0x00]), Buffer.from(DC_BITS), Buffer.from(DC_VALUES)]);
  const dhtAc = Buffer.concat([Buffer.from([0x10]), Buffer.from(AC_BITS), Buffer.from(AC_VALUES)]);
  const sos = Buffer.from([1, 1, 0x00, 0, 63, 0]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, jfif),
    segment(0xdb, dqt),
    segment(0xc0, sof),
    segment(0xc4, dhtDc),
    segment(0xc4, dhtAc),
    segment(0xda, sos),
    Buffer.from(bytes),
    Buffer.from([0xff, 0xd9]),
  ]);
}

/**
 * Decodes the DC-only baseline JPEGs above from the file's own DHT, SOF and
 * scan bytes: proves the derivative still decodes to the same pixels.
 */
function decodeFlatGrayJpeg(buf: Buffer): { width: number; height: number; levels: number[] } {
  let pos = 2;
  let width = 0;
  let height = 0;
  const tables = new Map<number, Map<string, number>>();
  while (pos < buf.length) {
    const marker = buf[pos + 1];
    const length = buf.readUInt16BE(pos + 2);
    const payload = buf.subarray(pos + 4, pos + 2 + length);
    if (marker === 0xc0) {
      height = payload.readUInt16BE(1);
      width = payload.readUInt16BE(3);
    }
    if (marker === 0xc4) {
      const bits = [...payload.subarray(1, 17)];
      const values = [...payload.subarray(17, 17 + bits.reduce((a, b) => a + b, 0))];
      const lookup = new Map<string, number>();
      for (const [symbol, { code, length: size }] of huffmanCodes(bits, values)) lookup.set(code.toString(2).padStart(size, '0'), symbol);
      tables.set(payload[0], lookup);
    }
    pos += 2 + length;
    if (marker === 0xda) break;
  }
  const scan: number[] = [];
  for (let index = pos; index < buf.length - 2; index += 1) {
    scan.push(buf[index]);
    if (buf[index] === 0xff) index += 1; // skip stuffed 0x00
  }
  let bit = 0;
  const readBit = () => (scan[bit >> 3] >> (7 - (bit++ & 7))) & 1;
  const readSymbol = (table: Map<string, number>) => {
    let code = '';
    while (code.length <= 16) {
      code += readBit();
      if (table.has(code)) return table.get(code)!;
    }
    throw new Error('bad Huffman code');
  };
  const levels: number[] = [];
  let previous = 0;
  for (let block = 0; block < (width / 8) * (height / 8); block += 1) {
    const category = readSymbol(tables.get(0x00)!);
    let diff = 0;
    if (category > 0) {
      let raw = 0;
      for (let index = 0; index < category; index += 1) raw = (raw << 1) | readBit();
      diff = raw >= 1 << (category - 1) ? raw : raw - (1 << category) + 1;
    }
    previous += diff;
    if (readSymbol(tables.get(0x10)!) !== 0x00) throw new Error('expected EOB');
    levels.push(previous / 8 + 128);
  }
  return { width, height, levels };
}

function app(marker: number, id: string, body: Buffer | string): Buffer {
  return segment(marker, Buffer.concat([Buffer.from(id, 'latin1'), Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1')]));
}

function iptcApp13(): Buffer {
  const byline = Buffer.from(MARK.iptc, 'latin1');
  const record = Buffer.concat([Buffer.from([0x1c, 0x02, 0x50, 0x00, byline.length]), byline]);
  const resource = Buffer.alloc(12);
  resource.write('8BIM', 0, 'latin1');
  resource.writeUInt16BE(0x0404, 4);
  resource.writeUInt32BE(record.length, 8);
  return app(0xed, 'Photoshop 3.0\0', Buffer.concat([resource, record, Buffer.alloc(record.length % 2)]));
}

function iccApp2(): Buffer {
  const profile = Buffer.alloc(128);
  profile.writeUInt32BE(128, 0);
  profile.write(MARK.icc, 48, 'latin1'); // device manufacturer signature
  profile.write('acsp', 36, 'latin1');
  return app(0xe2, 'ICC_PROFILE\0', Buffer.concat([Buffer.from([1, 1]), profile]));
}

/** A JPEG carrying EXIF (GPS, make/model, serial, thumbnail IFD), XMP, IPTC, a comment, ICC, MPF and a trailer. */
function syntheticJpeg(orientation: number | null = 6): Buffer {
  const base = encodeGrayJpeg(32, 16);
  const soiAndJfif = base.subarray(0, 2 + 18);
  const rest = base.subarray(2 + 18);
  return Buffer.concat([
    soiAndJfif,
    app(0xe1, 'Exif\0\0', syntheticExifTiff(orientation)),
    app(0xe1, 'http://ns.adobe.com/xap/1.0/\0', xmpPacket()),
    iccApp2(),
    app(0xe2, 'MPF\0', 'MM\0*\0\0\0\x08'),
    iptcApp13(),
    segment(0xfe, Buffer.from(MARK.comment, 'latin1')),
    app(0xe5, 'SynthVendor\0', `${MARK.serial}`),
    rest,
    Buffer.from(`${MARK.trailer}`, 'latin1'),
    Buffer.from([0xff, 0xd8, 0xff, 0xe1]), // an appended secondary image start
  ]);
}

function jpegMarkers(buf: Buffer): number[] {
  const markers: number[] = [];
  let pos = 2;
  while (pos < buf.length) {
    const marker = buf[pos + 1];
    markers.push(marker);
    if (marker === 0xd9) break;
    pos += 2 + buf.readUInt16BE(pos + 2);
    if (marker === 0xda) {
      while (!(buf[pos] === 0xff && buf[pos + 1] !== 0x00)) pos += 1;
    }
  }
  return markers;
}

// --- PNG ---------------------------------------------------------------------

function pngChunk(type: string, data: Buffer | string): Buffer {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), body])) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}

const PNG_WIDTH = 5;
const PNG_HEIGHT = 3;
const PNG_RAW = Buffer.concat(Array.from({ length: PNG_HEIGHT }, (_, row) => Buffer.concat([
  Buffer.from([0]),
  Buffer.from(Array.from({ length: PNG_WIDTH * 3 }, (_, index) => (row * 50 + index * 13) % 256)),
])));

function syntheticPng(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(PNG_WIDTH, 0);
  ihdr.writeUInt32BE(PNG_HEIGHT, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const time = Buffer.from([0x07, 0xea, 10, 21, 9, 15, 0]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('gAMA', Buffer.from([0, 0, 0xb1, 0x8f])),
    pngChunk('iCCP', Buffer.concat([Buffer.from('SynthICC\0\0', 'latin1'), deflateSync(Buffer.from(MARK.icc, 'latin1'))])),
    pngChunk('eXIf', syntheticExifTiff(null)),
    pngChunk('tEXt', `Comment\0${MARK.comment}`),
    pngChunk('zTXt', Buffer.concat([Buffer.from('Author\0\0', 'latin1'), deflateSync(Buffer.from(MARK.owner, 'latin1'))])),
    pngChunk('iTXt', `XML:com.adobe.xmp\0\0\0\0\0${xmpPacket()}`),
    pngChunk('tIME', time),
    pngChunk('IDAT', deflateSync(PNG_RAW)),
    pngChunk('prVt', `${MARK.serial}`),
    pngChunk('IEND', Buffer.alloc(0)),
    Buffer.from(MARK.trailer, 'latin1'),
  ]);
}

function pngChunkTypes(buf: Buffer): string[] {
  const types: string[] = [];
  let pos = 8;
  while (pos < buf.length) {
    const length = buf.readUInt32BE(pos);
    types.push(buf.toString('latin1', pos + 4, pos + 8));
    pos += 12 + length;
  }
  return types;
}

function decodePngPixels(buf: Buffer): { width: number; height: number; raw: Buffer } {
  let pos = 8;
  const idat: Buffer[] = [];
  let width = 0;
  let height = 0;
  while (pos < buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + length);
    expect(buf.readUInt32BE(pos + 8 + length)).toBe(crc32(buf.subarray(pos + 4, pos + 8 + length)) >>> 0);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    }
    if (type === 'IDAT') idat.push(data);
    pos += 12 + length;
  }
  return { width, height, raw: inflateSync(Buffer.concat(idat)) };
}

// --- MP4 / MOV ------------------------------------------------------------------

function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

function fullBox(type: string, version: number, flags: number, ...parts: Buffer[]): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE((version << 24) | flags, 0);
  return box(type, head, ...parts);
}

function u32(...values: number[]): Buffer {
  const out = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => out.writeUInt32BE(value >>> 0, index * 4));
  return out;
}

function u16(...values: number[]): Buffer {
  const out = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => out.writeUInt16BE(value, index * 2));
  return out;
}

const SYNTH_TIME = 0xe0a1b2c3; // a non-zero creation time to be zeroed
const MATRIX = u32(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000);

function qtString(type: string, value: string): Buffer {
  const text = Buffer.from(value, 'latin1');
  return box(type, u16(text.length, 0x15c7), text);
}

type TrackSpec = {
  id: number;
  handler: 'vide' | 'soun' | 'meta';
  entry: Buffer;
  chunks: Array<{ offset: number; sizes: number[] }>;
  constantSize?: number;
  tref?: Buffer;
  udta?: Buffer;
  externalData?: boolean;
};

function trak(spec: TrackSpec): Buffer {
  const tkhd = fullBox('tkhd', 0, 7, u32(SYNTH_TIME, SYNTH_TIME, spec.id, 0, 1000), Buffer.alloc(8), u16(0, 0, 0, 0), MATRIX,
    u32(spec.handler === 'vide' ? 32 << 16 : 0, spec.handler === 'vide' ? 16 << 16 : 0));
  const mdhd = fullBox('mdhd', 0, 0, u32(SYNTH_TIME, SYNTH_TIME, 1000, 1000), u16(0x55c4, 0));
  const hdlr = fullBox('hdlr', 0, 0, u32(0), Buffer.from(spec.handler, 'latin1'), Buffer.alloc(12), Buffer.from(`${MARK.handler}\0`, 'latin1'));
  const mediaHeader = spec.handler === 'vide' ? fullBox('vmhd', 0, 1, Buffer.alloc(8)) : spec.handler === 'soun' ? fullBox('smhd', 0, 0, Buffer.alloc(4)) : fullBox('nmhd', 0, 0);
  const dref = fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, spec.externalData ? 0 : 1));
  const sizes = spec.chunks.flatMap(chunk => chunk.sizes);
  const stsz = spec.constantSize
    ? fullBox('stsz', 0, 0, u32(spec.constantSize, sizes.length))
    : fullBox('stsz', 0, 0, u32(0, sizes.length, ...sizes));
  const stscEntries = spec.chunks.flatMap((chunk, index) => [index + 1, chunk.sizes.length, 1]);
  const stbl = box('stbl',
    fullBox('stsd', 0, 0, u32(1), spec.entry),
    fullBox('stts', 0, 0, u32(1, sizes.length, 100)),
    fullBox('stsc', 0, 0, u32(spec.chunks.length, ...stscEntries)),
    stsz,
    fullBox('stco', 0, 0, u32(spec.chunks.length, ...spec.chunks.map(chunk => chunk.offset))));
  const minf = box('minf', mediaHeader, box('dinf', dref), stbl);
  return box('trak', tkhd, ...(spec.tref ? [spec.tref] : []), box('mdia', mdhd, hdlr, minf), ...(spec.udta ? [spec.udta] : []));
}

function avc1Entry(): Buffer {
  const compressor = Buffer.alloc(32);
  compressor[0] = MARK.compressor.length;
  compressor.write(MARK.compressor, 1, 'latin1');
  return box('avc1', Buffer.alloc(6), u16(1), Buffer.alloc(16), u16(32, 16), u32(0x00480000, 0x00480000, 0), u16(1), compressor,
    u16(0x18, 0xffff), box('avcC', Buffer.from([1, 0x42, 0xc0, 0x1e, 0xff, 0xe0, 0x00])), box('uuid', Buffer.alloc(16, 0x5a), Buffer.from(MARK.uuid, 'latin1')));
}

function mp4aEntry(type = 'mp4a', soundVersion = 0): Buffer {
  return box(type, Buffer.alloc(6), u16(1), u16(soundVersion, 0), u32(0), u16(1, 16, 0, 0), u32(44100 << 16), box('esds', u32(0), Buffer.from([3, 5, 0, 1, 0, 4, 0])));
}

function mebxEntry(): Buffer {
  return box('mebx', Buffer.alloc(6), u16(1), box('keys', u32(0, 1), box('keyd', Buffer.from('mdtacom.apple.quicktime.location.ISO6709', 'latin1'))));
}

type MovieOptions = {
  moovFirst?: boolean;
  brand?: string;
  audioOnly?: boolean;
  fragmented?: boolean;
  externalData?: boolean;
  videoReferencesMeta?: boolean;
  pcmAudio?: boolean;
};

const VIDEO_SAMPLES = [Buffer.alloc(10, 0x11), Buffer.alloc(12, 0x12), Buffer.alloc(8, 0x13)];
const AUDIO_SAMPLE = Buffer.alloc(6, 0x21);

/** An MP4/MOV with udta (©xyz, ©mak, ©mod), mdta meta, a timed GPS track, a uuid XMP box, leftovers in mdat and free space. */
function syntheticMovie(options: MovieOptions = {}): Buffer {
  const gpsSample = Buffer.from(`${MARK.iso6709}${MARK.gpsTrack}`, 'latin1');
  const leftover = Buffer.from(MARK.leftover, 'latin1');
  const mdatBody = options.audioOnly
    ? Buffer.concat([AUDIO_SAMPLE, leftover])
    : Buffer.concat([VIDEO_SAMPLES[0], VIDEO_SAMPLES[1], gpsSample, leftover, VIDEO_SAMPLES[2], AUDIO_SAMPLE]);
  const ftyp = box('ftyp', Buffer.from(options.brand ?? 'isom', 'latin1'), u32(0x200), Buffer.from('isomiso2mp41', 'latin1'));
  const xmpUuid = box('uuid', Buffer.from('be7acfcb97a942e89c71999491e3afac', 'hex'), Buffer.from(xmpPacket(), 'latin1'));
  const free = box('free', Buffer.from(MARK.leftover, 'latin1'));

  const build = (mdatOffset: number) => {
    const at = (offset: number) => mdatOffset + 8 + offset;
    const tracks: Buffer[] = [];
    if (!options.audioOnly) {
      tracks.push(trak({
        id: 1, handler: 'vide', entry: avc1Entry(),
        chunks: [{ offset: at(0), sizes: [10, 12] }, { offset: at(22 + gpsSample.length + leftover.length), sizes: [8] }],
        tref: options.videoReferencesMeta ? box('tref', box('cdsc', u32(3))) : undefined,
        udta: box('udta', qtString('\xa9xyz', MARK.iso6709)),
        externalData: options.externalData,
      }));
    }
    tracks.push(trak({
      id: 2, handler: 'soun', entry: options.pcmAudio ? mp4aEntry('lpcm') : mp4aEntry(),
      chunks: [{ offset: at(options.audioOnly ? 0 : 30 + gpsSample.length + leftover.length), sizes: [6] }],
      constantSize: 6,
    }));
    if (!options.audioOnly) {
      tracks.push(trak({ id: 3, handler: 'meta', entry: mebxEntry(), chunks: [{ offset: at(22), sizes: [gpsSample.length] }] }));
    }
    const mvhd = fullBox('mvhd', 0, 0, u32(SYNTH_TIME, SYNTH_TIME, 1000, 1000, 0x00010000), u16(0x0100), Buffer.alloc(10), MATRIX, Buffer.alloc(24), u32(4));
    const udta = box('udta', qtString('\xa9xyz', MARK.iso6709), qtString('\xa9mak', MARK.make), qtString('\xa9mod', MARK.model), qtString('\xa9day', '2026-10-21'));
    const meta = fullBox('meta', 0, 0,
      fullBox('hdlr', 0, 0, u32(0), Buffer.from('mdta', 'latin1'), Buffer.alloc(13)),
      fullBox('keys', 0, 0, u32(2), box('mdta', Buffer.from('com.apple.quicktime.location.ISO6709', 'latin1')), box('mdta', Buffer.from('com.apple.quicktime.make', 'latin1'))),
      box('ilst', box('\0\0\0\x01', box('data', u32(1, 0), Buffer.from(MARK.iso6709, 'latin1'))), box('\0\0\0\x02', box('data', u32(1, 0), Buffer.from(MARK.make, 'latin1')))));
    const mvex = options.fragmented ? box('mvex', fullBox('trex', 0, 0, u32(1, 1, 0, 0, 0))) : Buffer.alloc(0);
    return box('moov', mvhd, ...tracks, udta, meta, box('free', Buffer.from(MARK.serial, 'latin1')), mvex);
  };

  const mdat = box('mdat', mdatBody);
  if (options.moovFirst === false) {
    const mdatOffset = ftyp.length;
    return Buffer.concat([ftyp, mdat, build(mdatOffset), xmpUuid]);
  }
  const moovLength = build(0).length;
  const mdatOffset = ftyp.length + moovLength + xmpUuid.length + free.length;
  return Buffer.concat([ftyp, build(mdatOffset), xmpUuid, free, mdat, ...(options.fragmented ? [box('moof', u32(0))] : [])]);
}

function topLevelTypes(buf: Buffer): string[] {
  const types: string[] = [];
  let pos = 0;
  while (pos < buf.length) {
    types.push(buf.toString('latin1', pos + 4, pos + 8));
    pos += buf.readUInt32BE(pos);
  }
  return types;
}

const MOVIE_MARKERS = [
  MARK.make, MARK.model, MARK.iso6709, MARK.gpsTrack, MARK.leftover, MARK.serial, MARK.handler, MARK.compressor,
  MARK.uuid, MARK.xmp, 'com.apple.quicktime.location', '\xa9xyz', '\xa9mak', '\xa9mod',
];

// --- MP3 ----------------------------------------------------------------------

function mp3Frame(index: number): Buffer {
  // MPEG-1 Layer III, 128 kbit/s, 44.1 kHz, no padding: 417 bytes.
  const frame = Buffer.alloc(417, (index * 29 + 7) % 256);
  frame.set([0xff, 0xfb, 0x90, 0xc4], 0);
  return frame;
}

function id3v2(): Buffer {
  const frame = (id: string, text: string) => {
    const body = Buffer.concat([Buffer.from([0]), Buffer.from(text, 'latin1')]);
    const head = Buffer.alloc(10);
    head.write(id, 0, 'latin1');
    head.writeUInt32BE(body.length, 4);
    return Buffer.concat([head, body]);
  };
  const frames = Buffer.concat([
    frame('TPE1', MARK.owner),
    frame('TXXX', `GPS\0${MARK.iso6709}`),
    frame('COMM', `eng\0${MARK.comment}`),
    frame('TSSE', MARK.software),
  ]);
  const size = frames.length;
  const head = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
  return Buffer.concat([head, frames]);
}

function apeTag(): Buffer {
  const value = Buffer.from(MARK.ape, 'latin1');
  const item = Buffer.concat([u32le(value.length, 0), Buffer.from('Artist\0', 'latin1'), value]);
  const footer = Buffer.concat([Buffer.from('APETAGEX', 'latin1'), u32le(2000, item.length + 32, 1, 0), Buffer.alloc(8)]);
  return Buffer.concat([item, footer]);
}

function u32le(...values: number[]): Buffer {
  const out = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => out.writeUInt32LE(value, index * 4));
  return out;
}

function id3v1(): Buffer {
  const tag = Buffer.alloc(128);
  tag.write('TAG', 0, 'latin1');
  tag.write(MARK.id3v1, 3, 'latin1');
  return tag;
}

const MP3_FRAMES = Array.from({ length: 5 }, (_, index) => mp3Frame(index));

function syntheticMp3(): Buffer {
  return Buffer.concat([id3v2(), ...MP3_FRAMES, apeTag(), id3v1()]);
}

// --- WAV ----------------------------------------------------------------------

function riffChunk(id: string, body: Buffer | string): Buffer {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1');
  const head = Buffer.alloc(8);
  head.write(id, 0, 'latin1');
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, Buffer.alloc(data.length % 2)]);
}

const WAV_FMT = Buffer.concat([Buffer.from([1, 0, 1, 0]), u32le(8000, 16000), Buffer.from([2, 0, 16, 0])]);
const WAV_DATA = Buffer.from(Array.from({ length: 200 }, (_, index) => (index * 7) % 256));

function syntheticWav(): Buffer {
  const info = Buffer.concat([
    Buffer.from('INFO', 'latin1'),
    riffChunk('IART', `${MARK.riff}\0`),
    riffChunk('ICMT', `${MARK.comment}\0`),
    riffChunk('ICRD', '2026-10-21\0'),
    riffChunk('ISFT', `${MARK.software}\0`),
  ]);
  const bext = Buffer.alloc(602);
  bext.write(MARK.bext, 256, 'latin1');
  bext.write('2026-10-21', 320, 'latin1');
  const body = Buffer.concat([
    Buffer.from('WAVE', 'latin1'),
    riffChunk('fmt ', WAV_FMT),
    riffChunk('LIST', info),
    riffChunk('bext', bext),
    riffChunk('data', WAV_DATA),
    riffChunk('id3 ', Buffer.concat([id3v2()])),
    riffChunk('XYZ1', `${MARK.serial}x`),
  ]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body, Buffer.from(MARK.trailer, 'latin1')]);
}

// --- tests --------------------------------------------------------------------

/**
 * Set EVIDENCE_STRIP_DUMP_DIR to keep each synthetic original and its
 * derivative for an independent look (for example exiftool, ffprobe, Pillow).
 */
const dumped = new Map<string, Buffer>();
afterAll(() => {
  const dir = process.env.EVIDENCE_STRIP_DUMP_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of dumped) writeFileSync(join(dir, name), bytes);
});

let dumpIndex = 0;
function stripped(input: Buffer, mimeType: string) {
  const result = stripEvidenceMetadata(input, mimeType);
  if (result.outcome !== 'stripped') throw new Error(`expected stripped, got ${result.outcome}:${result.reason}`);
  const extension = { jpeg: 'jpg', png: 'png', isobmff: mimeType.includes('quicktime') ? 'mov' : mimeType.startsWith('audio') ? 'm4a' : 'mp4', mp3: 'mp3', wav: 'wav' }[result.format as string] ?? 'bin';
  dumpIndex += 1;
  dumped.set(`${String(dumpIndex).padStart(2, '0')}-original.${extension}`, input);
  dumped.set(`${String(dumpIndex).padStart(2, '0')}-derivative.${extension}`, result.output);
  return result;
}

describe('JPEG derivatives', () => {
  it('removes EXIF GPS, make/model, serial, XMP, IPTC, comments, ICC, MPF and trailers, keeping orientation and pixels', () => {
    const original = syntheticJpeg(6);
    expect(original.toString('latin1')).toContain(MARK.make);
    const result = stripped(original, 'image/jpeg');

    expect(result).toMatchObject({ format: 'jpeg', method: 'jpeg-segment-allowlist.v1', mimeType: 'image/jpeg' });
    expect(result.removed).toEqual(expect.arrayContaining([
      'exif', 'gps_location', 'device_make_model', 'device_serial', 'capture_timestamps', 'software', 'xmp', 'iptc',
      'comments', 'icc_profile', 'thumbnails', 'secondary_images', 'trailing_data', 'vendor_metadata',
    ]));
    expectNoMarkers(result.output, [
      MARK.make, MARK.model, MARK.serial, MARK.software, MARK.lens, MARK.owner, MARK.datetime, MARK.xmp, MARK.iptc,
      MARK.comment, MARK.icc, MARK.trailer, 'GPS', 'http://ns.adobe.com', 'Photoshop', 'ICC_PROFILE', 'MPF',
    ]);
    // SOI, JFIF, the orientation-only EXIF, then the coding segments untouched.
    expect(jpegMarkers(result.output)).toEqual([0xe0, 0xe1, 0xdb, 0xc0, 0xc4, 0xc4, 0xda, 0xd9]);
    const exif = result.output.subarray(20 + 4, 20 + 4 + 32);
    expect(exif.subarray(0, 6).toString('latin1')).toBe('Exif\0\0');
    expect(exif.readUInt16BE(6 + 8)).toBe(1); // exactly one IFD0 entry
    expect(exif.readUInt16BE(6 + 10)).toBe(0x0112); // Orientation
    expect(exif.readUInt16BE(6 + 18)).toBe(6);
    expect(exif.readUInt32BE(6 + 22)).toBe(0); // no next IFD

    const before = decodeFlatGrayJpeg(original);
    const after = decodeFlatGrayJpeg(result.output);
    expect(after).toEqual(before);
    expect(after).toMatchObject({ width: 32, height: 16 });
    expect(after.levels).toEqual(Array.from({ length: 8 }, (_, block) => blockLevel(block % 4, Math.floor(block / 4))));
  });

  it('writes no EXIF at all when the original has none or orientation 1', () => {
    for (const original of [syntheticJpeg(1), syntheticJpeg(null), encodeGrayJpeg(16, 8)]) {
      const result = stripped(original, 'image/jpeg');
      expect(jpegMarkers(result.output)).not.toContain(0xe1);
      expect(decodeFlatGrayJpeg(result.output).levels).toEqual(decodeFlatGrayJpeg(original).levels);
    }
    expect(stripped(encodeGrayJpeg(16, 8), 'image/jpeg').removed).toEqual([]);
  });

  it('rejects a derivative that still holds metadata or different image data', () => {
    const original = syntheticJpeg(6);
    expect(() => validateJpegDerivative(original, original)).toThrow(/after EOI/);
    const untrailed = original.subarray(0, original.indexOf(MARK.trailer));
    expect(() => validateJpegDerivative(original, untrailed)).toThrow(/gps_location.*device_make_model.*device_serial/);
    const clean = stripped(original, 'image/jpeg').output;
    const tampered = Buffer.from(clean);
    tampered[tampered.length - 3] ^= 0x01;
    expect(() => validateJpegDerivative(original, tampered)).toThrow(/image data differs/);
  });

  it('fails closed on truncated or mislabelled JPEGs', () => {
    const original = syntheticJpeg(6);
    expect(stripEvidenceMetadata(original.subarray(0, 300), 'image/jpeg')).toMatchObject({ outcome: 'failed', reason: 'parse_error' });
    expect(stripEvidenceMetadata(original, 'image/png')).toMatchObject({ outcome: 'failed', reason: 'type_mismatch' });
    expect(stripEvidenceMetadata(original, 'application/octet-stream').outcome).toBe('stripped');
  });
});

describe('PNG derivatives', () => {
  it('drops eXIf, tEXt/zTXt/iTXt, tIME, iCCP, private chunks and trailers; pixels decode identically', () => {
    const original = syntheticPng();
    const result = stripped(original, 'image/png');

    expect(result).toMatchObject({ format: 'png', method: 'png-chunk-allowlist.v1', mimeType: 'image/png' });
    expect(result.removed).toEqual(expect.arrayContaining([
      'exif', 'gps_location', 'device_make_model', 'device_serial', 'capture_timestamps', 'xmp', 'comments',
      'text_metadata', 'icc_profile', 'trailing_data', 'vendor_metadata',
    ]));
    expect(pngChunkTypes(result.output)).toEqual(['IHDR', 'gAMA', 'IDAT', 'IEND']);
    expectNoMarkers(result.output, [MARK.make, MARK.model, MARK.serial, MARK.comment, MARK.xmp, MARK.trailer, 'eXIf', 'tEXt', 'iTXt', 'tIME', 'GPS']);
    const decoded = decodePngPixels(result.output);
    expect(decoded).toMatchObject({ width: PNG_WIDTH, height: PNG_HEIGHT });
    expect(decoded.raw.equals(PNG_RAW)).toBe(true);
  });

  it('rejects a derivative with metadata chunks and fails closed on a bad CRC', () => {
    const original = syntheticPng();
    expect(() => validatePngDerivative(original, original.subarray(0, original.length - MARK.trailer.length))).toThrow(/exif|gps/);
    const corrupt = Buffer.from(original);
    corrupt[40] ^= 0xff;
    expect(stripEvidenceMetadata(corrupt, 'image/png')).toMatchObject({ outcome: 'failed', reason: 'parse_error' });
  });
});

describe('MP4 / MOV / M4A derivatives', () => {
  it.each([
    ['moov before mdat', {}],
    ['moov after mdat', { moovFirst: false }],
  ])('neutralises ©xyz, make/model, mdta keys, timed GPS tracks and leftovers (%s)', (_label, options: MovieOptions) => {
    const original = syntheticMovie(options);
    const result = stripped(original, 'video/mp4');

    expect(result).toMatchObject({ format: 'isobmff', method: 'isobmff-neutralize.v1', mimeType: 'video/mp4' });
    expect(result.removed).toEqual(expect.arrayContaining([
      'gps_location', 'device_make_model', 'capture_timestamps', 'xmp', 'container_metadata', 'timed_metadata_tracks',
      'unreferenced_media_data', 'free_space',
    ]));
    expectNoMarkers(result.output, MOVIE_MARKERS);
    expect(result.output.length).toBe(original.length);
    expect(topLevelTypes(result.output).filter(type => !['free'].includes(type))).toEqual(
      options.moovFirst === false ? ['ftyp', 'mdat', 'moov'] : ['ftyp', 'moov', 'mdat'],
    );
    // Audio and video samples are byte-identical at the offsets the untouched stco tables give.
    for (const sample of [...VIDEO_SAMPLES, AUDIO_SAMPLE]) {
      expect(result.output.indexOf(sample)).toBe(original.indexOf(sample));
    }
    // The creation time bytes are gone everywhere they were.
    expect(result.output.indexOf(u32(SYNTH_TIME))).toBe(-1);
  });

  it('keeps an audio-only M4A playable and labels it audio', () => {
    const original = syntheticMovie({ audioOnly: true, brand: 'M4A ' });
    const result = stripped(original, 'audio/mp4');
    expect(result.mimeType).toBe('audio/mp4');
    expectNoMarkers(result.output, [MARK.make, MARK.model, MARK.iso6709, MARK.leftover, MARK.xmp]);
    expect(result.output.indexOf(AUDIO_SAMPLE)).toBe(original.indexOf(AUDIO_SAMPLE));
  });

  it('labels a QuickTime brand as video/quicktime', () => {
    expect(stripped(syntheticMovie({ brand: 'qt  ' }), 'video/quicktime').mimeType).toBe('video/quicktime');
  });

  it.each([
    ['fragmented', { fragmented: true }],
    ['external data reference', { externalData: true }],
    ['a kept track referencing the removed GPS track', { videoReferencesMeta: true }],
    ['PCM audio', { pcmAudio: true }],
  ])('marks %s unsupported', (_label, options: MovieOptions) => {
    expect(stripEvidenceMetadata(syntheticMovie(options), 'video/mp4')).toMatchObject({ outcome: 'unsupported', reason: 'unsupported_variant' });
  });

  it('rejects a derivative that still holds metadata or changed media', () => {
    const original = syntheticMovie();
    expect(() => validateIsobmffDerivative(original, original)).toThrow();
    const clean = stripped(original, 'video/mp4').output;
    const tampered = Buffer.from(clean);
    tampered[clean.indexOf(VIDEO_SAMPLES[1])] ^= 0x01;
    expect(() => validateIsobmffDerivative(original, tampered)).toThrow(/media differs/);
  });
});

describe('MP3 derivatives', () => {
  it('keeps only the MPEG frames: ID3v2, APEv2 and ID3v1 are gone', () => {
    const original = syntheticMp3();
    const result = stripped(original, 'audio/mpeg');
    expect(result).toMatchObject({ format: 'mp3', method: 'mp3-frame-extract.v1', mimeType: 'audio/mpeg' });
    expect(result.removed).toEqual(['id3_tags', 'ape_tags']);
    expect(result.output.equals(Buffer.concat(MP3_FRAMES))).toBe(true);
    expectNoMarkers(result.output, ['ID3', 'TAG', 'APETAGEX', MARK.iso6709, MARK.comment, MARK.ape, MARK.id3v1, MARK.owner]);
    expect(() => validateMp3Derivative(original, original)).toThrow(/non-frame/);
  });
});

describe('WAV derivatives', () => {
  it('keeps fmt and data only and rebuilds the RIFF size', () => {
    const original = syntheticWav();
    const result = stripped(original, 'audio/wav');
    expect(result).toMatchObject({ format: 'wav', method: 'wav-chunk-allowlist.v1', mimeType: 'audio/wav' });
    expect(result.removed).toEqual(expect.arrayContaining([
      'capture_timestamps', 'software', 'comments', 'text_metadata', 'id3_tags', 'riff_info', 'broadcast_wave',
      'trailing_data', 'vendor_metadata',
    ]));
    expect(result.output.equals(Buffer.concat([
      Buffer.from('RIFF', 'latin1'), u32le(4 + 8 + WAV_FMT.length + 8 + WAV_DATA.length), Buffer.from('WAVE', 'latin1'),
      riffChunk('fmt ', WAV_FMT), riffChunk('data', WAV_DATA),
    ]))).toBe(true);
    expectNoMarkers(result.output, [MARK.riff, MARK.comment, MARK.software, MARK.bext, MARK.serial, MARK.trailer, 'LIST', 'bext', 'ID3']);
    expect(() => validateWavDerivative(original, original.subarray(0, original.length - MARK.trailer.length))).toThrow(/still holds/);
  });
});

describe('formats that are never shareable in phase 1', () => {
  it.each([
    ['HEIC', Buffer.concat([u32(24), Buffer.from('ftypheic', 'latin1'), u32(0), Buffer.from('mif1heic', 'latin1')]), 'image/heic', 'heif'],
    ['AVIF', Buffer.concat([u32(20), Buffer.from('ftypavif', 'latin1'), u32(0), Buffer.from('mif1', 'latin1')]), 'image/avif', 'heif'],
    ['PDF', Buffer.from('%PDF-1.7\n1 0 obj << /Author (SynthAuthor) >> endobj\n%%EOF', 'latin1'), 'application/pdf', 'pdf'],
    ['GIF', Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1'), 'image/gif', 'gif'],
    ['unknown bytes', Buffer.from('synthetic plain text evidence', 'latin1'), 'text/plain', 'unknown'],
  ])('%s is unsupported', (_label, bytes, mimeType, format) => {
    expect(sniffEvidenceFormat(bytes)).toBe(format);
    expect(stripEvidenceMetadata(bytes, mimeType)).toEqual({ outcome: 'unsupported', format, reason: 'unsupported_format' });
  });

  it('sniffs content, not the declared type', () => {
    expect(sniffEvidenceFormat(syntheticJpeg())).toBe('jpeg');
    expect(sniffEvidenceFormat(syntheticPng())).toBe('png');
    expect(sniffEvidenceFormat(syntheticMovie())).toBe('isobmff');
    expect(sniffEvidenceFormat(syntheticMp3())).toBe('mp3');
    expect(sniffEvidenceFormat(Buffer.concat(MP3_FRAMES))).toBe('mp3');
    expect(sniffEvidenceFormat(syntheticWav())).toBe('wav');
    expect(stripEvidenceMetadata(syntheticWav(), 'audio/mpeg')).toMatchObject({ outcome: 'failed', reason: 'type_mismatch' });
  });

  it('never returns output for unsupported or failed results', () => {
    const results = [
      stripEvidenceMetadata(Buffer.from('%PDF-1.4', 'latin1'), 'application/pdf'),
      stripEvidenceMetadata(syntheticJpeg().subarray(0, 100), 'image/jpeg'),
    ];
    for (const result of results) expect(result).not.toHaveProperty('output');
    expect(sha256(syntheticJpeg())).toBe(sha256(syntheticJpeg()));
  });
});

// --- crafted files from the independent review --------------------------------

/** The reviewer's canaries: none may survive in any stripped output. */
const CANARY = /SRC[A-Z0-9]{3,}|12\.3456|12,20\.736N|45\.6789/g;

function canaries(buf: Buffer): string[] {
  return [...new Set(buf.toString('latin1').match(CANARY) ?? [])];
}

type Located = { type: string; start: number; end: number };

function boxesIn(buf: Buffer, start: number, end: number): Located[] {
  const out: Located[] = [];
  for (let pos = start; pos + 8 <= end;) {
    const size = buf.readUInt32BE(pos);
    out.push({ type: buf.toString('latin1', pos + 4, pos + 8), start: pos, end: pos + size });
    if (size < 8) break;
    pos += size;
  }
  return out;
}

/** Follows a path such as ['moov', 'trak:1', 'mdia', 'minf', 'stbl', 'stsd'] and returns every box on it. */
function chain(buf: Buffer, path: string[]): Located[] {
  const found: Located[] = [];
  let [start, end] = [0, buf.length];
  for (const step of path) {
    const [type, index = '0'] = step.split(':');
    const next = boxesIn(buf, start, end).filter(item => item.type === type)[Number(index)];
    if (!next) throw new Error(`no ${step}`);
    found.push(next);
    [start, end] = [next.start + 8 + (type === 'stsd' ? 8 : 0), next.end];
  }
  return found;
}

/** Inserts bytes at `at` and grows every box in `ancestors` by their length. */
function insertInto(buf: Buffer, ancestors: Located[], at: number, bytes: Buffer): Buffer {
  const out = Buffer.concat([buf.subarray(0, at), bytes, buf.subarray(at)]);
  for (const ancestor of ancestors) out.writeUInt32BE(out.readUInt32BE(ancestor.start) + bytes.length, ancestor.start);
  return out;
}

function sampleEntry(buf: Buffer, track: number): Located[] {
  const path = chain(buf, ['moov', `trak:${track}`, 'mdia', 'minf', 'stbl', 'stsd']);
  return [...path, boxesIn(buf, path.at(-1)!.start + 16, path.at(-1)!.end)[0]];
}

const XMP_UUID = Buffer.from('be7acfcb97a942e89c71999491e3afac', 'hex');

describe('crafted movies from the review', () => {
  // moov after mdat, so growing moov never moves the sample data.
  const base = () => syntheticMovie({ moovFirst: false });

  it.each<[string, () => Buffer]>([
    ['a second ftyp', () => Buffer.concat([base(), box('ftyp', Buffer.from('isom', 'latin1'), u32(0), Buffer.from('SRCFTYP2 +12.3456+045.6789/', 'latin1'))])],
    ['a vendor box in stbl', () => {
      const path = chain(base(), ['moov', 'trak:0', 'mdia', 'minf', 'stbl']);
      return insertInto(base(), path, path.at(-1)!.end, box('zzzz', Buffer.from('SRCSTBLVENDOR lat=12,20.736N', 'latin1')));
    }],
    ['XMP in an sgpd box in stbl', () => {
      const path = chain(base(), ['moov', 'trak:0', 'mdia', 'minf', 'stbl']);
      return insertInto(base(), path, path.at(-1)!.end, box('sgpd', Buffer.from('<x:xmpmeta>SRCSGPD 12,20.736N</x:xmpmeta>', 'latin1')));
    }],
    ['trailing bytes after the stts entries', () => {
      const path = chain(base(), ['moov', 'trak:0', 'mdia', 'minf', 'stbl', 'stts']);
      return insertInto(base(), path, path.at(-1)!.end, Buffer.from('SRCSTTSPAD', 'latin1'));
    }],
    ['udta with ©xyz in the audio sample entry', () => {
      const path = sampleEntry(base(), 1);
      return insertInto(base(), path, path.at(-1)!.end, box('udta', box('\xa9xyz', u32(0x00120000), Buffer.from('+12.3456+045.6789/', 'latin1'))));
    }],
    ['XMP uuid in the audio sample entry', () => {
      const path = sampleEntry(base(), 1);
      return insertInto(base(), path, path.at(-1)!.end, box('uuid', XMP_UUID, Buffer.from('<x:xmpmeta exif:GPSLatitude="12,20.736N" tiff:Make="SRCAUDIOENTRYMAKE"/>', 'latin1')));
    }],
    ['XMP uuid in the video sample entry', () => {
      const path = sampleEntry(base(), 0);
      return insertInto(base(), path, path.at(-1)!.end, box('uuid', XMP_UUID, Buffer.from('<x:xmpmeta tiff:Make="SRCVIDEOENTRYMAKE"/>', 'latin1')));
    }],
    ['a path in a self-contained dref url', () => {
      const path = chain(base(), ['moov', 'trak:0', 'mdia', 'minf', 'dinf', 'dref']);
      const out = insertInto(base(), path, path.at(-1)!.end, fullBox('url ', 0, 1, Buffer.from('file:///Users/SRCDREFUSER/DCIM/', 'latin1')));
      out.writeUInt32BE(out.readUInt32BE(path.at(-1)!.start + 12) + 1, path.at(-1)!.start + 12);
      return out;
    }],
    ['a gmhd box in a video minf', () => {
      const path = chain(base(), ['moov', 'trak:0', 'mdia', 'minf']);
      return insertInto(base(), path, path.at(-1)!.end, box('gmhd', box('gmin', Buffer.from('SRCGMHD', 'latin1'))));
    }],
    ['an elng language tag', () => {
      const path = chain(base(), ['moov', 'trak:0', 'mdia']);
      return insertInto(base(), path, path.at(-1)!.end, fullBox('elng', 0, 0, Buffer.from('sw-KE-x-SRCELNG\0', 'latin1')));
    }],
    ['an unknown compatible brand', () => {
      const movie = base();
      movie.write('SRCB', 16, 'latin1'); // first compatible brand
      return movie;
    }],
    ['vendor codes in the sample entries', () => {
      const movie = base();
      const video = sampleEntry(movie, 0).at(-1)!;
      const audio = sampleEntry(movie, 1).at(-1)!;
      movie.write('SRCV', video.start + 20, 'latin1');
      movie.write('SRCA', audio.start + 20, 'latin1');
      return movie;
    }],
  ])('neutralises %s', (_label, build) => {
    const input = build();
    expect(canaries(input).length).toBeGreaterThan(0);
    const result = stripped(input, 'video/mp4');
    expect(canaries(result.output)).toEqual([]);
    expect(() => validateIsobmffDerivative(input, input)).toThrow();
  });

  it.each<[string, () => Buffer]>([
    ['junk bytes after a sample-entry box', () => {
      const path = sampleEntry(base(), 0);
      return insertInto(base(), path, path.at(-1)!.end, Buffer.concat([box('uuid', XMP_UUID, Buffer.from('SRCJUNKXMP', 'latin1')), Buffer.from([1, 2, 3])]));
    }],
    ['extra bytes in tkhd', () => {
      const path = chain(base(), ['moov', 'trak:0', 'tkhd']);
      return insertInto(base(), path, path.at(-1)!.end - 8, Buffer.from('SRCTKHDEXTRA', 'latin1'));
    }],
  ])('fails closed on %s', (_label, build) => {
    expect(stripEvidenceMetadata(build(), 'video/mp4')).toMatchObject({ outcome: 'failed', reason: 'parse_error' });
  });
});

describe('crafted images and audio from the review', () => {
  it('refuses a JPEG DQT padded with extra bytes', () => {
    const jpeg = encodeGrayJpeg(16, 8);
    let pos = 2;
    while (jpeg[pos + 1] !== 0xdb) pos += 2 + jpeg.readUInt16BE(pos + 2);
    const length = jpeg.readUInt16BE(pos + 2);
    const extra = Buffer.from('SRCDQTEXTRA+12.3456+045.6789/', 'latin1');
    const out = Buffer.concat([jpeg.subarray(0, pos + 2 + length), extra, jpeg.subarray(pos + 2 + length)]);
    out.writeUInt16BE(length + extra.length, pos + 2);
    expect(stripEvidenceMetadata(out, 'image/jpeg')).toMatchObject({ outcome: 'failed', reason: 'parse_error' });
  });

  it('refuses a PNG pHYs chunk with extra bytes', () => {
    const png = syntheticPng();
    const phys = pngChunk('pHYs', Buffer.concat([Buffer.from([0, 0, 0x0b, 0x13, 0, 0, 0x0b, 0x13, 1]), Buffer.from('SRCPHYSEXTRA', 'latin1')]));
    const out = Buffer.concat([png.subarray(0, 33), phys, png.subarray(33)]);
    expect(stripEvidenceMetadata(out, 'image/png')).toMatchObject({ outcome: 'failed', reason: 'parse_error' });
  });

  it('refuses a WAV fact chunk or fmt chunk carrying extra bytes, and compressed WAV', () => {
    const wav = syntheticWav();
    const withChunk = (chunk: Buffer) => {
      const out = Buffer.concat([wav.subarray(0, 12), chunk, wav.subarray(12, wav.length - MARK.trailer.length)]);
      out.writeUInt32LE(out.length - 8, 4);
      return out;
    };
    expect(stripEvidenceMetadata(withChunk(riffChunk('fact', 'SRCFACT+12.3456+045.6789/12345')), 'audio/wav'))
      .toMatchObject({ outcome: 'failed', reason: 'parse_error' });
    const paddedFmt = Buffer.concat([WAV_FMT, Buffer.from([4, 0]), Buffer.from('SRCF', 'latin1')]);
    const padded = Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVE', 'latin1'), riffChunk('fmt ', paddedFmt), riffChunk('data', WAV_DATA)]);
    padded.writeUInt32LE(padded.length - 8, 4);
    expect(stripEvidenceMetadata(padded, 'audio/wav')).toMatchObject({ outcome: 'failed', reason: 'parse_error' });
    const adpcmFmt = Buffer.from(WAV_FMT);
    adpcmFmt.writeUInt16LE(0x11, 0);
    const adpcm = Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVE', 'latin1'), riffChunk('fmt ', adpcmFmt), riffChunk('data', WAV_DATA)]);
    adpcm.writeUInt32LE(adpcm.length - 8, 4);
    expect(stripEvidenceMetadata(adpcm, 'audio/wav')).toMatchObject({ outcome: 'unsupported', reason: 'unsupported_variant' });
  });

  it('drops the MP3 Xing/LAME header frame and keeps the audio frames', () => {
    const header = mp3Frame(99);
    header.fill(0, 4);
    header.write('Info', 4 + 17, 'latin1'); // mono MPEG-1: 17 bytes of side information
    header.write('LAME3.100', 4 + 17 + 120, 'latin1');
    const input = Buffer.concat([id3v2(), header, ...MP3_FRAMES]);
    const result = stripped(input, 'audio/mpeg');
    expect(result.output.equals(Buffer.concat(MP3_FRAMES))).toBe(true);
    expect(result.removed).toEqual(['software', 'id3_tags']);
    expectNoMarkers(result.output, ['Info', 'LAME']);
    expect(() => validateMp3Derivative(input, Buffer.concat([header, ...MP3_FRAMES]))).toThrow(/header frame/);
  });
});

describe('resource limits', () => {
  const trakShape = (samples: number, chunks: number, perChunk: number, constant: number) => box('trak',
    fullBox('tkhd', 0, 0, Buffer.alloc(80)),
    box('mdia', fullBox('mdhd', 0, 0, Buffer.alloc(20)), fullBox('hdlr', 0, 0, u32(0), Buffer.from('vide', 'latin1'), Buffer.alloc(12), Buffer.from('\0', 'latin1')),
      box('minf', fullBox('vmhd', 0, 1, Buffer.alloc(8)), box('stbl', fullBox('stsd', 0, 0, u32(0)),
        fullBox('stco', 0, 0, u32(chunks), Buffer.alloc(chunks * 4)), fullBox('stsc', 0, 0, u32(1), u32(1), u32(perChunk), u32(1)),
        fullBox('stsz', 0, 0, u32(constant), u32(samples))))));
  const movie = (traks: Buffer[]) => Buffer.concat([
    box('ftyp', Buffer.from('isom', 'latin1'), u32(0), Buffer.from('isom', 'latin1')),
    box('moov', fullBox('mvhd', 0, 0, Buffer.alloc(96)), ...traks),
    box('mdat', Buffer.from('x', 'latin1')),
  ]);

  it.each<[string, () => Buffer, string]>([
    ['one track claiming 2^32-1 constant-size samples', () => movie([trakShape(0xffffffff, 1, 0xffffffff, 1)]), 'parse_error'],
    ['five such tracks', () => movie(Array(5).fill(trakShape(0xffffffff, 1, 0xffffffff, 1))), 'parse_error'],
    ['600,000 chunk offsets', () => movie([trakShape(600_000, 600_000, 1, 1)]), 'resource_limit'],
    ['5,000 tracks', () => movie(Array(5000).fill(box('trak', box('mdia', fullBox('hdlr', 0, 0, u32(0), Buffer.from('vide', 'latin1'), Buffer.alloc(12)))))), 'resource_limit'],
  ])('fails a movie with %s quickly', (_label, build, reason) => {
    const input = build();
    const started = Date.now();
    expect(stripEvidenceMetadata(input, 'video/mp4')).toMatchObject({ outcome: 'failed', reason });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('fails JPEG, PNG and WAV files made of floods of tiny segments or chunks', () => {
    const jpeg = encodeGrayJpeg(16, 8);
    const comments = Buffer.concat(Array.from({ length: 12_000 }, () => segment(0xfe, Buffer.alloc(0))));
    expect(stripEvidenceMetadata(Buffer.concat([jpeg.subarray(0, 2), comments, jpeg.subarray(2)]), 'image/jpeg'))
      .toMatchObject({ outcome: 'failed', reason: 'resource_limit' });
    const png = syntheticPng();
    const chunks = Buffer.concat(Array.from({ length: 260_000 }, () => pngChunk('zzZz', Buffer.alloc(0))));
    expect(stripEvidenceMetadata(Buffer.concat([png.subarray(0, 33), chunks, png.subarray(33)]), 'image/png'))
      .toMatchObject({ outcome: 'failed', reason: 'resource_limit' });
    const junk = Buffer.concat(Array.from({ length: 11_000 }, () => riffChunk('JUNK', Buffer.alloc(0))));
    const wav = Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVE', 'latin1'), riffChunk('fmt ', WAV_FMT), junk, riffChunk('data', WAV_DATA)]);
    wav.writeUInt32LE(wav.length - 8, 4);
    expect(stripEvidenceMetadata(wav, 'audio/wav')).toMatchObject({ outcome: 'failed', reason: 'resource_limit' });
  });
});
