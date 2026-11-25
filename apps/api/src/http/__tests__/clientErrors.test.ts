/**
 * Fastify's own client refusals (empty or malformed JSON, the wrong content
 * type, a body over the limit) must answer with their 4xx in our structured
 * shape, never the parser's text, and log at warn, on a real survivor route
 * and a real partner route alike. Server faults keep their 5xx.
 */
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';

import Fastify, { errorCodes, type FastifyInstance, type InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseTrustedProxyCidrs } from '../../config/partnerNetwork.js';
import { applyPartnerScopeGuards } from '../../middleware/partnerSession.js';
import { registerAuthRoutes } from '../../routes/auth.js';
import { registerPartnerApi } from '../../routes/partnerAuth.js';
import { fastifyClientError, registerErrorHandler } from '../errorHandler.js';

const authRepo = vi.hoisted(() => ({ reservePartnerLoginAttempt: vi.fn(), resolvePartnerSession: vi.fn() }));
const partnerRepo = vi.hoisted(() => ({ recordPartnerAccess: vi.fn() }));
const redisState = vi.hoisted(() => ({
  incr: vi.fn(async () => 1), decr: vi.fn(async () => 0), expire: vi.fn(async () => 1), del: vi.fn(async () => 1),
}));

vi.mock('../../config/env.js', () => ({ env: { authJwtSecret: 'synthetic-test-only-jwt-secret-0123456789abcdef' } }));
vi.mock('../../plugins/db.js', () => ({ query: vi.fn(), pool: { connect: vi.fn() } }));
vi.mock('../../plugins/redis.js', () => ({ redis: redisState }));
vi.mock('../../storage/evidenceStorage.js', () => ({ createPresignedDownloadUrl: vi.fn() }));
vi.mock('../../config/privacyControls.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../config/privacyControls.js')>()),
  isPrivacyCapabilityEnabled: vi.fn(() => false),
}));
vi.mock('../../repositories/partnerAuthRepository.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../repositories/partnerAuthRepository.js')>()),
  ...authRepo,
}));
vi.mock('../../repositories/partnerRepository.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../repositories/partnerRepository.js')>()),
  ...partnerRepo,
}));

const ORIGIN = 'https://partners.example.invalid';
const HOST = 'partners.example.invalid';
/** Fastify's default bodyLimit is 1 MiB; one byte more is over it. */
const OVERSIZED_JSON = `{"pad":"${'a'.repeat(1024 * 1024)}"}`;
const FASTIFY_PARSER_TEXT = /Body cannot be empty|not valid JSON|Unsupported Media Type|Request body is too large|FST_ERR/;

type LogLine = { level: number; msg?: string; fastifyCode?: string; statusCode?: number };

let app: FastifyInstance;
let logLines: LogLine[];

async function buildApp(): Promise<FastifyInstance> {
  logLines = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of String(chunk).split('\n').filter(Boolean)) logLines.push(JSON.parse(line) as LogLine);
      callback();
    },
  });
  const built = Fastify({ logger: { level: 'info', stream } });
  // Same order as server.ts: root handler first, survivor routes, then the partner scope.
  registerErrorHandler(built);
  await registerAuthRoutes(built);
  built.get('/api/synthetic/library-fault', async () => {
    throw Object.assign(new Error('synthetic private diagnostic'), { statusCode: 404, code: 'NoSuchKey' });
  });
  built.get('/api/synthetic/fastify-server-fault', async () => {
    // A FastifyError with a 5xx status (a misconfigured parser) is a server fault.
    throw new errorCodes.FST_ERR_CTP_INVALID_TYPE();
  });
  await registerPartnerApi(built, {
    publicOrigin: ORIGIN,
    totpKey: randomBytes(32),
    trustedProxies: parseTrustedProxyCidrs('127.0.0.0/8'),
  });
  await built.register(async scope => {
    applyPartnerScopeGuards(scope, { publicOrigin: ORIGIN });
    scope.get('/library-fault', async () => {
      throw Object.assign(new Error('synthetic private diagnostic'), { statusCode: 413, code: 'EntityTooLarge' });
    });
  }, { prefix: '/partner-synthetic' });
  return built;
}

const ROUTES = {
  survivor: { url: '/auth/signup', headers: {} as Record<string, string> },
  partner: { url: '/partner/v1/auth/login', headers: { host: HOST, origin: ORIGIN } as Record<string, string> },
};

const CASES: Array<{
  name: string;
  headers: Record<string, string>;
  payload: string;
  status: number;
  code: string;
  message: string;
  fastifyCode: string;
}> = [
  {
    name: 'an empty JSON body', headers: { 'content-type': 'application/json' }, payload: '',
    status: 400, code: 'bad_request', message: 'Invalid request', fastifyCode: 'FST_ERR_CTP_EMPTY_JSON_BODY',
  },
  {
    name: 'malformed JSON', headers: { 'content-type': 'application/json' }, payload: '{"email": "synthetic@example.invalid",',
    status: 400, code: 'bad_request', message: 'Invalid request', fastifyCode: 'FST_ERR_CTP_INVALID_JSON_BODY',
  },
  {
    name: 'the wrong content type', headers: { 'content-type': 'application/xml' }, payload: '<signup/>',
    status: 415, code: 'unsupported_media_type', message: 'Unsupported content type', fastifyCode: 'FST_ERR_CTP_INVALID_MEDIA_TYPE',
  },
  {
    name: 'a body over the limit', headers: { 'content-type': 'application/json' }, payload: OVERSIZED_JSON,
    status: 413, code: 'payload_too_large', message: 'Request body exceeds the size limit', fastifyCode: 'FST_ERR_CTP_BODY_TOO_LARGE',
  },
];

describe('Fastify client errors answer 4xx, not 500', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  for (const realm of ['survivor', 'partner'] as const) {
    for (const testCase of CASES) {
      it(`answers ${testCase.name} on the ${realm} route with ${testCase.status}, logged at warn`, async () => {
        const route = ROUTES[realm];
        const options: InjectOptions = {
          method: 'POST',
          url: route.url,
          headers: { ...route.headers, ...testCase.headers },
          payload: testCase.payload,
        };
        const response = await app.inject(options);

        expect(response.statusCode).toBe(testCase.status);
        expect(response.json()).toEqual({ code: testCase.code, message: testCase.message, requestId: expect.any(String) });
        expect(response.body).not.toMatch(FASTIFY_PARSER_TEXT);
        if (realm === 'partner') expect(response.headers['cache-control']).toBe('no-store');

        const rejected = logLines.filter(line => line.msg === 'Client request rejected');
        expect(rejected).toEqual([expect.objectContaining({ level: 40, fastifyCode: testCase.fastifyCode, statusCode: testCase.status })]);
        expect(logLines.filter(line => line.level >= 50)).toEqual([]);
        // The request never reached a handler or a partner repository.
        expect(authRepo.reservePartnerLoginAttempt).not.toHaveBeenCalled();
        expect(partnerRepo.recordPartnerAccess).not.toHaveBeenCalled();
      });
    }
  }

  it('still reaches the survivor handler with a well-formed body', async () => {
    const response = await app.inject({ method: 'POST', url: '/auth/signup', payload: {} });
    // Sign-up is paused while case ingestion is off: the handler's own refusal.
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'service_unavailable' });
    expect(logLines.filter(line => line.msg === 'Client request rejected')).toEqual([]);
  });

  it('runs the partner scope guards before body parsing', async () => {
    const response = await app.inject({
      method: 'POST', url: '/partner/v1/auth/login', headers: { host: HOST, 'content-type': 'application/json' }, payload: '',
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'forbidden' });
  });

  it('keeps a library error carrying a 4xx statusCode a generic 500 on survivor routes', async () => {
    const response = await app.inject('/api/synthetic/library-fault');
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ code: 'internal_error', message: 'Internal server error', requestId: expect.any(String) });
    expect(response.body).not.toContain('private diagnostic');
    expect(logLines.filter(line => line.level === 50 && line.msg === 'Unhandled API error')).toHaveLength(1);
  });

  it('keeps a Fastify server fault a generic 500', async () => {
    const response = await app.inject('/api/synthetic/fastify-server-fault');
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: 'internal_error' });
    expect(response.body).not.toContain('private diagnostic');
  });

  it('keeps a library error carrying 413 a fail-closed 503 on partner routes', async () => {
    const response = await app.inject({ method: 'GET', url: '/partner-synthetic/library-fault', headers: { host: HOST } });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'service_unavailable' });
    expect(response.body).not.toContain('private diagnostic');
    expect(logLines.filter(line => line.level === 50 && line.msg === 'Partner request failed closed')).toHaveLength(1);
  });
});

describe('fastifyClientError', () => {
  it('accepts only FastifyErrors with an FST_ code and a 4xx status', () => {
    expect(fastifyClientError(new errorCodes.FST_ERR_CTP_EMPTY_JSON_BODY())).toEqual({ statusCode: 400, code: 'FST_ERR_CTP_EMPTY_JSON_BODY' });
    expect(fastifyClientError(new errorCodes.FST_ERR_CTP_BODY_TOO_LARGE())).toEqual({ statusCode: 413, code: 'FST_ERR_CTP_BODY_TOO_LARGE' });
    expect(fastifyClientError(new errorCodes.FST_ERR_CTP_INVALID_TYPE())).toBeUndefined();
    expect(fastifyClientError(Object.assign(new Error('synthetic'), { name: 'FastifyError', code: 'NoSuchKey', statusCode: 404 }))).toBeUndefined();
    expect(fastifyClientError(Object.assign(new Error('synthetic'), { code: 'FST_ERR_SPOOFED', statusCode: 400 }))).toBeUndefined();
    expect(fastifyClientError({ name: 'FastifyError', code: 'FST_ERR_CTP_EMPTY_JSON_BODY', statusCode: 400 })).toBeUndefined();
  });
});
