import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => {
  const client = {
    query: vi.fn(),
    release: vi.fn(),
  };
  return {
    client,
    pool: { connect: vi.fn(async () => client) },
    query: vi.fn(),
  };
});

vi.mock('../../plugins/db.js', () => ({
  pool: db.pool,
  query: db.query,
}));

import { CaseSubmissionConflictError, PartnerRoutingRejectedError, submitCaseTransaction } from '../caseRepository.js';

const CASE_ID = '11111111-1111-4111-8111-111111111111';
const CONSENT_ID = '22222222-2222-4222-8222-222222222222';

const params = {
  ownerId: 'owner-a',
  draftId: 'draft-a',
  pathway: 'referral',
  summary: { schemaVersion: '1.0', workflow: { workflowType: 'referral' } },
  lifecyclePayload: { schemaVersion: '1.0', workflowType: 'referral', status: 'submitted' },
  consentRecordId: CONSENT_ID,
  consentPurpose: 'pathway_submission' as const,
  consentVersion: 'pathway-consent.v1',
  idempotencyKey: CONSENT_ID,
  requestId: 'safe-request-id',
  policyVersion: 'privacy-controls.2026-07-30.2',
};

describe('atomic case submission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The optional no-sharing retry lookup is covered against PostgreSQL in
    // partnerRouting.db.test.ts. These fixtures model a first submission.
    db.pool.connect.mockResolvedValue({
      query: ((sql: string, values?: unknown[]) => sql.includes("summary ? 'partnerRouting'")
        ? Promise.resolve({ rows: [] })
        // The owned-draft lookup: these fixtures model a draft the owner holds on the server.
        : sql.startsWith('select id from saferide.drafts')
          ? Promise.resolve({ rows: [{ id: values?.[1] }] })
          : db.client.query(sql, values)) as typeof db.client.query,
      release: db.client.release,
    });
  });

  it('commits server-timed consent, case, event, draft, and minimized audit together', async () => {
    const caseRecord = {
      id: CASE_ID,
      owner_id: 'owner-a',
      draft_id: 'draft-a',
      pathway: 'referral',
      status: 'submitted',
      summary: params.summary,
      created_at: '2026-07-31T00:00:00.000Z',
      updated_at: '2026-07-31T00:00:00.000Z',
    };
    db.client.query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: CONSENT_ID }] })
      .mockResolvedValueOnce({ rows: [caseRecord] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({});

    await expect(submitCaseTransaction(params)).resolves.toEqual({ caseRecord, partnerReferral: null });

    const statements = db.client.query.mock.calls.map(([sql]) => String(sql));
    expect(statements[0]).toBe('begin');
    expect(statements[1]).toContain("values ($1, $2, $3, $4, 'granted', now())");
    expect(statements[2]).toContain('on conflict (owner_id, submission_idempotency_key)');
    expect(statements[2]).toContain('saferide.cases.summary = excluded.summary');
    expect(statements[3]).toContain("on conflict (case_id, event_type) where event_type = 'submission'");
    expect(statements[4]).toContain("set status = 'submitted'");
    expect(statements[5]).toContain("values ('case.create', 'case', $1, 'success', $2)");
    expect(statements[6]).toBe('commit');
    expect(db.client.release).toHaveBeenCalledOnce();
  });

  it('rolls back when a consent UUID belongs to a different identity or state', async () => {
    db.client.query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({});

    await expect(submitCaseTransaction(params)).rejects.toBeInstanceOf(CaseSubmissionConflictError);
    expect(db.client.query.mock.calls.map(([sql]) => String(sql))).toEqual([
      'begin',
      expect.stringContaining('insert into saferide.consent_records'),
      'rollback',
    ]);
    expect(db.client.release).toHaveBeenCalledOnce();
  });

  it('rolls back every earlier write when case insertion fails', async () => {
    db.client.query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: CONSENT_ID }] })
      .mockRejectedValueOnce(new Error('synthetic database failure'))
      .mockResolvedValueOnce({});

    await expect(submitCaseTransaction(params)).rejects.toThrow('synthetic database failure');
    expect(db.client.query.mock.calls.at(-1)?.[0]).toBe('rollback');
    expect(db.client.release).toHaveBeenCalledOnce();
  });

  describe('with partner routing', () => {
    const ORG_ID = '33333333-3333-4333-8333-333333333333';
    const REFERRAL_ID = '44444444-4444-4444-8444-444444444444';
    const FOLLOW_UP_ID = '55555555-5555-4555-8555-555555555555';
    const CALLBACK_CONSENT_ID = '66666666-6666-4666-8666-666666666666';
    const caseRecord = { id: CASE_ID, owner_id: 'owner-a', status: 'submitted' };
    const seal = vi.fn(() => 'v1.synthetic-sealed-callback');
    const SHARED = [
      { manifestIndex: 0, mediaType: 'photo' as const, sha256: 'a'.repeat(64) },
      { manifestIndex: 1, mediaType: 'video' as const, sha256: null },
    ];
    const routing = (withCallback: boolean, sharedEvidence: typeof SHARED = []) => ({
      partnerStableId: 'ke-coast-huria',
      consentRecordId: FOLLOW_UP_ID,
      consentVersion: 'partner-follow-up.ke-coast-huria.v1',
      sharedEvidence,
      ...(withCallback ? {
        callback: { consentRecordId: CALLBACK_CONSENT_ID, consentVersion: 'partner-callback.ke-coast-huria.v1', seal },
      } : {}),
    });

    function arrangeThroughDraft() {
      db.client.query
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ id: CONSENT_ID }] })
        .mockResolvedValueOnce({ rows: [caseRecord] })
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValueOnce({ rowCount: 1 });
    }

    it('routes inside the submission transaction: org gate, both consents, referral, sealed callback, event, audit', async () => {
      arrangeThroughDraft();
      db.client.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: ORG_ID }] })
        .mockResolvedValueOnce({ rows: [{ id: FOLLOW_UP_ID }] })
        .mockResolvedValueOnce({ rows: [{ id: CALLBACK_CONSENT_ID }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ id: REFERRAL_ID, reference: 'SR-7K3Q-9M2D', status: 'new' }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rowCount: 2 })
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValueOnce({});

      await expect(submitCaseTransaction({ ...params, partnerRouting: routing(true, SHARED) })).resolves.toEqual({
        caseRecord,
        partnerReferral: { partnerStableId: 'ke-coast-huria', reference: 'SR-7K3Q-9M2D', status: 'new', callbackShared: true },
      });

      const calls = db.client.query.mock.calls.map(([sql, values]) => ({ sql: String(sql), values: values as unknown[] }));
      expect(calls[5].sql).toContain('from saferide.partner_referrals referral');
      expect(calls[6].sql).toContain('intake_enabled');
      expect(calls[6].sql).toContain('agreement_expires_at > now()');
      expect(calls[6].sql).toContain('for share');
      expect(calls[6].values).toEqual(['ke-coast-huria']);
      expect(calls[7].values).toEqual([FOLLOW_UP_ID, 'owner-a', 'partner_follow_up', 'partner-follow-up.ke-coast-huria.v1']);
      expect(calls[7].sql).toContain("consent.status = 'granted'");
      expect(calls[8].values).toEqual([CALLBACK_CONSENT_ID, 'owner-a', 'partner_callback', 'partner-callback.ke-coast-huria.v1']);
      expect(calls[9].sql).toBe('savepoint partner_reference');
      expect(calls[10].sql).toContain('insert into saferide.partner_referrals');
      expect(calls[10].values).toEqual([CASE_ID, 'owner-a', ORG_ID, FOLLOW_UP_ID, expect.stringMatching(/^SR-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)]);
      expect(calls[11].sql).toBe('release savepoint partner_reference');
      expect(seal).toHaveBeenCalledWith(REFERRAL_ID);
      expect(calls[12].sql).toContain('insert into saferide.partner_referral_evidence');
      expect(calls[12].values).toEqual([REFERRAL_ID, ORG_ID, [0, 1], ['photo', 'video'], ['a'.repeat(64), null]]);
      expect(calls[13].sql).toContain('insert into saferide.partner_referral_callbacks');
      expect(calls[13].values).toEqual([REFERRAL_ID, ORG_ID, 'owner-a', CALLBACK_CONSENT_ID, 'v1.synthetic-sealed-callback']);
      expect(calls[14].sql).toContain("'partner_routed'");
      expect(calls[14].values[2]).toEqual({
        schemaVersion: '1.0', partner: 'ke-coast-huria', reference: 'SR-7K3Q-9M2D', partner_status: 'new', callback_shared: true,
      });
      expect(calls[15].sql).toContain("('case.partner_route', 'partner_referral', $1, 'success', $2)");
      expect(calls[16].sql).toContain("('case.create', 'case', $1, 'success', $2)");
      expect(calls[17].sql).toBe('commit');
    });

    it.each([
      ['partner_not_accepting', [{ rows: [] }]],
      ['partner_consent_missing', [{ rows: [{ id: ORG_ID }] }, { rows: [] }]],
      ['callback_consent_missing', [{ rows: [{ id: ORG_ID }] }, { rows: [{ id: FOLLOW_UP_ID }] }, { rows: [] }]],
    ])('rolls the whole submission back when %s', async (reason, responses) => {
      arrangeThroughDraft();
      db.client.query.mockResolvedValueOnce({ rows: [] });
      for (const response of responses) db.client.query.mockResolvedValueOnce(response);
      db.client.query.mockResolvedValueOnce({});

      const error = await submitCaseTransaction({ ...params, partnerRouting: routing(true) }).catch(caught => caught);
      expect(error).toBeInstanceOf(PartnerRoutingRejectedError);
      expect(error.reason).toBe(reason);
      const statements = db.client.query.mock.calls.map(([sql]) => String(sql));
      expect(statements.at(-1)).toBe('rollback');
      expect(statements.some(sql => sql.includes('insert into saferide.partner_referrals'))).toBe(false);
      expect(statements.some(sql => sql.includes("'case.create'"))).toBe(false);
      expect(seal).not.toHaveBeenCalled();
    });

    it('returns the first routing on a retry instead of routing twice', async () => {
      arrangeThroughDraft();
      db.client.query
        .mockResolvedValueOnce({ rows: [{ consent_record_id: FOLLOW_UP_ID, reference: 'SR-7K3Q-9M2D', status: 'acknowledged', callback_shared: false }] })
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValueOnce({});

      await expect(submitCaseTransaction({ ...params, partnerRouting: routing(true) })).resolves.toMatchObject({
        partnerReferral: { reference: 'SR-7K3Q-9M2D', status: 'acknowledged', callbackShared: false },
      });
      const statements = db.client.query.mock.calls.map(([sql]) => String(sql));
      expect(statements.filter(sql => sql.includes('partner_routed') || sql.includes('insert into saferide.partner_'))).toEqual([]);
      expect(seal).not.toHaveBeenCalled();
    });

    it('treats a retry that names a different consent as a conflict', async () => {
      arrangeThroughDraft();
      db.client.query
        .mockResolvedValueOnce({ rows: [{ consent_record_id: CALLBACK_CONSENT_ID, reference: 'SR-7K3Q-9M2D', status: 'new', callback_shared: false }] })
        .mockResolvedValueOnce({});
      await expect(submitCaseTransaction({ ...params, partnerRouting: routing(false) })).rejects.toBeInstanceOf(CaseSubmissionConflictError);
    });

    it('reports a consent used concurrently by another report as missing', async () => {
      arrangeThroughDraft();
      db.client.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: ORG_ID }] })
        .mockResolvedValueOnce({ rows: [{ id: FOLLOW_UP_ID }] })
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'partner_referrals_consent_record_id_key' }))
        .mockResolvedValueOnce({});
      const error = await submitCaseTransaction({ ...params, partnerRouting: routing(false) }).catch(caught => caught);
      expect(error).toBeInstanceOf(PartnerRoutingRejectedError);
      expect(error.reason).toBe('partner_consent_missing');
    });

    it('draws a new reference when one clashes, instead of failing the submission', async () => {
      arrangeThroughDraft();
      const clash = Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'partner_referrals_reference_key' });
      db.client.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: ORG_ID }] })
        .mockResolvedValueOnce({ rows: [{ id: FOLLOW_UP_ID }] })
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(clash)
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ id: REFERRAL_ID, reference: 'SR-7K3Q-9M2D', status: 'new' }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValueOnce({});
      await expect(submitCaseTransaction({ ...params, partnerRouting: routing(false) })).resolves.toMatchObject({
        partnerReferral: { reference: 'SR-7K3Q-9M2D' },
      });
      const statements = db.client.query.mock.calls.map(([sql]) => String(sql).trim());
      expect(statements.filter(sql => sql.startsWith('insert into saferide.partner_referrals'))).toHaveLength(2);
      expect(statements).toContain('rollback to savepoint partner_reference');
      expect(statements.at(-1)).toBe('commit');
    });

    it('gives up after repeated reference clashes without committing', async () => {
      arrangeThroughDraft();
      const clash = Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'partner_referrals_reference_key' });
      db.client.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: ORG_ID }] })
        .mockResolvedValueOnce({ rows: [{ id: FOLLOW_UP_ID }] });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        db.client.query.mockResolvedValueOnce({}).mockRejectedValueOnce(clash);
        if (attempt < 4) db.client.query.mockResolvedValueOnce({});
      }
      db.client.query.mockResolvedValueOnce({});
      await expect(submitCaseTransaction({ ...params, partnerRouting: routing(false) })).rejects.toBe(clash);
      expect(db.client.query.mock.calls.at(-1)?.[0]).toBe('rollback');
    });

    it('reports intake closing between the check and the insert as not accepting', async () => {
      arrangeThroughDraft();
      db.client.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: ORG_ID }] })
        .mockResolvedValueOnce({ rows: [{ id: FOLLOW_UP_ID }] })
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(Object.assign(new Error('partner organisation is not open for intake'), { code: 'P0001' }))
        .mockResolvedValueOnce({});
      const error = await submitCaseTransaction({ ...params, partnerRouting: routing(false) }).catch(caught => caught);
      expect(error).toBeInstanceOf(PartnerRoutingRejectedError);
      expect(error.reason).toBe('partner_not_accepting');
      expect(db.client.query.mock.calls.at(-1)?.[0]).toBe('rollback');
    });
  });
});
