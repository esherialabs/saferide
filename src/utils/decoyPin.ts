import AsyncStorage from '@react-native-async-storage/async-storage';
import * as LocalAuthentication from 'expo-local-authentication';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { Platform } from 'react-native';
import { devPrivacyWarn, getPrivacySafeErrorReason } from './privacyLog';
import { DECOY_PIN_ATTEMPTS_STORE_KEY, DECOY_PIN_STORE_KEY } from './storageKeys';

export const DECOY_PIN_KDF = 'pbkdf2-sha256' as const;

export interface DecoyPinConfig {
  hashedPin: string;
  requireToExit: boolean;
  salt: string;
  createdAt: number;
  /** Absent on verifiers written before PBKDF2, which are a single salted SHA-256. */
  kdf?: typeof DECOY_PIN_KDF;
  iterations?: number;
}

interface DecoyPinAttemptState {
  failedAttempts: number;
  lastFailedAt: number;
}

export interface DecoyPinStorageStatus {
  secure: boolean;
  storage: 'secure-store' | 'unavailable';
  platform: typeof Platform.OS;
  message: string;
}

export interface DecoyPinExitAuthStatus {
  available: boolean;
  method: 'device-auth' | 'unavailable';
  platform: typeof Platform.OS;
  message: string;
}

interface CalculatorState {
  display: string;
  operation: string | null;
  previousValue: string | null;
  isNewInput: boolean;
}

const DECOY_PIN_KEY = DECOY_PIN_STORE_KEY;
const DECOY_PIN_ATTEMPTS_KEY = DECOY_PIN_ATTEMPTS_STORE_KEY;
const CALCULATOR_STATE_KEY = 'calculator_state';
const SALT_BYTES = 16;
const PIN_PATTERN = /^\d{4,8}$/;
// The KDF runs in JS (Hermes has no JIT) once per "=" press, so the count is
// bounded by on-device latency and must be timed on a low-end Android. No
// phone-friendly count makes a 4-8 digit PIN expensive to brute-force offline;
// the verifier's main protection is SecureStore plus the attempt throttle.
// Verifiers record their own count and are rehashed on the next successful
// entry whenever this value is raised.
const PIN_KDF_ITERATIONS = 5_000;
const MIN_PIN_KDF_ITERATIONS = 1_000;
const MAX_PIN_KDF_ITERATIONS = 1_000_000;
const PIN_KDF_KEY_BYTES = 32;
// Survivor safety outranks guess resistance: a locked-out survivor cannot get
// back from the calculator to SOS, so the lockout stays short and silent.
const FREE_FAILED_ATTEMPTS = 5;
const LOCKOUT_BASE_MS = 15_000;
const LOCKOUT_MAX_MS = 60_000;
const MAX_RECORDED_FAILED_ATTEMPTS = 10_000;
// "=" presses that are not PIN submissions still run one KDF over this fixed
// input, so every "=" costs the same whether or not it was a PIN attempt.
const EQUALIZER_INPUT = '00000000';
const EQUALIZER_SALT = 'saferide-decoy-equalizer';

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function needsVerifierUpgrade(config: DecoyPinConfig): boolean {
  return config.kdf !== DECOY_PIN_KDF || (config.iterations ?? 0) < PIN_KDF_ITERATIONS;
}

/** 0 for the first four failures, then 15 s, 30 s and at most 60 s. */
function lockoutDurationMs(failedAttempts: number): number {
  if (failedAttempts < FREE_FAILED_ATTEMPTS) return 0;
  return Math.min(LOCKOUT_BASE_MS * 2 ** (failedAttempts - FREE_FAILED_ATTEMPTS), LOCKOUT_MAX_MS);
}

/**
 * Elapsed-time check against the last failure. Callers clamp a future
 * failure time to now first, so a lockout can never last longer than
 * LOCKOUT_MAX_MS from any moment, whichever way the clock moves.
 */
function isLockedOut(state: DecoyPinAttemptState, now: number): boolean {
  const lockoutMs = lockoutDurationMs(state.failedAttempts);
  return lockoutMs > 0 && now - state.lastFailedAt < lockoutMs;
}

async function pbkdf2Hex(pin: string, salt: string, iterations: number): Promise<string> {
  const derived = await pbkdf2Async(sha256, pin, salt, {
    c: iterations,
    dkLen: PIN_KDF_KEY_BYTES,
    asyncTick: 10,
  });
  return bytesToHex(derived);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function constantTimeEquals(a: string, b: string): boolean {
  const maxLength = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length;

  for (let i = 0; i < maxLength; i += 1) {
    mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }

  return mismatch === 0;
}

// PIN Management
export class DecoyPinManager {
  private static instance: DecoyPinManager;
  
  static getInstance(): DecoyPinManager {
    if (!DecoyPinManager.instance) {
      DecoyPinManager.instance = new DecoyPinManager();
    }
    return DecoyPinManager.instance;
  }

  private verification: Promise<unknown> = Promise.resolve();

  private async hashPin(
    pin: string,
    verifier: Pick<DecoyPinConfig, 'salt' | 'kdf' | 'iterations'>,
  ): Promise<string> {
    if (verifier.kdf === DECOY_PIN_KDF && verifier.iterations !== undefined) {
      return pbkdf2Hex(pin, verifier.salt, verifier.iterations);
    }

    // Verifiers written before PBKDF2; only read so they can be migrated.
    return await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      pin + verifier.salt,
      { encoding: Crypto.CryptoEncoding.HEX }
    );
  }

  private async generateSalt(): Promise<string> {
    const bytes = await Crypto.getRandomBytesAsync(SALT_BYTES);
    return bytesToHex(bytes);
  }

  private async createVerifier(
    pin: string,
    requireToExit: boolean,
    createdAt: number,
  ): Promise<DecoyPinConfig> {
    const verifier = {
      requireToExit,
      salt: await this.generateSalt(),
      createdAt,
      kdf: DECOY_PIN_KDF,
      iterations: PIN_KDF_ITERATIONS,
    };

    return { ...verifier, hashedPin: await this.hashPin(pin, verifier) };
  }

  async getStorageStatus(): Promise<DecoyPinStorageStatus> {
    if (Platform.OS === 'web') {
      return {
        secure: false,
        storage: 'unavailable',
        platform: Platform.OS,
        message: 'Decoy PIN requires native secure storage and is unavailable on web.',
      };
    }

    try {
      const isAvailable = typeof SecureStore.isAvailableAsync === 'function'
        ? await SecureStore.isAvailableAsync()
        : true;

      if (!isAvailable) {
        return {
          secure: false,
          storage: 'unavailable',
          platform: Platform.OS,
          message: 'Secure storage is unavailable on this device.',
        };
      }
    } catch (error) {
      devPrivacyWarn('decoy pin secure storage check failed', {
        reason: getPrivacySafeErrorReason(error),
      });
      return {
        secure: false,
        storage: 'unavailable',
        platform: Platform.OS,
        message: 'Secure storage could not be verified on this device.',
      };
    }

    return {
      secure: true,
      storage: 'secure-store',
      platform: Platform.OS,
      message: 'Decoy PIN verifier is stored with native secure storage on this device.',
    };
  }

  private parseConfig(configStr: string | null): DecoyPinConfig | null {
    if (!configStr) return null;

    try {
      const parsed = JSON.parse(configStr) as Partial<DecoyPinConfig>;
      if (
        typeof parsed.hashedPin === 'string' &&
        typeof parsed.salt === 'string' &&
        typeof parsed.createdAt === 'number'
      ) {
        const config: DecoyPinConfig = {
          hashedPin: parsed.hashedPin,
          requireToExit: !!parsed.requireToExit,
          salt: parsed.salt,
          createdAt: parsed.createdAt,
        };
        if (parsed.kdf === undefined) {
          return config;
        }
        if (
          parsed.kdf === DECOY_PIN_KDF &&
          isIntegerInRange(parsed.iterations, MIN_PIN_KDF_ITERATIONS, MAX_PIN_KDF_ITERATIONS)
        ) {
          return { ...config, kdf: DECOY_PIN_KDF, iterations: parsed.iterations };
        }
      }
    } catch {
      return null;
    }

    return null;
  }

  /**
   * Failures are never forgotten by elapsed time, only by a correct entry or
   * a new or cleared PIN, so moving the clock forward cannot reset the count.
   * A failure time in the future (clock moved back) is clamped to now and
   * saved, so it cannot stretch a lockout past LOCKOUT_MAX_MS.
   */
  private async readAttemptState(now: number): Promise<DecoyPinAttemptState> {
    const fresh: DecoyPinAttemptState = { failedAttempts: 0, lastFailedAt: 0 };

    try {
      const raw = await SecureStore.getItemAsync(DECOY_PIN_ATTEMPTS_KEY);
      if (!raw) return fresh;

      const parsed = JSON.parse(raw) as Partial<DecoyPinAttemptState>;
      if (
        !isIntegerInRange(parsed.failedAttempts, 0, MAX_RECORDED_FAILED_ATTEMPTS) ||
        !isIntegerInRange(parsed.lastFailedAt, 0, Number.MAX_SAFE_INTEGER)
      ) {
        return fresh;
      }

      const state: DecoyPinAttemptState = {
        failedAttempts: parsed.failedAttempts,
        lastFailedAt: parsed.lastFailedAt,
      };
      if (state.lastFailedAt > now) {
        state.lastFailedAt = now;
        await this.writeAttemptState(state);
      }
      return state;
    } catch (error) {
      devPrivacyWarn('decoy pin attempt state read failed', {
        reason: getPrivacySafeErrorReason(error),
      });
      return fresh;
    }
  }

  private async writeAttemptState(state: DecoyPinAttemptState): Promise<void> {
    try {
      await SecureStore.setItemAsync(DECOY_PIN_ATTEMPTS_KEY, JSON.stringify(state), {
        keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      });
    } catch (error) {
      devPrivacyWarn('decoy pin attempt state write failed', {
        reason: getPrivacySafeErrorReason(error),
      });
    }
  }

  private async recordFailedAttempt(state: DecoyPinAttemptState, now: number): Promise<void> {
    await this.writeAttemptState({
      failedAttempts: Math.min(state.failedAttempts + 1, MAX_RECORDED_FAILED_ATTEMPTS),
      lastFailedAt: now,
    });
  }

  private async clearAttemptState(): Promise<void> {
    try {
      await SecureStore.deleteItemAsync(DECOY_PIN_ATTEMPTS_KEY);
    } catch (error) {
      devPrivacyWarn('decoy pin attempt state clear failed', {
        reason: getPrivacySafeErrorReason(error),
      });
    }
  }

  private async readSecureConfig(): Promise<DecoyPinConfig | null> {
    const status = await this.getStorageStatus();
    if (!status.secure) return null;

    try {
      return this.parseConfig(await SecureStore.getItemAsync(DECOY_PIN_KEY));
    } catch (error) {
      devPrivacyWarn('decoy pin secure read failed', {
        reason: getPrivacySafeErrorReason(error),
      });
      return null;
    }
  }

  private async writeSecureConfig(config: DecoyPinConfig): Promise<void> {
    const status = await this.getStorageStatus();
    if (!status.secure) {
      throw new Error(status.message);
    }

    await SecureStore.setItemAsync(DECOY_PIN_KEY, JSON.stringify(config), {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    });
  }

  private async deleteSecureConfig(): Promise<void> {
    const status = await this.getStorageStatus();
    if (!status.secure) return;

    try {
      await SecureStore.deleteItemAsync(DECOY_PIN_KEY);
    } catch (error) {
      devPrivacyWarn('decoy pin secure delete failed', {
        reason: getPrivacySafeErrorReason(error),
      });
    }
  }

  private async readLegacyConfig(): Promise<DecoyPinConfig | null> {
    try {
      return this.parseConfig(await AsyncStorage.getItem(DECOY_PIN_KEY));
    } catch {
      return null;
    }
  }

  async setPinConfig(pin: string, requireToExit: boolean): Promise<void> {
    if (requireToExit) {
      const exitAuthStatus = await this.getExitAuthStatus();
      if (!exitAuthStatus.available) {
        throw new Error(exitAuthStatus.message);
      }
    }

    if (!PIN_PATTERN.test(pin)) {
      throw new Error('Decoy PIN must be 4 to 8 digits.');
    }

    const config = await this.createVerifier(pin, requireToExit, Date.now());

    await this.writeSecureConfig(config);
    await this.clearAttemptState();
    await AsyncStorage.removeItem(DECOY_PIN_KEY);
  }

  async getPinConfig(): Promise<DecoyPinConfig | null> {
    const secureConfig = await this.readSecureConfig();
    if (secureConfig) {
      return secureConfig;
    }

    const legacyConfig = await this.readLegacyConfig();
    if (!legacyConfig) {
      return null;
    }

    const status = await this.getStorageStatus();
    if (!status.secure) {
      return null;
    }

    try {
      await this.writeSecureConfig(legacyConfig);
      await AsyncStorage.removeItem(DECOY_PIN_KEY);
      return legacyConfig;
    } catch (error) {
      devPrivacyWarn('decoy pin legacy migration failed', {
        reason: getPrivacySafeErrorReason(error),
      });
      return null;
    }
  }

  async hasPinConfigured(): Promise<boolean> {
    const config = await this.getPinConfig();
    return config !== null;
  }

  async getExitAuthStatus(): Promise<DecoyPinExitAuthStatus> {
    if (Platform.OS === 'web') {
      return {
        available: false,
        method: 'unavailable',
        platform: Platform.OS,
        message: 'Device authentication for calculator exit is unavailable on web.',
      };
    }

    try {
      if (typeof LocalAuthentication.getEnrolledLevelAsync === 'function') {
        const enrolledLevel = await LocalAuthentication.getEnrolledLevelAsync();
        const hasDeviceAuth = enrolledLevel > LocalAuthentication.SecurityLevel.NONE;

        return {
          available: hasDeviceAuth,
          method: hasDeviceAuth ? 'device-auth' : 'unavailable',
          platform: Platform.OS,
          message: hasDeviceAuth
            ? 'Device authentication can protect calculator exit on this device.'
            : 'Device authentication is unavailable. Set up a device passcode or biometric unlock before requiring authentication to leave calculator mode.',
        };
      }

      const hasHardware = typeof LocalAuthentication.hasHardwareAsync === 'function'
        ? await LocalAuthentication.hasHardwareAsync()
        : false;
      const isEnrolled = typeof LocalAuthentication.isEnrolledAsync === 'function'
        ? await LocalAuthentication.isEnrolledAsync()
        : false;
      const hasDeviceAuth = hasHardware && isEnrolled;

      return {
        available: hasDeviceAuth,
        method: hasDeviceAuth ? 'device-auth' : 'unavailable',
        platform: Platform.OS,
        message: hasDeviceAuth
          ? 'Device authentication can protect calculator exit on this device.'
          : 'Device authentication is unavailable. Set up a device passcode or biometric unlock before requiring authentication to leave calculator mode.',
      };
    } catch (error) {
      devPrivacyWarn('decoy pin exit auth capability check failed', {
        reason: getPrivacySafeErrorReason(error),
      });
      return {
        available: false,
        method: 'unavailable',
        platform: Platform.OS,
        message: 'Device authentication could not be verified on this device.',
      };
    }
  }

  async canUnlockCalculator(): Promise<boolean> {
    const config = await this.getPinConfig();
    if (!config) return false;
    if (!config.requireToExit) return true;

    const exitAuthStatus = await this.getExitAuthStatus();
    return exitAuthStatus.available;
  }

  /**
   * Checks one explicit calculator submission (the "=" key). `entry` is the
   * digit run typed since the last clear, operator or "="; it is null when the
   * press finished a calculation or the entry is not a plain 4-8 digit run, and
   * such presses never count as attempts. Every press while a PIN is set runs
   * exactly one PBKDF2 pass, so its cost does not reveal whether it was a PIN
   * attempt, its length, or a lockout. Checks are serialized so concurrent
   * presses cannot lose a failed attempt. While locked out, submissions are
   * rejected without any hint: the calculator disguise must not reveal that a
   * PIN exists.
   */
  async verifyPin(entry: string | null): Promise<boolean> {
    const result = this.verification.then(() => this.verifyPinNow(entry));
    this.verification = result.catch(() => undefined);
    return result;
  }

  private async verifyPinNow(entry: string | null): Promise<boolean> {
    try {
      const config = await this.getPinConfig();
      if (!config) return false;

      const now = Date.now();
      const attempts = await this.readAttemptState(now);
      const candidate = entry !== null && PIN_PATTERN.test(entry) ? entry : null;
      if (candidate === null || isLockedOut(attempts, now)) {
        await this.runEqualizer(config);
        return false;
      }

      if (!(await this.matches(candidate, config))) {
        await this.recordFailedAttempt(attempts, now);
        return false;
      }

      if (attempts.failedAttempts > 0) {
        await this.clearAttemptState();
      }
      if (needsVerifierUpgrade(config)) {
        await this.upgradeVerifier(candidate, config);
      }
      return true;
    } catch (error) {
      devPrivacyWarn('decoy pin verification failed', {
        reason: getPrivacySafeErrorReason(error),
      });
      return false;
    }
  }

  private async matches(candidate: string, config: DecoyPinConfig): Promise<boolean> {
    const hashed = await this.hashPin(candidate, config);
    if (config.kdf !== DECOY_PIN_KDF) {
      // Legacy SHA-256 is near-instant; pay the PBKDF2 cost anyway.
      await this.runEqualizer(config);
    }
    return constantTimeEquals(hashed, config.hashedPin);
  }

  private async runEqualizer(config: DecoyPinConfig): Promise<void> {
    await pbkdf2Hex(
      EQUALIZER_INPUT,
      config.kdf === DECOY_PIN_KDF ? config.salt : EQUALIZER_SALT,
      config.kdf === DECOY_PIN_KDF && config.iterations !== undefined ? config.iterations : PIN_KDF_ITERATIONS,
    );
  }

  /** Rehash an older verifier with the entered PIN once it has been proven correct. */
  private async upgradeVerifier(pin: string, config: DecoyPinConfig): Promise<void> {
    try {
      await this.writeSecureConfig(
        await this.createVerifier(pin, config.requireToExit, config.createdAt),
      );
    } catch (error) {
      devPrivacyWarn('decoy pin verifier upgrade failed', {
        reason: getPrivacySafeErrorReason(error),
      });
    }
  }

  async clearPinConfig(): Promise<void> {
    await this.deleteSecureConfig();
    await this.clearAttemptState();
    await AsyncStorage.removeItem(DECOY_PIN_KEY);
  }

  async shouldRequireToExit(): Promise<boolean> {
    const config = await this.getPinConfig();
    return config?.requireToExit ?? false;
  }
}

// Calculator Logic for Decoy Mode
export class DecoyCalculator {
  private static instance: DecoyCalculator;
  private state: CalculatorState;
  /**
   * Digits typed since the last clear, operator or "=". Null once the entry
   * stops being a plain digit run (a decimal point). Only this whole entry,
   * submitted with "=" and no pending operation, is ever checked as a PIN.
   */
  private entry: string | null = '';
  private listeners: Array<(state: CalculatorState) => void> = [];
  
  static getInstance(): DecoyCalculator {
    if (!DecoyCalculator.instance) {
      DecoyCalculator.instance = new DecoyCalculator();
    }
    return DecoyCalculator.instance;
  }

  constructor() {
    this.state = {
      display: '0',
      operation: null,
      previousValue: null,
      isNewInput: true,
    };
    this.loadState();
  }

  private async loadState(): Promise<void> {
    try {
      const stateStr = await AsyncStorage.getItem(CALCULATOR_STATE_KEY);
      if (stateStr) {
        this.state = JSON.parse(stateStr);
        this.notifyListeners();
      }
    } catch {
      // Use default state
    }
  }

  private async saveState(): Promise<void> {
    try {
      await AsyncStorage.setItem(CALCULATOR_STATE_KEY, JSON.stringify(this.state));
    } catch {
      // Ignore save errors
    }
  }

  addListener(listener: (state: CalculatorState) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  private notifyListeners(): void {
    this.listeners.forEach(listener => listener({ ...this.state }));
  }

  /** Digits never unlock on their own; see submit(). */
  async inputNumber(digit: string): Promise<void> {
    if (this.entry !== null) {
      this.entry += digit;
    }

    if (this.state.isNewInput) {
      this.state.display = digit;
      this.state.isNewInput = false;
    } else {
      this.state.display = this.state.display === '0' ? digit : this.state.display + digit;
    }

    this.notifyListeners();
    await this.saveState();
  }

  inputOperation(op: string): void {
    this.entry = '';
    if (this.state.operation && !this.state.isNewInput) {
      this.calculate();
    }
    
    this.state.operation = op;
    this.state.previousValue = this.state.display;
    this.state.isNewInput = true;
    
    this.notifyListeners();
    this.saveState();
  }

  inputDecimal(): void {
    if (this.state.display.includes('.')) return;
    this.entry = null;
    
    if (this.state.isNewInput) {
      this.state.display = '0.';
      this.state.isNewInput = false;
    } else {
      this.state.display += '.';
    }
    
    this.notifyListeners();
    this.saveState();
  }

  /**
   * The "=" key. Finishes any pending calculation and, only when there was no
   * pending operation, submits the whole digit entry as a PIN attempt. The
   * display updates before the check, which never blocks it.
   */
  async submit(): Promise<{ shouldUnlock: boolean }> {
    const entry = this.state.operation ? null : this.entry;
    this.entry = '';
    this.calculate();

    const shouldUnlock = await DecoyPinManager.getInstance().verifyPin(entry);
    if (shouldUnlock) {
      // Do not leave the PIN on the persisted calculator display.
      this.clear();
    }
    return { shouldUnlock };
  }

  calculate(): void {
    if (!this.state.operation || !this.state.previousValue) return;
    
    const prev = parseFloat(this.state.previousValue);
    const current = parseFloat(this.state.display);
    let result = 0;
    
    switch (this.state.operation) {
      case '+':
        result = prev + current;
        break;
      case '-':
        result = prev - current;
        break;
      case '×':
        result = prev * current;
        break;
      case '÷':
        result = current !== 0 ? prev / current : 0;
        break;
      default:
        return;
    }
    
    this.state.display = result.toString();
    this.state.operation = null;
    this.state.previousValue = null;
    this.state.isNewInput = true;
    
    this.notifyListeners();
    this.saveState();
  }

  clear(): void {
    this.state = {
      display: '0',
      operation: null,
      previousValue: null,
      isNewInput: true,
    };
    this.entry = '';
    
    this.notifyListeners();
    this.saveState();
  }

  backspace(): void {
    if (this.entry !== null) {
      this.entry = this.entry.slice(0, -1);
    }
    if (this.state.display.length > 1) {
      this.state.display = this.state.display.slice(0, -1);
    } else {
      this.state.display = '0';
    }
    
    this.notifyListeners();
    this.saveState();
  }

  getState(): CalculatorState {
    return { ...this.state };
  }
}

// Decoy Mode Detection
export class DecoyModeDetector {
  private static instance: DecoyModeDetector;
  private isInDecoyMode: boolean = false;
  private listeners: Array<(isDecoy: boolean) => void> = [];
  
  static getInstance(): DecoyModeDetector {
    if (!DecoyModeDetector.instance) {
      DecoyModeDetector.instance = new DecoyModeDetector();
    }
    return DecoyModeDetector.instance;
  }

  addListener(listener: (isDecoy: boolean) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  private notifyListeners(): void {
    this.listeners.forEach(listener => listener(this.isInDecoyMode));
  }

  async enterDecoyMode(): Promise<void> {
    this.isInDecoyMode = true;
    this.notifyListeners();
    
    // Initialize calculator
    DecoyCalculator.getInstance();
  }

  async exitDecoyMode(): Promise<boolean> {
    const pinManager = DecoyPinManager.getInstance();
    const requiresPin = await pinManager.shouldRequireToExit();
    
    if (requiresPin) {
      const isAuthorized = await this.authenticateForExit();
      if (!isAuthorized) {
        return false;
      }
    }
    
    this.isInDecoyMode = false;
    this.notifyListeners();
    return true;
  }

  private async authenticateForExit(): Promise<boolean> {
    try {
      // Try biometric authentication first
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Exit calculator mode',
        cancelLabel: 'Cancel',
        disableDeviceFallback: false,
      });
      
      return result.success;
    } catch {
      return false;
    }
  }

  isDecoyActive(): boolean {
    return this.isInDecoyMode;
  }

  async shouldShowDecoyOnLaunch(): Promise<boolean> {
    // Launch-time decoy requires native launch-context support that is not present yet.
    return false;
  }
}

// Utility functions
export const decoyPinUtils = {
  isValidPin: (pin: string): boolean => {
    return /^\d{4,8}$/.test(pin) && pin !== '0000' && pin !== '1234' && pin !== '1111';
  },
  
  formatPinDisplay: (pin: string): string => {
    return pin.replace(/./g, '•');
  },
  
  generateSecurePin: async (): Promise<string> => {
    const bytes = await Crypto.getRandomBytesAsync(4);
    const value = (
      (bytes[0] << 24) +
      (bytes[1] << 16) +
      (bytes[2] << 8) +
      bytes[3]
    ) >>> 0;

    return String(100000 + (value % 900000));
  },
};
