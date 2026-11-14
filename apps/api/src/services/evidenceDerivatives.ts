/**
 * Server-side evidence derivatives: a metadata-stripped copy of each released
 * attachment, for partner downloads. The original is never modified.
 *
 * Flow (jobs/evidenceDerivativeJob.ts, one file at a time):
 *   claim a released attachment -> read the original -> check its sha256 is
 *   the released one -> strip and validate (services/evidenceStrip) -> write
 *   evidence-derivatives/<uuid>/<uuid> -> read it back and re-hash -> mark
 *   ready. Anything else ends `unsupported` or `failed`: no derivative, not
 *   shareable. Deleted derivative rows queue their objects for deletion.
 *
 * Partners are served only through getShareableDerivative(), which re-checks
 * the attachment's release on every call.
 */
import { createHash, randomUUID } from 'node:crypto';

import { env } from '../config/env.js';
import type { AttachmentRow } from '../repositories/caseRepository.js';
import {
  claimNextEvidenceDerivative,
  closeEvidenceDerivative,
  completeEvidenceDerivative,
  deleteEvidenceDerivativePurge,
  type EvidenceDerivativeClaim,
  type EvidenceDerivativeRow,
  expireStaleEvidenceDerivativeClaims,
  findAttachmentsWithDerivatives,
  listEvidenceDerivativePurges,
  withActiveEvidenceDerivativeWrite,
  withInactiveEvidenceDerivativeCleanup,
} from '../repositories/evidenceDerivativeRepository.js';
import {
  buildEvidenceDerivativeObjectKey,
  deleteEvidenceDerivativeObject,
  EVIDENCE_DERIVATIVE_PREFIX,
  hashStoredObject,
  putEvidenceDerivativeObject,
  readStoredObject,
  StoredObjectSizeMismatchError,
  StoredObjectTooLargeError,
} from '../storage/evidenceStorage.js';
import { getEvidenceDownloadDecision } from './evidenceQuarantine.js';
import type { StripOutcome } from './evidenceStrip/index.js';
import { stripInSandbox } from './evidenceStrip/sandbox.js';
import { MAX_EVIDENCE_SIZE_BYTES } from './evidenceUploadPolicy.js';

/** A claim older than this is presumed dead and may be retried. */
export const DERIVATIVE_CLAIM_STALE_SECONDS = 15 * 60;
/** A storage failure is retried no sooner than this. */
export const DERIVATIVE_RETRY_AFTER_SECONDS = 5 * 60;
/** Attempts per source file, counting stale claims and storage failures. */
export const DERIVATIVE_MAX_ATTEMPTS = 3;
/**
 * Wall time for one file end to end (read, strip, write, read back). The
 * strip itself has its own 30 s budget in the sandbox; this also covers a
 * hung storage call. A file over it is skipped; its claim goes stale and is
 * retried at most DERIVATIVE_MAX_ATTEMPTS times, then fails.
 */
export const DERIVATIVE_ITEM_TIMEOUT_MS = 120_000;

/** Strips one file; the default runs the stripper in the budgeted sandbox. */
export type StripRunner = (input: Buffer, declaredMimeType: string | null) => Promise<StripOutcome>;
const sandboxStrip: StripRunner = (input, declaredMimeType) => stripInSandbox(input, declaredMimeType, { transferInput: true });

export type ShareableDerivativeReason = 'unsupported_format' | 'processing' | 'failed' | 'not_released';

export type ShareableDerivative =
  | {
      shareable: true;
      attachmentId: string;
      /** Presign this key (never the attachment's bucket_path). */
      objectKey: string;
      bucket: string;
      /** sha256 of the derivative bytes. */
      sha256: string;
      /** sha256 of the released original it was made from (the packet's file hash). */
      sourceSha256: string;
      sizeBytes: number;
      mimeType: string;
      method: string;
      removedCategories: string[];
    }
  | { shareable: false; attachmentId: string; reason: ShareableDerivativeReason };

/**
 * Pure decision, re-run on every request: the attachment must still pass the
 * release gate, and the derivative must be ready, made from that exact
 * sha256, and stored under the derivative prefix.
 */
export function decideShareableDerivative(
  attachmentId: string,
  attachment: AttachmentRow | null,
  derivative: EvidenceDerivativeRow | null,
): ShareableDerivative {
  if (!attachment || !getEvidenceDownloadDecision(attachment).allowed) {
    return { shareable: false, attachmentId, reason: 'not_released' };
  }
  if (!derivative || derivative.source_sha256 !== attachment.sha256!.toLowerCase() || derivative.status === 'processing') {
    return { shareable: false, attachmentId, reason: 'processing' };
  }
  if (derivative.status === 'unsupported') return { shareable: false, attachmentId, reason: 'unsupported_format' };
  if (
    derivative.status !== 'ready' ||
    derivative.bucket !== env.s3Bucket ||
    !derivative.object_key.startsWith(EVIDENCE_DERIVATIVE_PREFIX) ||
    !derivative.derivative_sha256 ||
    !derivative.mime_type ||
    !derivative.method ||
    derivative.size_bytes === null
  ) {
    return { shareable: false, attachmentId, reason: 'failed' };
  }
  return {
    shareable: true,
    attachmentId,
    objectKey: derivative.object_key,
    bucket: derivative.bucket,
    sha256: derivative.derivative_sha256,
    sourceSha256: derivative.source_sha256,
    sizeBytes: Number(derivative.size_bytes),
    mimeType: derivative.mime_type,
    method: derivative.method,
    removedCategories: derivative.removed_categories,
  };
}

/** Batch form for list views: one decision per requested id. */
export async function getShareableDerivatives(attachmentIds: string[]): Promise<Map<string, ShareableDerivative>> {
  const unique = [...new Set(attachmentIds)];
  const { attachments, derivatives } = await findAttachmentsWithDerivatives(unique);
  const attachmentById = new Map(attachments.map(row => [row.id, row]));
  const derivativeByAttachment = new Map(derivatives.map(row => [row.attachment_id, row]));
  return new Map(unique.map(id => [
    id,
    decideShareableDerivative(id, attachmentById.get(id) ?? null, derivativeByAttachment.get(id) ?? null),
  ]));
}

/**
 * For P3's partner download (PARTNER_EVIDENCE_DOWNLOAD=derivatives): the key
 * to presign, or why there is none. Callers must already have scoped the
 * attachment to the partner's referral and packet.
 */
export async function getShareableDerivative(attachmentId: string): Promise<ShareableDerivative> {
  return (await getShareableDerivatives([attachmentId])).get(attachmentId)!;
}

export type DerivativeRunOutcome =
  | { status: 'ready' }
  | { status: 'unsupported'; reason: string }
  | { status: 'failed'; reason: string }
  | { status: 'lost' }
  | { status: 'timedOut' };

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Closes the claim as never shareable. If it was still ours, the object at
 * the claim's key goes too: a partial write, or the derivative of an older
 * source hash that this run was replacing.
 */
async function close(claim: EvidenceDerivativeClaim, status: 'unsupported' | 'failed', reason: string, format: string | null) {
  const closed = await closeEvidenceDerivative({
    derivativeId: claim.derivativeId, claimToken: claim.claimToken, status, reason, sourceFormat: format,
  });
  if (!closed) return { status: 'lost' } as DerivativeRunOutcome;
  await withInactiveEvidenceDerivativeCleanup(claim.objectKey, () => deleteEvidenceDerivativeObject(claim.objectKey, AbortSignal.timeout(10_000))).catch(() => undefined);
  return { status, reason } as DerivativeRunOutcome;
}

/** Processes one claimed attachment end to end. Never logs or returns content. */
export async function processEvidenceDerivativeClaim(
  claim: EvidenceDerivativeClaim,
  strip: StripRunner = sandboxStrip,
): Promise<DerivativeRunOutcome> {
  if (claim.attachmentBucket !== env.s3Bucket) return close(claim, 'failed', 'source_unavailable', null);
  if (claim.attachmentSizeBytes !== null && claim.attachmentSizeBytes > MAX_EVIDENCE_SIZE_BYTES) {
    return close(claim, 'failed', 'too_large', null);
  }

  let original: Buffer;
  try {
    original = await readStoredObject(claim.attachmentObjectKey, MAX_EVIDENCE_SIZE_BYTES, claim.attachmentSizeBytes);
  } catch (error) {
    if (error instanceof StoredObjectTooLargeError) return close(claim, 'failed', 'too_large', null);
    if (error instanceof StoredObjectSizeMismatchError) return close(claim, 'failed', 'source_mismatch', null);
    return close(claim, 'failed', 'storage_error', null);
  }
  if (sha256(original) !== claim.sourceSha256) return close(claim, 'failed', 'source_mismatch', null);

  let result: StripOutcome;
  try {
    // The sandbox takes over the buffer; `original` is not used after this.
    result = await strip(original, claim.attachmentMimeType);
  } catch {
    return close(claim, 'failed', 'parse_error', null);
  }
  if (result.outcome !== 'stripped') return close(claim, result.outcome, result.reason, result.format);

  const derivativeSha256 = sha256(result.output);
  try {
    const written = await withActiveEvidenceDerivativeWrite(claim, () => putEvidenceDerivativeObject(claim.objectKey, result.output, result.mimeType, AbortSignal.timeout(20_000)));
    if (!written) return { status: 'lost' };
    const stored = await hashStoredObject(claim.objectKey);
    if (stored.sha256 !== derivativeSha256 || stored.sizeBytes !== result.output.length) {
      return close(claim, 'failed', 'storage_error', result.format);
    }
  } catch {
    return close(claim, 'failed', 'storage_error', result.format);
  }

  const completed = await completeEvidenceDerivative({
    derivativeId: claim.derivativeId,
    claimToken: claim.claimToken,
    derivativeSha256,
    sizeBytes: result.output.length,
    method: result.method,
    mimeType: result.mimeType,
    sourceFormat: result.format,
    removedCategories: result.removed,
  });
  if (completed) return { status: 'ready' };

  // Still our claim but the evidence is no longer released: keep no copy. If
  // another worker took over this stale claim instead, leave its object alone.
  return close(claim, 'failed', 'source_unavailable', result.format);
}

/** Deletes queued derivative objects (their rows are gone), then their queue rows. */
export async function drainEvidenceDerivativePurges(limit: number): Promise<{ purged: number; failed: number }> {
  let purged = 0;
  let failed = 0;
  for (const item of await listEvidenceDerivativePurges(limit)) {
    try {
      if (item.bucket !== env.s3Bucket) throw new Error('Derivative purge is for another bucket');
      await deleteEvidenceDerivativeObject(item.objectKey, AbortSignal.timeout(10_000));
      await deleteEvidenceDerivativePurge(item.objectKey);
      purged += 1;
    } catch {
      failed += 1;
    }
  }
  return { purged, failed };
}

export type EvidenceDerivativeRunSummary = {
  ready: number;
  unsupported: number;
  failed: number;
  lost: number;
  timedOut: number;
  expired: number;
  purged: number;
  purgeFailed: number;
};

/** Resolves `{status: 'timedOut'}` if `work` takes longer than `ms`; `work` is left to settle on its own. */
async function withItemTimeout(work: Promise<DerivativeRunOutcome>, ms: number): Promise<DerivativeRunOutcome> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<DerivativeRunOutcome>(resolve => {
    timer = setTimeout(() => resolve({ status: 'timedOut' }), ms);
  });
  try {
    return await Promise.race([work.catch((): DerivativeRunOutcome => ({ status: 'lost' })), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One job run: expire dead claims, drain purges, then process up to `limit`
 * attachments (optionally only `onlyAttachmentIds`, for an on-demand run).
 */
export async function runEvidenceDerivativeJob(options: {
  limit: number;
  onlyAttachmentIds?: string[];
  itemTimeoutMs?: number;
  strip?: StripRunner;
}): Promise<EvidenceDerivativeRunSummary> {
  const summary: EvidenceDerivativeRunSummary = {
    ready: 0, unsupported: 0, failed: 0, lost: 0, timedOut: 0, expired: 0, purged: 0, purgeFailed: 0,
  };
  const expired = await expireStaleEvidenceDerivativeClaims({
    staleAfterSeconds: DERIVATIVE_CLAIM_STALE_SECONDS, maxAttempts: DERIVATIVE_MAX_ATTEMPTS,
  });
  summary.expired = expired.length;
  // An expired claim may have written its object before dying.
  for (const objectKey of expired) await withInactiveEvidenceDerivativeCleanup(objectKey, () => deleteEvidenceDerivativeObject(objectKey, AbortSignal.timeout(10_000))).catch(() => undefined);
  const purges = await drainEvidenceDerivativePurges(options.limit);
  summary.purged = purges.purged;
  summary.purgeFailed = purges.failed;

  for (let processed = 0; processed < options.limit; processed += 1) {
    const claim = await claimNextEvidenceDerivative({
      claimToken: randomUUID(),
      newObjectKey: buildEvidenceDerivativeObjectKey(),
      bucket: env.s3Bucket,
      staleAfterSeconds: DERIVATIVE_CLAIM_STALE_SECONDS,
      retryAfterSeconds: DERIVATIVE_RETRY_AFTER_SECONDS,
      maxAttempts: DERIVATIVE_MAX_ATTEMPTS,
      onlyAttachmentIds: options.onlyAttachmentIds,
    });
    if (!claim) break;
    // One bad file cannot stall the rest: past the item timeout it is skipped.
    const outcome = await withItemTimeout(
      processEvidenceDerivativeClaim(claim, options.strip),
      options.itemTimeoutMs ?? DERIVATIVE_ITEM_TIMEOUT_MS,
    );
    summary[outcome.status] += 1;
  }
  return summary;
}
