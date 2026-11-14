import { describe, expect, it } from 'vitest';

import { getLocalAiPilotCopy } from '../../i18n/localAiPilotCopy';
import {
  LOCAL_AI_FAILURE_CATEGORIES,
  LOCAL_AI_FAILURE_CODES,
  categorizeLocalAiFailure,
  classifyLocalAiFailure,
  isLocalAiFailureCode,
} from './pilotFailureReasons';

function nativeError(code: string, message = 'Synthetic native failure.'): Error {
  return Object.assign(new Error(message), { code });
}

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe('local AI failure reason mapping', () => {
  it('maps native LiteRT-LM bridge codes', () => {
    expect(classifyLocalAiFailure(nativeError('ERR_LITERT_INIT_FAILED'))).toBe('MODEL_START_FAILED');
    expect(classifyLocalAiFailure(nativeError('ERR_LITERT_LOAD_FAILED'))).toBe('MODEL_START_FAILED');
    expect(classifyLocalAiFailure(nativeError('ERR_LITERT_CHECKSUM_MISMATCH'))).toBe('CHECKSUM_MISMATCH');
    expect(classifyLocalAiFailure(nativeError('ERR_LITERT_MODEL_SIZE_MISMATCH'))).toBe('DOWNLOAD_INCOMPLETE');
    expect(classifyLocalAiFailure(nativeError('ERR_LITERT_MODEL_FILE_MISSING'))).toBe('MODEL_FILE_MISSING');
    expect(classifyLocalAiFailure(nativeError('ERR_LITERT_GENERATE_FAILED'))).toBe('GENERATION_FAILED');
    expect(classifyLocalAiFailure(nativeError('ERR_LITERT_REAL_RUNTIME_DISABLED'))).toBe('RUNTIME_UNAVAILABLE');
    expect(classifyLocalAiFailure(nativeError('ERR_LITERT_UNSUPPORTED_MANIFEST'))).toBe('ARTIFACT_UNAVAILABLE');
    expect(classifyLocalAiFailure(nativeError('ERR_LITERT_CANCELLED'))).toBe('GENERATION_CANCELLED');
  });

  it('maps SafeRide download, storage, and checksum errors', () => {
    expect(classifyLocalAiFailure(new Error(
      'Not enough device storage for gemma.litertlm. Free at least 5400 MB and resume.',
    ))).toBe('NOT_ENOUGH_STORAGE');
    expect(classifyLocalAiFailure(new Error('Checksum mismatch for gemma.litertlm'))).toBe('CHECKSUM_MISMATCH');
    expect(classifyLocalAiFailure(new Error('Could not read gemma.litertlm for checksum verification.')))
      .toBe('CHECKSUM_READ_FAILED');
    expect(classifyLocalAiFailure(new Error('Incomplete download for gemma.litertlm. Progress was saved for resume.')))
      .toBe('DOWNLOAD_INCOMPLETE');
    expect(classifyLocalAiFailure(new Error('Size mismatch for gemma.litertlm'))).toBe('DOWNLOAD_INCOMPLETE');
    expect(classifyLocalAiFailure(new TypeError('Network request failed'))).toBe('DOWNLOAD_NETWORK');
    expect(classifyLocalAiFailure(new Error(
      'Server does not support resumable range download for gemma.litertlm (status 200)',
    ))).toBe('DOWNLOAD_NETWORK');
    expect(classifyLocalAiFailure(namedError('AbortError', 'Aborted'))).toBe('DOWNLOAD_NETWORK');
    expect(classifyLocalAiFailure(namedError(
      'ModelDownloadAuthorizationError',
      'Metered-network download requires separate explicit consent.',
    ))).toBe('DOWNLOAD_NOT_AUTHORIZED');
  });

  it('maps engine timeouts, empty replies, memory, and unavailable runtime', () => {
    expect(classifyLocalAiFailure(new Error('LiteRT-LM model configuration timed out.'))).toBe('MODEL_LOAD_TIMEOUT');
    expect(classifyLocalAiFailure(new Error('LiteRT-LM readiness check timed out.'))).toBe('READINESS_PROBE_TIMEOUT');
    expect(classifyLocalAiFailure(new Error('LiteRT-LM readiness check produced an empty response')))
      .toBe('READINESS_PROBE_FAILED');
    expect(classifyLocalAiFailure(new Error('Local assistant reply timed out.'))).toBe('GENERATION_TIMEOUT');
    expect(classifyLocalAiFailure(new Error('LiteRT-LM local model engine produced an empty response')))
      .toBe('EMPTY_RESPONSE');
    expect(classifyLocalAiFailure(new Error('java.lang.OutOfMemoryError: Failed to allocate 512 MB')))
      .toBe('NOT_ENOUGH_MEMORY');
    expect(classifyLocalAiFailure(nativeError('ERR_LITERT_INIT_FAILED', 'Out of memory while mapping weights')))
      .toBe('NOT_ENOUGH_MEMORY');
    expect(classifyLocalAiFailure(new Error('SafeRide LiteRT-LM native bridge is unavailable in this build.')))
      .toBe('RUNTIME_UNAVAILABLE');
    expect(classifyLocalAiFailure(new Error(
      'Tuned local AI is unavailable (artifact-revoked). SafeRide remains available without local AI.',
    ))).toBe('ARTIFACT_UNAVAILABLE');
    expect(classifyLocalAiFailure(new Error('LiteRT-LM init failed'))).toBe('MODEL_START_FAILED');
    expect(classifyLocalAiFailure(namedError('LocalModelGenerationStoppedError', 'stopped')))
      .toBe('GENERATION_CANCELLED');
  });

  it('returns an allowlisted code for anything else and never echoes error text', () => {
    const code = classifyLocalAiFailure(new Error('SYNTHETIC-SECRET survivor narrative /data/user/0/path'));
    expect(code).toBe('UNCLASSIFIED');
    expect(classifyLocalAiFailure(undefined)).toBe('UNCLASSIFIED');
    expect(classifyLocalAiFailure({ code: 42 })).toBe('UNCLASSIFIED');
    for (const value of [new Error('anything'), 'string failure', null, { code: 'ERR_LITERT_INIT_FAILED' }]) {
      expect(isLocalAiFailureCode(classifyLocalAiFailure(value))).toBe(true);
    }
  });

  it('assigns every code a user-facing category and infers memory pressure on low-RAM phones', () => {
    for (const code of LOCAL_AI_FAILURE_CODES) {
      expect(LOCAL_AI_FAILURE_CATEGORIES).toContain(categorizeLocalAiFailure(code));
    }
    expect(categorizeLocalAiFailure('NOT_ENOUGH_STORAGE')).toBe('storage');
    expect(categorizeLocalAiFailure('CHECKSUM_MISMATCH')).toBe('download-incomplete');
    expect(categorizeLocalAiFailure('MODEL_START_FAILED')).toBe('model-start');
    expect(categorizeLocalAiFailure('MODEL_START_FAILED', { ramClassGb: 6 })).toBe('memory');
    expect(categorizeLocalAiFailure('GENERATION_FAILED', { ramClassGb: 4 })).toBe('memory');
    expect(categorizeLocalAiFailure('MODEL_START_FAILED', { ramClassGb: 8 })).toBe('model-start');
    expect(categorizeLocalAiFailure('GENERATION_TIMEOUT', { ramClassGb: 4 })).toBe('reply-failed');
    expect(categorizeLocalAiFailure('UNCLASSIFIED')).toBe('unknown');
  });

  it('shows a short reason and keeps help-line guidance in every chat fallback', () => {
    const copy = getLocalAiPilotCopy('en');
    for (const category of LOCAL_AI_FAILURE_CATEGORIES) {
      const fallback = copy.failure.chatFallback(category);
      expect(fallback).toContain(copy.failure.category(category).label);
      expect(fallback).toContain('1195');
      expect(fallback).toContain('999');
    }
    expect(copy.failure.statusMessage('memory', true)).toMatch(/^Not enough memory: .*still saved/);
    expect(copy.failure.statusMessage('storage', false)).toMatch(/^Not enough storage: /);
    expect(copy.failure.statusMessage('download-incomplete', false)).toMatch(/^Download incomplete: /);
    expect(copy.failure.statusMessage('model-start', false)).toMatch(/^Model failed to start: /);
  });
});
