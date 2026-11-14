/**
 * Coarse, content-free device facts for the local AI pilot.
 *
 * Only manufacturer/model, OS version, and bucketed RAM/free-storage ranges
 * leave this module. Exact byte counts stay in memory, and the user-chosen
 * device name (`Device.deviceName`) is never read.
 */
import type { TunedArtifactDeviceClass } from './qaDiagnostics';

/** Gemma 4 E2B pilot guidance: phones below this installed-RAM class are expected to struggle. */
export const LOCAL_AI_MIN_RAM_GB = 8;

const BYTES_PER_GIB = 1024 ** 3;
const BYTES_PER_GB = 1_000_000_000;
// Android reports usable RAM (kernel/carve-outs excluded), so an "8 GB" phone
// reports roughly 7.0-7.8 GiB. Map to the smallest marketed class that fits.
const MARKETED_RAM_CLASSES_GB = [1, 1.5, 2, 3, 4, 6, 8, 10, 12, 16, 18, 24, 32] as const;
const RAM_CLASS_TOLERANCE_GIB = 0.05;

export const LOCAL_AI_RAM_BUCKETS = ['lt-2gb', '2-3gb', '4gb', '6-8gb', '8gb-plus', 'unknown'] as const;
export type LocalAiRamBucket = typeof LOCAL_AI_RAM_BUCKETS[number];

export const LOCAL_AI_FREE_STORAGE_BUCKETS = [
  'lt-2gb',
  '2-5gb',
  '5-6gb',
  '6-8gb',
  '8-16gb',
  '16-32gb',
  '32gb-plus',
  'unknown',
] as const;
export type LocalAiFreeStorageBucket = typeof LOCAL_AI_FREE_STORAGE_BUCKETS[number];

export type RawLocalAiDeviceFacts = {
  manufacturer?: string | null;
  modelName?: string | null;
  osVersion?: string | null;
  platformApiLevel?: number | null;
  totalMemory?: number | null;
};

export type LocalAiDeviceFacts = {
  manufacturer: string | null;
  model: string | null;
  androidVersion: string | null;
  apiLevel: number | null;
  ramClassGb: number | null;
  ramBucket: LocalAiRamBucket;
};

export type LocalAiRamRequirement = {
  known: boolean;
  ramClassGb: number | null;
  ramBucket: LocalAiRamBucket;
  minimumRamGb: number;
  belowMinimum: boolean;
};

type DeviceFactsProvider = () => Promise<RawLocalAiDeviceFacts>;
type FreeStorageProvider = () => Promise<number>;

async function defaultDeviceFactsProvider(): Promise<RawLocalAiDeviceFacts> {
  const Device = await import('expo-device');
  return {
    manufacturer: Device.manufacturer,
    modelName: Device.modelName,
    osVersion: Device.osVersion,
    platformApiLevel: Device.platformApiLevel,
    totalMemory: Device.totalMemory,
  };
}

async function defaultFreeStorageProvider(): Promise<number> {
  const FileSystem = await import('expo-file-system/legacy');
  return FileSystem.getFreeDiskStorageAsync();
}

let deviceFactsProvider: DeviceFactsProvider = defaultDeviceFactsProvider;
let freeStorageProvider: FreeStorageProvider = defaultFreeStorageProvider;
let cachedDeviceFacts: LocalAiDeviceFacts | null = null;
let pendingDeviceFacts: Promise<LocalAiDeviceFacts> | null = null;

/** Keeps short hardware labels only; strips anything that could carry free text. */
export function sanitizeDeviceLabel(value: unknown, maxLength = 40): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[^A-Za-z0-9 ._()+-]/g, '').replace(/\s+/g, ' ').trim().slice(0, maxLength).trim();
  return cleaned || null;
}

export function estimateInstalledRamClassGb(totalMemoryBytes: number | null | undefined): number | null {
  if (typeof totalMemoryBytes !== 'number' || !Number.isFinite(totalMemoryBytes) || totalMemoryBytes <= 0) {
    return null;
  }
  const gib = totalMemoryBytes / BYTES_PER_GIB;
  for (const ramClass of MARKETED_RAM_CLASSES_GB) {
    if (gib <= ramClass + RAM_CLASS_TOLERANCE_GIB) return ramClass;
  }
  return Math.ceil(gib);
}

export function bucketRamClass(ramClassGb: number | null): LocalAiRamBucket {
  if (ramClassGb === null) return 'unknown';
  if (ramClassGb < 2) return 'lt-2gb';
  if (ramClassGb < 4) return '2-3gb';
  if (ramClassGb < 6) return '4gb';
  if (ramClassGb < LOCAL_AI_MIN_RAM_GB) return '6-8gb';
  return '8gb-plus';
}

export function deviceClassForRamBucket(bucket: LocalAiRamBucket): TunedArtifactDeviceClass {
  switch (bucket) {
    case 'lt-2gb':
    case '2-3gb':
      return 'android-2-3gb';
    case '4gb':
      return 'android-4gb';
    case '6-8gb':
      return 'android-6-8gb';
    case '8gb-plus':
      return 'android-8gb-plus';
    default:
      return 'android-unknown';
  }
}

export function evaluateLocalAiRamRequirement(
  totalMemoryBytes: number | null | undefined,
  minimumRamGb = LOCAL_AI_MIN_RAM_GB,
): LocalAiRamRequirement {
  const ramClassGb = estimateInstalledRamClassGb(totalMemoryBytes);
  return {
    known: ramClassGb !== null,
    ramClassGb,
    ramBucket: bucketRamClass(ramClassGb),
    minimumRamGb,
    // Unknown RAM is not treated as "below": the warning must describe a real measurement.
    belowMinimum: ramClassGb !== null && ramClassGb < minimumRamGb,
  };
}

export function bucketFreeStorageBytes(bytes: number | null | undefined): LocalAiFreeStorageBucket {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return 'unknown';
  const gb = bytes / BYTES_PER_GB;
  if (gb < 2) return 'lt-2gb';
  if (gb < 5) return '2-5gb';
  if (gb < 6) return '5-6gb';
  if (gb < 8) return '6-8gb';
  if (gb < 16) return '8-16gb';
  if (gb < 32) return '16-32gb';
  return '32gb-plus';
}

export function normalizeLocalAiDeviceFacts(raw: RawLocalAiDeviceFacts): LocalAiDeviceFacts {
  const ramClassGb = estimateInstalledRamClassGb(raw.totalMemory);
  const apiLevel = typeof raw.platformApiLevel === 'number'
    && Number.isInteger(raw.platformApiLevel)
    && raw.platformApiLevel > 0
    && raw.platformApiLevel < 1000
    ? raw.platformApiLevel
    : null;
  return {
    manufacturer: sanitizeDeviceLabel(raw.manufacturer),
    model: sanitizeDeviceLabel(raw.modelName),
    androidVersion: sanitizeDeviceLabel(raw.osVersion, 16),
    apiLevel,
    ramClassGb,
    ramBucket: bucketRamClass(ramClassGb),
  };
}

const UNKNOWN_DEVICE_FACTS: LocalAiDeviceFacts = {
  manufacturer: null,
  model: null,
  androidVersion: null,
  apiLevel: null,
  ramClassGb: null,
  ramBucket: 'unknown',
};

/** Reads device facts once per process; failures resolve to "unknown" rather than throwing. */
export async function loadLocalAiDeviceFacts(): Promise<LocalAiDeviceFacts> {
  if (cachedDeviceFacts) return cachedDeviceFacts;
  if (!pendingDeviceFacts) {
    pendingDeviceFacts = deviceFactsProvider()
      .then(raw => normalizeLocalAiDeviceFacts(raw))
      .catch(() => UNKNOWN_DEVICE_FACTS)
      .then(facts => {
        cachedDeviceFacts = facts;
        return facts;
      })
      .finally(() => {
        pendingDeviceFacts = null;
      });
  }
  return pendingDeviceFacts;
}

export function getCachedLocalAiDeviceFacts(): LocalAiDeviceFacts | null {
  return cachedDeviceFacts;
}

export async function readLocalAiFreeStorageBucket(): Promise<LocalAiFreeStorageBucket> {
  try {
    return bucketFreeStorageBytes(await freeStorageProvider());
  } catch {
    return 'unknown';
  }
}

export async function checkLocalAiRamRequirement(): Promise<LocalAiRamRequirement> {
  let totalMemory: number | null | undefined = null;
  try {
    totalMemory = (await deviceFactsProvider()).totalMemory;
  } catch {
    totalMemory = null;
  }
  void loadLocalAiDeviceFacts();
  return evaluateLocalAiRamRequirement(totalMemory);
}

export function __setLocalAiDeviceProvidersForTests(providers: {
  deviceFacts?: DeviceFactsProvider | null;
  freeStorage?: FreeStorageProvider | null;
} = {}): void {
  deviceFactsProvider = providers.deviceFacts ?? defaultDeviceFactsProvider;
  freeStorageProvider = providers.freeStorage ?? defaultFreeStorageProvider;
  cachedDeviceFacts = null;
  pendingDeviceFacts = null;
}
