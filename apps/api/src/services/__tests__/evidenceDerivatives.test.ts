import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({ env: { s3Bucket: 'synthetic-evidence' } }));

const repository = vi.hoisted(() => ({
  claimNextEvidenceDerivative: vi.fn(),
  closeEvidenceDerivative: vi.fn(),
  completeEvidenceDerivative: vi.fn(),
  deleteEvidenceDerivativePurge: vi.fn(),
  expireStaleEvidenceDerivativeClaims: vi.fn(),
  findAttachmentsWithDerivatives: vi.fn(),
  listEvidenceDerivativePurges: vi.fn(),
  withActiveEvidenceDerivativeWrite: vi.fn(),
  withInactiveEvidenceDerivativeCleanup: vi.fn(),
}));
vi.mock('../../repositories/evidenceDerivativeRepository.js', () => repository);

const storage = vi.hoisted(() => {
  class StoredObjectTooLargeError extends Error {}
  class StoredObjectSizeMismatchError extends Error {}
  return {
    EVIDENCE_DERIVATIVE_PREFIX: 'evidence-derivatives/',
    StoredObjectTooLargeError,
    StoredObjectSizeMismatchError,
    buildEvidenceDerivativeObjectKey: vi.fn(() => 'evidence-derivatives/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222'),
    readStoredObject: vi.fn(),
    putEvidenceDerivativeObject: vi.fn(),
    hashStoredObject: vi.fn(),
    deleteEvidenceDerivativeObject: vi.fn(),
  };
});
vi.mock('../../storage/evidenceStorage.js', () => storage);

import type { AttachmentRow } from '../../repositories/caseRepository.js';
import type { EvidenceDerivativeClaim, EvidenceDerivativeRow } from '../../repositories/evidenceDerivativeRepository.js';
import {
  decideShareableDerivative,
  drainEvidenceDerivativePurges,
  processEvidenceDerivativeClaim,
  runEvidenceDerivativeJob,
  type StripRunner,
} from '../evidenceDerivatives.js';
import { stripEvidenceMetadata } from '../evidenceStrip/index.js';

/** The real stripper without the worker sandbox (that has its own tests). */
const inProcess: StripRunner = async (input, mime) => stripEvidenceMetadata(input, mime);

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

function pngChunk(type: string, data: Buffer | string): Buffer {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), body])) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}

const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  pngChunk('IHDR', ihdr),
  pngChunk('tEXt', 'Comment\0SYNTH-COMMENT-MARKER'),
  pngChunk('IDAT', deflateSync(Buffer.from([0, 7]))),
  pngChunk('IEND', Buffer.alloc(0)),
]);

function claim(overrides: Partial<EvidenceDerivativeClaim> = {}): EvidenceDerivativeClaim {
  return {
    derivativeId: 'derivative', attachmentId: 'attachment', claimToken: 'token',
    objectKey: 'evidence-derivatives/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222',
    sourceSha256: sha256(PNG), attempts: 1, attachmentBucket: 'synthetic-evidence',
    attachmentObjectKey: 'evidence/original', attachmentMimeType: 'image/png', attachmentSizeBytes: PNG.length,
    ...overrides,
  };
}

function attachment(overrides: Partial<AttachmentRow> = {}): AttachmentRow {
  return {
    id: 'attachment', owner_id: 'owner', draft_id: null, case_id: 'case', bucket: 'synthetic-evidence', bucket_path: 'evidence/original',
    mime_type: 'image/png', size_bytes: 1, sha256: 'A'.repeat(64), expected_sha256: 'a'.repeat(64),
    upload_manifest: {}, retention: {}, retention_policy_id: 'submitted-case-pending-legal-v1',
    antivirus_status: 'clean', quarantine_status: 'released', scan_evidence: {}, status: 'uploaded', metadata: {},
    created_at: '2026-10-21T00:00:00Z', updated_at: '2026-10-21T00:00:00Z',
    ...overrides,
  };
}

function derivative(overrides: Partial<EvidenceDerivativeRow> = {}): EvidenceDerivativeRow {
  return {
    id: 'derivative', attachment_id: 'attachment', retention_policy_id: 'submitted-case-pending-legal-v1',
    bucket: 'synthetic-evidence', object_key: 'evidence-derivatives/a/b', source_sha256: 'a'.repeat(64), status: 'ready',
    source_format: 'png', method: 'png-chunk-allowlist.v1', mime_type: 'image/png', derivative_sha256: 'b'.repeat(64),
    size_bytes: '42', removed_categories: ['comments', 'text_metadata'], outcome_reason: null, attempts: 1,
    claim_token: null, claimed_at: null, completed_at: '2026-10-21T00:00:00Z',
    created_at: '2026-10-21T00:00:00Z', updated_at: '2026-10-21T00:00:00Z',
    ...overrides,
  };
}

describe('derivative generation', () => {
  beforeEach(() => {
    repository.withActiveEvidenceDerivativeWrite.mockImplementation(async (_claim, write) => { await write(); return true; });
    repository.withInactiveEvidenceDerivativeCleanup.mockImplementation(async (_key, remove) => { await remove(); return true; });
    storage.readStoredObject.mockResolvedValue(Buffer.from(PNG));
    storage.putEvidenceDerivativeObject.mockResolvedValue(undefined);
    storage.deleteEvidenceDerivativeObject.mockResolvedValue(undefined);
    storage.hashStoredObject.mockImplementation(async () => {
      const written = storage.putEvidenceDerivativeObject.mock.calls.at(-1)![1] as Buffer;
      return { sha256: sha256(written), sizeBytes: written.length };
    });
    repository.completeEvidenceDerivative.mockResolvedValue(true);
    repository.closeEvidenceDerivative.mockResolvedValue(true);
  });

  it('writes a validated derivative under its own prefix and records hash, method and categories', async () => {
    expect(await processEvidenceDerivativeClaim(claim())).toEqual({ status: 'ready' });
    const [key, body, contentType] = storage.putEvidenceDerivativeObject.mock.calls[0] as [string, Buffer, string];
    expect(key).toMatch(/^evidence-derivatives\//);
    expect(contentType).toBe('image/png');
    expect(body.toString('latin1')).not.toContain('SYNTH-COMMENT-MARKER');
    expect(repository.completeEvidenceDerivative).toHaveBeenCalledWith({
      derivativeId: 'derivative', claimToken: 'token', derivativeSha256: sha256(body), sizeBytes: body.length,
      method: 'png-chunk-allowlist.v1', mimeType: 'image/png', sourceFormat: 'png', removedCategories: ['comments', 'text_metadata'],
    });
    expect(repository.closeEvidenceDerivative).not.toHaveBeenCalled();
  });

  it('never writes storage after deletion or legal hold invalidates the claim', async () => {
    repository.withActiveEvidenceDerivativeWrite.mockResolvedValue(false);
    expect(await processEvidenceDerivativeClaim(claim(), inProcess)).toEqual({ status: 'lost' });
    expect(storage.putEvidenceDerivativeObject).not.toHaveBeenCalled();
  });

  it.each([
    ['another bucket', { attachmentBucket: 'elsewhere' }, 'source_unavailable'],
    ['over the size cap', { attachmentSizeBytes: 200 * 1024 * 1024 }, 'too_large'],
    ['a different object than was released', { sourceSha256: 'c'.repeat(64) }, 'source_mismatch'],
    ['a declared type the bytes contradict', { attachmentMimeType: 'video/mp4' }, 'type_mismatch'],
  ])('fails closed for %s without writing anything', async (_label, overrides, reason) => {
    expect(await processEvidenceDerivativeClaim(claim(overrides))).toEqual({ status: 'failed', reason });
    expect(storage.putEvidenceDerivativeObject).not.toHaveBeenCalled();
    expect(repository.completeEvidenceDerivative).not.toHaveBeenCalled();
    expect(repository.closeEvidenceDerivative).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', reason }));
  });

  it('marks unsupported formats without writing anything', async () => {
    storage.readStoredObject.mockResolvedValue(Buffer.from('%PDF-1.7 synthetic', 'latin1'));
    const pdf = claim({ sourceSha256: sha256(Buffer.from('%PDF-1.7 synthetic', 'latin1')), attachmentMimeType: 'application/pdf' });
    expect(await processEvidenceDerivativeClaim(pdf)).toEqual({ status: 'unsupported', reason: 'unsupported_format' });
    expect(storage.putEvidenceDerivativeObject).not.toHaveBeenCalled();
    expect(repository.closeEvidenceDerivative).toHaveBeenCalledWith(expect.objectContaining({ status: 'unsupported', sourceFormat: 'pdf' }));
  });

  it('treats read errors, write errors and a bad read-back as storage errors and removes what the claim wrote', async () => {
    storage.readStoredObject.mockRejectedValueOnce(new Error('synthetic outage'));
    expect(await processEvidenceDerivativeClaim(claim(), inProcess)).toEqual({ status: 'failed', reason: 'storage_error' });

    storage.readStoredObject.mockRejectedValueOnce(new storage.StoredObjectTooLargeError());
    expect(await processEvidenceDerivativeClaim(claim(), inProcess)).toEqual({ status: 'failed', reason: 'too_large' });

    storage.readStoredObject.mockRejectedValueOnce(new storage.StoredObjectSizeMismatchError());
    expect(await processEvidenceDerivativeClaim(claim(), inProcess)).toEqual({ status: 'failed', reason: 'source_mismatch' });
    expect(storage.readStoredObject).toHaveBeenLastCalledWith('evidence/original', 100 * 1024 * 1024, PNG.length);

    storage.hashStoredObject.mockResolvedValueOnce({ sha256: 'd'.repeat(64), sizeBytes: 1 });
    expect(await processEvidenceDerivativeClaim(claim(), inProcess)).toEqual({ status: 'failed', reason: 'storage_error' });
    expect(repository.completeEvidenceDerivative).not.toHaveBeenCalled();
    // Every closed claim removes its key: a partial write, or an older derivative it was replacing.
    expect(storage.deleteEvidenceDerivativeObject).toHaveBeenCalledTimes(4);
    expect(storage.deleteEvidenceDerivativeObject).toHaveBeenCalledWith(claim().objectKey, expect.any(AbortSignal));
  });

  it('removes its copy when the evidence stopped being released mid-run, and leaves a lost claim alone', async () => {
    repository.completeEvidenceDerivative.mockResolvedValue(false);
    expect(await processEvidenceDerivativeClaim(claim(), inProcess)).toEqual({ status: 'failed', reason: 'source_unavailable' });
    expect(storage.deleteEvidenceDerivativeObject).toHaveBeenCalledTimes(1);

    repository.closeEvidenceDerivative.mockResolvedValue(false);
    expect(await processEvidenceDerivativeClaim(claim(), inProcess)).toEqual({ status: 'lost' });
    storage.readStoredObject.mockRejectedValueOnce(new Error('synthetic outage'));
    expect(await processEvidenceDerivativeClaim(claim(), inProcess)).toEqual({ status: 'lost' });
    expect(storage.deleteEvidenceDerivativeObject).toHaveBeenCalledTimes(1);
  });

  it('fails a file the sandbox gives up on, never retrying it as a storage error', async () => {
    const overBudget: StripRunner = async () => ({ outcome: 'failed', format: 'isobmff', reason: 'resource_limit' });
    expect(await processEvidenceDerivativeClaim(claim(), overBudget)).toEqual({ status: 'failed', reason: 'resource_limit' });
    expect(repository.closeEvidenceDerivative).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', reason: 'resource_limit' }));
    expect(storage.putEvidenceDerivativeObject).not.toHaveBeenCalled();
  });

  it('skips an item that outlives the item timeout and carries on with the next', async () => {
    repository.expireStaleEvidenceDerivativeClaims.mockResolvedValue([]);
    repository.listEvidenceDerivativePurges.mockResolvedValue([]);
    repository.claimNextEvidenceDerivative
      .mockResolvedValueOnce(claim({ derivativeId: 'stuck' }))
      .mockResolvedValueOnce(claim())
      .mockResolvedValueOnce(null);
    let calls = 0;
    const hangsOnce: StripRunner = (input, mime) => {
      calls += 1;
      return calls === 1 ? new Promise(() => undefined) : inProcess(input, mime);
    };
    const started = Date.now();
    expect(await runEvidenceDerivativeJob({ limit: 10, itemTimeoutMs: 50, strip: hangsOnce })).toMatchObject({ timedOut: 1, ready: 1 });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('runs expiry, purges and claims until none are left, counting outcomes only', async () => {
    repository.expireStaleEvidenceDerivativeClaims.mockResolvedValue(['evidence-derivatives/old/claim']);
    repository.listEvidenceDerivativePurges.mockResolvedValue([
      { objectKey: 'evidence-derivatives/x/y', bucket: 'synthetic-evidence' },
      { objectKey: 'evidence-derivatives/z/w', bucket: 'other-bucket' },
    ]);
    repository.claimNextEvidenceDerivative.mockResolvedValueOnce(claim()).mockResolvedValueOnce(null);
    expect(await runEvidenceDerivativeJob({ limit: 10, strip: inProcess })).toEqual({
      ready: 1, unsupported: 0, failed: 0, lost: 0, timedOut: 0, expired: 1, purged: 1, purgeFailed: 1,
    });
    expect(storage.deleteEvidenceDerivativeObject).toHaveBeenCalledWith('evidence-derivatives/old/claim', expect.any(AbortSignal));
    expect(storage.deleteEvidenceDerivativeObject).toHaveBeenCalledWith('evidence-derivatives/x/y', expect.any(AbortSignal));
    expect(repository.deleteEvidenceDerivativePurge).toHaveBeenCalledWith('evidence-derivatives/x/y');
    expect(repository.deleteEvidenceDerivativePurge).not.toHaveBeenCalledWith('evidence-derivatives/z/w');
  });

  it('keeps a purge queued when the object delete fails', async () => {
    repository.listEvidenceDerivativePurges.mockResolvedValue([{ objectKey: 'evidence-derivatives/x/y', bucket: 'synthetic-evidence' }]);
    storage.deleteEvidenceDerivativeObject.mockRejectedValueOnce(new Error('synthetic outage'));
    expect(await drainEvidenceDerivativePurges(5)).toEqual({ purged: 0, failed: 1 });
    expect(repository.deleteEvidenceDerivativePurge).not.toHaveBeenCalled();
  });
});

describe('getShareableDerivative decision', () => {
  it('shares only a ready derivative of the exact released bytes', () => {
    expect(decideShareableDerivative('attachment', attachment(), derivative())).toEqual({
      shareable: true, attachmentId: 'attachment', objectKey: 'evidence-derivatives/a/b', bucket: 'synthetic-evidence',
      sha256: 'b'.repeat(64), sourceSha256: 'a'.repeat(64), sizeBytes: 42, mimeType: 'image/png',
      method: 'png-chunk-allowlist.v1', removedCategories: ['comments', 'text_metadata'],
    });
  });

  it.each([
    ['no attachment', null, derivative(), 'not_released'],
    ['quarantined', attachment({ quarantine_status: 'quarantined' }), derivative(), 'not_released'],
    ['scan pending', attachment({ antivirus_status: 'pending' }), derivative(), 'not_released'],
    ['hash mismatch', attachment({ expected_sha256: 'e'.repeat(64) }), derivative(), 'not_released'],
    ['not yet generated', attachment(), null, 'processing'],
    ['being generated', attachment(), derivative({ status: 'processing', derivative_sha256: null }), 'processing'],
    ['made from other bytes', attachment(), derivative({ source_sha256: 'f'.repeat(64) }), 'processing'],
    ['unsupported', attachment(), derivative({ status: 'unsupported', derivative_sha256: null }), 'unsupported_format'],
    ['failed', attachment(), derivative({ status: 'failed', derivative_sha256: null }), 'failed'],
    ['a key outside the derivative prefix', attachment(), derivative({ object_key: 'evidence/original' }), 'failed'],
    ['a derivative in another bucket', attachment(), derivative({ bucket: 'elsewhere' }), 'failed'],
  ] as Array<[string, AttachmentRow | null, EvidenceDerivativeRow | null, string]>)('refuses %s', (_label, row, made, reason) => {
    expect(decideShareableDerivative('attachment', row, made)).toEqual({ shareable: false, attachmentId: 'attachment', reason });
  });
});
