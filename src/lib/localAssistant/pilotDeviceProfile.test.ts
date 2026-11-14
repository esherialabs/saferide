import { afterEach, describe, expect, it } from 'vitest';

import {
  LOCAL_AI_MIN_RAM_GB,
  __setLocalAiDeviceProvidersForTests,
  bucketFreeStorageBytes,
  checkLocalAiRamRequirement,
  deviceClassForRamBucket,
  estimateInstalledRamClassGb,
  evaluateLocalAiRamRequirement,
  loadLocalAiDeviceFacts,
  normalizeLocalAiDeviceFacts,
  sanitizeDeviceLabel,
} from './pilotDeviceProfile';

const GIB = 1024 ** 3;

describe('local AI RAM warning logic', () => {
  afterEach(() => {
    __setLocalAiDeviceProvidersForTests();
  });

  it('maps Android-reported usable RAM to the marketed installed-RAM class', () => {
    expect(estimateInstalledRamClassGb(7.3 * GIB)).toBe(8);
    expect(estimateInstalledRamClassGb(7.9 * GIB)).toBe(8);
    expect(estimateInstalledRamClassGb(5.5 * GIB)).toBe(6);
    expect(estimateInstalledRamClassGb(3.6 * GIB)).toBe(4);
    expect(estimateInstalledRamClassGb(2.7 * GIB)).toBe(3);
    expect(estimateInstalledRamClassGb(1.8 * GIB)).toBe(2);
    expect(estimateInstalledRamClassGb(11.2 * GIB)).toBe(12);
    expect(estimateInstalledRamClassGb(null)).toBeNull();
    expect(estimateInstalledRamClassGb(0)).toBeNull();
    expect(estimateInstalledRamClassGb(Number.NaN)).toBeNull();
  });

  it('warns below the 8 GB guidance and not on a typical 8 GB phone', () => {
    expect(LOCAL_AI_MIN_RAM_GB).toBe(8);
    expect(evaluateLocalAiRamRequirement(7.3 * GIB)).toEqual({
      known: true,
      ramClassGb: 8,
      ramBucket: '8gb-plus',
      minimumRamGb: 8,
      belowMinimum: false,
    });
    expect(evaluateLocalAiRamRequirement(5.5 * GIB)).toMatchObject({
      ramClassGb: 6,
      ramBucket: '6-8gb',
      belowMinimum: true,
    });
    expect(evaluateLocalAiRamRequirement(3.6 * GIB)).toMatchObject({ ramBucket: '4gb', belowMinimum: true });
    expect(evaluateLocalAiRamRequirement(2.7 * GIB)).toMatchObject({ ramBucket: '2-3gb', belowMinimum: true });
  });

  it('does not claim a shortfall when RAM cannot be read', async () => {
    expect(evaluateLocalAiRamRequirement(undefined)).toEqual({
      known: false,
      ramClassGb: null,
      ramBucket: 'unknown',
      minimumRamGb: 8,
      belowMinimum: false,
    });

    __setLocalAiDeviceProvidersForTests({
      deviceFacts: async () => {
        throw new Error('native module missing');
      },
    });
    await expect(checkLocalAiRamRequirement()).resolves.toMatchObject({ known: false, belowMinimum: false });
  });

  it('reads RAM through the injected device provider', async () => {
    __setLocalAiDeviceProvidersForTests({
      deviceFacts: async () => ({ totalMemory: 3.6 * GIB }),
    });
    await expect(checkLocalAiRamRequirement()).resolves.toMatchObject({
      known: true,
      ramClassGb: 4,
      belowMinimum: true,
    });
  });

  it('maps RAM buckets to the device matrix classes', () => {
    expect(deviceClassForRamBucket('lt-2gb')).toBe('android-2-3gb');
    expect(deviceClassForRamBucket('2-3gb')).toBe('android-2-3gb');
    expect(deviceClassForRamBucket('4gb')).toBe('android-4gb');
    expect(deviceClassForRamBucket('6-8gb')).toBe('android-6-8gb');
    expect(deviceClassForRamBucket('8gb-plus')).toBe('android-8gb-plus');
    expect(deviceClassForRamBucket('unknown')).toBe('android-unknown');
  });

  it('buckets free storage around the 5 GB model size', () => {
    expect(bucketFreeStorageBytes(1.5e9)).toBe('lt-2gb');
    expect(bucketFreeStorageBytes(4.9e9)).toBe('2-5gb');
    expect(bucketFreeStorageBytes(5.5e9)).toBe('5-6gb');
    expect(bucketFreeStorageBytes(7e9)).toBe('6-8gb');
    expect(bucketFreeStorageBytes(12e9)).toBe('8-16gb');
    expect(bucketFreeStorageBytes(20e9)).toBe('16-32gb');
    expect(bucketFreeStorageBytes(64e9)).toBe('32gb-plus');
    expect(bucketFreeStorageBytes(undefined)).toBe('unknown');
    expect(bucketFreeStorageBytes(-1)).toBe('unknown');
  });

  it('keeps only short hardware labels and never reads the user-set device name', async () => {
    expect(sanitizeDeviceLabel('SM-A546E')).toBe('SM-A546E');
    expect(sanitizeDeviceLabel('Pixel 7a')).toBe('Pixel 7a');
    expect(sanitizeDeviceLabel('<script>"x"</script>')).toBe('scriptxscript');
    expect(sanitizeDeviceLabel('a'.repeat(80))).toHaveLength(40);
    expect(sanitizeDeviceLabel(42)).toBeNull();

    const facts = normalizeLocalAiDeviceFacts({
      manufacturer: 'Synthetic',
      modelName: 'Test Phone 6',
      osVersion: '14',
      platformApiLevel: 34,
      totalMemory: 5.5 * GIB,
      deviceName: "Synthetic Person's phone",
    } as Parameters<typeof normalizeLocalAiDeviceFacts>[0]);
    expect(facts).toEqual({
      manufacturer: 'Synthetic',
      model: 'Test Phone 6',
      androidVersion: '14',
      apiLevel: 34,
      ramClassGb: 6,
      ramBucket: '6-8gb',
    });
    expect(JSON.stringify(facts)).not.toContain('Person');

    __setLocalAiDeviceProvidersForTests({ deviceFacts: async () => ({ manufacturer: 'Synthetic' }) });
    await expect(loadLocalAiDeviceFacts()).resolves.toMatchObject({ manufacturer: 'Synthetic', ramBucket: 'unknown' });
  });
});
