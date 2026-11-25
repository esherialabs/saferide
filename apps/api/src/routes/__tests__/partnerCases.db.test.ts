/**
 * End to end across both realms against a real, disposable PostgreSQL with
 * migrations 000-008, 010, 011 and runtime-role.sql applied. Skipped unless
 * SAFERIDE_TEST_DATABASE_URL is set. Synthetic data only; the privacy
 * controls come from a temporary test manifest, never the checked-in one.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { resetPrivacyControlsForTests } from '../../config/privacyControls.js';
import { AppError } from '../../http/errors.js';
import { REQUEST_ID_OPTIONS } from '../../http/requestId.js';
import { registerRequestContext } from '../../middleware/requestContext.js';
import { partnerCsrfToken } from '../../middleware/partnerSession.js';
import * as db from '../../plugins/db.js';
import { generatePartnerReference, generatePartnerToken, hashPartnerToken } from '../../services/partnerTokens.js';
import { registerCaseRoutes } from '../cases.js';
import { registerPartnerApi } from '../partnerAuth.js';
import { registerPrivacyRoutes } from '../privacy.js';

const SYNTHETIC_JWT_SECRET = 'synthetic-test-only-jwt-secret-0123456789abcdef';
const SYNTHETIC_PARTNER_KEY = 'cd'.repeat(32);
const SYNTHETIC_CALLBACK_KEY = 'ef'.repeat(32);
/** Shape-valid sealed TOTP placeholder; these users never sign in with TOTP here. */
const SEALED_PLACEHOLDER = `v1.${'A'.repeat(16)}.${'B'.repeat(22)}.${'C'.repeat(27)}`;
const ORIGIN = 'https://partners.example.invalid';
const HOST = 'partners.example.invalid';

vi.mock('../../config/env.js', () => ({
  env: {
    databaseUrl: process.env.SAFERIDE_TEST_DATABASE_URL ?? 'postgres://unused.invalid/none',
    authJwtSecret: 'synthetic-test-only-jwt-secret-0123456789abcdef',
    appEnvironment: 'test',
    partnerPublicOrigin: 'https://partners.example.invalid',
    partnerTotpKey: 'cd'.repeat(32),
    partnerCallbackKey: 'ef'.repeat(32),
    // Without a trusted gateway range the API refuses the realm and routing (P7).
    partnerTrustedProxyCidrs: '127.0.0.0/8',
    s3Bucket: 'synthetic-evidence',
  },
}));
vi.mock('../../plugins/redis.js', () => ({ redis: { incr: vi.fn(async () => 1), expire: vi.fn(async () => 1) } }));
vi.mock('../../plugins/metrics.js', () => ({ uploadCounter: { labels: vi.fn(() => ({ inc: vi.fn() })) } }));
vi.mock('../../storage/evidenceStorage.js', () => ({
  buildEvidenceObjectKey: vi.fn(), createPresignedUploadPolicy: vi.fn(), deleteEvidenceObject: vi.fn(), hashStoredObject: vi.fn(),
  createPresignedDownloadUrl: vi.fn(async () => 'https://storage.example.invalid/synthetic-presigned'),
}));

const enabled = Boolean(process.env.SAFERIDE_TEST_DATABASE_URL);
const run = randomUUID().slice(0, 8);
const FOLLOW_UP_VERSION = 'partner-follow-up.test-partner.v1';
const CALLBACK_VERSION = 'partner-callback.test-partner.v1';

let app: FastifyInstance;
let manifestDir: string;
const originalManifestPath = process.env.SAFERIDE_PRIVACY_CONTROLS_PATH;

const state = {
  huriaOrgId: '', otherOrgId: '',
  caseworker: { userId: '', token: '' },
  admin: { userId: '', token: '' },
  otherCaseworker: { userId: '', token: '' },
  survivorId: randomUUID(),
  survivorJwt: '',
  followUpConsentId: '', callbackConsentId: '',
  caseId: '', referralId: '', reference: '',
  otherReferralId: '', otherOwnerId: randomUUID(), otherCaseId: '',
  releasedAttachmentId: '', quarantinedAttachmentId: '', lateAttachmentId: '',
};

function partner(who: { token: string }, method: 'GET' | 'POST', path: string, body?: unknown) {
  const inject: InjectOptions = {
    method,
    url: `/partner/v1${path}`,
    headers: {
      host: HOST, origin: ORIGIN, cookie: `__Host-saferide_partner=${who.token}`,
      ...(method === 'POST' ? { 'x-saferide-partner-csrf': partnerCsrfToken(who.token) } : {}),
    },
  };
  if (body !== undefined) inject.payload = body as InjectOptions['payload'];
  return app.inject(inject);
}

function partnerWithClientRequestId(who: { token: string }, path: string, body: unknown, clientRequestId: string) {
  return app.inject({
    method: 'POST',
    url: `/partner/v1${path}`,
    headers: {
      host: HOST, origin: ORIGIN, cookie: `__Host-saferide_partner=${who.token}`,
      'x-saferide-partner-csrf': partnerCsrfToken(who.token), 'x-request-id': clientRequestId,
    },
    payload: body as InjectOptions['payload'],
  });
}

function survivor(method: 'GET' | 'POST', url: string, body?: unknown) {
  const inject: InjectOptions = { method, url, headers: { authorization: `Bearer ${state.survivorJwt}` } };
  if (body !== undefined) inject.payload = body as InjectOptions['payload'];
  return app.inject(inject);
}

async function partnerUser(orgId: string, label: string, role: 'partner_admin' | 'partner_caseworker') {
  const { rows } = await db.query<{ id: string }>(
    `insert into saferide.partner_users (
       org_id, email, display_name, role, status, password_hash, totp_secret_enc, totp_enrolled_at
     ) values ($1, $2, $3, $4, 'active', 'scrypt$synthetic-test-hash', $5, now())
     returning id`,
    [orgId, `${label}-${run}@example.invalid`, `Synthetic ${label}`, role, SEALED_PLACEHOLDER],
  );
  const token = generatePartnerToken('session');
  await db.query(
    `insert into saferide.partner_sessions (token_hash, user_id, org_id, mfa_verified, idle_expires_at, absolute_expires_at)
     values ($1, $2, $3, true, now() + interval '30 minutes', now() + interval '11 hours')`,
    [hashPartnerToken(token), rows[0].id, orgId],
  );
  return { userId: rows[0].id, token };
}

async function auditFor(userId: string): Promise<string[]> {
  const { rows } = await db.query<{ action: string; outcome: string; referral_id: string | null; attachment_id: string | null }>(
    `select action, outcome, referral_id, attachment_id from saferide.partner_access_audit
     where partner_user_id = $1 order by created_at, id`,
    [userId],
  );
  return rows.map(row => [row.action, row.outcome, row.referral_id === state.referralId ? 'own' : row.referral_id === state.otherReferralId ? 'other' : '-', row.attachment_id ? 'att' : '-'].join(' '));
}

// The packet the survivor consented to lists two photos (light redaction keeps their checksums).
const RELEASED_SHA256 = 'b'.repeat(64);
const QUARANTINED_SHA256 = 'c'.repeat(64);
const escalation = {
  schemaVersion: '1.0', workflowType: 'submitted-case', pathway: 'escalation',
  submission: {
    schemaVersion: '1.0', workflowType: 'escalation',
    packet: {
      version: '1.0', generatedAt: '2026-10-21T07:00:00.000Z', pathway: 'escalate', redactionLevel: 'light',
      contact: { preference: 'none', label: 'No contact identity included' },
      content: {
        timeRange: 'Synthetic evening', location: 'Synthetic stage | public_transport | Coordinates: -4.0435, 39.6682',
        incidentDescription: 'Synthetic description', statement: '[redacted]', tags: ['harassment'], patterns: [], transportIdentifiers: [],
      },
      evidenceManifest: [
        { id: 'synthetic-device-file-1', type: 'photo', label: 'Photo 1', sizeBytes: 10, checksum: RELEASED_SHA256, metadataStatus: 'synthetic', privacyRequests: [] },
        { id: 'synthetic-device-file-2', type: 'photo', label: 'Photo 2', sizeBytes: 10, checksum: QUARANTINED_SHA256, metadataStatus: 'synthetic', privacyRequests: [] },
      ],
      redaction: { appliedLabels: ['names'], textFields: ['statement'], evidenceMetadata: 'redacted', mediaProcessing: [] },
    },
  },
};

describe.skipIf(!enabled)('partner dashboard API end to end on the synthetic test partner (PostgreSQL)', () => {
  beforeAll(async () => {
    const controls = JSON.parse(readFileSync(new URL('../../../../../config/privacy/privacy-controls.v1.json', import.meta.url), 'utf8'));
    controls.consentPurposes.pathway_submission = { status: 'enabled', version: 'pathway-consent.v1' };
    controls.consentPurposes.partner_follow_up = { status: 'enabled', version: FOLLOW_UP_VERSION };
    controls.consentPurposes.partner_callback = { status: 'enabled', version: CALLBACK_VERSION };
    controls.capabilities.submitted_case_ingestion = { status: 'enabled', version: 'synthetic-test-only' };
    manifestDir = mkdtempSync(join(tmpdir(), 'saferide-partner-e2e-'));
    writeFileSync(join(manifestDir, 'privacy-controls.json'), JSON.stringify(controls));
    process.env.SAFERIDE_PRIVACY_CONTROLS_PATH = join(manifestDir, 'privacy-controls.json');
    resetPrivacyControlsForTests();

    const huria = await db.query<{ id: string }>(
      `insert into saferide.partner_organizations (
         stable_id, display_name, intake_enabled, agreement_ref, agreement_signed_at, agreement_expires_at
       ) values ('test-partner', 'Test partner (synthetic)', true, 'SYNTHETIC-TEST', now() - interval '1 day', now() + interval '30 days')
       on conflict (stable_id) do update set status = 'active', intake_enabled = true, agreement_ref = 'SYNTHETIC-TEST',
         agreement_signed_at = now() - interval '1 day', agreement_expires_at = now() + interval '30 days'
       returning id`,
    );
    state.huriaOrgId = huria.rows[0].id;
    const other = await db.query<{ id: string }>(
      `insert into saferide.partner_organizations (
         stable_id, display_name, intake_enabled, agreement_ref, agreement_signed_at, agreement_expires_at
       ) values ($1, 'Synthetic other org', true, 'SYNTHETIC-TEST', now() - interval '1 day', now() + interval '30 days')
       returning id`,
      [`test-other-${run}`],
    );
    state.otherOrgId = other.rows[0].id;
    state.caseworker = await partnerUser(state.huriaOrgId, 'huria-caseworker', 'partner_caseworker');
    state.admin = await partnerUser(state.huriaOrgId, 'huria-admin', 'partner_admin');
    state.otherCaseworker = await partnerUser(state.otherOrgId, 'other-caseworker', 'partner_caseworker');
    state.survivorJwt = await new SignJWT({ role: 'survivor' }).setProtectedHeader({ alg: 'HS256' }).setSubject(state.survivorId)
      .setIssuedAt().setExpirationTime('10m').sign(new TextEncoder().encode(SYNTHETIC_JWT_SECRET));

    // Another org's referral, for the isolation checks.
    const otherCase = await db.query<{ id: string }>(
      `insert into saferide.cases (owner_id, pathway, status, summary) values ($1, 'referral', 'submitted', $2) returning id`,
      [state.otherOwnerId, { workflow: { workflowType: 'referral' } }],
    );
    state.otherCaseId = otherCase.rows[0].id;
    const otherConsent = await db.query<{ id: string }>(
      `insert into saferide.consent_records (owner_id, purpose, consent_version, status, granted_at)
       values ($1, 'partner_follow_up', 'synthetic-test.v1', 'granted', now()) returning id`,
      [state.otherOwnerId],
    );
    const otherReferral = await db.query<{ id: string }>(
      `insert into saferide.partner_referrals (case_id, owner_id, org_id, consent_record_id, reference)
       values ($1, $2, $3, $4, $5) returning id`,
      [state.otherCaseId, state.otherOwnerId, state.otherOrgId, otherConsent.rows[0].id, generatePartnerReference()],
    );
    state.otherReferralId = otherReferral.rows[0].id;

    // The production request-id options: client X-Request-Id headers are ignored.
    app = Fastify({ logger: false, ...REQUEST_ID_OPTIONS });
    await registerRequestContext(app);
    app.setErrorHandler((error, request, reply) => {
      if (error instanceof AppError) {
        reply.status(error.statusCode).send({ code: error.code, message: error.message, details: error.details });
      } else if (error instanceof ZodError) {
        reply.status(400).send({ code: 'bad_request' });
      } else {
        reply.status(500).send({ code: 'internal_error' });
      }
    });
    await registerPrivacyRoutes(app);
    await registerCaseRoutes(app);
    await registerPartnerApi(app, {
      publicOrigin: ORIGIN,
      totpKey: Buffer.from(SYNTHETIC_PARTNER_KEY, 'hex'),
      callbackKey: Buffer.from(SYNTHETIC_CALLBACK_KEY, 'hex'),
    });
  });

  afterAll(async () => {
    await app?.close();
    await db.closeDb();
    if (originalManifestPath === undefined) delete process.env.SAFERIDE_PRIVACY_CONTROLS_PATH;
    else process.env.SAFERIDE_PRIVACY_CONTROLS_PATH = originalManifestPath;
    resetPrivacyControlsForTests();
    if (manifestDir) rmSync(manifestDir, { recursive: true, force: true });
  });

  it('routes a survivor escalation to HURIA only with both consents, opt-in per report', async () => {
    const followUp = await survivor('POST', '/api/privacy/consents', { purpose: 'partner_follow_up', consentVersion: FOLLOW_UP_VERSION });
    const callback = await survivor('POST', '/api/privacy/consents', { purpose: 'partner_callback', consentVersion: CALLBACK_VERSION });
    expect(followUp.statusCode).toBe(200);
    expect(callback.statusCode).toBe(200);
    state.followUpConsentId = followUp.json().consent.id;
    state.callbackConsentId = callback.json().consent.id;

    const pathwayConsentId = randomUUID();
    const body = {
      idempotencyKey: pathwayConsentId,
      pathwayConsent: { recordId: pathwayConsentId, purpose: 'pathway_submission', version: 'pathway-consent.v1' },
      workflow: escalation,
      partnerRouting: {
        partnerStableId: 'test-partner', consentRecordId: state.followUpConsentId,
        callback: { phoneNumber: '0712 345 678', consentRecordId: state.callbackConsentId },
      },
    };
    const created = await survivor('POST', '/api/cases', body);
    expect(created.statusCode).toBe(200);
    expect(created.json().partnerReferral).toMatchObject({ partnerStableId: 'test-partner', status: 'new', callbackShared: true });
    expect(created.body).not.toContain('712345678');
    state.caseId = created.json().case.id;
    state.reference = created.json().partnerReferral.reference;
    const referral = await db.query<{ id: string }>(`select id from saferide.partner_referrals where case_id = $1`, [state.caseId]);
    state.referralId = referral.rows[0].id;

    // The same consent cannot route a second report.
    const secondConsent = randomUUID();
    const reused = await survivor('POST', '/api/cases', {
      ...body, idempotencyKey: secondConsent,
      pathwayConsent: { ...body.pathwayConsent, recordId: secondConsent },
      partnerRouting: { partnerStableId: 'test-partner', consentRecordId: state.followUpConsentId },
    });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().details).toEqual({ reason: 'partner_consent_missing' });

    // Evidence uploaded after routing: the two files the packet listed (one released,
    // one still quarantined) and a third file the packet never listed.
    const released = await db.query<{ id: string }>(
      `insert into saferide.attachments (
         owner_id, case_id, bucket, bucket_path, mime_type, size_bytes, sha256, expected_sha256, retention_policy_id,
         antivirus_status, quarantine_status, scan_evidence, status, metadata
       ) values ($1, $2, 'synthetic-evidence', $3, 'image/jpeg', 10, $4, $4, 'submitted-case-pending-legal-v1',
         'clean', 'released', '{"scanner":"synthetic"}', 'uploaded', '{"displayName":"evidence-photo.jpg"}')
       returning id`,
      [state.survivorId, state.caseId, `evidence/synthetic/${run}/released`, RELEASED_SHA256],
    );
    const quarantined = await db.query<{ id: string }>(
      `insert into saferide.attachments (
         owner_id, case_id, bucket, bucket_path, mime_type, size_bytes, sha256, expected_sha256, retention_policy_id,
         antivirus_status, quarantine_status, status
       ) values ($1, $2, 'synthetic-evidence', $3, 'image/jpeg', 10, $4, $4, 'submitted-case-pending-legal-v1',
         'pending', 'quarantined', 'uploaded')
       returning id`,
      [state.survivorId, state.caseId, `evidence/synthetic/${run}/quarantined`, QUARANTINED_SHA256],
    );
    const late = await db.query<{ id: string }>(
      `insert into saferide.attachments (
         owner_id, case_id, bucket, bucket_path, mime_type, size_bytes, sha256, expected_sha256, retention_policy_id,
         antivirus_status, quarantine_status, scan_evidence, status
       ) values ($1, $2, 'synthetic-evidence', $3, 'image/jpeg', 99, $4, $4, 'submitted-case-pending-legal-v1',
         'clean', 'released', '{"scanner":"synthetic"}', 'uploaded')
       returning id`,
      [state.survivorId, state.caseId, `evidence/synthetic/${run}/late`, 'd'.repeat(64)],
    );
    state.releasedAttachmentId = released.rows[0].id;
    state.quarantinedAttachmentId = quarantined.rows[0].id;
    state.lateAttachmentId = late.rows[0].id;
    const shared = await db.query(`select manifest_index, sha256 from saferide.partner_referral_evidence where referral_id = $1 order by 1`, [state.referralId]);
    expect(shared.rows).toEqual([
      { manifest_index: 0, sha256: RELEASED_SHA256 }, { manifest_index: 1, sha256: QUARANTINED_SHA256 },
    ]);
  });

  it('never shows a caseworker another org’s referral, by any endpoint', async () => {
    const queue = await partner(state.caseworker, 'GET', '/referrals');
    expect(queue.statusCode).toBe(200);
    const ids = queue.json().referrals.map((item: { id: string }) => item.id);
    expect(ids).toContain(state.referralId);
    expect(ids).not.toContain(state.otherReferralId);

    const other = state.otherReferralId;
    const attempts = await Promise.all([
      partner(state.caseworker, 'GET', `/referrals/${other}`),
      partner(state.caseworker, 'POST', `/referrals/${other}/status`, { to: 'acknowledged', expectedStatus: 'new' }),
      partner(state.caseworker, 'POST', `/referrals/${other}/notes`, { body: 'Synthetic cross-org note' }),
      partner(state.caseworker, 'POST', `/referrals/${other}/evidence/${state.releasedAttachmentId}/url`),
      partner(state.caseworker, 'POST', `/referrals/${other}/callback`),
      // The other org cannot reach HURIA's referral either, nor its evidence through its own referral.
      partner(state.otherCaseworker, 'GET', `/referrals/${state.referralId}`),
      partner(state.otherCaseworker, 'POST', `/referrals/${other}/evidence/${state.releasedAttachmentId}/url`),
    ]);
    expect(attempts.map(response => response.statusCode)).toEqual([404, 404, 404, 404, 404, 404, 404]);
    const otherQueue = await partner(state.otherCaseworker, 'GET', '/referrals');
    expect(otherQueue.json().referrals.map((item: { id: string }) => item.id)).toEqual([other]);
    const untouched = await db.query(`select status from saferide.partner_referrals where id = $1`, [other]);
    expect(untouched.rows[0]).toEqual({ status: 'new' });
    const notes = await db.query(`select 1 from saferide.partner_case_notes where referral_id = $1`, [other]);
    expect(notes.rows).toHaveLength(0);
  });

  it('shows HURIA the minimised packet and evidence state, without survivor account ids', async () => {
    const detail = await partner(state.caseworker, 'GET', `/referrals/${state.referralId}`);
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.referral).toMatchObject({ reference: state.reference, status: 'new', pathway: 'escalation', callbackShared: true });
    expect(body.view).toMatchObject({
      kind: 'escalation', redactionLevel: 'light', contact: { preference: 'none' },
      content: { location: 'Synthetic stage | public_transport' },
    });
    expect(detail.body).not.toMatch(/4\.0435|39\.6682|synthetic-device-file/);
    // Only the two files the packet listed; the file uploaded later is never shown.
    expect(body.attachments.map((item: { id: string }) => item.id)).toEqual([state.releasedAttachmentId, state.quarantinedAttachmentId]);
    // Partner downloads are off by default; the list still shows type and size.
    expect(body.attachments.map((item: { mediaType: string; sizeBytes: number; download: unknown }) => [item.mediaType, item.sizeBytes, item.download])).toEqual([
      ['photo', 10, { available: false, reason: 'evidence_not_shareable_yet' }],
      ['photo', 10, { available: false, reason: 'evidence_not_shareable_yet' }],
    ]);
    expect(body.timeline).toEqual([{ event: 'received', status: 'new', at: expect.any(String) }]);
    for (const secret of [state.survivorId, state.caseId, state.followUpConsentId, state.callbackConsentId, 'evidence/synthetic', '712345678']) {
      expect(detail.body).not.toContain(secret);
    }
  });

  it('moves the status, shows it to the survivor as a status_change event, and never leaks notes or reasons', async () => {
    const acknowledged = await partner(state.caseworker, 'POST', `/referrals/${state.referralId}/status`, { to: 'acknowledged', expectedStatus: 'new' });
    expect(acknowledged.statusCode).toBe(200);
    const stale = await partner(state.admin, 'POST', `/referrals/${state.referralId}/status`, { to: 'acknowledged', expectedStatus: 'new' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().details).toEqual({ reason: 'stale', currentStatus: 'acknowledged' });
    const skip = await partner(state.caseworker, 'POST', `/referrals/${state.referralId}/status`, { to: 'referred_onward', expectedStatus: 'acknowledged' });
    expect(skip.json().details).toEqual({ reason: 'invalid_transition', currentStatus: 'acknowledged' });
    const note = await partner(state.caseworker, 'POST', `/referrals/${state.referralId}/notes`, { body: 'Synthetic private caseworker note' });
    expect(note.statusCode).toBe(200);
    expect(note.json().note.author.displayName).toBe('Synthetic huria-caseworker');
    expect((await partner(state.caseworker, 'POST', `/referrals/${state.referralId}/status`, { to: 'in_progress', expectedStatus: 'acknowledged' })).statusCode).toBe(200);

    const survivorView = await survivor('GET', `/api/cases/${state.caseId}`);
    expect(survivorView.statusCode).toBe(200);
    expect(survivorView.json().case.status).toBe('in_review');
    const events = survivorView.json().events as Array<{ event_type: string; payload: Record<string, unknown> }>;
    expect(events.map(event => event.event_type)).toEqual(['submission', 'partner_routed', 'status_change', 'status_change']);
    expect(events[2].payload).toEqual({
      schemaVersion: '1.0', new_status: 'in_review', actor: 'partner', partner: 'test-partner', partner_status: 'acknowledged',
    });
    expect(events[3].payload).toMatchObject({ new_status: 'in_review', partner_status: 'in_progress' });
    expect(survivorView.body).not.toContain('Synthetic private caseworker note');
    expect(survivorView.body).not.toContain(state.caseworker.userId);

    const referred = await partner(state.caseworker, 'POST', `/referrals/${state.referralId}/status`, { to: 'referred_onward', expectedStatus: 'in_progress' });
    expect(referred.json().referral.allowedTransitions).toEqual(['closed']);
    expect((await survivor('GET', `/api/cases/${state.caseId}`)).json().case.status).toBe('referred');

    const timeline = (await partner(state.caseworker, 'GET', `/referrals/${state.referralId}`)).json().timeline;
    expect(timeline.map((item: { status: string }) => item.status)).toEqual(['new', 'acknowledged', 'in_progress', 'referred_onward']);
  });

  it('never lets a partner-chosen X-Request-Id reach the survivor or any stored row', async () => {
    const clientRequestId = `partner-chosen-request-id-${run}`;
    const moved = await partnerWithClientRequestId(
      state.caseworker, `/referrals/${state.referralId}/status`,
      { to: 'closed', expectedStatus: 'referred_onward', closureReason: 'support_provided' }, clientRequestId,
    );
    expect(moved.statusCode).toBe(200);
    expect(moved.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const closedEvent = await db.query<{ request_id: string }>(
      `select request_id from saferide.case_events where case_id = $1 and payload->>'partner_status' = 'closed'`, [state.caseId],
    );
    expect(closedEvent.rows).toEqual([{ request_id: moved.headers['x-request-id'] }]);
    const note = await partnerWithClientRequestId(state.caseworker, `/referrals/${state.referralId}/notes`, { body: 'Synthetic note' }, clientRequestId);
    expect(note.statusCode).toBe(200);
    expect(note.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);

    const survivorView = await survivor('GET', `/api/cases/${state.caseId}`);
    expect(survivorView.body).not.toContain(clientRequestId);
    for (const event of survivorView.json().events as Array<Record<string, unknown>>) {
      expect(Object.keys(event).sort()).toEqual(['case_id', 'created_at', 'event_type', 'id', 'owner_id', 'payload']);
    }
    for (const table of ['case_events', 'partner_access_audit', 'audit_events']) {
      const leaked = await db.query(`select 1 from saferide.${table} where request_id = $1`, [clientRequestId]);
      expect(leaked.rows, table).toHaveLength(0);
    }
    const stored = await db.query<{ request_id: string }>(
      `select request_id from saferide.partner_access_audit where partner_user_id = $1 order by created_at desc limit 1`,
      [state.caseworker.userId],
    );
    expect(stored.rows[0].request_id).toBe(note.headers['x-request-id']);
  });

  it('refuses evidence downloads by default (raw originals) and reveals the callback only to caseworkers', async () => {
    for (const attachmentId of [state.releasedAttachmentId, state.quarantinedAttachmentId]) {
      const url = await partner(state.caseworker, 'POST', `/referrals/${state.referralId}/evidence/${attachmentId}/url`);
      expect(url.statusCode).toBe(409);
      expect(url.json().details).toEqual({ reason: 'evidence_not_shareable_yet' });
    }
    // A file the packet never listed does not exist for the partner.
    expect((await partner(state.caseworker, 'POST', `/referrals/${state.referralId}/evidence/${state.lateAttachmentId}/url`)).statusCode).toBe(404);
    const shown = await partner(state.caseworker, 'POST', `/referrals/${state.referralId}/callback`);
    expect(shown.json()).toEqual({ callback: { phoneNumber: '+254712345678' } });
    expect((await partner(state.admin, 'POST', `/referrals/${state.referralId}/callback`)).statusCode).toBe(403);
  });

  it('writes one content-free audit row per partner read and write', async () => {
    // Order-insensitive: the cross-org attempts ran concurrently.
    expect((await auditFor(state.caseworker.userId)).sort()).toEqual([
      'partner.referral.list success - -',
      'partner.referral.read denied other -',
      'partner.referral.status denied other -',
      'partner.referral.note denied other -',
      'partner.evidence.url denied other att',
      'partner.referral.callback.read denied other -',
      'partner.referral.read success own -',
      'partner.referral.status success own -',
      'partner.referral.status denied own -',
      'partner.referral.note success own -',
      'partner.referral.status success own -',
      'partner.referral.status success own -',
      'partner.referral.read success own -',
      'partner.evidence.url denied own att',
      'partner.evidence.url denied own att',
      'partner.evidence.url denied own att',
      'partner.referral.callback.read success own -',
      // From the X-Request-Id test: the close and its note.
      'partner.referral.status success own -',
      'partner.referral.note success own -',
    ].sort());
    expect(await auditFor(state.admin.userId)).toEqual([
      'partner.referral.status denied own -',
      'partner.referral.callback.read denied own -',
    ]);
    const columns = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_schema = 'saferide' and table_name = 'partner_access_audit' order by column_name`,
    );
    expect(columns.rows.map(row => row.column_name)).toEqual([
      'action', 'actor_type', 'attachment_id', 'created_at', 'id', 'operator_ref', 'org_id', 'outcome',
      'partner_user_id', 'policy_version', 'reason_code', 'referral_id', 'request_id', 'target_user_id',
    ]);
  });

  it('ends partner access the moment the survivor withdraws, and drops the callback on its own withdrawal', async () => {
    const withdrawCallback = await survivor('POST', `/api/privacy/consents/${state.callbackConsentId}/withdraw`);
    expect(withdrawCallback.statusCode).toBe(200);
    expect((await partner(state.caseworker, 'POST', `/referrals/${state.referralId}/callback`)).statusCode).toBe(404);
    expect((await partner(state.caseworker, 'GET', `/referrals/${state.referralId}`)).json().referral.callbackShared).toBe(false);

    const withdraw = await survivor('POST', `/api/privacy/consents/${state.followUpConsentId}/withdraw`);
    expect(withdraw.statusCode).toBe(200);
    const tombstone = await partner(state.caseworker, 'GET', `/referrals/${state.referralId}`);
    expect(tombstone.json()).toMatchObject({
      referral: { id: state.referralId, reference: state.reference, status: 'withdrawn', withdrawn: true },
      view: null, attachments: [], timeline: [], notes: [],
    });
    expect(tombstone.body).not.toContain('Synthetic private caseworker note');
    expect(tombstone.body).not.toContain('Synthetic description');
    const refused = await Promise.all([
      partner(state.caseworker, 'POST', `/referrals/${state.referralId}/status`, { to: 'closed', expectedStatus: 'referred_onward', closureReason: 'support_provided' }),
      partner(state.caseworker, 'POST', `/referrals/${state.referralId}/notes`, { body: 'Synthetic late note' }),
      partner(state.caseworker, 'POST', `/referrals/${state.referralId}/evidence/${state.releasedAttachmentId}/url`),
    ]);
    expect(refused.map(response => response.statusCode)).toEqual([410, 410, 410]);
    for (const response of refused) {
      expect(response.json()).toMatchObject({
        code: 'withdrawn', message: 'This report is no longer shared with your organisation', details: { reason: 'withdrawn' },
      });
      expect(response.body).not.toMatch(/survivor/i);
    }
    const queue = await partner(state.caseworker, 'GET', '/referrals?status=withdrawn');
    expect(queue.json().referrals).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: state.referralId, status: 'withdrawn', withdrawn: true, pathway: null }),
    ]));
    const active = await partner(state.caseworker, 'GET', '/referrals?status=referred_onward');
    expect(active.json().referrals.map((item: { id: string }) => item.id)).not.toContain(state.referralId);
    const notes = await db.query(`select 1 from saferide.partner_case_notes where referral_id = $1`, [state.referralId]);
    expect(notes.rows).toHaveLength(0);

    // The survivor's timeline says sharing ended (HURIA had closed it, so the case stays closed). No reason, no request id.
    const survivorView = await survivor('GET', `/api/cases/${state.caseId}`);
    expect(survivorView.json().case.status).toBe('closed');
    const events = survivorView.json().events as Array<{ event_type: string; payload: Record<string, unknown> }>;
    expect(events.filter(event => event.payload?.partner_access === 'ended').map(event => [event.event_type, event.payload])).toEqual([[
      'status_change',
      { schemaVersion: '1.0', new_status: 'closed', actor: 'survivor', partner: 'test-partner', partner_status: 'closed', partner_access: 'ended' },
    ]]);
  });
});
