import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { REQUEST_ID_OPTIONS } from '../../http/requestId.js';
import { registerRequestContext } from '../requestContext.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('request context', () => {
  const apps: ReturnType<typeof Fastify>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(app => app.close()));
  });

  async function buildApp() {
    // The same request-id options as server.ts.
    const app = Fastify({ logger: false, ...REQUEST_ID_OPTIONS });
    apps.push(app);
    await registerRequestContext(app);
    app.get('/request-id', async request => ({ requestId: request.id }));
    return app;
  }

  it.each([
    'client-correlation-01',
    'partner-chosen-request-id',
    'sensitive narrative and exact location',
    'x'.repeat(500),
  ])('never adopts a client X-Request-Id (%j); the id is generated and echoed', async clientValue => {
    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/request-id', headers: { 'x-request-id': clientValue } });
    const { requestId } = response.json();
    expect(requestId).toMatch(UUID);
    expect(response.headers['x-request-id']).toBe(requestId);
    expect(response.body).not.toContain(clientValue);
  });

  it('gives each request its own id', async () => {
    const app = await buildApp();
    const first = (await app.inject({ method: 'GET', url: '/request-id' })).json().requestId;
    const second = (await app.inject({ method: 'GET', url: '/request-id' })).json().requestId;
    expect(first).toMatch(UUID);
    expect(second).not.toBe(first);
  });
});
