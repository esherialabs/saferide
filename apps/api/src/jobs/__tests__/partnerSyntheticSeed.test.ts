import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from '../partnerAdmin.js';
import {
  SYNTHETIC_ORG_STABLE_ID,
  SYNTHETIC_PARTNER_USERS,
  runPartnerSyntheticSeed,
  syntheticSeedRefusal,
} from '../partnerSyntheticSeed.js';

const envState = vi.hoisted(() => ({
  env: { nodeEnv: 'development', appEnvironment: 'local', partnerPublicOrigin: undefined as string | undefined },
}));

const repo = vi.hoisted(() => ({
  addPartnerOperator: vi.fn(),
  countPartnerOperators: vi.fn(),
  createPartnerOrg: vi.fn(),
  findPartnerUserByEmail: vi.fn(),
  getPartnerOrgByStableId: vi.fn(),
  invitePartnerUser: vi.fn(),
  recordPartnerAccess: vi.fn(),
  setPartnerOrgAgreement: vi.fn(),
  setPartnerOrgIntake: vi.fn(),
}));

vi.mock('../../repositories/partnerRepository.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../repositories/partnerRepository.js')>()),
  ...repo,
}));
const demo = vi.hoisted(() => ({ seedPartnerDemoCases: vi.fn() }));
vi.mock('../partnerDemoCases.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../partnerDemoCases.js')>()),
  ...demo,
}));
vi.mock('../../plugins/db.js', () => ({ closeDb: vi.fn(), query: vi.fn(), pool: { connect: vi.fn() } }));
vi.mock('../../config/env.js', () => envState);

const org = { id: '11111111-1111-4111-8111-111111111111', stableId: SYNTHETIC_ORG_STABLE_ID };
let dir: string;
let out: string[];
let err: string[];
const io = () => ({ stdout: (line: string) => out.push(line), stderr: (line: string) => err.push(line) });

describe('synthetic partner seed', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    envState.env.nodeEnv = 'development';
    envState.env.appEnvironment = 'local';
    vi.stubEnv('APP_ENV', 'test');
    dir = await mkdtemp(join(tmpdir(), 'partner-seed-test-'));
    out = [];
    err = [];
    repo.countPartnerOperators.mockResolvedValue(0);
    repo.getPartnerOrgByStableId.mockResolvedValue(null);
    repo.createPartnerOrg.mockResolvedValue(org);
    repo.findPartnerUserByEmail.mockResolvedValue(null);
    repo.invitePartnerUser.mockImplementation(async params => ({ id: 'u', email: params.email, role: params.role }));
    demo.seedPartnerDemoCases.mockResolvedValue({
      created: ['urgent-new', 'assigned-in-progress', 'unassigned-referral'], existing: [], assignment: 'no_active_user',
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  it.each([
    [{ nodeEnv: 'production', rawAppEnv: 'test' }],
    [{ nodeEnv: 'development', rawAppEnv: undefined }],
    [{ nodeEnv: 'development', rawAppEnv: '' }],
    [{ nodeEnv: 'development', rawAppEnv: 'local' }],
    [{ nodeEnv: 'development', rawAppEnv: 'staging' }],
    [{ nodeEnv: 'development', rawAppEnv: 'production' }],
  ])('refuses %o', async environment => {
    expect(syntheticSeedRefusal(environment)).toMatch(/refusing/);
    envState.env.nodeEnv = environment.nodeEnv;
    if (environment.rawAppEnv === undefined) vi.stubEnv('APP_ENV', undefined);
    else vi.stubEnv('APP_ENV', environment.rawAppEnv);
    const code = await runPartnerSyntheticSeed(['--confirm-synthetic', '--link-file', join(dir, 'links.txt')], io());
    expect(code).toBe(EXIT_USAGE);
    expect(repo.createPartnerOrg).not.toHaveBeenCalled();
    expect(demo.seedPartnerDemoCases).not.toHaveBeenCalled();
    await expect(stat(join(dir, 'links.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires explicit confirmation', async () => {
    expect(await runPartnerSyntheticSeed(['--link-file', join(dir, 'links.txt')], io())).toBe(EXIT_USAGE);
    expect(repo.countPartnerOperators).not.toHaveBeenCalled();
  });

  it('accepts only explicit test or development', () => {
    expect(syntheticSeedRefusal({ nodeEnv: 'development', rawAppEnv: 'test' })).toBeNull();
    expect(syntheticSeedRefusal({ nodeEnv: 'test', rawAppEnv: 'development' })).toBeNull();
  });

  it('seeds the synthetic test-partner org (never a real partner) with intake on and fake users, keeping links out of the output', async () => {
    const linkFile = join(dir, 'links.txt');
    const code = await runPartnerSyntheticSeed(['--confirm-synthetic', '--link-file', linkFile], io());
    expect(code).toBe(EXIT_OK);
    expect(repo.addPartnerOperator).toHaveBeenCalledWith(expect.objectContaining({ handle: 'synthetic-seed' }));
    expect(SYNTHETIC_ORG_STABLE_ID).toBe('test-partner');
    expect(repo.createPartnerOrg).toHaveBeenCalledWith(expect.objectContaining({ stableId: 'test-partner' }));
    for (const call of [...repo.setPartnerOrgAgreement.mock.calls, ...repo.setPartnerOrgIntake.mock.calls, ...repo.invitePartnerUser.mock.calls]) {
      expect(JSON.stringify(call[0])).not.toContain('ke-coast-huria');
    }
    expect(repo.setPartnerOrgAgreement.mock.calls[0][0].agreementRef).toMatch(/^SYNTHETIC/);
    expect(repo.setPartnerOrgIntake).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
    expect(repo.invitePartnerUser).toHaveBeenCalledTimes(SYNTHETIC_PARTNER_USERS.length);
    expect(SYNTHETIC_PARTNER_USERS.every(user => user.email.endsWith('@example.invalid'))).toBe(true);
    expect(repo.recordPartnerAccess).toHaveBeenCalledWith(expect.objectContaining({ action: 'operator.seed.synthetic', orgId: org.id }));
    expect(demo.seedPartnerDemoCases).toHaveBeenCalledWith(expect.objectContaining({ orgId: org.id }));
    expect(out.join('\n')).toContain('demo referrals created=3 existing=0 in_progress_assignee=no_active_user');

    const contents = await readFile(linkFile, 'utf8');
    const tokens = contents.match(/srpe_[A-Za-z0-9_-]{43}/g) ?? [];
    expect(tokens).toHaveLength(SYNTHETIC_PARTNER_USERS.length);
    expect((await stat(linkFile)).mode & 0o777).toBe(0o600);
    const printed = [...out, ...err].join('\n');
    for (const token of tokens) expect(printed).not.toContain(token);
  });

  it('skips users that already exist and does not re-register the operator', async () => {
    repo.countPartnerOperators.mockResolvedValue(2);
    repo.getPartnerOrgByStableId.mockResolvedValue(org);
    repo.findPartnerUserByEmail.mockResolvedValue({ id: 'existing' });
    const code = await runPartnerSyntheticSeed(['--confirm-synthetic', '--link-file', join(dir, 'links.txt'), '--operator', 'dev-ops'], io());
    expect(code).toBe(EXIT_OK);
    expect(repo.addPartnerOperator).not.toHaveBeenCalled();
    expect(repo.createPartnerOrg).not.toHaveBeenCalled();
    expect(repo.invitePartnerUser).not.toHaveBeenCalled();
    expect(repo.setPartnerOrgIntake.mock.calls[0][0].context.operatorRef).toBe('dev-ops');
  });

  it('removes the link file when seeding fails', async () => {
    repo.setPartnerOrgIntake.mockRejectedValue(new Error('synthetic failure'));
    const linkFile = join(dir, 'links.txt');
    expect(await runPartnerSyntheticSeed(['--confirm-synthetic', '--link-file', linkFile], io())).toBe(EXIT_FAILED);
    await expect(stat(linkFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('synthetic demo referrals', () => {
  it('are valid escalation and referral workflows the partner view can show, and plainly synthetic', async () => {
    const { demoEscalationWorkflow, demoReferralWorkflow } = await import('../partnerDemoCases.js');
    const { buildPartnerCaseView } = await import('../../services/partnerCaseView.js');
    const urgent = buildPartnerCaseView({ workflow: demoEscalationWorkflow('2026-10-22T08:00:00.000Z', 'urgent') });
    expect(urgent.kind).toBe('escalation');
    expect(buildPartnerCaseView({ workflow: demoEscalationWorkflow('2026-10-22T08:00:00.000Z', 'in_progress') }).kind).toBe('escalation');
    expect(buildPartnerCaseView({ workflow: demoReferralWorkflow() })).toMatchObject({ kind: 'referral', channel: 'whatsapp' });
    expect(JSON.stringify(urgent)).toContain('SYNTHETIC DEMO ONLY');
    expect(JSON.stringify(urgent)).not.toContain('ke-coast-huria');
  });
});
