import { z } from 'zod';

import { decodePartnerKey } from './partnerKey.js';
import { parseTrustedProxyCidrs } from './partnerNetwork.js';

const placeholderPattern = /^(replace|change|your|todo|example|placeholder|xxx)/i;

const requiredString = z
  .string()
  .trim()
  .min(1)
  .refine(value => !placeholderPattern.test(value), 'must not be a placeholder value');

const requiredUrl = z
  .string()
  .trim()
  .url()
  .refine(value => !placeholderPattern.test(value), 'must not be a placeholder value');

const requiredSecret = z
  .string()
  .trim()
  .min(32)
  .refine(value => !placeholderPattern.test(value), 'must not be a placeholder value');

function usableSecret(value: string | undefined): value is string {
  if (!value) return false;
  const trimmed = value.trim();
  return Boolean(trimmed) && !placeholderPattern.test(trimmed);
}

function databaseUrlFromParts(): string | undefined {
  if (
    !usableSecret(process.env.DATABASE_HOST) ||
    !usableSecret(process.env.DATABASE_NAME) ||
    !usableSecret(process.env.DATABASE_USER) ||
    !usableSecret(process.env.DATABASE_PASSWORD)
  ) {
    return undefined;
  }

  const port = process.env.DATABASE_PORT?.trim() || '5432';
  const sslMode = process.env.DATABASE_SSLMODE?.trim();
  const credentials = `${encodeURIComponent(process.env.DATABASE_USER)}:${encodeURIComponent(process.env.DATABASE_PASSWORD)}`;
  const database = encodeURIComponent(process.env.DATABASE_NAME);
  const query = sslMode ? `?sslmode=${encodeURIComponent(sslMode)}` : '';
  return `postgres://${credentials}@${process.env.DATABASE_HOST.trim()}:${port}/${database}${query}`;
}

function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/** A bare https origin (http only for localhost), e.g. https://partners.example.org */
export function isPartnerOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && isLocalHostname(url.hostname));
  return secure && url.origin === value && !url.username && !url.password;
}

const optionalPartnerOrigin = z
  .string()
  .trim()
  .optional()
  .transform(value => (value ? value : undefined))
  .refine(value => value === undefined || isPartnerOrigin(value), 'must be a bare https origin');

const optionalPartnerKey = z
  .string()
  .trim()
  .optional()
  .transform(value => (value ? value : undefined))
  .refine(value => value === undefined || decodePartnerKey(value) !== null, 'must be a 32-byte key (hex or base64)');

const optionalTrustedProxyCidrs = z
  .string()
  .trim()
  .optional()
  .transform(value => (value ? value : undefined))
  .refine(value => {
    try {
      parseTrustedProxyCidrs(value);
      return true;
    } catch {
      return false;
    }
  }, 'must be a comma-separated list of CIDRs');

const envSchema = z
  .object({
    nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
    appEnvironment: z.enum(['local', 'development', 'staging', 'production', 'test']).default('local'),
    apiHost: z.string().default('127.0.0.1'),
    apiPort: z.coerce.number().int().positive().default(3333),
    wsHost: z.string().default('127.0.0.1'),
    wsPort: z.coerce.number().int().positive().default(3334),
    apiPublicBaseUrl: requiredUrl,
    wsPublicBaseUrl: requiredString,
    authPublicBaseUrl: requiredUrl,
    storagePublicBaseUrl: requiredUrl,
    databaseUrl: requiredString,
    redisUrl: requiredString,
    authJwtSecret: requiredSecret,
    s3Endpoint: requiredUrl,
    s3PublicEndpoint: requiredUrl,
    s3Region: requiredString,
    s3Bucket: requiredString,
    s3CredentialMode: z.enum(['static', 'iam']).default('static'),
    s3AccessKeyId: z.string().trim().optional(),
    s3SecretAccessKey: z.string().trim().optional(),
    corsOrigins: z.string().default('*'),
    partnerPublicOrigin: optionalPartnerOrigin,
    partnerTotpKey: optionalPartnerKey,
    partnerCallbackKey: optionalPartnerKey,
    partnerTrustedProxyCidrs: optionalTrustedProxyCidrs,
    // Partner evidence downloads hand out raw originals (EXIF GPS, device
    // make/model) until a metadata-stripped derivative pipeline exists, so
    // they are off unless explicitly set, and `originals` is refused outside
    // development and test.
    partnerEvidenceDownload: z.enum(['disabled', 'originals']).default('disabled'),
    // clamd (ClamAV) for evidence malware scanning. Unset: no scanner, so
    // evidence ingestion stays refused and nothing is ever released.
    clamdHost: z
      .string()
      .trim()
      .optional()
      .transform(value => (value ? value : undefined)),
    clamdPort: z.coerce.number().int().min(1).max(65535).default(3310),
    // Scans the API runs at once (in-process worker); 1 or 2.
    evidenceScanConcurrency: z.coerce.number().int().min(1).max(2).default(1),
    logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  })
  .superRefine((value, ctx) => {
    if (value.partnerEvidenceDownload === 'originals' && !['development', 'test'].includes(value.appEnvironment)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['partnerEvidenceDownload'],
        message: 'originals may only be served to partners with APP_ENV=development or test',
      });
    }
    if (value.s3CredentialMode === 'iam') return;

    if (!usableSecret(value.s3AccessKeyId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['s3AccessKeyId'],
        message: 'is required when S3_CREDENTIAL_MODE=static',
      });
    }

    if (!usableSecret(value.s3SecretAccessKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['s3SecretAccessKey'],
        message: 'is required when S3_CREDENTIAL_MODE=static',
      });
    }
  });

export const env = envSchema.parse({
  nodeEnv: process.env.NODE_ENV,
  appEnvironment: process.env.APP_ENV,
  apiHost: process.env.API_HOST,
  apiPort: process.env.API_PORT,
  wsHost: process.env.WS_HOST,
  wsPort: process.env.WS_PORT,
  apiPublicBaseUrl: process.env.API_PUBLIC_BASE_URL,
  wsPublicBaseUrl: process.env.WS_PUBLIC_BASE_URL,
  authPublicBaseUrl: process.env.AUTH_PUBLIC_BASE_URL,
  storagePublicBaseUrl: process.env.STORAGE_PUBLIC_BASE_URL,
  databaseUrl: process.env.DATABASE_URL ?? databaseUrlFromParts(),
  redisUrl: process.env.REDIS_URL,
  authJwtSecret: process.env.AUTH_JWT_SECRET,
  s3Endpoint: process.env.S3_ENDPOINT,
  s3PublicEndpoint: process.env.S3_PUBLIC_ENDPOINT,
  s3Region: process.env.S3_REGION,
  s3Bucket: process.env.S3_BUCKET,
  s3CredentialMode: process.env.S3_CREDENTIAL_MODE,
  s3AccessKeyId: process.env.S3_ACCESS_KEY_ID,
  s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  corsOrigins: process.env.CORS_ORIGINS,
  partnerPublicOrigin: process.env.PARTNER_PUBLIC_ORIGIN,
  partnerTotpKey: process.env.PARTNER_TOTP_KEY,
  partnerCallbackKey: process.env.PARTNER_CALLBACK_KEY,
  partnerTrustedProxyCidrs: process.env.PARTNER_TRUSTED_PROXY_CIDRS,
  partnerEvidenceDownload: process.env.PARTNER_EVIDENCE_DOWNLOAD?.trim() || undefined,
  clamdHost: process.env.CLAMD_HOST,
  clamdPort: process.env.CLAMD_PORT?.trim() || undefined,
  evidenceScanConcurrency: process.env.EVIDENCE_SCAN_CONCURRENCY?.trim() || undefined,
  logLevel: process.env.LOG_LEVEL,
});

export function corsOriginList(): string[] | true {
  if (env.corsOrigins.trim() === '*') return true;
  return env.corsOrigins
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
}
