import { afterEach, describe, expect, it, vi } from 'vitest';

// Synthetic, non-secret values that satisfy the API's required settings.
const SYNTHETIC_ENV: Record<string, string> = {
  API_PUBLIC_BASE_URL: 'https://api.example.invalid',
  WS_PUBLIC_BASE_URL: 'wss://ws.example.invalid',
  AUTH_PUBLIC_BASE_URL: 'https://auth.example.invalid',
  STORAGE_PUBLIC_BASE_URL: 'https://storage.example.invalid',
  DATABASE_URL: 'postgres://synthetic@db.example.invalid:5432/saferide',
  REDIS_URL: 'redis://redis.example.invalid:6379',
  AUTH_JWT_SECRET: 'synthetic-test-only-jwt-secret-0123456789abcdef',
  S3_ENDPOINT: 'https://s3.example.invalid',
  S3_PUBLIC_ENDPOINT: 'https://storage.example.invalid',
  S3_REGION: 'synthetic-region',
  S3_BUCKET: 'synthetic-evidence',
  S3_ACCESS_KEY_ID: 'synthetic-access-key-id',
  S3_SECRET_ACCESS_KEY: 'synthetic-test-only-secret-access-key',
};

const touched = new Set<string>();

function setEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    touched.add(key);
    vi.stubEnv(key, value);
  }
}

async function loadEnv() {
  vi.resetModules();
  return (await import('../env.js')).env;
}

afterEach(() => {
  vi.unstubAllEnvs();
  touched.clear();
  vi.resetModules();
});

describe('PARTNER_EVIDENCE_DOWNLOAD', () => {
  it('defaults to disabled', async () => {
    setEnv({ ...SYNTHETIC_ENV, APP_ENV: 'staging', NODE_ENV: 'production', PARTNER_EVIDENCE_DOWNLOAD: undefined });
    expect((await loadEnv()).partnerEvidenceDownload).toBe('disabled');
    setEnv({ PARTNER_EVIDENCE_DOWNLOAD: '' });
    expect((await loadEnv()).partnerEvidenceDownload).toBe('disabled');
  });

  it('refuses to serve raw originals outside development and test', async () => {
    for (const appEnv of ['staging', 'production', 'local']) {
      setEnv({ ...SYNTHETIC_ENV, APP_ENV: appEnv, PARTNER_EVIDENCE_DOWNLOAD: 'originals' });
      await expect(loadEnv(), appEnv).rejects.toThrow(/originals may only be served/);
    }
    for (const appEnv of ['development', 'test']) {
      setEnv({ ...SYNTHETIC_ENV, APP_ENV: appEnv, PARTNER_EVIDENCE_DOWNLOAD: 'originals' });
      expect((await loadEnv()).partnerEvidenceDownload, appEnv).toBe('originals');
    }
  });

  it('rejects any other value instead of guessing', async () => {
    setEnv({ ...SYNTHETIC_ENV, APP_ENV: 'test', PARTNER_EVIDENCE_DOWNLOAD: 'enabled' });
    await expect(loadEnv()).rejects.toThrow();
  });
});
