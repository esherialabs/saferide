import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { registerErrorHandler } from '../errorHandler.js';
import { serviceUnavailable } from '../errors.js';

it('preserves case gate reasons after an awaited partner plugin and keeps unknown errors generic', async () => {
  const app = Fastify();
  registerErrorHandler(app);
  app.get('/api/cases', async () => { throw serviceUnavailable('Sending is paused', { reason: 'case_ingestion_disabled' }); });
  app.get('/api/validation', async () => z.string().parse(123));
  app.get('/api/unknown', async () => { throw new Error('synthetic private diagnostic'); });
  // Matches server.ts: register the partner scope after survivor routes.
  await app.register(async scope => { scope.get('/partner/v1/me', async () => ({ ok: true })); });
  try {
    const refused = await app.inject('/api/cases');
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toMatchObject({ code: 'service_unavailable', details: { reason: 'case_ingestion_disabled' } });
    const invalid = await app.inject('/api/validation');
    expect(invalid.statusCode).toBe(400);
    const unknown = await app.inject('/api/unknown');
    expect(unknown.statusCode).toBe(500);
    expect(unknown.body).not.toContain('private diagnostic');
  } finally { await app.close(); }
});
