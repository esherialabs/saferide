import AsyncStorage from '@react-native-async-storage/async-storage';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const kdfRuns = vi.hoisted(() => ({ count: 0 }));

vi.mock('@noble/hashes/pbkdf2.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@noble/hashes/pbkdf2.js')>();
  return {
    ...actual,
    pbkdf2Async: (...args: Parameters<typeof actual.pbkdf2Async>) => {
      kdfRuns.count += 1;
      return actual.pbkdf2Async(...args);
    },
  };
});

const mockState = vi.hoisted(() => ({
  secureItems: new Map<string, string>(),
  platform: 'ios' as 'ios' | 'android' | 'web',
  secureStoreAvailable: true,
  localAuthLevel: 1,
  localAuthThrows: false,
  randomCounter: 1,
  digest(data: string) {
    let hash = 0;
    for (let i = 0; i < data.length; i += 1) {
      hash = (hash * 31 + data.charCodeAt(i)) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  },
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return mockState.platform;
    },
  },
}));

vi.mock('expo-secure-store', () => ({
  isAvailableAsync: vi.fn(async () => mockState.secureStoreAvailable),
  getItemAsync: vi.fn(async (key: string) => mockState.secureItems.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    mockState.secureItems.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    mockState.secureItems.delete(key);
  }),
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
}));

vi.mock('expo-local-authentication', () => ({
  SecurityLevel: {
    NONE: 0,
    SECRET: 1,
    BIOMETRIC_WEAK: 2,
    BIOMETRIC_STRONG: 3,
  },
  getEnrolledLevelAsync: vi.fn(async () => {
    if (mockState.localAuthThrows) {
      throw new Error('local auth unavailable');
    }
    return mockState.localAuthLevel;
  }),
  hasHardwareAsync: vi.fn(async () => mockState.localAuthLevel > 0),
  isEnrolledAsync: vi.fn(async () => mockState.localAuthLevel > 0),
  authenticateAsync: vi.fn(async () => ({ success: true })),
}));

vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  CryptoEncoding: { HEX: 'hex' },
  getRandomBytesAsync: vi.fn(async (length: number) => {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) {
      bytes[i] = (mockState.randomCounter + i) % 256;
    }
    mockState.randomCounter += length;
    return bytes;
  }),
  digestStringAsync: vi.fn(async (_algorithm: string, data: string) => mockState.digest(data)),
}));

import { DecoyCalculator, DecoyPinManager } from '../decoyPin';

const DECOY_PIN_KEY = 'safe_ride_decoy_pin';
const DECOY_PIN_ATTEMPTS_KEY = 'safe_ride_decoy_pin_attempts';
const ITERATIONS = 5_000;
const T0 = 1_785_568_642_927;

function readStoredConfig(): Record<string, unknown> {
  return JSON.parse(mockState.secureItems.get(DECOY_PIN_KEY) ?? '{}') as Record<string, unknown>;
}

function readAttempts(): Record<string, number> | null {
  const raw = mockState.secureItems.get(DECOY_PIN_ATTEMPTS_KEY);
  return raw ? JSON.parse(raw) as Record<string, number> : null;
}

function expectedPbkdf2(pin: string, salt: string, iterations: number): string {
  return bytesToHex(pbkdf2(sha256, pin, salt, { c: iterations, dkLen: 32 }));
}

function storeLegacySecureVerifier(pin: string, salt: string, requireToExit = false): void {
  mockState.secureItems.set(DECOY_PIN_KEY, JSON.stringify({
    hashedPin: mockState.digest(`${pin}${salt}`),
    requireToExit,
    salt,
    createdAt: 7,
  }));
}

async function failTimes(manager: DecoyPinManager, pin: string, times: number): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    expect(await manager.verifyPin(pin)).toBe(false);
  }
}

/** Presses calculator keys; returns whether any "=" press unlocked. */
async function press(calculator: DecoyCalculator, keys: string): Promise<boolean> {
  let unlocked = false;
  for (const key of keys) {
    if (/\d/.test(key)) await calculator.inputNumber(key);
    else if (key === '.') calculator.inputDecimal();
    else if (key === 'C') calculator.clear();
    else if (key === '<') calculator.backspace();
    else if (key === '=') unlocked = (await calculator.submit()).shouldUnlock || unlocked;
    else calculator.inputOperation(key);
  }
  return unlocked;
}

describe('DecoyPinManager', () => {
  beforeEach(() => {
    mockState.secureItems.clear();
    mockState.platform = 'ios';
    mockState.secureStoreAvailable = true;
    mockState.localAuthLevel = 1;
    mockState.localAuthThrows = false;
    mockState.randomCounter = 1;
    kdfRuns.count = 0;
  });

  afterEach(() => vi.restoreAllMocks());

  it('stores the decoy PIN verifier in native secure storage, not AsyncStorage', async () => {
    const manager = DecoyPinManager.getInstance();
    vi.spyOn(Date, 'now').mockReturnValue(T0);

    await manager.setPinConfig('8642', true);

    expect(await AsyncStorage.getItem(DECOY_PIN_KEY)).toBeNull();
    const stored = mockState.secureItems.get(DECOY_PIN_KEY);
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored ?? '{}') as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('pin');
    expect(parsed).not.toHaveProperty('rawPin');
    expect(parsed).not.toHaveProperty('pinLength');
    expect(Object.values(parsed)).not.toContain('8642');
    expect(parsed).toMatchObject({ kdf: 'pbkdf2-sha256', iterations: ITERATIONS });
    expect(parsed.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(parsed.hashedPin).toBe(expectedPbkdf2('8642', parsed.salt as string, ITERATIONS));
    expect(parsed.hashedPin).not.toBe(mockState.digest(`8642${parsed.salt}`));
    expect(await manager.verifyPin('8642')).toBe(true);
    expect(await manager.verifyPin('8643')).toBe(false);
    expect(await manager.shouldRequireToExit()).toBe(true);
    expect(await manager.canUnlockCalculator()).toBe(true);
  });

  it('does not treat a require-to-exit PIN as calculator-unlockable when local auth is unavailable', async () => {
    const manager = DecoyPinManager.getInstance();

    await manager.setPinConfig('8642', true);
    mockState.localAuthLevel = 0;

    expect(await manager.hasPinConfigured()).toBe(true);
    expect(await manager.shouldRequireToExit()).toBe(true);
    expect(await manager.canUnlockCalculator()).toBe(false);
  });

  it('still treats a PIN without exit auth as calculator-unlockable when local auth is unavailable', async () => {
    const manager = DecoyPinManager.getInstance();
    mockState.localAuthLevel = 0;

    await manager.setPinConfig('9753', false);

    expect(await manager.canUnlockCalculator()).toBe(true);
  });

  it('refuses require-to-exit PIN setup when local auth is unavailable', async () => {
    const manager = DecoyPinManager.getInstance();
    mockState.localAuthLevel = 0;

    await expect(manager.setPinConfig('8642', true)).rejects.toThrow(/device authentication/i);
    expect(await manager.hasPinConfigured()).toBe(false);
  });

  it('migrates a legacy AsyncStorage verifier into secure storage on read', async () => {
    const manager = DecoyPinManager.getInstance();
    const legacy = {
      hashedPin: mockState.digest('2468legacy-salt'),
      requireToExit: false,
      salt: 'legacy-salt',
      createdAt: 1,
    };
    await AsyncStorage.setItem(DECOY_PIN_KEY, JSON.stringify(legacy));

    expect(await manager.verifyPin('2468')).toBe(true);
    expect(await AsyncStorage.getItem(DECOY_PIN_KEY)).toBeNull();
    const upgraded = readStoredConfig();
    expect(upgraded).toMatchObject({
      kdf: 'pbkdf2-sha256',
      iterations: ITERATIONS,
      requireToExit: false,
      createdAt: 1,
    });
    expect(upgraded.salt).not.toBe('legacy-salt');
    expect(upgraded.hashedPin).toBe(expectedPbkdf2('2468', upgraded.salt as string, ITERATIONS));
    expect(await manager.verifyPin('2468')).toBe(true);
  });

  it('refuses new decoy PINs when secure storage is unavailable', async () => {
    const manager = DecoyPinManager.getInstance();
    mockState.platform = 'web';

    await expect(manager.setPinConfig('97531', false)).rejects.toThrow(/native secure storage/i);
    expect(await manager.hasPinConfigured()).toBe(false);
  });

  it('refuses PINs that are not 4 to 8 digits', async () => {
    const manager = DecoyPinManager.getInstance();

    await expect(manager.setPinConfig('123', false)).rejects.toThrow(/4 to 8 digits/);
    await expect(manager.setPinConfig('123456789', false)).rejects.toThrow(/4 to 8 digits/);
    await expect(manager.setPinConfig('12a4', false)).rejects.toThrow(/4 to 8 digits/);
    expect(mockState.secureItems.has(DECOY_PIN_KEY)).toBe(false);
  });

  it('upgrades a legacy SHA-256 verifier only after the correct PIN is entered', async () => {
    const manager = DecoyPinManager.getInstance();
    storeLegacySecureVerifier('135792', 'old-salt', true);
    const before = mockState.secureItems.get(DECOY_PIN_KEY);

    expect(await manager.verifyPin('135790')).toBe(false);
    expect(mockState.secureItems.get(DECOY_PIN_KEY)).toBe(before);

    expect(await manager.verifyPin('135792')).toBe(true);
    const upgraded = readStoredConfig();
    expect(upgraded).toMatchObject({
      kdf: 'pbkdf2-sha256',
      iterations: ITERATIONS,
      requireToExit: true,
      createdAt: 7,
    });
    expect(upgraded.hashedPin).toBe(expectedPbkdf2('135792', upgraded.salt as string, ITERATIONS));
    expect(readAttempts()).toBeNull();
    expect(await manager.verifyPin('135792')).toBe(true);
    expect(await manager.verifyPin('135790')).toBe(false);
  });

  it('rehashes a PBKDF2 verifier written with fewer iterations', async () => {
    const manager = DecoyPinManager.getInstance();
    mockState.secureItems.set(DECOY_PIN_KEY, JSON.stringify({
      hashedPin: expectedPbkdf2('4826', 'aa'.repeat(16), 2_000),
      requireToExit: false,
      salt: 'aa'.repeat(16),
      createdAt: 3,
      kdf: 'pbkdf2-sha256',
      iterations: 2_000,
    }));

    expect(await manager.verifyPin('4826')).toBe(true);
    expect(readStoredConfig()).toMatchObject({ iterations: ITERATIONS, createdAt: 3 });
    expect(readStoredConfig().salt).not.toBe('aa'.repeat(16));
  });

  it('treats a verifier with an unknown KDF or out-of-range settings as absent', async () => {
    const manager = DecoyPinManager.getInstance();
    const base = { hashedPin: 'ab', requireToExit: false, salt: 'cd', createdAt: 1 };

    for (const tampered of [
      { ...base, kdf: 'md5', iterations: ITERATIONS },
      { ...base, kdf: 'pbkdf2-sha256', iterations: 1 },
      { ...base, kdf: 'pbkdf2-sha256', iterations: 10_000_000 },
    ]) {
      mockState.secureItems.set(DECOY_PIN_KEY, JSON.stringify(tampered));
      expect(await manager.hasPinConfigured()).toBe(false);
      expect(await manager.verifyPin('1357')).toBe(false);
    }
  });

  it('never counts a submission that is not a whole 4-8 digit entry', async () => {
    const manager = DecoyPinManager.getInstance();
    await manager.setPinConfig('8642', false);

    for (const entry of [null, '', '864', '864201357', '86.4']) {
      expect(await manager.verifyPin(entry)).toBe(false);
    }
    expect(readAttempts()).toBeNull();
  });

  it('runs exactly one PBKDF2 pass per submission whatever its kind, length or lockout', async () => {
    const manager = DecoyPinManager.getInstance();
    vi.spyOn(Date, 'now').mockReturnValue(T0);
    await manager.setPinConfig('8642', false);

    for (const entry of [null, '12', '1357', '135792', '13579246', '8642']) {
      kdfRuns.count = 0;
      await manager.verifyPin(entry);
      expect(kdfRuns.count).toBe(1);
    }

    await failTimes(manager, '1357', 5);
    kdfRuns.count = 0;
    expect(await manager.verifyPin('8642')).toBe(false);
    expect(kdfRuns.count).toBe(1);

    storeLegacySecureVerifier('2468', 'old-salt');
    mockState.secureItems.delete(DECOY_PIN_ATTEMPTS_KEY);
    kdfRuns.count = 0;
    expect(await manager.verifyPin('2469')).toBe(false);
    expect(kdfRuns.count).toBe(1);
  });

  it('locks out silently after five failed submissions with a short backoff capped at 60 s', async () => {
    const manager = DecoyPinManager.getInstance();
    const now = vi.spyOn(Date, 'now').mockReturnValue(T0);
    await manager.setPinConfig('8642', false);

    await failTimes(manager, '1357', 4);
    expect(readAttempts()).toEqual({ failedAttempts: 4, lastFailedAt: T0 });
    expect(await manager.verifyPin('8642')).toBe(true);
    expect(readAttempts()).toBeNull();

    await failTimes(manager, '1357', 5);
    // Locked for 15 s: the correct PIN is ignored and the press is not counted.
    now.mockReturnValue(T0 + 14_999);
    expect(await manager.verifyPin('8642')).toBe(false);
    expect(readAttempts()).toEqual({ failedAttempts: 5, lastFailedAt: T0 });

    now.mockReturnValue(T0 + 15_000);
    await failTimes(manager, '1357', 1);
    now.mockReturnValue(T0 + 15_000 + 29_999);
    expect(await manager.verifyPin('8642')).toBe(false);

    let clock = T0 + 45_000;
    for (let i = 0; i < 10; i += 1) {
      now.mockReturnValue(clock);
      await failTimes(manager, '1357', 1);
      clock += 60_000;
    }
    // Never more than 60 s after the latest failure.
    now.mockReturnValue(clock - 60_000 + 59_999);
    expect(await manager.verifyPin('8642')).toBe(false);
    now.mockReturnValue(clock);
    expect(await manager.verifyPin('8642')).toBe(true);
    expect(readAttempts()).toBeNull();
  }, 20_000); // ~25 PIN hashes; slow under coverage instrumentation on a loaded host.

  it('does not let a clock moved back stretch a lockout past the cap', async () => {
    const manager = DecoyPinManager.getInstance();
    const now = vi.spyOn(Date, 'now').mockReturnValue(T0);
    await manager.setPinConfig('8642', false);
    await failTimes(manager, '1357', 5);

    const earlier = T0 - 60 * 60_000;
    now.mockReturnValue(earlier);
    expect(await manager.verifyPin('8642')).toBe(false);
    expect(readAttempts()).toEqual({ failedAttempts: 5, lastFailedAt: earlier });

    now.mockReturnValue(earlier + 15_000);
    expect(await manager.verifyPin('8642')).toBe(true);
  });

  it('does not let a clock moved forward reset the failure count', async () => {
    const manager = DecoyPinManager.getInstance();
    const now = vi.spyOn(Date, 'now').mockReturnValue(T0);
    await manager.setPinConfig('8642', false);
    await failTimes(manager, '1357', 5);

    const later = T0 + 2 * 24 * 60 * 60_000;
    now.mockReturnValue(later);
    await failTimes(manager, '1357', 1);
    expect(readAttempts()).toEqual({ failedAttempts: 6, lastFailedAt: later });

    now.mockReturnValue(later + 29_999);
    expect(await manager.verifyPin('8642')).toBe(false);
    now.mockReturnValue(later + 30_000);
    expect(await manager.verifyPin('8642')).toBe(true);
  });

  it('keeps PIN material out of the attempt record', async () => {
    const manager = DecoyPinManager.getInstance();
    vi.spyOn(Date, 'now').mockReturnValue(T0);
    await manager.setPinConfig('8642', false);
    await failTimes(manager, '1357', 3);

    expect(Object.keys(readAttempts() ?? {}).sort()).toEqual(['failedAttempts', 'lastFailedAt']);
    expect(mockState.secureItems.get(DECOY_PIN_ATTEMPTS_KEY)).not.toContain('1357');
  });

  it('resets throttling when the PIN is set again or cleared', async () => {
    const manager = DecoyPinManager.getInstance();
    vi.spyOn(Date, 'now').mockReturnValue(T0);
    await manager.setPinConfig('8642', false);
    await failTimes(manager, '1357', 5);
    expect(readAttempts()?.failedAttempts).toBe(5);

    await manager.setPinConfig('9753', false);
    expect(readAttempts()).toBeNull();
    expect(await manager.verifyPin('9753')).toBe(true);

    await failTimes(manager, '1357', 5);
    await manager.clearPinConfig();
    expect(readAttempts()).toBeNull();
    expect(mockState.secureItems.has(DECOY_PIN_KEY)).toBe(false);
  });

  it('serializes concurrent checks so no failed attempt is lost', async () => {
    const manager = DecoyPinManager.getInstance();
    vi.spyOn(Date, 'now').mockReturnValue(T0);
    await manager.setPinConfig('8642', false);

    const results = await Promise.all(['1111', '2222', '3333'].map(pin => manager.verifyPin(pin)));
    expect(results).toEqual([false, false, false]);
    expect(readAttempts()).toMatchObject({ failedAttempts: 3 });
  });
});

describe('DecoyCalculator', () => {
  let calculator: DecoyCalculator;

  beforeEach(async () => {
    mockState.secureItems.clear();
    mockState.platform = 'android';
    mockState.secureStoreAvailable = true;
    mockState.localAuthLevel = 1;
    mockState.randomCounter = 1;
    vi.spyOn(Date, 'now').mockReturnValue(T0);
    await DecoyPinManager.getInstance().setPinConfig('8642', false);
    calculator = DecoyCalculator.getInstance();
    calculator.clear();
  });

  afterEach(() => vi.restoreAllMocks());

  it('never counts ordinary calculator use, so the correct PIN works immediately after it', async () => {
    // The review probe: many ordinary sums, several using the PIN digits.
    const sums = [
      '1234+5678=', '8642+1=', '8643×2=', '9999-1111=', '4321÷3=',
      '12+34=', '86420-8642=', '7777+8642=', '5555×1=', '2468+1357=',
      'C1234+4321=', '86.42+1=', '100-8641=', '3×8642=', '13579+2468=',
    ];
    for (const sum of sums) {
      expect(await press(calculator, sum)).toBe(false);
    }
    // Digit runs without "=" are not submissions either.
    await press(calculator, 'C1357C2468C9753C');

    expect(readAttempts()).toBeNull();
    expect(await press(calculator, 'C8642=')).toBe(true);
    expect(calculator.getState().display).toBe('0');
  });

  it('only unlocks on "=" with no pending operation, never on the digits alone', async () => {
    expect(await press(calculator, '8642')).toBe(false);
    expect(await press(calculator, '=')).toBe(true);

    expect(await press(calculator, '12+8642=')).toBe(false);
    expect(await press(calculator, '8642+=')).toBe(false);
    expect(readAttempts()).toBeNull();
  });

  it('starts a new entry after an operator, "=" or clear, and drops it after a decimal point', async () => {
    expect(await press(calculator, '5+=8642=')).toBe(true);
    expect(await press(calculator, '1.58642=')).toBe(false);
    expect(await press(calculator, '1.5C8642=')).toBe(true);
    expect(await press(calculator, '98642<<<<<8642=')).toBe(true);
    expect(await press(calculator, '86423<=')).toBe(true);
  });

  it('counts a wrong whole-entry submission, and a short lockout never blocks the PIN for long', async () => {
    const now = vi.mocked(Date.now);
    for (let i = 0; i < 5; i += 1) {
      expect(await press(calculator, 'C1357=')).toBe(false);
    }
    expect(readAttempts()).toMatchObject({ failedAttempts: 5 });

    expect(await press(calculator, 'C8642=')).toBe(false);
    now.mockReturnValue(T0 + 15_000);
    expect(await press(calculator, 'C8642=')).toBe(true);
    expect(readAttempts()).toBeNull();
  });
});
