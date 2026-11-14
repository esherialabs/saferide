/**
 * completeAttachment (#299: its status parameter was typed two ways, 42P08)
 * against a real, disposable PostgreSQL with migrations 000-008 and
 * runtime-role.sql applied. Skipped unless SAFERIDE_TEST_DATABASE_URL is
 * set. Synthetic data only. From the #295/#299 review probe.
 */
import { createHash, randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  completeAttachment,
  createPendingAttachment,
  listAttachments,
  recordAttachmentMalwareScan,
} from '../caseRepository.js';
import { closeDb, query } from '../../plugins/db.js';

vi.mock('../../config/env.js', () => ({
  env: { databaseUrl: process.env.SAFERIDE_TEST_DATABASE_URL ?? 'postgres://unused.invalid/none' },
}));

const enabled = Boolean(process.env.SAFERIDE_TEST_DATABASE_URL);
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

async function pendingAttachment(ownerId: string, content: string) {
  const { rows } = await query<{ id: string }>(
    `insert into saferide.cases (owner_id, pathway, status) values ($1, 'referral', 'submitted') returning id`,
    [ownerId],
  );
  const caseId = rows[0].id;
  const attachment = await createPendingAttachment({
    ownerId,
    caseId,
    bucket: 'synthetic-evidence',
    objectKey: `synthetic-complete/${randomUUID()}.jpg`,
    mimeType: 'image/jpeg',
    sizeBytes: content.length,
    expectedSha256: sha(content),
    uploadManifest: { displayName: 'synthetic.jpg' },
    retentionPolicyId: 'submitted-case-pending-legal-v1',
    metadata: null,
  });
  expect(attachment.status).toBe('pending_upload');
  return { caseId, attachment };
}

describe.skipIf(!enabled)('completeAttachment against PostgreSQL (#299)', () => {
  afterAll(async () => {
    await closeDb();
  });

  it('completes an uploaded object: uploaded, scan pending, quarantined', async () => {
    const ownerId = randomUUID();
    const { caseId, attachment } = await pendingAttachment(ownerId, 'synthetic-bytes');
    const completed = await completeAttachment({
      ownerId, attachmentId: attachment.id, sha256: sha('synthetic-bytes'), sizeBytes: 15, status: 'uploaded',
    });
    expect(completed).not.toBeNull();
    expect(completed?.status).toBe('uploaded');
    expect(completed?.antivirus_status).toBe('pending');
    expect(completed?.quarantine_status).toBe('quarantined');
    expect(completed?.sha256).toBe(sha('synthetic-bytes'));
    const listed = await listAttachments(ownerId, caseId);
    expect(listed.map(row => row.status)).toEqual(['uploaded']);

    // The next step of the flow still works on the completed row.
    const scanned = await recordAttachmentMalwareScan({
      ownerId, attachmentId: attachment.id, result: 'clean', objectSha256: sha('synthetic-bytes'),
      scanEvidence: { engine: 'synthetic', result: 'clean' },
    });
    expect(scanned?.antivirus_status).toBe('clean');
    expect(scanned?.quarantine_status).toBe('released');
  });

  it.each(['hash_mismatch', 'rejected'] as const)('completes a %s object: not_scanned, rejected', async status => {
    const ownerId = randomUUID();
    const { attachment } = await pendingAttachment(ownerId, 'expected-bytes');
    const completed = await completeAttachment({
      ownerId, attachmentId: attachment.id, sha256: sha('other-bytes'), sizeBytes: 11, status,
    });
    expect(completed?.status).toBe(status);
    expect(completed?.antivirus_status).toBe('not_scanned');
    expect(completed?.quarantine_status).toBe('rejected');
  });

  it('returns null for another owner and leaves the row untouched', async () => {
    const ownerId = randomUUID();
    const { attachment } = await pendingAttachment(ownerId, 'synthetic-bytes');
    const completed = await completeAttachment({
      ownerId: randomUUID(), attachmentId: attachment.id, sha256: sha('x'), sizeBytes: 1, status: 'uploaded',
    });
    expect(completed).toBeNull();
    const { rows } = await query<{ status: string }>(`select status from saferide.attachments where id = $1`, [attachment.id]);
    expect(rows[0].status).toBe('pending_upload');
  });
});
