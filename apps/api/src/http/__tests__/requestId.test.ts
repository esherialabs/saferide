import { describe, expect, it } from 'vitest';

import { REQUEST_ID_OPTIONS, generateRequestId } from '../requestId.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('request ID boundary', () => {
  it('generates a fresh random UUID for every request', () => {
    const first = generateRequestId();
    expect(first).toMatch(UUID);
    expect(generateRequestId()).not.toBe(first);
  });

  it('configures Fastify to ignore request-id headers and generate ids server-side', () => {
    expect(REQUEST_ID_OPTIONS.requestIdHeader).toBe(false);
    expect(REQUEST_ID_OPTIONS.genReqId()).toMatch(UUID);
  });
});
