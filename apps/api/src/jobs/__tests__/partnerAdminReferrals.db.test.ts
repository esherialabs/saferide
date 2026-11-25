/**
 * The operator's referral:list and referral:revoke commands, run through
 * the CLI entry point against a real, disposable PostgreSQL with
 * migrations 000-008, 010 and 011 plus runtime-role.sql applied, as the
 * owner or the runtime role. The partner and survivor sides are checked through
 * their real routes. Skipped unless SAFERIDE_TEST_DATABASE_URL is set.
 * Synthetic data only.
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
import { PartnerAdminError, createPartnerOrg, exportPartnerAudit } from '../../repositories/partnerRepository.js';
import { registerCaseRoutes } from '../../routes/cases.js';
import { registerPartnerApi } from '../../routes/partnerAuth.js';
import { registerPrivacyRoutes } from '../../routes/privacy.js';
import { deriveCallbackSealKey, sealPartnerCallback } from '../../services/partnerCallbackSeal.js';
import { generatePartnerReference, generatePartnerToken, hashPartnerToken } from '../../services/partnerTokens.js';
import { EXIT_OK, EXIT_REFUSED, EXIT_USAGE, runPartnerAdmin } from '../partnerAdmin.js';

const SYNTHETIC_JWT_SECRET = 'synthetic-test-only-jwt-secret-0123456789abcdef';
const SYNTHETIC_PARTNER_KEY = 'cd'.repeat(32);
const SYNTHETIC_CALLBACK_KEY = 'ef'.repeat(32);
const SEALED_PLACEHOLDER = `v1.${'A'.repeat(16)}.${'B'.repeat(22)}.${'C'.repeat(27)}`;
const ORIGIN = 'https://partners.example.invalid';
const HOST = 'partners.example.invalid';
const PHONE = '+254700111222';
const NOTE = 'Synthetic operator-test caseworker note';
const DESCRIPTION = 'Synthetic operator-test description';

vi.mock('../../config/env.js', () => ({
  env: {
    databaseUrl: process.env.SAFERIDE_TEST_DATABASE_URL ?? 'postgres://unused.invalid/none',
    authJwtSecret: 'synthetic-test-only-jwt-secret-0123456789abcdef',
    appEnvironment: 'test',
    partnerPublicOrigin: 'https://partners.example.invalid',
    partnerTotpKey: 'cd'.repeat(32),
    partnerCallbackKey: 'ef'.repeat(32),
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
const operator = `ops-referral-${run}`;
const orgStableId = `test-cli-${run}`;

type Referral = {
  ownerId: string; caseId: string; referralId: string; reference: string;
  followUpConsentId: string; callbackConsentId: string; jwt: string;
};

let app: FastifyInstance;
let manifestDir: string;
const originalManifestPath = process.env.SAFERIDE_PRIVACY_CONTROLS_PATH;
const state = {
  orgId: '',
  caseworker: { userId: '', token: '' },
  target: {} as Referral,
  other: {} as Referral,
  withdrawn: {} as Referral,
};

async function cli(...args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runPartnerAdmin(args, { stdout: line => out.push(line), stderr: line => err.push(line) });
  return { code, out, err };
}

function partner(method: 'GET' | 'POST', path: string, body?: unknown) {
  const token = state.caseworker.token;
  const inject: InjectOptions = {
    method,
    url: `/partner/v1${path}`,
    headers: {
      host: HOST, origin: ORIGIN, cookie: `__Host-saferide_partner=${token}`,
      ...(method === 'POST' ? { 'x-saferide-partner-csrf': partnerCsrfToken(token) } : {}),
    },
  };
  if (body !== undefined) inject.payload = body as InjectOptions['payload'];
  return app.inject(inject);
}

function survivor(subject: Referral, method: 'GET' | 'POST', url: string) {
  return app.inject({ method, url, headers: { authorization: `Bearer ${subject.jwt}` } });
}

async function newReferral(): Promise<Referral> {
  const ownerId = randomUUID();
  const created = await db.query<{ id: string }>(
    `insert into saferide.cases (owner_id, pathway, status, summary) values ($1, 'escalate', 'submitted', $2) returning id`,
    [ownerId, { workflow: { workflowType: 'escalation', incidentDescription: DESCRIPTION } }],
  );
  const consent = async (purpose: string) => (await db.query<{ id: string }>(
    `insert into saferide.consent_records (owner_id, purpose, consent_version, status, granted_at)
     values ($1, $2, 'synthetic-test.v1', 'granted', now()) returning id`,
    [ownerId, purpose],
  )).rows[0].id;
  const followUpConsentId = await consent('partner_follow_up');
  const callbackConsentId = await consent('partner_callback');
  const reference = generatePartnerReference();
  const referral = await db.query<{ id: string }>(
    `insert into saferide.partner_referrals (case_id, owner_id, org_id, consent_record_id, reference)
     values ($1, $2, $3, $4, $5) returning id`,
    [created.rows[0].id, ownerId, state.orgId, followUpConsentId, reference],
  );
  const referralId = referral.rows[0].id;
  await db.query(
    `insert into saferide.partner_referral_callbacks (referral_id, org_id, owner_id, consent_record_id, phone_enc)
     values ($1, $2, $3, $4, $5)`,
    [referralId, state.orgId, ownerId, callbackConsentId,
      sealPartnerCallback(deriveCallbackSealKey(Buffer.from(SYNTHETIC_CALLBACK_KEY, 'hex')), referralId, PHONE)],
  );
  const jwt = await new SignJWT({ role: 'survivor' }).setProtectedHeader({ alg: 'HS256' }).setSubject(ownerId)
    .setIssuedAt().setExpirationTime('10m').sign(new TextEncoder().encode(SYNTHETIC_JWT_SECRET));
  return { ownerId, caseId: created.rows[0].id, referralId, reference, followUpConsentId, callbackConsentId, jwt };
}

async function operatorAudit(action: string) {
  const { rows } = await db.query<{
    org_id: string | null; referral_id: string | null; reason_code: string | null; outcome: string; operator_ref: string;
  }>(
    `select org_id, referral_id, reason_code, outcome, operator_ref from saferide.partner_access_audit
     where operator_ref = $1 and action = $2 order by created_at, id`,
    [operator, action],
  );
  return rows;
}

async function survivorEvents(subject: Referral) {
  const view = await survivor(subject, 'GET', `/api/cases/${subject.caseId}`);
  expect(view.statusCode).toBe(200);
  return {
    body: view.body,
    status: view.json().case.status as string,
    events: view.json().events as Array<{ event_type: string; payload: Record<string, unknown> }>,
  };
}

describe.skipIf(!enabled)('operator referral commands against PostgreSQL', () => {
  beforeAll(async () => {
    const controls = JSON.parse(readFileSync(new URL('../../../../../config/privacy/privacy-controls.v1.json', import.meta.url), 'utf8'));
    controls.capabilities.submitted_case_ingestion = { status: 'enabled', version: 'synthetic-test-only' };
    manifestDir = mkdtempSync(join(tmpdir(), 'saferide-operator-referrals-'));
    writeFileSync(join(manifestDir, 'privacy-controls.json'), JSON.stringify(controls));
    process.env.SAFERIDE_PRIVACY_CONTROLS_PATH = join(manifestDir, 'privacy-controls.json');
    resetPrivacyControlsForTests();

    await db.query(
      `insert into saferide.partner_operators (handle, display_name, role_label) values ($1, 'Synthetic operator', 'Synthetic test')`,
      [operator],
    );
    const org = await db.query<{ id: string }>(
      `insert into saferide.partner_organizations (
         stable_id, display_name, intake_enabled, agreement_ref, agreement_signed_at, agreement_expires_at
       ) values ($1, 'Synthetic CLI org', true, 'SYNTHETIC-TEST', now() - interval '1 day', now() + interval '30 days')
       returning id`,
      [orgStableId],
    );
    state.orgId = org.rows[0].id;
    const user = await db.query<{ id: string }>(
      `insert into saferide.partner_users (
         org_id, email, display_name, role, status, password_hash, totp_secret_enc, totp_enrolled_at
       ) values ($1, $2, 'Synthetic caseworker', 'partner_caseworker', 'active', 'scrypt$synthetic-test-hash', $3, now())
       returning id`,
      [state.orgId, `cli-caseworker-${run}@example.invalid`, SEALED_PLACEHOLDER],
    );
    const token = generatePartnerToken('session');
    await db.query(
      `insert into saferide.partner_sessions (token_hash, user_id, org_id, mfa_verified, idle_expires_at, absolute_expires_at)
       values ($1, $2, $3, true, now() + interval '30 minutes', now() + interval '11 hours')`,
      [hashPartnerToken(token), user.rows[0].id, state.orgId],
    );
    state.caseworker = { userId: user.rows[0].id, token };

    app = Fastify({ logger: false, ...REQUEST_ID_OPTIONS });
    await registerRequestContext(app);
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof AppError) reply.status(error.statusCode).send({ code: error.code, message: error.message, details: error.details });
      else if (error instanceof ZodError) reply.status(400).send({ code: 'bad_request' });
      else reply.status(500).send({ code: 'internal_error' });
    });
    await registerPrivacyRoutes(app);
    await registerCaseRoutes(app);
    await registerPartnerApi(app, {
      publicOrigin: ORIGIN,
      totpKey: Buffer.from(SYNTHETIC_PARTNER_KEY, 'hex'),
      callbackKey: Buffer.from(SYNTHETIC_CALLBACK_KEY, 'hex'),
    });

    state.withdrawn = await newReferral();
    state.other = await newReferral();
    state.target = await newReferral();

    // The partner works the target: acknowledged (the survivor's case shows in_review) plus a private note.
    expect((await partner('POST', `/referrals/${state.target.referralId}/status`, { to: 'acknowledged', expectedStatus: 'new' })).statusCode).toBe(200);
    expect((await partner('POST', `/referrals/${state.target.referralId}/notes`, { body: NOTE })).statusCode).toBe(200);
    expect((await partner('POST', `/referrals/${state.target.referralId}/callback`)).json()).toEqual({ callback: { phoneNumber: PHONE } });
    // One survivor already withdrew.
    expect((await survivor(state.withdrawn, 'POST', `/api/privacy/consents/${state.withdrawn.followUpConsentId}/withdraw`)).statusCode).toBe(200);
  });

  afterAll(async () => {
    await app?.close();
    await db.closeDb();
    if (originalManifestPath === undefined) delete process.env.SAFERIDE_PRIVACY_CONTROLS_PATH;
    else process.env.SAFERIDE_PRIVACY_CONTROLS_PATH = originalManifestPath;
    resetPrivacyControlsForTests();
    if (manifestDir) rmSync(manifestDir, { recursive: true, force: true });
  });

  it('records migrations 010 and 011', async () => {
    const version = await db.query(`select version from saferide.schema_migrations where version in ('010', '011') order by 1`);
    expect(version.rows).toEqual([{ version: '010' }, { version: '011' }]);
  });

  it('lists an org’s referrals as metadata only, by stable id or id, and audits the listing', async () => {
    const listed = await cli('referral:list', '--operator', operator, '--org', orgStableId);
    expect(listed.code).toBe(EXIT_OK);
    expect(listed.out[0]).toBe(`ok referral:list org=${orgStableId} shown=3 more=no`);
    const rows = listed.out.slice(1);
    // Newest first; every line is exactly these six fields.
    expect(rows.map(line => line.split(' ')[0])).toEqual([
      `reference=${state.target.reference}`, `reference=${state.other.reference}`, `reference=${state.withdrawn.reference}`,
    ]);
    const iso = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z';
    for (const line of rows) {
      expect(line).toMatch(new RegExp(
        `^reference=SR-[0-9A-Z]{4}-[0-9A-Z]{4} pathway=escalation status=[a-z_]+ access=(active|withdrawn|revoked) received=${iso} status_changed=${iso}$`,
      ));
    }
    expect(rows[0]).toContain('status=acknowledged access=active');
    expect(rows[2]).toContain('status=new access=withdrawn');

    const printed = [...listed.out, ...listed.err].join('\n');
    for (const subject of [state.target, state.other, state.withdrawn]) {
      for (const secret of [subject.ownerId, subject.caseId, subject.referralId, subject.followUpConsentId, subject.callbackConsentId]) {
        expect(printed).not.toContain(secret);
      }
    }
    for (const secret of [state.orgId, NOTE, DESCRIPTION, PHONE, '700111222', 'v1.', state.caseworker.userId]) {
      expect(printed).not.toContain(secret);
    }

    const byId = await cli('referral:list', '--operator', operator, '--org', state.orgId, '--status', 'withdrawn');
    expect(byId.code).toBe(EXIT_OK);
    expect(byId.out).toHaveLength(2);
    expect(byId.out[1]).toContain(`reference=${state.withdrawn.reference}`);
    const page = await cli('referral:list', '--operator', operator, '--org', orgStableId, '--status', 'new', '--limit', '1');
    expect(page.out[0]).toBe(`ok referral:list org=${orgStableId} shown=1 more=no`);
    expect(page.out[1]).toContain(`reference=${state.other.reference}`);
    expect((await cli('referral:list', '--operator', operator, '--org', orgStableId, '--limit', '1')).out[0]).toContain('more=yes');

    expect((await cli('referral:list', '--operator', operator, '--org', `missing-${run}`)).code).toBe(EXIT_REFUSED);
    expect((await cli('referral:list', '--operator', `nobody-${run}`, '--org', orgStableId)).code).toBe(EXIT_REFUSED);

    const audit = await operatorAudit('operator.referral.list');
    expect(audit.map(row => [row.outcome, row.org_id, row.referral_id, row.reason_code])).toEqual([
      ['success', state.orgId, null, null],
      ['success', state.orgId, null, null],
      ['success', state.orgId, null, null],
      ['success', state.orgId, null, null],
      ['denied', null, null, null],
    ]);
  });

  it('without --yes only shows the referral’s org and state, and refuses a different --org', async () => {
    const otherStableId = `test-cli-other-${run}`;
    const otherOrg = await db.query<{ id: string }>(
      `insert into saferide.partner_organizations (stable_id, display_name) values ($1, 'Synthetic second org') returning id`,
      [otherStableId],
    );
    const preview = await cli('referral:revoke', '--operator', operator, '--reference', state.target.reference, '--reason', 'misrouted');
    expect(preview.code).toBe(EXIT_REFUSED);
    expect(preview.out).toEqual([
      `check referral:revoke reference=${state.target.reference} org=${orgStableId} status=acknowledged access=active reason=misrouted`,
      'not revoked: if that is the right referral and org, rerun with --yes',
    ]);
    for (const org of [otherStableId, otherOrg.rows[0].id, `missing-${run}`]) {
      const refused = await cli('referral:revoke', '--operator', operator, '--reference', state.target.reference, '--reason', 'misrouted',
        '--org', org, '--yes');
      expect(refused.code, org).toBe(EXIT_REFUSED);
      expect(refused.err.join('\n')).toMatch(/refused \((conflict|not_found)\)/);
    }

    // Nothing changed: the partner still has the case and the survivor saw nothing.
    expect((await partner('POST', `/referrals/${state.target.referralId}/callback`)).json()).toEqual({ callback: { phoneNumber: PHONE } });
    const access = await db.query(`select access_revoked_at from saferide.partner_referrals where id = $1`, [state.target.referralId]);
    expect(access.rows).toEqual([{ access_revoked_at: null }]);
    expect((await survivorEvents(state.target)).events.filter(event => event.payload?.partner_access)).toHaveLength(0);
    expect(await operatorAudit('operator.referral.revoke')).toEqual([
      { org_id: state.orgId, referral_id: state.target.referralId, reason_code: 'misrouted', outcome: 'denied', operator_ref: operator },
      { org_id: null, referral_id: null, reason_code: null, outcome: 'denied', operator_ref: operator },
      { org_id: null, referral_id: null, reason_code: null, outcome: 'denied', operator_ref: operator },
      { org_id: null, referral_id: null, reason_code: null, outcome: 'denied', operator_ref: operator },
    ]);
  });

  it('revokes one referral: tombstone and 410 for the partner, callback and notes gone, audited with the code', async () => {
    const revoked = await cli('referral:revoke', '--operator', operator, '--reference', state.target.reference, '--reason', 'misrouted',
      '--org', state.orgId, '--yes');
    expect(revoked.code).toBe(EXIT_OK);
    expect(revoked.out[0]).toMatch(new RegExp(
      `^ok referral:revoke reference=${state.target.reference} org=${orgStableId} reason=misrouted state=revoked revoked_at=\\S+Z$`,
    ));

    const tombstone = await partner('GET', `/referrals/${state.target.referralId}`);
    expect(tombstone.statusCode).toBe(200);
    expect(tombstone.json()).toMatchObject({
      referral: { id: state.target.referralId, reference: state.target.reference, status: 'withdrawn', withdrawn: true },
      view: null, attachments: [], timeline: [], notes: [],
    });
    for (const secret of [NOTE, DESCRIPTION, PHONE, 'misrouted', operator]) expect(tombstone.body).not.toContain(secret);

    const refused = await Promise.all([
      partner('POST', `/referrals/${state.target.referralId}/status`, { to: 'in_progress', expectedStatus: 'acknowledged' }),
      partner('POST', `/referrals/${state.target.referralId}/notes`, { body: 'Synthetic late note' }),
      partner('POST', `/referrals/${state.target.referralId}/callback`),
      partner('POST', `/referrals/${state.target.referralId}/evidence/${randomUUID()}/url`),
    ]);
    expect(refused.map(response => response.statusCode)).toEqual([410, 410, 410, 410]);
    // The same response a survivor withdrawal gives: the partner cannot tell the two apart.
    for (const response of refused) {
      expect(response.json()).toMatchObject({
        code: 'withdrawn', message: 'This report is no longer shared with your organisation', details: { reason: 'withdrawn' },
      });
      expect(response.body).not.toMatch(/survivor/i);
    }
    expect(revoked.out.join('\n')).not.toContain('sessions:revoke');

    const queue = await partner('GET', '/referrals?status=withdrawn');
    expect(queue.json().referrals).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: state.target.referralId, status: 'withdrawn', withdrawn: true, pathway: null }),
    ]));
    const active = await partner('GET', '/referrals');
    expect(active.json().referrals.find((item: { id: string }) => item.id === state.target.referralId))
      .toMatchObject({ withdrawn: true });

    const callback = await db.query(`select 1 from saferide.partner_referral_callbacks where referral_id = $1`, [state.target.referralId]);
    expect(callback.rows).toHaveLength(0);
    const notes = await db.query(`select 1 from saferide.partner_case_notes where referral_id = $1`, [state.target.referralId]);
    expect(notes.rows).toHaveLength(0);
    const row = await db.query<{ revoke_reason: string; status: string }>(
      `select revoke_reason, status from saferide.partner_referrals where id = $1`, [state.target.referralId],
    );
    expect(row.rows[0]).toEqual({ revoke_reason: 'operator', status: 'acknowledged' });

    // The other referrals are untouched.
    expect((await partner('POST', `/referrals/${state.other.referralId}/callback`)).json()).toEqual({ callback: { phoneNumber: PHONE } });

    expect((await operatorAudit('operator.referral.revoke')).filter(row => row.outcome === 'success')).toEqual([
      { org_id: state.orgId, referral_id: state.target.referralId, reason_code: 'misrouted', outcome: 'success', operator_ref: operator },
    ]);
    const exported = await exportPartnerAudit({
      orgStableId, since: new Date(Date.now() - 60 * 60 * 1000), until: new Date(Date.now() + 60 * 1000),
      context: { operatorRef: operator, requestId: `db-test-${randomUUID()}` },
    });
    expect(exported.filter(item => item.action === 'operator.referral.revoke').map(item => [item.outcome, item.reasonCode]))
      .toEqual([['denied', 'misrouted'], ['success', 'misrouted']]);

    const listed = await cli('referral:list', '--operator', operator, '--org', orgStableId, '--status', 'revoked');
    expect(listed.out.slice(1)).toEqual([expect.stringContaining(`reference=${state.target.reference} pathway=escalation status=acknowledged access=revoked`)]);
  });

  it('tells the survivor with a content-free status_change: access ended, no reason code and no operator', async () => {
    const { body, status, events } = await survivorEvents(state.target);
    expect(status).toBe('submitted');
    const revocation = events.at(-1);
    expect(revocation?.event_type).toBe('status_change');
    expect(revocation?.payload).toEqual({
      schemaVersion: '1.0', new_status: 'submitted', actor: 'saferide', partner: orgStableId, partner_status: 'acknowledged',
      partner_access: 'ended',
    });
    // The partner's own status_change keys, plus partner_access.
    const partnerChange = events.find(event => event.event_type === 'status_change' && event.payload.actor === 'partner');
    expect(Object.keys(revocation?.payload ?? {}).sort()).toEqual([...Object.keys(partnerChange?.payload ?? {}), 'partner_access'].sort());
    // The internal request id is the CLI's, so the event can be traced to the audit row.
    const stored = await db.query<{ request_id: string }>(
      `select request_id from saferide.case_events where case_id = $1 and payload->>'partner_access' = 'ended'`, [state.target.caseId],
    );
    expect(stored.rows).toEqual([{ request_id: expect.stringMatching(/^cli-[0-9a-f-]{36}$/) }]);
    for (const secret of ['misrouted', operator, NOTE]) expect(body).not.toContain(secret);
    // The CLI request id (cli-<uuid>) stays in the internal request_id column.
    expect(body).not.toMatch(/cli-[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it('is idempotent: a second run changes nothing but is audited again', async () => {
    const before = await db.query<{ access_revoked_at: Date }>(
      `select access_revoked_at from saferide.partner_referrals where id = $1`, [state.target.referralId],
    );
    const again = await cli('referral:revoke', '--operator', operator, '--reference', state.target.reference.toLowerCase(), '--reason', 'partner_compromise', '--yes');
    expect(again.code).toBe(EXIT_OK);
    expect(again.out[0]).toContain('state=already_revoked');
    // A compromised partner: point at the org-wide session revoke, never run it.
    expect(again.out.at(-1)).toBe(`hint: partner_compromise: also end the org's partner sessions with sessions:revoke --operator <handle> --org ${orgStableId}`);
    const sessions = await db.query<{ revoked_at: Date | null }>(
      `select revoked_at from saferide.partner_sessions where user_id = $1`, [state.caseworker.userId],
    );
    expect(sessions.rows.map(row => row.revoked_at)).toEqual([null]);
    expect(again.out[0]).toContain(`revoked_at=${new Date(before.rows[0].access_revoked_at).toISOString()}`);
    const after = await db.query<{ access_revoked_at: Date; revoke_reason: string }>(
      `select access_revoked_at, revoke_reason from saferide.partner_referrals where id = $1`, [state.target.referralId],
    );
    expect(after.rows[0]).toEqual({ access_revoked_at: before.rows[0].access_revoked_at, revoke_reason: 'operator' });
    const { events } = await survivorEvents(state.target);
    expect(events.filter(event => event.payload?.actor === 'saferide')).toHaveLength(1);
    expect((await operatorAudit('operator.referral.revoke')).filter(row => row.outcome === 'success').map(row => row.reason_code))
      .toEqual(['misrouted', 'partner_compromise']);

    // A survivor withdrawal is not overwritten either, and the survivor gets no second event.
    const withdrawn = await cli('referral:revoke', '--operator', operator, '--reference', state.withdrawn.reference, '--reason', 'safeguarding_concern', '--yes');
    expect(withdrawn.out[0]).toContain('state=already_revoked');
    const kept = await db.query<{ revoke_reason: string }>(`select revoke_reason from saferide.partner_referrals where id = $1`, [state.withdrawn.referralId]);
    expect(kept.rows[0].revoke_reason).toBe('consent_withdrawn');
    const withdrawal = await survivorEvents(state.withdrawn);
    expect(withdrawal.status).toBe('submitted');
    expect(withdrawal.events.filter(event => event.event_type === 'status_change').map(event => event.payload)).toEqual([{
      schemaVersion: '1.0', new_status: 'submitted', actor: 'survivor', partner: orgStableId, partner_status: 'new', partner_access: 'ended',
    }]);
  });

  it('rejects an unknown or malformed reference and changes nothing', async () => {
    const auditBefore = (await operatorAudit('operator.referral.revoke')).length;
    let unknown = generatePartnerReference();
    while ([state.target, state.other, state.withdrawn].some(subject => subject.reference === unknown)) unknown = generatePartnerReference();
    const refused = await cli('referral:revoke', '--operator', operator, '--reference', unknown, '--reason', 'misrouted', '--yes');
    expect(refused.code).toBe(EXIT_REFUSED);
    expect(refused.err.join('\n')).toContain('refused (not_found)');
    const denied = (await operatorAudit('operator.referral.revoke')).slice(auditBefore);
    expect(denied).toEqual([{ org_id: null, referral_id: null, reason_code: null, outcome: 'denied', operator_ref: operator }]);

    expect((await cli('referral:revoke', '--operator', operator, '--reference', 'SR-NOPE', '--reason', 'misrouted')).code).toBe(EXIT_USAGE);
    expect((await cli('referral:revoke', '--operator', operator, '--reference', state.other.reference, '--reason', 'misrouted',
      '--note-to-audit', 'Synthetic free text')).code).toBe(EXIT_USAGE);
    expect((await operatorAudit('operator.referral.revoke')).length).toBe(auditBefore + 1);
    const other = await db.query<{ access_revoked_at: Date | null }>(
      `select access_revoked_at from saferide.partner_referrals where id = $1`, [state.other.referralId],
    );
    expect(other.rows[0].access_revoked_at).toBeNull();
  });

  it('refuses UUID-shaped stable ids for new orgs, in the CLI, the repository and the database', async () => {
    const uuidShaped = randomUUID();
    const created = await cli('org:create', '--operator', operator, '--stable-id', uuidShaped, '--name', 'Synthetic UUID-shaped org');
    expect(created.code).toBe(EXIT_USAGE);
    expect(created.err.join('\n')).toContain('must not look like a UUID');
    await expect(createPartnerOrg({ stableId: uuidShaped, displayName: 'Synthetic', context: { operatorRef: operator, requestId: 'db-test' } }))
      .rejects.toBeInstanceOf(PartnerAdminError);
    await expect(db.query(
      `insert into saferide.partner_organizations (stable_id, display_name) values ($1, 'Synthetic UUID-shaped org')`, [uuidShaped],
    )).rejects.toThrow(/partner_org_stable_id_not_uuid/);
    const none = await db.query(`select 1 from saferide.partner_organizations where stable_id = $1`, [uuidShaped]);
    expect(none.rows).toHaveLength(0);
    // Ordinary stable ids, hex-looking ones included, still work.
    expect((await cli('org:create', '--operator', operator, '--stable-id', `cafe-${run}`, '--name', 'Synthetic hex-ish org')).code).toBe(EXIT_OK);
  });

  it('keeps reason codes to operator revocations at the database too', async () => {
    await expect(db.query(
      `insert into saferide.partner_access_audit (actor_type, operator_ref, action, outcome, request_id, policy_version, reason_code)
       values ('operator', $1, 'operator.referral.list', 'success', 'db-test', 'partner-dashboard.phase1.v1', 'misrouted')`,
      [operator],
    )).rejects.toThrow(/partner_audit_reason_code/);
    await expect(db.query(
      `insert into saferide.partner_access_audit (actor_type, operator_ref, action, outcome, request_id, policy_version, reason_code)
       values ('operator', $1, 'operator.referral.revoke', 'success', 'db-test', 'partner-dashboard.phase1.v1', 'Synthetic free text')`,
      [operator],
    )).rejects.toThrow(/partner_audit_reason_code/);
  });
});
