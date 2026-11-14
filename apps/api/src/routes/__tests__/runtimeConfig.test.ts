import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env', () => ({
  env: {
    appEnvironment: 'test',
    apiPublicBaseUrl: 'https://api.example.test',
    wsPublicBaseUrl: 'wss://api.example.test',
    authPublicBaseUrl: 'https://auth.example.test',
    storagePublicBaseUrl: 'https://storage.example.test',
  },
}));

import { registerRuntimeConfigRoutes } from '../runtimeConfig';

describe('runtime config route', () => {
  it('publishes a content-free disabled tuned artifact decision', async () => {
    const app = Fastify({ logger: false });
    await registerRuntimeConfigRoutes(app);
    const response = await app.inject({ method: 'GET', url: '/api/config/runtime' });
    expect(response.statusCode).toBe(200);
    expect(response.json().localAi).toMatchObject({
      enabled: false,
      activeManifestId: null,
      rolloutPercent: 0,
      rollbackTargetManifestId: 'fail-closed:no-local-ai',
    });
    await app.close();
  });

  it('keeps partner sharing off by default', async () => {
    const app = Fastify({ logger: false });
    await registerRuntimeConfigRoutes(app);
    const response = await app.inject({ method: 'GET', url: '/api/config/runtime' });
    expect(response.json().features).toMatchObject({ partnerRouting: false, partnerCallback: false });
    expect(response.json().partnerConsentVersions).toEqual({ partner_follow_up: null, partner_callback: null });
    expect(response.json().features.caseSubmission).toBe(false);
    await app.close();
  });
});
