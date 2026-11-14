import { createHash, randomUUID } from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import { Client, IamAwsProvider, type ClientOptions } from 'minio';

import { env } from '../config/env.js';

const endpointUrl = new URL(env.s3Endpoint);
const publicEndpointUrl = new URL(env.s3PublicEndpoint);

type AwsCredentialResponse = {
  AccessKeyId?: string;
  AccessKeyID?: string;
  SecretAccessKey?: string;
  Token?: string;
  Expiration?: string;
};

type MinioCredentials = Awaited<ReturnType<IamAwsProvider['getCredentials']>>;

let cachedTaskRoleCredentials: {
  credentials: MinioCredentials;
  expiresAt: number;
} | null = null;

function ecsCredentialUrl(): URL | null {
  if (process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI) {
    return new URL(process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI, 'http://169.254.170.2');
  }

  if (process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI) {
    return new URL(process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI);
  }

  return null;
}

const ecsTaskRoleCredentialProvider = {
  async getCredentials(): Promise<MinioCredentials> {
    const now = Date.now();
    if (cachedTaskRoleCredentials && cachedTaskRoleCredentials.expiresAt - now > 30_000) {
      return cachedTaskRoleCredentials.credentials;
    }

    const url = ecsCredentialUrl();
    if (!url) {
      throw new Error('ECS task credential endpoint is unavailable');
    }

    const headers: Record<string, string> = {};
    if (process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN) {
      headers.Authorization = process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN;
    }

    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`ECS task credential endpoint returned ${response.status}`);
    }

    const body = (await response.json()) as AwsCredentialResponse;
    const accessKey = body.AccessKeyId ?? body.AccessKeyID;
    if (!accessKey || !body.SecretAccessKey) {
      throw new Error('ECS task credential response is missing access keys');
    }

    const credentials = {
      getAccessKey: () => accessKey,
      getSecretKey: () => body.SecretAccessKey!,
      getSessionToken: () => body.Token,
    } as MinioCredentials;

    cachedTaskRoleCredentials = {
      credentials,
      expiresAt: body.Expiration ? new Date(body.Expiration).getTime() : now + 10 * 60 * 1000,
    };
    return cachedTaskRoleCredentials.credentials;
  },
};

function iamCredentialProvider(): ClientOptions['credentialsProvider'] {
  const ecsUrl = ecsCredentialUrl();
  return ecsUrl
    ? (ecsTaskRoleCredentialProvider as ClientOptions['credentialsProvider'])
    : new IamAwsProvider({});
}

function createStorageClient(url: URL, signal?: AbortSignal): Client {
  const transport = url.protocol === 'https:' ? https : http;
  const baseOptions = {
    endPoint: url.hostname,
    port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
    useSSL: url.protocol === 'https:',
    region: env.s3Region,
    ...(signal ? { transport: { request: (options: http.RequestOptions, callback?: (response: http.IncomingMessage) => void) =>
      transport.request({ ...options, signal }, callback) } as ClientOptions['transport'] } : {}),
  };

  if (env.s3CredentialMode === 'iam') {
    return new Client({
      ...baseOptions,
      credentialsProvider: iamCredentialProvider(),
    });
  }

  return new Client({
    ...baseOptions,
    accessKey: env.s3AccessKeyId!,
    secretKey: env.s3SecretAccessKey!,
  });
}

export const minioClient = createStorageClient(endpointUrl);
const publicMinioClient = createStorageClient(publicEndpointUrl);

export function buildEvidenceObjectKey(): string {
  return `evidence/${randomUUID()}/${randomUUID()}`;
}

export async function createPresignedUploadPolicy(params: {
  objectKey: string;
  expirySeconds: number;
  mimeType: string;
  maxSizeBytes: number;
}): Promise<{ url: string; fields: Record<string, string> }> {
  const policy = publicMinioClient.newPostPolicy();
  policy.setBucket(env.s3Bucket);
  policy.setKey(params.objectKey);
  policy.setExpires(new Date(Date.now() + params.expirySeconds * 1000));
  policy.setContentType(params.mimeType);
  policy.setContentLengthRange(1, params.maxSizeBytes);

  const signed = await publicMinioClient.presignedPostPolicy(policy);
  return {
    url: signed.postURL,
    fields: Object.fromEntries(Object.entries(signed.formData).map(([key, value]) => [key, String(value)])),
  };
}

export async function createPresignedDownloadUrl(params: {
  objectKey: string;
  expirySeconds: number;
  /** Serve as a download only (no inline preview), e.g. for partner caseworkers. */
  forceDownload?: boolean;
}): Promise<string> {
  if (params.forceDownload) {
    return publicMinioClient.presignedGetObject(env.s3Bucket, params.objectKey, params.expirySeconds, {
      'response-content-disposition': 'attachment',
      'response-content-type': 'application/octet-stream',
    });
  }
  return publicMinioClient.presignedGetObject(env.s3Bucket, params.objectKey, params.expirySeconds);
}

export async function deleteEvidenceObject(objectKey: string): Promise<void> {
  await minioClient.removeObject(env.s3Bucket, objectKey);
}

/** Retention uses a dedicated abortable client; it cannot delete another
 * bucket or an unowned prefix, and its request ends before the DB hold lock. */
export async function deleteRetainedEvidenceObject(bucket: string, objectKey: string, kind: 'original' | 'derivative'): Promise<void> {
  const prefix = kind === 'derivative' ? 'evidence-derivatives/' : 'evidence/';
  if (bucket !== env.s3Bucket || !objectKey.startsWith(prefix)) throw new Error('Retention object is outside the owned storage scope');
  const client = createStorageClient(endpointUrl, AbortSignal.timeout(10_000));
  await client.removeObject(bucket, objectKey);
}

export async function hashStoredObject(objectKey: string): Promise<{ sha256: string; sizeBytes: number }> {
  const stream = await minioClient.getObject(env.s3Bucket, objectKey);
  const hash = createHash('sha256');
  let sizeBytes = 0;

  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    sizeBytes += buffer.length;
    hash.update(buffer);
  }

  return {
    sha256: hash.digest('hex'),
    sizeBytes,
  };
}

/** The stored object as a stream (for the malware scan); the caller consumes or destroys it. */
export async function openStoredObjectStream(objectKey: string): Promise<AsyncIterable<Uint8Array> & { destroy: () => void }> {
  return minioClient.getObject(env.s3Bucket, objectKey);
}

/** Metadata-stripped derivatives live under their own prefix, never beside originals. */
export const EVIDENCE_DERIVATIVE_PREFIX = 'evidence-derivatives/';

export function buildEvidenceDerivativeObjectKey(): string {
  return `${EVIDENCE_DERIVATIVE_PREFIX}${randomUUID()}/${randomUUID()}`;
}

export class StoredObjectTooLargeError extends Error {
  constructor() {
    super('Stored object exceeds the evidence size limit');
    this.name = 'StoredObjectTooLargeError';
  }
}

export class StoredObjectSizeMismatchError extends Error {
  constructor() {
    super('Stored object size differs from the recorded size');
    this.name = 'StoredObjectSizeMismatchError';
  }
}

/**
 * Reads a whole stored object into memory, refusing anything over `maxBytes`.
 * With `expectedBytes` (the verified size on record) it allocates once and
 * refuses an object of any other size, so peak memory is one copy.
 */
export async function readStoredObject(objectKey: string, maxBytes: number, expectedBytes?: number | null): Promise<Buffer> {
  if (expectedBytes !== undefined && expectedBytes !== null && (expectedBytes <= 0 || expectedBytes > maxBytes)) {
    throw new StoredObjectTooLargeError();
  }
  const stream = await minioClient.getObject(env.s3Bucket, objectKey);
  const out = expectedBytes ? Buffer.allocUnsafe(expectedBytes) : null;
  const chunks: Buffer[] = [];
  let sizeBytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (sizeBytes + buffer.length > maxBytes) {
      stream.destroy();
      throw new StoredObjectTooLargeError();
    }
    if (out) {
      if (sizeBytes + buffer.length > out.length) {
        stream.destroy();
        throw new StoredObjectSizeMismatchError();
      }
      buffer.copy(out, sizeBytes);
    } else {
      chunks.push(buffer);
    }
    sizeBytes += buffer.length;
  }
  if (out) {
    if (sizeBytes !== out.length) throw new StoredObjectSizeMismatchError();
    return out;
  }
  return Buffer.concat(chunks, sizeBytes);
}

/** Writes a derivative; refuses any key outside the derivative prefix so an original can never be overwritten. */
export async function putEvidenceDerivativeObject(objectKey: string, body: Buffer, contentType: string, signal?: AbortSignal): Promise<void> {
  if (!objectKey.startsWith(EVIDENCE_DERIVATIVE_PREFIX)) {
    throw new Error('Derivatives are written only under the derivative prefix');
  }
  const client = signal ? createStorageClient(endpointUrl, signal) : minioClient;
  await client.putObject(env.s3Bucket, objectKey, body, body.length, { 'Content-Type': contentType });
}

/** Deletes a derivative; refuses any key outside the derivative prefix. Deleting a missing object succeeds. */
export async function deleteEvidenceDerivativeObject(objectKey: string, signal?: AbortSignal): Promise<void> {
  if (!objectKey.startsWith(EVIDENCE_DERIVATIVE_PREFIX)) {
    throw new Error('Only derivative objects are deleted here');
  }
  const client = signal ? createStorageClient(endpointUrl, signal) : minioClient;
  await client.removeObject(env.s3Bucket, objectKey);
}
