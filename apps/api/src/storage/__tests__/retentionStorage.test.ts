import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({ endpoint: '', hang: false }));
vi.mock('../../config/env.js', () => ({ env: {
  get s3Endpoint() { return settings.endpoint; }, get s3PublicEndpoint() { return settings.endpoint; },
  s3Region: 'us-east-1', s3Bucket: 'synthetic-evidence', s3CredentialMode: 'static',
  s3AccessKeyId: 'synthetic-retention-test', s3SecretAccessKey: 'synthetic-retention-test-only',
} }));
let server: Server;
let storage: typeof import('../evidenceStorage.js');
const objects = new Map<string, Buffer>();

describe('retention owned-storage HTTP requests', () => {
  beforeAll(async () => {
    server = createServer((request, response) => {
      if (settings.hang) return;
      const path = new URL(request.url!, 'http://localhost').pathname.replace('/synthetic-evidence/', '');
      if (request.method === 'DELETE') { objects.delete(path); response.writeHead(204); response.end(); return; }
      response.writeHead(200, { 'content-type': 'application/xml' });
      response.end('<LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">us-east-1</LocationConstraint>');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Synthetic listener unavailable');
    settings.endpoint = `http://127.0.0.1:${address.port}`;
    storage = await import('../evidenceStorage.js');
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  it('deletes an owned original and derivative through the signed S3 client, idempotently', async () => {
    objects.set('evidence/synthetic/original', Buffer.from('test'));
    objects.set('evidence-derivatives/synthetic/copy', Buffer.from('safe'));
    await storage.deleteRetainedEvidenceObject('synthetic-evidence', 'evidence/synthetic/original', 'original');
    await storage.deleteRetainedEvidenceObject('synthetic-evidence', 'evidence-derivatives/synthetic/copy', 'derivative');
    await storage.deleteRetainedEvidenceObject('synthetic-evidence', 'evidence/synthetic/original', 'original');
    expect(objects.size).toBe(0);
    await expect(storage.deleteRetainedEvidenceObject('another-bucket', 'evidence/a/b', 'original')).rejects.toThrow('outside');
    await expect(storage.deleteRetainedEvidenceObject('synthetic-evidence', 'unowned/a/b', 'original')).rejects.toThrow('outside');
  });
  it('aborts an actual stalled derivative PUT instead of leaving a late write behind', async () => {
    settings.hang = true;
    try {
      await expect(storage.putEvidenceDerivativeObject('evidence-derivatives/synthetic/stalled', Buffer.from('safe'), 'image/png', AbortSignal.timeout(30))).rejects.toThrow();
    } finally { settings.hang = false; }
  });
});
