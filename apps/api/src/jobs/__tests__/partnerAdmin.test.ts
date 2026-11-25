import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { partnerPasswordProblem, verifyPartnerPassword } from '../../services/partnerCredentials.js';
import { hashPartnerToken } from '../../services/partnerTokens.js';
import { EXIT_FAILED, EXIT_OK, EXIT_REFUSED, EXIT_USAGE, maskEmail, runPartnerAdmin } from '../partnerAdmin.js';

const repo = vi.hoisted(() => ({
  addPartnerOperator: vi.fn(),
  createPartnerOrg: vi.fn(),
  disablePartnerOperator: vi.fn(),
  disablePartnerUser: vi.fn(),
  exportPartnerAudit: vi.fn(),
  invitePartnerUser: vi.fn(),
  listPartnerReferralsForOperator: vi.fn(),
  recordPartnerAccess: vi.fn(),
  resetPartnerUserEnrollment: vi.fn(),
  revokePartnerReferralByOperator: vi.fn(),
  revokePartnerSessions: vi.fn(),
  setPartnerOrgAgreement: vi.fn(),
  setPartnerOrgIntake: vi.fn(),
  setPartnerOrgMfa: vi.fn(),
  setPartnerUserPassword: vi.fn(),
}));

vi.mock('../../repositories/partnerRepository.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../repositories/partnerRepository.js')>()),
  ...repo,
}));
vi.mock('../../plugins/db.js', () => ({ closeDb: vi.fn(), query: vi.fn(), pool: { connect: vi.fn() } }));
vi.mock('../../config/env.js', () => ({ env: { partnerPublicOrigin: 'https://partners.example.invalid' } }));

const { PartnerAdminError } = await import('../../repositories/partnerRepository.js');

const invitedUser = {
  id: '22222222-2222-4222-8222-222222222222', orgId: '11111111-1111-4111-8111-111111111111',
  email: 'case.worker@example.invalid', displayName: 'Synthetic caseworker',
  role: 'partner_caseworker', status: 'invited', totpEnrolled: false,
};

let dir: string;
let out: string[];
let err: string[];
const io = () => ({
  stdout: (line: string) => out.push(line),
  stderr: (line: string) => err.push(line),
  now: () => new Date('2026-10-21T10:00:00.000Z'),
});
const printed = () => [...out, ...err].join('\n');

describe('partner operator CLI', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    dir = await mkdtemp(join(tmpdir(), 'partner-admin-test-'));
    out = [];
    err = [];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('requires a valid --operator before touching the database', async () => {
    expect(await runPartnerAdmin(['org:create', '--stable-id', 'ke-coast-huria', '--name', 'HURIA'], io())).toBe(EXIT_USAGE);
    expect(await runPartnerAdmin(['org:create', '--operator', 'Not A Handle', '--stable-id', 'ke-coast-huria', '--name', 'HURIA'], io()))
      .toBe(EXIT_USAGE);
    expect(repo.createPartnerOrg).not.toHaveBeenCalled();
  });

  it('rejects unknown commands and unexpected flags', async () => {
    expect(await runPartnerAdmin(['org:delete', '--operator', 'ops-one'], io())).toBe(EXIT_USAGE);
    expect(await runPartnerAdmin(['user:disable', '--operator', 'ops-one', '--email', 'a@example.invalid', '--org', 'x-y'], io()))
      .toBe(EXIT_USAGE);
    expect(await runPartnerAdmin(['user:disable', '--operator', 'ops-one', '--bogus', '1'], io())).toBe(EXIT_USAGE);
    expect(repo.disablePartnerUser).not.toHaveBeenCalled();
  });

  it('registers an operator with the acting operator recorded for audit', async () => {
    repo.addPartnerOperator.mockResolvedValue({ id: 'op', handle: 'ops-two', displayName: 'Ops Two', roleLabel: 'Partnership lead', status: 'active' });
    const code = await runPartnerAdmin([
      'operator:add', '--operator', 'ops-one', '--handle', 'ops-two', '--name', 'Ops Two', '--role-label', 'Partnership lead',
    ], io());
    expect(code).toBe(EXIT_OK);
    expect(repo.addPartnerOperator).toHaveBeenCalledWith(expect.objectContaining({
      handle: 'ops-two', context: expect.objectContaining({ operatorRef: 'ops-one', requestId: expect.stringMatching(/^cli-/) }),
    }));
    expect(out[0]).toBe('ok operator:add handle=ops-two status=active');
  });

  it('passes an explicit --bootstrap through for the first operator only when given', async () => {
    repo.addPartnerOperator.mockResolvedValue({ id: 'op', handle: 'ops-one', displayName: 'Ops One', roleLabel: 'Technical lead', status: 'active' });
    expect(await runPartnerAdmin([
      'operator:add', '--bootstrap', '--operator', 'ops-one', '--handle', 'ops-one', '--name', 'Ops One', '--role-label', 'Technical lead',
    ], io())).toBe(EXIT_OK);
    expect(repo.addPartnerOperator.mock.calls[0][0].bootstrap).toBe(true);
    expect(await runPartnerAdmin([
      'operator:add', '--operator', 'ops-one', '--handle', 'ops-two', '--name', 'Ops Two', '--role-label', 'Partnership lead',
    ], io())).toBe(EXIT_OK);
    expect(repo.addPartnerOperator.mock.calls[1][0].bootstrap).toBe(false);
    expect(await runPartnerAdmin(['user:disable', '--bootstrap', '--operator', 'ops-one', '--email', 'a@example.invalid'], io()))
      .toBe(EXIT_USAGE);
  });

  it('refuses output files outside the temp directory (the API container tmpfs)', async () => {
    for (const linkFile of ['/srv/state/invite.txt', join(dir, '..', '..', 'etc', 'invite.txt'), 'relative-invite.txt']) {
      const code = await runPartnerAdmin([
        'user:invite', '--operator', 'ops-one', '--org', 'test-partner', '--email', 'a@example.invalid',
        '--name', 'A', '--role', 'partner_admin', '--link-file', linkFile,
      ], io());
      expect(code).toBe(EXIT_USAGE);
    }
    expect(repo.invitePartnerUser).not.toHaveBeenCalled();
    expect(err.join('\n')).toContain('under');
  });

  describe('operator-issued passwords and per-org MFA (013)', () => {
    const activeUser = { ...invitedUser, status: 'active' };

    it('generates a password, writes it only to a new 0600 file, stores only its hash and never prints it', async () => {
      repo.setPartnerUserPassword.mockResolvedValue({ user: activeUser, revokedSessions: 2, wasInvited: true, orgMfaRequired: false });
      const outFile = join(dir, 'password.txt');
      const code = await runPartnerAdmin([
        'user:set-password', '--operator', 'ops-one', '--email', 'Case.Worker@Example.Invalid', '--generate', '--out-file', outFile,
      ], io());
      expect(code).toBe(EXIT_OK);
      const contents = await readFile(outFile, 'utf8');
      const password = contents.split('\n').find(line => line && !line.startsWith('#')) as string;
      expect(password).toMatch(/^[a-hj-km-np-z2-9]{5}(-[a-hj-km-np-z2-9]{5}){4}$/);
      expect(partnerPasswordProblem(password, 'case.worker@example.invalid')).toBeNull();
      expect((await stat(outFile)).mode & 0o777).toBe(0o600);
      const call = repo.setPartnerUserPassword.mock.calls[0][0];
      expect(call.email).toBe('case.worker@example.invalid');
      await expect(verifyPartnerPassword(password, call.passwordHash)).resolves.toBe(true);
      expect(JSON.stringify(call)).not.toContain(password);
      expect(printed()).not.toContain(password);
      expect(out[0]).toBe(`ok user:set-password id=${activeUser.id} email=c***@example.invalid status=active must_change_password=yes revoked_sessions=2 activated=yes`);
      expect(out[1]).toContain('it is not shown here');
      expect(out[2]).toContain('MFA off');
    });

    it('requires --generate and a new file under the temp directory, and leaves no file when refused', async () => {
      const outFile = join(dir, 'password.txt');
      expect(await runPartnerAdmin(['user:set-password', '--operator', 'ops-one', '--email', 'a@example.invalid', '--out-file', outFile], io()))
        .toBe(EXIT_USAGE);
      expect(await runPartnerAdmin([
        'user:set-password', '--operator', 'ops-one', '--email', 'a@example.invalid', '--generate', '--out-file', '/srv/state/p.txt',
      ], io())).toBe(EXIT_USAGE);
      await writeFile(join(dir, 'exists.txt'), 'x');
      expect(await runPartnerAdmin([
        'user:set-password', '--operator', 'ops-one', '--email', 'a@example.invalid', '--generate', '--out-file', join(dir, 'exists.txt'),
      ], io())).toBe(EXIT_USAGE);
      expect(await runPartnerAdmin([
        'user:set-password', '--operator', 'ops-one', '--email', 'a@example.invalid', '--generate', '--password', 'x', '--out-file', outFile,
      ], io())).toBe(EXIT_USAGE);
      expect(repo.setPartnerUserPassword).not.toHaveBeenCalled();

      repo.setPartnerUserPassword.mockRejectedValue(new PartnerAdminError('invalid_state', 'Disabled partner users cannot get a password'));
      expect(await runPartnerAdmin([
        'user:set-password', '--operator', 'ops-one', '--email', 'a@example.invalid', '--generate', '--out-file', outFile,
      ], io())).toBe(EXIT_REFUSED);
      await expect(stat(outFile)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(repo.recordPartnerAccess).toHaveBeenCalledWith(expect.objectContaining({ action: 'operator.user.set_password', outcome: 'denied' }));
    });

    it('switches org MFA by stable id or id, warning when it goes off while intake is on', async () => {
      repo.setPartnerOrgMfa.mockResolvedValueOnce({
        org: { id: invitedUser.orgId, stableId: 'ke-coast-huria', intakeEnabled: true }, changed: true, revokedSessions: 0, usersWithoutTotp: 3,
      });
      expect(await runPartnerAdmin(['org:mfa', '--operator', 'ops-one', '--org', 'ke-coast-huria', '--state', 'off'], io())).toBe(EXIT_OK);
      expect(repo.setPartnerOrgMfa).toHaveBeenLastCalledWith(expect.objectContaining({ org: 'ke-coast-huria', required: false }));
      expect(out).toEqual([
        'ok org:mfa stable_id=ke-coast-huria mfa=off changed=yes revoked_password_only_sessions=0',
        'warning: intake is on for this org; SafeRide recommends MFA required before real survivor cases flow',
      ]);

      out = [];
      repo.setPartnerOrgMfa.mockResolvedValueOnce({
        org: { id: invitedUser.orgId, stableId: 'ke-coast-huria', intakeEnabled: true }, changed: true, revokedSessions: 4, usersWithoutTotp: 3,
      });
      expect(await runPartnerAdmin(['org:mfa', '--operator', 'ops-one', '--org', invitedUser.orgId, '--state', 'required'], io())).toBe(EXIT_OK);
      expect(repo.setPartnerOrgMfa).toHaveBeenLastCalledWith(expect.objectContaining({ org: invitedUser.orgId, required: true }));
      expect(out[0]).toBe('ok org:mfa stable_id=ke-coast-huria mfa=required changed=yes revoked_password_only_sessions=4');
      expect(out[1]).toContain('3 active user(s) have no authenticator yet');

      expect(await runPartnerAdmin(['org:mfa', '--operator', 'ops-one', '--org', 'ke-coast-huria', '--state', 'on'], io())).toBe(EXIT_USAGE);
      expect(repo.setPartnerOrgMfa).toHaveBeenCalledTimes(2);
    });
  });

  it('invites a user, writes the one-time link only to a new 0600 file and never prints it', async () => {
    repo.invitePartnerUser.mockResolvedValue(invitedUser);
    const linkFile = join(dir, 'invite.txt');
    const code = await runPartnerAdmin([
      'user:invite', '--operator', 'ops-one', '--org', 'ke-coast-huria', '--email', 'Case.Worker@Example.Invalid',
      '--name', 'Synthetic caseworker', '--role', 'partner_caseworker', '--link-file', linkFile,
    ], io());
    expect(code).toBe(EXIT_OK);

    const contents = await readFile(linkFile, 'utf8');
    const token = contents.match(/#token=(srpe_[A-Za-z0-9_-]{43})/)?.[1];
    expect(token).toBeDefined();
    expect(contents).toContain('https://partners.example.invalid/enroll#token=');
    expect((await stat(linkFile)).mode & 0o777).toBe(0o600);

    const call = repo.invitePartnerUser.mock.calls[0][0];
    expect(call.email).toBe('case.worker@example.invalid');
    expect(call.enrollmentTokenHash).toBe(hashPartnerToken(token as string));
    expect(call.enrollmentExpiresAt.toISOString()).toBe('2026-10-22T10:00:00.000Z');
    expect(JSON.stringify(call)).not.toContain(token);

    expect(printed()).not.toContain(token);
    expect(printed()).not.toMatch(/srpe_|#token=/);
    expect(printed()).not.toContain('case.worker@example.invalid');
    expect(out[0]).toContain(`email=${maskEmail(invitedUser.email)}`);
  });

  it('refuses to overwrite an existing link file and changes nothing', async () => {
    const linkFile = join(dir, 'exists.txt');
    await writeFile(linkFile, 'keep me');
    const code = await runPartnerAdmin([
      'user:invite', '--operator', 'ops-one', '--org', 'ke-coast-huria', '--email', 'a@example.invalid',
      '--name', 'A', '--role', 'partner_admin', '--link-file', linkFile,
    ], io());
    expect(code).toBe(EXIT_USAGE);
    expect(repo.invitePartnerUser).not.toHaveBeenCalled();
    expect(await readFile(linkFile, 'utf8')).toBe('keep me');
  });

  it('removes the link file and audits a denial when the repository refuses', async () => {
    repo.invitePartnerUser.mockRejectedValue(new PartnerAdminError('not_found', 'No active partner organisation with that stable id'));
    const linkFile = join(dir, 'refused.txt');
    const code = await runPartnerAdmin([
      'user:invite', '--operator', 'ops-one', '--org', 'missing-org', '--email', 'a@example.invalid',
      '--name', 'A', '--role', 'partner_admin', '--link-file', linkFile,
    ], io());
    expect(code).toBe(EXIT_REFUSED);
    await expect(stat(linkFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(repo.recordPartnerAccess).toHaveBeenCalledWith(expect.objectContaining({
      action: 'operator.user.invite', outcome: 'denied', actor: { type: 'operator', operatorRef: 'ops-one' },
    }));
    expect(err.join('\n')).toContain('refused (not_found)');
  });

  it('resets enrolment through a new link file without printing the token', async () => {
    repo.resetPartnerUserEnrollment.mockResolvedValue({ user: invitedUser, revokedSessions: 2, releasedAssignments: 3 });
    const linkFile = join(dir, 'reset.txt');
    const code = await runPartnerAdmin([
      'user:reset', '--operator', 'ops-one', '--email', 'case.worker@example.invalid', '--link-file', linkFile,
    ], io());
    expect(code).toBe(EXIT_OK);
    const token = (await readFile(linkFile, 'utf8')).match(/srpe_[A-Za-z0-9_-]{43}/)?.[0] as string;
    expect(repo.resetPartnerUserEnrollment.mock.calls[0][0].enrollmentTokenHash).toBe(hashPartnerToken(token));
    expect(printed()).not.toContain(token);
    expect(out[0]).toContain('revoked_sessions=2 released_referrals=3');
  });

  it('disables a user and reports revoked sessions', async () => {
    repo.disablePartnerUser.mockResolvedValue({ user: { ...invitedUser, status: 'disabled' }, revokedSessions: 1, releasedAssignments: 1 });
    const code = await runPartnerAdmin(['user:disable', '--operator', 'ops-one', '--email', 'case.worker@example.invalid'], io());
    expect(code).toBe(EXIT_OK);
    expect(repo.disablePartnerUser).toHaveBeenCalledWith(expect.objectContaining({ email: 'case.worker@example.invalid' }));
    expect(out[0]).toContain('status=disabled revoked_sessions=1 released_referrals=1');
  });

  it('validates org intake and agreement flags', async () => {
    expect(await runPartnerAdmin(['org:intake', '--operator', 'ops-one', '--org', 'ke-coast-huria', '--state', 'yes'], io()))
      .toBe(EXIT_USAGE);
    expect(await runPartnerAdmin([
      'org:set-agreement', '--operator', 'ops-one', '--org', 'ke-coast-huria', '--ref', 'DPA-1',
      '--signed-at', '2026-11-01', '--expires-at', '2026-10-01',
    ], io())).toBe(EXIT_USAGE);
    expect(repo.setPartnerOrgIntake).not.toHaveBeenCalled();
    expect(repo.setPartnerOrgAgreement).not.toHaveBeenCalled();

    repo.setPartnerOrgIntake.mockRejectedValue(new PartnerAdminError('agreement_required', 'Intake needs a recorded agreement'));
    expect(await runPartnerAdmin(['org:intake', '--operator', 'ops-one', '--org', 'ke-coast-huria', '--state', 'on'], io()))
      .toBe(EXIT_REFUSED);
  });

  it('needs exactly one target to revoke sessions', async () => {
    expect(await runPartnerAdmin(['sessions:revoke', '--operator', 'ops-one'], io())).toBe(EXIT_USAGE);
    repo.revokePartnerSessions.mockResolvedValue(3);
    expect(await runPartnerAdmin(['sessions:revoke', '--operator', 'ops-one', '--org', 'ke-coast-huria'], io())).toBe(EXIT_OK);
    expect(repo.revokePartnerSessions).toHaveBeenCalledWith(expect.objectContaining({ target: { orgStableId: 'ke-coast-huria' } }));
  });

  it('exports audit rows as JSON lines to a new 0600 file', async () => {
    repo.exportPartnerAudit.mockResolvedValue([{ id: 'a1', action: 'auth.login', outcome: 'success' }]);
    const outFile = join(dir, 'audit.jsonl');
    const code = await runPartnerAdmin([
      'audit:export', '--operator', 'ops-one', '--org', 'ke-coast-huria', '--since', '2026-10-01', '--out-file', outFile,
    ], io());
    expect(code).toBe(EXIT_OK);
    expect(await readFile(outFile, 'utf8')).toBe('{"id":"a1","action":"auth.login","outcome":"success"}\n');
    expect((await stat(outFile)).mode & 0o777).toBe(0o600);
    expect(repo.exportPartnerAudit.mock.calls[0][0].until.toISOString()).toBe('2026-10-21T10:00:00.000Z');
  });

  it('lists referrals as metadata only, with validated flags', async () => {
    for (const flags of [
      ['--org', 'Not An Org'], ['--org', 'ke-coast-huria', '--status', 'deleted'],
      ['--org', 'ke-coast-huria', '--limit', '0'], ['--org', 'ke-coast-huria', '--limit', '201'],
      ['--org', 'ke-coast-huria', '--limit', 'ten'], ['--org', 'ke-coast-huria', '--email', 'a@example.invalid'],
      [],
    ]) {
      expect(await runPartnerAdmin(['referral:list', '--operator', 'ops-one', ...flags], io()), flags.join(' ')).toBe(EXIT_USAGE);
    }
    expect(repo.listPartnerReferralsForOperator).not.toHaveBeenCalled();

    repo.listPartnerReferralsForOperator.mockResolvedValue({
      org: { id: '11111111-1111-4111-8111-111111111111', stableId: 'ke-coast-huria' },
      rows: [{
        reference: 'SR-7K3Q-9M2D', pathway: 'escalation', status: 'acknowledged', access: 'revoked',
        receivedAt: new Date('2026-10-20T08:00:00.000Z'), statusChangedAt: new Date('2026-10-21T09:00:00.000Z'),
      }],
      more: true,
    });
    expect(await runPartnerAdmin(['referral:list', '--operator', 'ops-one', '--org', 'ke-coast-huria'], io())).toBe(EXIT_OK);
    expect(repo.listPartnerReferralsForOperator).toHaveBeenLastCalledWith(expect.objectContaining({
      org: 'ke-coast-huria', status: undefined, limit: 50,
    }));
    expect(out).toEqual([
      'ok referral:list org=ke-coast-huria shown=1 more=yes',
      'reference=SR-7K3Q-9M2D pathway=escalation status=acknowledged access=revoked received=2026-10-20T08:00:00.000Z status_changed=2026-10-21T09:00:00.000Z',
    ]);

    const orgId = '11111111-1111-4111-8111-111111111111';
    expect(await runPartnerAdmin(['referral:list', '--operator', 'ops-one', '--org', orgId, '--status', 'withdrawn', '--limit', '200'], io()))
      .toBe(EXIT_OK);
    expect(repo.listPartnerReferralsForOperator).toHaveBeenLastCalledWith(expect.objectContaining({ org: orgId, status: 'withdrawn', limit: 200 }));
  });

  it('revokes one referral by reference with a reason code and never takes free text', async () => {
    for (const flags of [
      ['--reference', 'SR-7K3Q-9M2D'],
      ['--reference', 'SR-7K3Q-9M2D', '--reason', 'because'],
      ['--reference', 'SR-7K3Q-9M2', '--reason', 'misrouted'],
      ['--reference', 'SR-IIII-OOOO', '--reason', 'misrouted'],
      ['--reference', 'SR-7K3Q-9M2D', '--reason', 'misrouted', '--note-to-audit', 'Synthetic free text'],
      ['--reference', 'SR-7K3Q-9M2D', '--reason', 'misrouted', '--org', 'Not An Org', '--yes'],
      ['--reference', 'SR-7K3Q-9M2D', '--reason', 'misrouted', '--email', 'a@example.invalid', '--yes'],
      ['--reference', 'SR-7K3Q-9M2D', '--reason', 'misrouted', '--yes=no'],
    ]) {
      expect(await runPartnerAdmin(['referral:revoke', '--operator', 'ops-one', ...flags], io()), flags.join(' ')).toBe(EXIT_USAGE);
    }
    expect(repo.revokePartnerReferralByOperator).not.toHaveBeenCalled();
    expect(printed()).not.toContain('Synthetic free text');

    // Without --yes: shows the org and reference to check, and the repository is told not to act.
    repo.revokePartnerReferralByOperator.mockResolvedValueOnce({
      confirmed: false, reference: 'SR-7K3Q-9M2D', orgStableId: 'ke-coast-huria', status: 'acknowledged', access: 'active',
    });
    expect(await runPartnerAdmin(['referral:revoke', '--operator', 'ops-one', '--reference', 'SR-7K3Q-9M2D', '--reason', 'misrouted'], io()))
      .toBe(EXIT_REFUSED);
    expect(repo.revokePartnerReferralByOperator).toHaveBeenLastCalledWith(expect.objectContaining({ confirm: false, org: undefined }));
    expect(out).toEqual([
      'check referral:revoke reference=SR-7K3Q-9M2D org=ke-coast-huria status=acknowledged access=active reason=misrouted',
      'not revoked: if that is the right referral and org, rerun with --yes',
    ]);

    out = [];
    repo.revokePartnerReferralByOperator.mockResolvedValue({
      confirmed: true, reference: 'SR-7K3Q-9M2D', orgStableId: 'ke-coast-huria', revokedAt: new Date('2026-10-21T10:00:00.000Z'), alreadyRevoked: false,
    });
    expect(await runPartnerAdmin([
      'referral:revoke', '--operator', 'ops-one', '--reference', 'sr-7k3q-9m2d', '--reason', 'safeguarding_concern', '--org', 'ke-coast-huria', '--yes',
    ], io())).toBe(EXIT_OK);
    expect(repo.revokePartnerReferralByOperator).toHaveBeenLastCalledWith(expect.objectContaining({
      reference: 'SR-7K3Q-9M2D', reason: 'safeguarding_concern', org: 'ke-coast-huria', confirm: true,
      context: expect.objectContaining({ operatorRef: 'ops-one' }),
    }));
    expect(out[0]).toBe('ok referral:revoke reference=SR-7K3Q-9M2D org=ke-coast-huria reason=safeguarding_concern state=revoked revoked_at=2026-10-21T10:00:00.000Z');
    expect(out.join('\n')).not.toContain('sessions:revoke');

    out = [];
    expect(await runPartnerAdmin(['referral:revoke', '--operator', 'ops-one', '--reference', 'SR-7K3Q-9M2D', '--reason', 'partner_compromise', '--yes'], io()))
      .toBe(EXIT_OK);
    expect(out.at(-1)).toBe("hint: partner_compromise: also end the org's partner sessions with sessions:revoke --operator <handle> --org ke-coast-huria");
    expect(repo.revokePartnerSessions).not.toHaveBeenCalled();

    repo.revokePartnerReferralByOperator.mockRejectedValue(new PartnerAdminError('not_found', 'No partner referral with that reference'));
    expect(await runPartnerAdmin(['referral:revoke', '--operator', 'ops-one', '--reference', 'SR-0000-0000', '--reason', 'other', '--yes'], io()))
      .toBe(EXIT_REFUSED);
    expect(repo.recordPartnerAccess).toHaveBeenCalledWith(expect.objectContaining({ action: 'operator.referral.revoke', outcome: 'denied' }));
  });

  it('refuses a UUID-shaped stable id for a new org, and --yes on other commands', async () => {
    expect(await runPartnerAdmin([
      'org:create', '--operator', 'ops-one', '--stable-id', '0f8c2b1e-5d4a-4c3b-9a21-7e6d5c4b3a29', '--name', 'Synthetic',
    ], io())).toBe(EXIT_USAGE);
    expect(err.join('\n')).toContain('invalid --stable-id: must not look like a UUID');
    expect(await runPartnerAdmin(['org:create', '--operator', 'ops-one', '--stable-id', 'ke-coast-huria', '--name', 'HURIA', '--yes'], io()))
      .toBe(EXIT_USAGE);
    expect(repo.createPartnerOrg).not.toHaveBeenCalled();
  });

  it('fails closed on unexpected errors without echoing their detail', async () => {
    repo.createPartnerOrg.mockRejectedValue(new Error('connect ECONNREFUSED synthetic-detail'));
    repo.recordPartnerAccess.mockRejectedValue(new Error('audit down'));
    const code = await runPartnerAdmin(['org:create', '--operator', 'ops-one', '--stable-id', 'ke-coast-huria', '--name', 'HURIA'], io());
    expect(code).toBe(EXIT_FAILED);
    expect(repo.recordPartnerAccess).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', action: 'operator.org.create' }));
    expect(printed()).not.toContain('synthetic-detail');
    expect(err.join('\n')).toContain('nothing was committed');
  });
});
