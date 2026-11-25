/**
 * Runs against a real, disposable PostgreSQL that already has migrations
 * 000-009 and runtime-role.sql applied (the selfhost init path). Skipped
 * unless SAFERIDE_TEST_DATABASE_URL is set. Object storage is an in-memory
 * stand-in; every file is synthetic and generated here.
 */
import { createHash, randomUUID } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';

import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    databaseUrl: process.env.SAFERIDE_TEST_DATABASE_URL ?? 'postgres://unused.invalid/none',
    s3Bucket: 'synthetic-evidence',
  },
}));

const store = vi.hoisted(() => new Map<string, Buffer>());
vi.mock('../../storage/evidenceStorage.js', async () => {
  const { createHash: hash, randomUUID: uuid } = await import('node:crypto');
  const prefix = 'evidence-derivatives/';
  class StoredObjectTooLargeError extends Error {}
  class StoredObjectSizeMismatchError extends Error {}
  return {
    EVIDENCE_DERIVATIVE_PREFIX: prefix,
    StoredObjectTooLargeError,
    StoredObjectSizeMismatchError,
    buildEvidenceDerivativeObjectKey: () => `${prefix}${uuid()}/${uuid()}`,
    readStoredObject: async (key: string, maxBytes: number, expectedBytes?: number | null) => {
      const body = store.get(key);
      if (!body) throw new Error('NoSuchKey');
      if (body.length > maxBytes) throw new StoredObjectTooLargeError();
      if (expectedBytes && body.length !== expectedBytes) throw new StoredObjectSizeMismatchError();
      return Buffer.from(body);
    },
    putEvidenceDerivativeObject: async (key: string, body: Buffer) => {
      if (!key.startsWith(prefix)) throw new Error('outside prefix');
      store.set(key, Buffer.from(body));
    },
    hashStoredObject: async (key: string) => {
      const body = store.get(key);
      if (!body) throw new Error('NoSuchKey');
      return { sha256: hash('sha256').update(body).digest('hex'), sizeBytes: body.length };
    },
    deleteEvidenceDerivativeObject: async (key: string) => {
      if (!key.startsWith(prefix)) throw new Error('outside prefix');
      store.delete(key);
    },
  };
});

import { closeDb, pool, query } from '../../plugins/db.js';
import { claimNextEvidenceDerivative, expireStaleEvidenceDerivativeClaims } from '../../repositories/evidenceDerivativeRepository.js';
import { purgeOnePrivacyObject } from '../../repositories/privacyRetentionRepository.js';
import {
  DERIVATIVE_MAX_ATTEMPTS,
  getShareableDerivative,
  getShareableDerivatives,
  runEvidenceDerivativeJob,
} from '../evidenceDerivatives.js';

const enabled = Boolean(process.env.SAFERIDE_TEST_DATABASE_URL);
const POLICY = 'submitted-case-pending-legal-v1';
const createdCases: string[] = [];

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

/** Little-endian TIFF: IFD0 Make + a GPS IFD with GPSLatitudeRef. */
function gpsTiff(): Buffer {
  const out = Buffer.alloc(68);
  out.write('II', 0, 'latin1');
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(8, 4);
  out.writeUInt16LE(2, 8);
  out.writeUInt16LE(0x010f, 10); // Make
  out.writeUInt16LE(2, 12);
  out.writeUInt32LE(12, 14);
  out.writeUInt32LE(38, 18);
  out.writeUInt16LE(0x8825, 22); // GPS IFD
  out.writeUInt16LE(4, 24);
  out.writeUInt32LE(1, 26);
  out.writeUInt32LE(50, 30);
  out.writeUInt32LE(0, 34);
  out.write('SynthMakeCo\0', 38, 'latin1');
  out.writeUInt16LE(1, 50);
  out.writeUInt16LE(0x0001, 52); // GPSLatitudeRef
  out.writeUInt16LE(2, 54);
  out.writeUInt32LE(2, 56);
  out.write('N\0', 60, 'latin1');
  out.writeUInt32LE(0, 64);
  return out;
}

function syntheticPng(seed: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const raw = Buffer.from([0, seed, seed + 1, 0, seed + 2, seed + 3]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('eXIf', gpsTiff()),
    pngChunk('tEXt', 'Comment\0SYNTH-COMMENT-MARKER'),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function newCase(): Promise<{ caseId: string; ownerId: string }> {
  const ownerId = randomUUID();
  const { rows } = await query<{ id: string }>(
    `insert into saferide.cases (owner_id, pathway, summary) values ($1, 'referral', '{}'::jsonb) returning id`,
    [ownerId],
  );
  createdCases.push(rows[0].id);
  return { caseId: rows[0].id, ownerId };
}

/** A released attachment whose stored object is `bytes` (sha256 recorded as scanned). */
async function releasedAttachment(bytes: Buffer, mimeType: string, options: { released?: boolean; storedBytes?: Buffer } = {}) {
  const { caseId, ownerId } = await newCase();
  const objectKey = `evidence/${randomUUID()}/${randomUUID()}`;
  const hash = sha256(bytes);
  const released = options.released ?? true;
  store.set(objectKey, options.storedBytes ?? bytes);
  const { rows } = await query<{ id: string }>(
    `
      insert into saferide.attachments (
        owner_id, case_id, bucket, bucket_path, mime_type, size_bytes, sha256, expected_sha256,
        retention_policy_id, antivirus_status, quarantine_status, scan_evidence, status
      ) values ($1, $2, 'synthetic-evidence', $3, $4, $5, $6, $6, $7, $8, $9, $10, 'uploaded')
      returning id
    `,
    [
      ownerId, caseId, objectKey, mimeType, bytes.length, hash, POLICY,
      released ? 'clean' : 'pending', released ? 'released' : 'quarantined',
      released ? { schemaVersion: '1.0', synthetic: true } : null,
    ],
  );
  return { attachmentId: rows[0].id, caseId, ownerId, objectKey, sha256: hash };
}

async function derivativeRow(attachmentId: string) {
  const { rows } = await query(`select * from saferide.evidence_derivatives where attachment_id = $1`, [attachmentId]);
  return rows[0] ?? null;
}

async function expectDbError(statement: Promise<unknown>, pattern: RegExp): Promise<void> {
  await expect(statement).rejects.toThrow(pattern);
}

describe.skipIf(!enabled)('evidence derivatives (PostgreSQL)', () => {
  afterAll(async () => {
    if (createdCases.length > 0) await query(`delete from saferide.cases where id = any($1::uuid[])`, [createdCases]);
    await query(`delete from saferide.evidence_derivative_object_purges where object_key like 'evidence-derivatives/%'`);
    await closeDb();
  });

  it('strips released evidence end to end and serves only the derivative key', async () => {
    const original = syntheticPng(10);
    const evidence = await releasedAttachment(original, 'image/png');
    expect(await getShareableDerivative(evidence.attachmentId)).toEqual({
      shareable: false, attachmentId: evidence.attachmentId, reason: 'processing',
    });

    const summary = await runEvidenceDerivativeJob({ limit: 5, onlyAttachmentIds: [evidence.attachmentId] });
    expect(summary).toMatchObject({ ready: 1, failed: 0, unsupported: 0 });

    const row = await derivativeRow(evidence.attachmentId);
    expect(row).toMatchObject({
      status: 'ready', method: 'png-chunk-allowlist.v1', mime_type: 'image/png', source_format: 'png',
      source_sha256: evidence.sha256, retention_policy_id: POLICY, bucket: 'synthetic-evidence', outcome_reason: null,
      claim_token: null, attempts: 1,
    });
    expect(row.object_key).toMatch(/^evidence-derivatives\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/);
    expect(row.removed_categories).toEqual(['exif', 'gps_location', 'device_make_model', 'comments', 'text_metadata']);
    const stored = store.get(row.object_key)!;
    expect(sha256(stored)).toBe(row.derivative_sha256);
    expect(Number(row.size_bytes)).toBe(stored.length);
    for (const marker of ['SynthMakeCo', 'SYNTH-COMMENT-MARKER', 'eXIf', 'tEXt']) {
      expect(stored.toString('latin1')).not.toContain(marker);
    }
    expect(store.get(evidence.objectKey)!.equals(original)).toBe(true); // the original is untouched

    expect(await getShareableDerivative(evidence.attachmentId)).toEqual({
      shareable: true,
      attachmentId: evidence.attachmentId,
      objectKey: row.object_key,
      bucket: 'synthetic-evidence',
      sha256: row.derivative_sha256,
      sourceSha256: evidence.sha256,
      sizeBytes: stored.length,
      mimeType: 'image/png',
      method: 'png-chunk-allowlist.v1',
      removedCategories: ['exif', 'gps_location', 'device_make_model', 'comments', 'text_metadata'],
    });

    // Release is re-checked on every call: re-quarantined evidence is not shareable.
    await query(`update saferide.attachments set quarantine_status = 'quarantined' where id = $1`, [evidence.attachmentId]);
    expect(await getShareableDerivative(evidence.attachmentId)).toMatchObject({ shareable: false, reason: 'not_released' });
    await query(`update saferide.attachments set quarantine_status = 'released' where id = $1`, [evidence.attachmentId]);

    // Done means done: a second run claims nothing for it.
    expect(await runEvidenceDerivativeJob({ limit: 5, onlyAttachmentIds: [evidence.attachmentId] })).toMatchObject({ ready: 0 });
  });

  it('records unsupported, failed and unreleased evidence as never shareable', async () => {
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic\0\0\0\0mif1heic', 'latin1')]);
    const unsupported = await releasedAttachment(heic, 'image/heic');
    const mislabelled = await releasedAttachment(syntheticPng(20), 'image/jpeg');
    const swapped = await releasedAttachment(syntheticPng(30), 'image/png', { storedBytes: syntheticPng(31) });
    const missing = await releasedAttachment(syntheticPng(40), 'image/png');
    store.delete(missing.objectKey);
    const quarantined = await releasedAttachment(syntheticPng(50), 'image/png', { released: false });
    const ids = [unsupported, mislabelled, swapped, missing, quarantined].map(item => item.attachmentId);

    const summary = await runEvidenceDerivativeJob({ limit: 10, onlyAttachmentIds: ids });
    expect(summary).toMatchObject({ ready: 0, unsupported: 1, failed: 3 });

    expect(await derivativeRow(unsupported.attachmentId)).toMatchObject({
      status: 'unsupported', outcome_reason: 'unsupported_format', source_format: 'heif', derivative_sha256: null,
    });
    expect(await derivativeRow(mislabelled.attachmentId)).toMatchObject({ status: 'failed', outcome_reason: 'type_mismatch' });
    expect(await derivativeRow(swapped.attachmentId)).toMatchObject({ status: 'failed', outcome_reason: 'source_mismatch' });
    expect(await derivativeRow(missing.attachmentId)).toMatchObject({ status: 'failed', outcome_reason: 'storage_error', attempts: 1 });
    expect(await derivativeRow(quarantined.attachmentId)).toBeNull();
    for (const id of ids) {
      const row = await derivativeRow(id);
      if (row) expect(store.has(row.object_key)).toBe(false); // nothing was written
    }

    const decisions = await getShareableDerivatives(ids);
    expect(ids.map(id => decisions.get(id))).toEqual([
      { shareable: false, attachmentId: unsupported.attachmentId, reason: 'unsupported_format' },
      { shareable: false, attachmentId: mislabelled.attachmentId, reason: 'failed' },
      { shareable: false, attachmentId: swapped.attachmentId, reason: 'failed' },
      { shareable: false, attachmentId: missing.attachmentId, reason: 'failed' },
      { shareable: false, attachmentId: quarantined.attachmentId, reason: 'not_released' },
    ]);
    expect(await getShareableDerivative(randomUUID())).toMatchObject({ shareable: false, reason: 'not_released' });

    // A storage failure is retried, but not before the retry delay.
    store.set(missing.objectKey, syntheticPng(40));
    expect(await runEvidenceDerivativeJob({ limit: 5, onlyAttachmentIds: [missing.attachmentId] })).toMatchObject({ ready: 0, failed: 0 });
    await query(`update saferide.evidence_derivatives set completed_at = now() - interval '1 hour' where attachment_id = $1`, [missing.attachmentId]);
    expect(await runEvidenceDerivativeJob({ limit: 5, onlyAttachmentIds: [missing.attachmentId] })).toMatchObject({ ready: 1 });
    expect(await derivativeRow(missing.attachmentId)).toMatchObject({ status: 'ready', attempts: 2 });
  });

  it('fails a crafted movie on its resource limit, for good', async () => {
    const u32 = (value: number) => Buffer.from([value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
    const box = (type: string, ...parts: Buffer[]) => Buffer.concat([u32(Buffer.concat(parts).length + 8), Buffer.from(type, 'latin1'), ...parts]);
    const trak = box('trak', box('mdia', box('hdlr', u32(0), u32(0), Buffer.from('vide', 'latin1'), Buffer.alloc(12))));
    const movie = Buffer.concat([
      box('ftyp', Buffer.from('isom', 'latin1'), u32(0)),
      box('moov', ...Array(5000).fill(trak)),
      box('mdat', Buffer.from('x', 'latin1')),
    ]);
    const evidence = await releasedAttachment(movie, 'video/mp4');
    expect(await runEvidenceDerivativeJob({ limit: 5, onlyAttachmentIds: [evidence.attachmentId] })).toMatchObject({ failed: 1 });
    expect(await derivativeRow(evidence.attachmentId)).toMatchObject({ status: 'failed', outcome_reason: 'resource_limit', attempts: 1 });
    expect(await runEvidenceDerivativeJob({ limit: 5, onlyAttachmentIds: [evidence.attachmentId] })).toMatchObject({ failed: 0 });
  });

  it('removes the old derivative when re-deriving a changed source fails', async () => {
    const evidence = await releasedAttachment(syntheticPng(95), 'image/png');
    await runEvidenceDerivativeJob({ limit: 5, onlyAttachmentIds: [evidence.attachmentId] });
    const ready = await derivativeRow(evidence.attachmentId);
    expect(store.has(ready.object_key)).toBe(true);

    // The stored object and its recorded hash change to something that cannot be stripped.
    const replacement = Buffer.from('%PDF-1.7 synthetic replacement', 'latin1');
    store.set(evidence.objectKey, replacement);
    await query(
      `update saferide.attachments set sha256 = $2, expected_sha256 = $2, size_bytes = $3, mime_type = 'image/png' where id = $1`,
      [evidence.attachmentId, sha256(replacement), replacement.length],
    );
    expect(await getShareableDerivative(evidence.attachmentId)).toMatchObject({ shareable: false, reason: 'processing' });
    expect(await runEvidenceDerivativeJob({ limit: 5, onlyAttachmentIds: [evidence.attachmentId] })).toMatchObject({ unsupported: 1 });
    expect(await derivativeRow(evidence.attachmentId)).toMatchObject({ status: 'unsupported', object_key: ready.object_key });
    expect(store.has(ready.object_key)).toBe(false);
  });

  it('enforces the record states and identity in the database', async () => {
    const evidence = await releasedAttachment(syntheticPng(60), 'image/png');
    const pending = await releasedAttachment(syntheticPng(61), 'image/png', { released: false });
    const key = () => `evidence-derivatives/${randomUUID()}/${randomUUID()}`;
    const insert = (values: Record<string, unknown>) => {
      const row = {
        attachment_id: evidence.attachmentId, retention_policy_id: POLICY, bucket: 'synthetic-evidence',
        object_key: key(), source_sha256: evidence.sha256, status: 'processing', claim_token: randomUUID(),
        claimed_at: new Date(), ...values,
      };
      const columns = Object.keys(row);
      return query(
        `insert into saferide.evidence_derivatives (${columns.join(', ')}) values (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
        Object.values(row),
      );
    };

    await expectDbError(insert({ status: 'ready', claim_token: null, completed_at: new Date() }), /evidence_derivative_state/);
    await expectDbError(insert({ object_key: 'evidence/not-a-derivative' }), /object_key_check/);
    await expectDbError(insert({ attachment_id: pending.attachmentId }), /not released evidence/);
    await expectDbError(insert({ source_sha256: 'f'.repeat(64) }), /not released evidence/);
    await expectDbError(insert({ retention_policy_id: 'local-manual-v1' }), /foreign key/);
    await expectDbError(insert({
      status: 'failed', claim_token: null, completed_at: new Date(), outcome_reason: 'device_said_so',
    }), /outcome_reason_check|evidence_derivative_state/);
    await expectDbError(insert({
      status: 'ready', claim_token: null, completed_at: new Date(), derivative_sha256: 'a'.repeat(64), size_bytes: 1,
      method: 'png-chunk-allowlist.v1', mime_type: 'image/png', source_format: 'png', removed_categories: ['gps_coordinates_text'],
    }), /removed_categories_check/);

    await insert({});
    await expectDbError(
      query(`update saferide.evidence_derivatives set object_key = $2 where attachment_id = $1`, [evidence.attachmentId, key()]),
      /identity is immutable/,
    );
    await expectDbError(insert({}), /duplicate key/);
  });

  it('follows the attachment retention policy and deletes the stored copy with the evidence', async () => {
    const evidence = await releasedAttachment(syntheticPng(70), 'image/png');
    await runEvidenceDerivativeJob({ limit: 5, onlyAttachmentIds: [evidence.attachmentId] });
    const row = await derivativeRow(evidence.attachmentId);
    expect(store.has(row.object_key)).toBe(true);

    await query(`update saferide.attachments set retention_policy_id = 'local-30-days-v1' where id = $1`, [evidence.attachmentId]);
    expect(await derivativeRow(evidence.attachmentId)).toMatchObject({ retention_policy_id: 'local-30-days-v1', status: 'ready' });

    await query(`delete from saferide.cases where id = $1`, [evidence.caseId]);
    expect(await derivativeRow(evidence.attachmentId)).toBeNull();
    const queued = await query(`select bucket from saferide.privacy_object_purges where object_key = $1`, [row.object_key]);
    expect(queued.rows).toEqual([{ bucket: 'synthetic-evidence' }]);

    await query(`update saferide.privacy_object_purges set created_at=now()-interval '11 minutes',next_attempt_at=now()-interval '1 second' where owner_id=$1`,[evidence.ownerId]);
    const remove = async (item: {object_key:string}) => {store.delete(item.object_key);};
    expect(await purgeOnePrivacyObject(remove,[evidence.ownerId])).toBe('deleted');
    expect(await purgeOnePrivacyObject(remove,[evidence.ownerId])).toBe('deleted');
    expect(store.has(row.object_key)).toBe(false);
    expect((await query(`select completed_at is not null as done from saferide.privacy_object_purges where object_key = $1`, [row.object_key])).rows).toEqual([{done:true}]);
  });

  it('never lets two workers hold one attachment, and retires claims that keep dying', async () => {
    const evidence = await releasedAttachment(syntheticPng(80), 'image/png');
    const claim = () => claimNextEvidenceDerivative({
      claimToken: randomUUID(), newObjectKey: `evidence-derivatives/${randomUUID()}/${randomUUID()}`,
      bucket: 'synthetic-evidence', staleAfterSeconds: 900, retryAfterSeconds: 300, maxAttempts: DERIVATIVE_MAX_ATTEMPTS,
      onlyAttachmentIds: [evidence.attachmentId],
    });
    const claims = await Promise.all([claim(), claim(), claim(), claim()]);
    const winners = claims.filter(Boolean);
    expect(winners).toHaveLength(1);
    const objectKey = winners[0]!.objectKey;
    expect(await claim()).toBeNull(); // a live claim is not taken over

    for (let attempt = 2; attempt <= DERIVATIVE_MAX_ATTEMPTS; attempt += 1) {
      await query(`update saferide.evidence_derivatives set claimed_at = now() - interval '1 hour' where attachment_id = $1`, [evidence.attachmentId]);
      const retaken = await claim();
      expect(retaken).toMatchObject({ attempts: attempt, objectKey }); // same key: a retry overwrites, never orphans
    }
    await query(`update saferide.evidence_derivatives set claimed_at = now() - interval '1 hour' where attachment_id = $1`, [evidence.attachmentId]);
    expect(await claim()).toBeNull();
    expect(await expireStaleEvidenceDerivativeClaims({ staleAfterSeconds: 900, maxAttempts: DERIVATIVE_MAX_ATTEMPTS })).toContain(objectKey);
    expect(await derivativeRow(evidence.attachmentId)).toMatchObject({ status: 'failed', outcome_reason: 'processing_timeout', claim_token: null });
    expect(await getShareableDerivative(evidence.attachmentId)).toMatchObject({ shareable: false, reason: 'failed' });
  });

  it('gives the runtime role only what the job needs', async () => {
    const role = await query(`select 1 from pg_roles where rolname = 'saferide_api'`);
    if (role.rows.length === 0) return;
    const evidence = await releasedAttachment(syntheticPng(90), 'image/png');
    await runEvidenceDerivativeJob({ limit: 5, onlyAttachmentIds: [evidence.attachmentId] });
    const row = await derivativeRow(evidence.attachmentId);

    const asRuntime = async (statement: string, values: unknown[] = []) => {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('set local role saferide_api');
        const result = await client.query(statement, values);
        await client.query('commit');
        return result;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    };

    await asRuntime(`select count(*) from saferide.evidence_derivatives`);
    await asRuntime(`update saferide.evidence_derivatives set attempts = attempts where attachment_id = $1`, [evidence.attachmentId]);
    await expectDbError(asRuntime(`delete from saferide.evidence_derivatives where attachment_id = $1`, [evidence.attachmentId]), /permission denied/);
    await expectDbError(
      asRuntime(`insert into saferide.evidence_derivative_object_purges (object_key, bucket) values ('evidence-derivatives/x', 'b')`),
      /permission denied/,
    );
    await expectDbError(asRuntime(`truncate saferide.evidence_derivatives`), /permission denied/);

    // Deleting the case as the runtime role still removes the derivative row and queues its object.
    await asRuntime(`delete from saferide.cases where id = $1`, [evidence.caseId]);
    expect(await derivativeRow(evidence.attachmentId)).toBeNull();
    const queued = await asRuntime(`select object_key from saferide.privacy_object_purges where object_key = $1`, [row.object_key]);
    expect(queued.rows).toHaveLength(1);
  });
});
