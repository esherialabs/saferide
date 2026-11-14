import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PARTNER_ACCESS_POLICY_VERSION,
  PartnerAdminError,
  addPartnerOperator,
  createPartnerOrg,
  disablePartnerUser,
  invitePartnerUser,
  recordPartnerAccess,
  resetPartnerUserEnrollment,
  setPartnerOrgIntake,
} from '../partnerRepository.js';

const db = vi.hoisted(() => ({
  query: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
  connect: vi.fn(),
}));

vi.mock('../../plugins/db.js', () => ({
  query: db.query,
  pool: { connect: db.connect },
}));

const context = { operatorRef: 'ops-one', requestId: 'cli-test-request' };
const orgRow = {
  id: '11111111-1111-4111-8111-111111111111', stable_id: 'ke-coast-huria', display_name: 'HURIA',
  status: 'active', intake_enabled: false, agreement_ref: null, agreement_signed_at: null, agreement_expires_at: null,
};
const userRow = {
  id: '22222222-2222-4222-8222-222222222222', org_id: orgRow.id, email: 'case.worker@example.invalid',
  display_name: 'Synthetic caseworker', role: 'partner_caseworker', status: 'active', totp_enrolled: true,
};
const activeOperator = { rows: [{ id: '33333333-3333-4333-8333-333333333333' }] };

function sqlCalls(): string[] {
  return db.clientQuery.mock.calls.map(call => String(call[0]));
}

function auditCalls(): unknown[][] {
  return db.clientQuery.mock.calls.filter(call => String(call[0]).includes('partner_access_audit'));
}

describe('partner repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.connect.mockResolvedValue({ query: db.clientQuery, release: db.release });
  });

  it('writes a named audit row with no content, IP or free text', async () => {
    db.query.mockResolvedValue({ rowCount: 1 });
    await recordPartnerAccess({
      orgId: orgRow.id,
      actor: { type: 'partner_user', userId: userRow.id },
      action: 'partner.referral.read',
      outcome: 'success',
      requestId: 'req-1',
      referralId: '44444444-4444-4444-8444-444444444444',
    });
    const [sql, values] = db.query.mock.calls[0];
    expect(String(sql)).toContain('insert into saferide.partner_access_audit');
    expect(values).toEqual([
      orgRow.id, 'partner_user', userRow.id, null, 'partner.referral.read',
      '44444444-4444-4444-8444-444444444444', null, null, 'success', 'req-1', PARTNER_ACCESS_POLICY_VERSION,
    ]);
  });

  it('creates an org and its operator audit row in one transaction', async () => {
    db.clientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(activeOperator)
      .mockResolvedValueOnce({ rows: [orgRow] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({});
    const org = await createPartnerOrg({ stableId: 'ke-coast-huria', displayName: 'HURIA', context });
    expect(org).toMatchObject({ stableId: 'ke-coast-huria', intakeEnabled: false });
    expect(sqlCalls()[0]).toBe('begin');
    expect(sqlCalls()[1]).toContain('partner_operators');
    expect(auditCalls()).toHaveLength(1);
    expect(auditCalls()[0][1]).toEqual(expect.arrayContaining(['operator', 'ops-one', 'operator.org.create', 'success']));
    expect(db.clientQuery).toHaveBeenLastCalledWith('commit');
    expect(db.release).toHaveBeenCalledOnce();
  });

  it('rolls the change back when the audit write fails', async () => {
    db.clientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(activeOperator)
      .mockResolvedValueOnce({ rows: [orgRow] })
      .mockRejectedValueOnce(new Error('audit unavailable'))
      .mockResolvedValueOnce({});
    await expect(createPartnerOrg({ stableId: 'ke-coast-huria', displayName: 'HURIA', context }))
      .rejects.toThrow('audit unavailable');
    expect(sqlCalls()).not.toContain('commit');
    expect(db.clientQuery).toHaveBeenLastCalledWith('rollback');
    expect(db.release).toHaveBeenCalledOnce();
  });

  it('refuses commands from an operator who is not registered and active', async () => {
    db.clientQuery.mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({});
    const error = await createPartnerOrg({ stableId: 'ke-coast-huria', displayName: 'HURIA', context }).catch(e => e);
    expect(error).toBeInstanceOf(PartnerAdminError);
    expect(error.code).toBe('operator_unknown');
    expect(sqlCalls().some(sql => sql.includes('insert into saferide.partner_organizations'))).toBe(false);
    expect(db.clientQuery).toHaveBeenLastCalledWith('rollback');
  });

  it('lets only an explicit bootstrap register the first operator', async () => {
    db.clientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({});
    const mismatch = await addPartnerOperator({
      handle: 'ops-two', displayName: 'Operator Two', roleLabel: 'Partnership lead', context,
    }).catch(e => e);
    expect(mismatch.code).toBe('operator_unknown');

    vi.clearAllMocks();
    db.connect.mockResolvedValue({ query: db.clientQuery, release: db.release });
    db.clientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'op-1', handle: 'ops-one', display_name: 'Operator One', role_label: 'Technical lead', status: 'active' }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({});
    await expect(addPartnerOperator({
      handle: 'ops-one', displayName: 'Operator One', roleLabel: 'Technical lead', bootstrap: true, context,
    })).resolves.toMatchObject({ handle: 'ops-one', status: 'active' });
    expect(sqlCalls()[1]).toContain('lock table saferide.partner_operators');

    vi.clearAllMocks();
    db.connect.mockResolvedValue({ query: db.clientQuery, release: db.release });
    db.clientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({});
    const notActive = await addPartnerOperator({
      handle: 'ops-two', displayName: 'Operator Two', roleLabel: 'Partnership lead',
      context: { operatorRef: 'ops-two', requestId: 'cli-2' },
    }).catch(e => e);
    expect(notActive.code).toBe('operator_unknown');

    for (const [count, bootstrap, handle, expected] of [
      ['0', false, 'ops-one', 'operator_unknown'],
      ['1', true, 'ops-one', 'invalid_state'],
    ] as const) {
      vi.clearAllMocks();
      db.connect.mockResolvedValue({ query: db.clientQuery, release: db.release });
      db.clientQuery
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ count }] })
        .mockResolvedValueOnce({});
      const refused = await addPartnerOperator({
        handle, displayName: 'Operator One', roleLabel: 'Technical lead', bootstrap, context,
      }).catch(e => e);
      expect(refused.code).toBe(expected);
      expect(sqlCalls().some(sql => sql.includes('insert into saferide.partner_operators'))).toBe(false);
    }
  });

  it('stores only the enrolment token hash and never selects credential columns', async () => {
    db.clientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(activeOperator)
      .mockResolvedValueOnce({ rows: [{ ...userRow, status: 'invited', totp_enrolled: false }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({});
    const tokenHash = 'a'.repeat(64);
    const user = await invitePartnerUser({
      orgStableId: 'ke-coast-huria', email: ' Case.Worker@Example.Invalid ', displayName: 'Synthetic caseworker',
      role: 'partner_caseworker', enrollmentTokenHash: tokenHash, enrollmentExpiresAt: new Date('2026-10-22T00:00:00Z'), context,
    });
    expect(user).toEqual({
      id: userRow.id, orgId: orgRow.id, email: userRow.email, displayName: 'Synthetic caseworker',
      role: 'partner_caseworker', status: 'invited', totpEnrolled: false,
    });
    const [insertSql, insertValues] = db.clientQuery.mock.calls[2];
    expect(insertValues).toContain('case.worker@example.invalid');
    expect(insertValues).toContain(tokenHash);
    expect(String(insertSql)).not.toMatch(/returning[\s\S]*(password_hash|totp_secret_enc|enrollment_token_hash)/);
    expect(auditCalls()[0][1]).toEqual(expect.arrayContaining(['operator.user.invite', userRow.id]));
  });

  it('disables a user and revokes every live session in the same transaction', async () => {
    db.clientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(activeOperator)
      .mockResolvedValueOnce({ rows: [userRow] })
      .mockResolvedValueOnce({ rows: [{ ...userRow, status: 'disabled' }] })
      .mockResolvedValueOnce({ rowCount: 2 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({});
    const result = await disablePartnerUser({ email: userRow.email, context });
    expect(result).toMatchObject({ revokedSessions: 2, user: { status: 'disabled' } });
    const revoke = db.clientQuery.mock.calls.find(call => String(call[0]).includes('update saferide.partner_sessions'));
    expect(revoke?.[1]).toEqual([userRow.id, 'user_disabled']);
    expect(String(db.clientQuery.mock.calls[2][0])).toContain('for update');
    expect(db.clientQuery).toHaveBeenLastCalledWith('commit');
  });

  it('refuses to disable an already disabled user', async () => {
    db.clientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(activeOperator)
      .mockResolvedValueOnce({ rows: [{ ...userRow, status: 'disabled' }] })
      .mockResolvedValueOnce({});
    const error = await disablePartnerUser({ email: userRow.email, context }).catch(e => e);
    expect(error.code).toBe('invalid_state');
    expect(db.clientQuery).toHaveBeenLastCalledWith('rollback');
  });

  it('resets enrolment by clearing the password and TOTP secret and revoking sessions', async () => {
    db.clientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(activeOperator)
      .mockResolvedValueOnce({ rows: [userRow] })
      .mockResolvedValueOnce({ rows: [{ ...userRow, status: 'invited', totp_enrolled: false }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({});
    const result = await resetPartnerUserEnrollment({
      email: userRow.email, enrollmentTokenHash: 'b'.repeat(64),
      enrollmentExpiresAt: new Date('2026-10-22T00:00:00Z'), context,
    });
    expect(result.user).toMatchObject({ status: 'invited', totpEnrolled: false });
    const resetSql = String(db.clientQuery.mock.calls[3][0]);
    expect(resetSql).toContain('password_hash = null');
    expect(resetSql).toContain('totp_secret_enc = null');
    expect(resetSql).toContain('locked_until = null');
    const revoke = db.clientQuery.mock.calls.find(call => String(call[0]).includes('update saferide.partner_sessions'));
    expect(revoke?.[1]).toEqual([userRow.id, 'credential_reset']);
  });

  it('only turns intake on while an agreement is in force', async () => {
    db.clientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(activeOperator)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({});
    const error = await setPartnerOrgIntake({ stableId: 'ke-coast-huria', enabled: true, context }).catch(e => e);
    expect(error.code).toBe('agreement_required');
    expect(String(db.clientQuery.mock.calls[2][0])).toContain('agreement_expires_at > now()');
    expect(auditCalls()).toHaveLength(0);
  });

  it('maps unique violations to a conflict without leaking database detail', async () => {
    db.clientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(activeOperator)
      .mockRejectedValueOnce(Object.assign(new Error('duplicate key value'), { code: '23505', detail: 'Key (stable_id)=(x)' }))
      .mockResolvedValueOnce({});
    const error = await createPartnerOrg({ stableId: 'ke-coast-huria', displayName: 'HURIA', context }).catch(e => e);
    expect(error).toBeInstanceOf(PartnerAdminError);
    expect(error.code).toBe('conflict');
    expect(error.message).not.toContain('Key (');
  });
});
