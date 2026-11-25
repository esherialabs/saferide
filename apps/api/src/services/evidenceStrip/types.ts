/**
 * Shared vocabulary for the evidence metadata-stripping pipeline. Every value
 * here is a category or code name: nothing in a result ever carries a tag
 * value, a coordinate, a device name or file content.
 */

/** What a derivative record may say was removed. Mirrored by migration 009. */
export const REMOVED_CATEGORIES = [
  'exif',
  'gps_location',
  'device_make_model',
  'device_serial',
  'capture_timestamps',
  'software',
  'maker_notes',
  'xmp',
  'iptc',
  'comments',
  'text_metadata',
  'icc_profile',
  'thumbnails',
  'secondary_images',
  'trailing_data',
  'vendor_metadata',
  'container_metadata',
  'timed_metadata_tracks',
  'unreferenced_media_data',
  'free_space',
  'id3_tags',
  'ape_tags',
  'riff_info',
  'broadcast_wave',
] as const;
export type RemovedCategory = typeof REMOVED_CATEGORIES[number];

/** The container family detected from the bytes, never from the client's MIME type alone. */
export const SOURCE_FORMATS = [
  'jpeg', 'png', 'isobmff', 'mp3', 'wav', 'heif', 'pdf', 'gif', 'webp', 'unknown',
] as const;
export type SourceFormat = typeof SOURCE_FORMATS[number];

/** Versioned so a later, stricter method can find and regenerate older derivatives. */
export const STRIP_METHODS = [
  'jpeg-segment-allowlist.v1',
  'png-chunk-allowlist.v1',
  'isobmff-neutralize.v1',
  'mp3-frame-extract.v1',
  'wav-chunk-allowlist.v1',
] as const;
export type StripMethod = typeof STRIP_METHODS[number];

export type UnsupportedReason = 'unsupported_format' | 'unsupported_variant';
export type StripFailureReason = 'type_mismatch' | 'parse_error' | 'validation_failed' | 'resource_limit';

export type StripOutcome =
  | {
      outcome: 'stripped';
      format: SourceFormat;
      method: StripMethod;
      mimeType: string;
      output: Buffer;
      removed: RemovedCategory[];
    }
  | { outcome: 'unsupported'; format: SourceFormat; reason: UnsupportedReason }
  | { outcome: 'failed'; format: SourceFormat; reason: StripFailureReason };

/** The bytes do not form the structure the parser needs. Never carries content. */
export class EvidenceParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceParseError';
  }
}

/** A well-formed file uses a feature this phase does not strip safely: never shareable. */
export class UnsupportedVariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedVariantError';
  }
}

/**
 * The file asks for more work or memory than any real recording needs (box,
 * chunk, segment or track counts; the sandbox's time or heap budget). Fail
 * closed and do not retry.
 */
export class ResourceLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResourceLimitError';
  }
}

/** The re-parsed derivative still holds metadata or lost media bytes. Fail closed. */
export class DerivativeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DerivativeValidationError';
  }
}

export function sortedCategories(categories: Iterable<RemovedCategory>): RemovedCategory[] {
  const present = new Set(categories);
  return REMOVED_CATEGORIES.filter(category => present.has(category));
}
