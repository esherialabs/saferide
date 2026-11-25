/**
 * Synthetic partner seed for local development and tests ONLY.
 *
 *   node dist/jobs/partnerSyntheticSeed.js --confirm-synthetic --link-file <new file> [--operator <handle>]
 *
 * Creates the synthetic `test-partner` organisation (never a real partner's
 * stable id such as `ke-coast-huria`), a synthetic agreement, intake on, and
 * fake users at example.invalid. It refuses NODE_ENV=production and runs
 * only when APP_ENV is explicitly `test` or `development`: the API's default
 * (`local`, when APP_ENV is unset) and the live stack's `staging` are both
 * refused. Enrolment links go only to a new 0600 file.
 *
 * It also seeds three synthetic demo referrals for test-partner
 * (jobs/partnerDemoCases.ts): an urgent new escalation, an assigned
 * in-progress escalation with a police onward referral, and an unassigned
 * referral. Run it again after a test-partner user enrols to put that user
 * in charge of the in-progress one.
 */
import { randomUUID } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { env } from '../config/env.js';
import { closeDb } from '../plugins/db.js';
import {
  OPERATOR_HANDLE_PATTERN,
  addPartnerOperator,
  countPartnerOperators,
  createPartnerOrg,
  findPartnerUserByEmail,
  getPartnerOrgByStableId,
  invitePartnerUser,
  recordPartnerAccess,
  setPartnerOrgAgreement,
  setPartnerOrgIntake,
  type OperatorContext,
  type PartnerRole,
} from '../repositories/partnerRepository.js';
import { generatePartnerToken, hashPartnerToken } from '../services/partnerTokens.js';
import { seedPartnerDemoCases } from './partnerDemoCases.js';
import {
  ENROLLMENT_TTL_MS,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  maskEmail,
  resolvePrivateOutputPath,
  type PartnerAdminIo,
} from './partnerAdmin.js';

export const SYNTHETIC_ORG_STABLE_ID = 'test-partner';
export const SYNTHETIC_OPERATOR = 'synthetic-seed';
const SYNTHETIC_AGREEMENT_REF = 'SYNTHETIC-TEST-ONLY-NOT-A-DPA';

export const SYNTHETIC_PARTNER_USERS: ReadonlyArray<{ email: string; displayName: string; role: PartnerRole }> = [
  { email: 'partner.admin@example.invalid', displayName: 'Synthetic partner admin (test)', role: 'partner_admin' },
  { email: 'partner.caseworker@example.invalid', displayName: 'Synthetic caseworker (test)', role: 'partner_caseworker' },
  { email: 'partner.caseworker2@example.invalid', displayName: 'Synthetic caseworker 2 (test)', role: 'partner_caseworker' },
];

const ALLOWED_APP_ENVIRONMENTS = new Set(['development', 'test']);

/** `rawAppEnv` is process.env.APP_ENV as given, so the parsed default cannot pass. */
export function syntheticSeedRefusal(environment: { nodeEnv: string; rawAppEnv: string | undefined }): string | null {
  if (environment.nodeEnv === 'production') return 'refusing to seed synthetic partner data with NODE_ENV=production';
  const appEnv = environment.rawAppEnv?.trim();
  if (!appEnv) return 'refusing to seed synthetic partner data: set APP_ENV=test or APP_ENV=development explicitly';
  if (!ALLOWED_APP_ENVIRONMENTS.has(appEnv)) {
    return `refusing to seed synthetic partner data with APP_ENV=${appEnv}`;
  }
  return null;
}

export async function runPartnerSyntheticSeed(argv: string[], io: PartnerAdminIo): Promise<number> {
  let values: { 'confirm-synthetic'?: boolean; 'link-file'?: string; operator?: string };
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      options: {
        'confirm-synthetic': { type: 'boolean' },
        'link-file': { type: 'string' },
        operator: { type: 'string' },
      },
    }));
  } catch {
    io.stderr('error: usage: partnerSyntheticSeed --confirm-synthetic --link-file <new file> [--operator <handle>]');
    return EXIT_USAGE;
  }
  const refusal = syntheticSeedRefusal({ nodeEnv: env.nodeEnv, rawAppEnv: process.env.APP_ENV });
  if (refusal) {
    io.stderr(`error: ${refusal}`);
    return EXIT_USAGE;
  }
  if (!values['confirm-synthetic'] || !values['link-file']) {
    io.stderr('error: pass --confirm-synthetic and --link-file <new file>');
    return EXIT_USAGE;
  }
  const operatorRef = values.operator ?? SYNTHETIC_OPERATOR;
  if (!OPERATOR_HANDLE_PATTERN.test(operatorRef)) {
    io.stderr('error: invalid --operator');
    return EXIT_USAGE;
  }

  let linkPath: string;
  let handle;
  try {
    linkPath = resolvePrivateOutputPath(values['link-file']);
    handle = await open(linkPath, 'wx', 0o600);
  } catch {
    io.stderr('error: the link file must be a new path under the temp directory');
    return EXIT_USAGE;
  }

  const context: OperatorContext = { operatorRef, requestId: `seed-${randomUUID()}` };
  const now = io.now?.() ?? new Date();
  const links: string[] = [];
  try {
    if (await countPartnerOperators() === 0) {
      await addPartnerOperator({
        handle: operatorRef,
        displayName: 'Synthetic seed operator (test)',
        roleLabel: 'Synthetic test data',
        bootstrap: true,
        context,
      });
    }
    let org = await getPartnerOrgByStableId(SYNTHETIC_ORG_STABLE_ID);
    if (!org) {
      org = await createPartnerOrg({
        stableId: SYNTHETIC_ORG_STABLE_ID,
        displayName: 'Test partner (synthetic)',
        context,
      });
    }
    await setPartnerOrgAgreement({
      stableId: SYNTHETIC_ORG_STABLE_ID,
      agreementRef: SYNTHETIC_AGREEMENT_REF,
      signedAt: new Date(now.getTime() - 60_000),
      expiresAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
      context,
    });
    await setPartnerOrgIntake({ stableId: SYNTHETIC_ORG_STABLE_ID, enabled: true, context });

    let created = 0;
    for (const user of SYNTHETIC_PARTNER_USERS) {
      if (await findPartnerUserByEmail(user.email)) continue;
      const token = generatePartnerToken('enrollment');
      await invitePartnerUser({
        orgStableId: SYNTHETIC_ORG_STABLE_ID,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        enrollmentTokenHash: hashPartnerToken(token),
        enrollmentExpiresAt: new Date(now.getTime() + ENROLLMENT_TTL_MS),
        context,
      });
      const link = env.partnerPublicOrigin ? `${env.partnerPublicOrigin}/enroll#token=${token}` : `token=${token}`;
      links.push(`# ${user.email} (${user.role})`, link);
      created += 1;
    }
    const demo = await seedPartnerDemoCases({ orgId: org.id, now });
    await recordPartnerAccess({
      orgId: org.id,
      actor: { type: 'operator', operatorRef },
      action: 'operator.seed.synthetic',
      outcome: 'success',
      requestId: context.requestId,
    });
    await handle.writeFile(['# SYNTHETIC TEST DATA ONLY. One-time enrolment links.', ...links, ''].join('\n'), 'utf8');
    await handle.close();
    io.stdout(`ok synthetic seed org=${SYNTHETIC_ORG_STABLE_ID} intake=on users_created=${created} users_existing=${SYNTHETIC_PARTNER_USERS.length - created}`);
    for (const user of SYNTHETIC_PARTNER_USERS) io.stdout(`  ${maskEmail(user.email)} ${user.role}`);
    io.stdout(`demo referrals created=${demo.created.length} existing=${demo.existing.length} in_progress_assignee=${demo.assignment}`);
    if (demo.assignment === 'no_active_user') {
      io.stdout('  no active test-partner user yet: run the seed again after one enrols to assign the in-progress referral');
    }
    io.stdout(`enrolment links for new users written to ${linkPath} (mode 0600); they are not shown here`);
    return EXIT_OK;
  } catch {
    await handle.close().catch(() => undefined);
    await unlink(linkPath).catch(() => undefined);
    io.stderr(`failed: synthetic seed did not complete (request ${context.requestId})`);
    return EXIT_FAILED;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const exitCode = await runPartnerSyntheticSeed(process.argv.slice(2), {
    stdout: line => process.stdout.write(`${line}\n`),
    stderr: line => process.stderr.write(`${line}\n`),
  });
  await closeDb();
  process.exitCode = exitCode;
}
