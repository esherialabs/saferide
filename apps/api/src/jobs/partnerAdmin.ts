/**
 * Partner dashboard operator CLI (phase 1 administration is CLI-only).
 *
 *   docker compose -p "$SAFERIDE_PROJECT" exec api \
 *     node dist/jobs/partnerAdmin.js <command> --operator <handle> [flags]
 *
 * Privileges: it runs inside the API container with the API's own database
 * role and settings. Anyone who can `docker compose exec` into the API can
 * run it, and --operator is recorded in the audit but not authenticated, so
 * host access to the API container is the real control.
 *
 * First use: register yourself once with
 *   operator:add --bootstrap --operator <you> --handle <you> --name ... --role-label ...
 * --bootstrap is refused as soon as any operator exists.
 *
 * Secrets: enrolment links (and audit exports) are written only to a NEW
 * 0600 file under the container's /tmp, which on the selfhost stack is an
 * in-memory tmpfs: they never reach a disk or volume and vanish on restart.
 * Read and delete one in a single step, then deliver it privately:
 *   docker compose -p "$SAFERIDE_PROJECT" exec api sh -c 'cat /tmp/invite-x.txt && rm /tmp/invite-x.txt'
 * Every command names a registered, active operator and is audited in
 * partner_access_audit; links are never printed.
 *
 * Passwords (owner decision, October 2026): `user:set-password --generate`
 * creates a strong random password for an existing user (activating an
 * invited one), writes it ONLY to a new 0600 file under /tmp like an
 * enrolment link, and sets must_change_password, so the person chooses
 * their own at first sign-in. It never takes a password on the command
 * line and never prints one. `org:mfa --state off` lets such users sign in
 * with the password alone; `--state required` (the default for every org)
 * brings the TOTP step back, and users without an authenticator set one up
 * at their next sign-in.
 *
 * Referrals: referral:list prints metadata only (reference, pathway, status,
 * whether access was withdrawn or revoked, and dates), never case content,
 * survivor, case or consent ids, callback numbers or notes. referral:revoke
 * is a safeguarding kill switch for one referral; it takes a reason code and
 * no free text. Without --yes it only shows the referral's org and state
 * (exit 3, nothing changed); --org, when given, must be the referral's org. There is no command that shares a case with an org: sharing
 * stays survivor-initiated and consented.
 */
import { randomUUID } from 'node:crypto';
import { open, unlink, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { relative, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { z } from 'zod';

import { env } from '../config/env.js';
import { closeDb } from '../plugins/db.js';
import {
  OPERATOR_HANDLE_PATTERN,
  PARTNER_OPERATOR_REFERRAL_FILTERS,
  PARTNER_OPERATOR_REVOKE_REASONS,
  PARTNER_ROLES,
  PARTNER_STABLE_ID_PATTERN,
  PartnerAdminError,
  addPartnerOperator,
  createPartnerOrg,
  disablePartnerOperator,
  disablePartnerUser,
  exportPartnerAudit,
  invitePartnerUser,
  listPartnerReferralsForOperator,
  looksLikeUuid,
  recordPartnerAccess,
  resetPartnerUserEnrollment,
  revokePartnerReferralByOperator,
  revokePartnerSessions,
  setPartnerOrgAgreement,
  setPartnerOrgIntake,
  setPartnerOrgMfa,
  setPartnerUserPassword,
  type OperatorContext,
  type PartnerAuditAction,
} from '../repositories/partnerRepository.js';
import { generatePartnerPassword, hashPartnerPassword } from '../services/partnerCredentials.js';
import { PARTNER_REFERENCE_PATTERN, generatePartnerToken, hashPartnerToken } from '../services/partnerTokens.js';

export const ENROLLMENT_TTL_MS = 24 * 60 * 60 * 1000;
export const REFERRAL_LIST_LIMIT = { default: 50, max: 200 } as const;

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_REFUSED = 3;

export type PartnerAdminIo = {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  now?: () => Date;
};

class UsageError extends Error {}

const USAGE = `usage: partnerAdmin <command> --operator <handle> [flags]
  operator:add      --handle <h> --name <display name> --role-label <label> [--bootstrap]
  operator:disable  --handle <h>
  org:create        --stable-id <id> --name <display name>
  org:set-agreement --org <id> --ref <agreement ref> --signed-at <ISO> --expires-at <ISO>
  org:intake        --org <id> --state on|off
  org:mfa           --org <stable id|id> --state required|off
                    (off: a correct password signs in without an authenticator; keep it required once intake is on)
  user:invite       --org <id> --email <email> --name <display name> --role partner_admin|partner_caseworker --link-file <new file>
  user:disable      --email <email>
  user:reset        --email <email> --link-file <new file>
  user:set-password --email <email> --generate --out-file <new file>
                    (a random password, written only to the file; the user must change it at first sign-in)
  sessions:revoke   --email <email> | --org <id>
  audit:export      --org <id> --since <ISO> [--until <ISO>] --out-file <new file>
  referral:list     --org <stable id|id> [--status ${PARTNER_OPERATOR_REFERRAL_FILTERS.join('|')}] [--limit 1-${REFERRAL_LIST_LIMIT.max}]
  referral:revoke   --reference SR-XXXX-XXXX --reason ${PARTNER_OPERATOR_REVOKE_REASONS.join('|')} [--org <stable id|id>] [--yes]
                    (without --yes: shows the referral's org and state and changes nothing)
Output files must be new paths under ${tmpdir()} (in-memory tmpfs in the API container).
The first operator registers themselves once: operator:add --bootstrap --operator <h> --handle <h> ...`;

const FLAG_NAMES = [
  'operator', 'handle', 'name', 'role-label', 'stable-id', 'org', 'ref', 'signed-at', 'expires-at',
  'state', 'email', 'role', 'link-file', 'since', 'until', 'out-file', 'status', 'limit', 'reference', 'reason',
] as const;
type Flags = Partial<Record<(typeof FLAG_NAMES)[number], string>> & { bootstrap?: boolean; yes?: boolean; generate?: boolean };

const handleSchema = z.string().regex(OPERATOR_HANDLE_PATTERN, 'must be a lowercase operator handle');
const stableIdSchema = z.string().min(3).max(80).regex(PARTNER_STABLE_ID_PATTERN, 'must be a lowercase stable id');
// A new stable id must not look like a UUID, so --org can take a stable id or an id unambiguously.
const newStableIdSchema = stableIdSchema.refine(value => !looksLikeUuid(value), 'must not look like a UUID');
const nameSchema = z.string().trim().min(1).max(120);
const emailSchema = z.string().trim().toLowerCase().email().max(254);
const isoDateSchema = z.string().datetime({ offset: true }).or(z.string().date()).transform(value => new Date(value));
const pathSchema = z.string().min(1).max(4096);
const orgRefSchema = z.string().refine(
  value => stableIdSchema.safeParse(value).success || z.string().uuid().safeParse(value).success,
  'must be an organisation stable id or id',
);
const referenceSchema = z.string().trim().toUpperCase().regex(PARTNER_REFERENCE_PATTERN, 'must look like SR-XXXX-XXXX');
const limitSchema = z.string().regex(/^\d{1,4}$/, 'must be a whole number').transform(Number)
  .pipe(z.number().int().min(1).max(REFERRAL_LIST_LIMIT.max));

function required<T>(flags: Flags, name: keyof Flags, schema: z.ZodType<T, unknown>): T {
  const value = flags[name];
  if (value === undefined) throw new UsageError(`missing --${name}`);
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new UsageError(`invalid --${name}: ${parsed.error.issues[0]?.message ?? 'invalid value'}`);
  return parsed.data;
}

function onlyFlags(flags: Flags, allowed: Array<keyof Flags>): void {
  const extra = Object.keys(flags).filter(name => name !== 'operator' && !allowed.includes(name as keyof Flags));
  if (extra.length > 0) throw new UsageError(`unexpected flag --${extra[0]}`);
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 1)}***@${domain ?? ''}`;
}

/** Output files must live under the temp dir (the API container's tmpfs), never a volume. */
export function resolvePrivateOutputPath(path: string): string {
  const absolute = resolve(path);
  const inside = relative(resolve(tmpdir()), absolute);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) {
    throw new UsageError(`output files must be new paths under ${tmpdir()}`);
  }
  return absolute;
}

/** Opens a brand-new file readable only by the current user; refuses to overwrite. */
async function createPrivateFile(path: string): Promise<{ handle: FileHandle; path: string }> {
  const absolute = resolvePrivateOutputPath(path);
  try {
    return { handle: await open(absolute, 'wx', 0o600), path: absolute };
  } catch (error) {
    const code = (error as { code?: string }).code;
    throw new UsageError(code === 'EEXIST' ? 'output file already exists; choose a new path' : 'cannot create the output file');
  }
}

async function discardPrivateFile(file: { handle: FileHandle; path: string }): Promise<void> {
  await file.handle.close().catch(() => undefined);
  await unlink(file.path).catch(() => undefined);
}

function enrollmentLink(token: string): string {
  return env.partnerPublicOrigin ? `${env.partnerPublicOrigin}/enroll#token=${token}` : `token=${token}`;
}

async function withEnrollmentLinkFile<T>(
  linkFile: string,
  now: Date,
  work: (tokenHash: string, expiresAt: Date) => Promise<T>,
  describe: (result: T) => string,
): Promise<{ result: T; path: string; expiresAt: Date }> {
  const file = await createPrivateFile(linkFile);
  const token = generatePartnerToken('enrollment');
  const expiresAt = new Date(now.getTime() + ENROLLMENT_TTL_MS);
  let result: T;
  try {
    result = await work(hashPartnerToken(token), expiresAt);
  } catch (error) {
    await discardPrivateFile(file);
    throw error;
  }
  await file.handle.writeFile([
    '# SafeRide partner dashboard enrolment link: one use only.',
    `# For ${describe(result)}; expires ${expiresAt.toISOString()}.`,
    '# Deliver over an approved private channel, then delete this file.',
    enrollmentLink(token),
    '',
  ].join('\n'), 'utf8');
  await file.handle.close();
  return { result, path: file.path, expiresAt };
}

const COMMAND_ACTIONS: Record<string, PartnerAuditAction> = {
  'operator:add': 'operator.operator.add',
  'operator:disable': 'operator.operator.disable',
  'org:create': 'operator.org.create',
  'org:set-agreement': 'operator.org.set_agreement',
  'org:intake': 'operator.org.intake',
  'user:invite': 'operator.user.invite',
  'user:disable': 'operator.user.disable',
  'user:reset': 'operator.user.reset',
  'sessions:revoke': 'operator.sessions.revoke',
  'audit:export': 'operator.audit.export',
  'referral:list': 'operator.referral.list',
  'referral:revoke': 'operator.referral.revoke',
  'org:mfa': 'operator.org.mfa',
  'user:set-password': 'operator.user.set_password',
};

/** Resolves with an exit code only when a command ends without acting (referral:revoke without --yes). */
async function runCommand(command: string, flags: Flags, context: OperatorContext, io: PartnerAdminIo): Promise<number | void> {
  const now = io.now?.() ?? new Date();
  switch (command) {
    case 'operator:add': {
      onlyFlags(flags, ['handle', 'name', 'role-label', 'bootstrap']);
      const operator = await addPartnerOperator({
        handle: required(flags, 'handle', handleSchema),
        displayName: required(flags, 'name', nameSchema),
        roleLabel: required(flags, 'role-label', nameSchema),
        bootstrap: flags.bootstrap === true,
        context,
      });
      io.stdout(`ok operator:add handle=${operator.handle} status=${operator.status}`);
      return;
    }
    case 'operator:disable': {
      onlyFlags(flags, ['handle']);
      const operator = await disablePartnerOperator({ handle: required(flags, 'handle', handleSchema), context });
      io.stdout(`ok operator:disable handle=${operator.handle} status=${operator.status}`);
      return;
    }
    case 'org:create': {
      onlyFlags(flags, ['stable-id', 'name']);
      const org = await createPartnerOrg({
        stableId: required(flags, 'stable-id', newStableIdSchema),
        displayName: required(flags, 'name', nameSchema),
        context,
      });
      io.stdout(`ok org:create stable_id=${org.stableId} id=${org.id} status=${org.status} intake=off`);
      return;
    }
    case 'org:set-agreement': {
      onlyFlags(flags, ['org', 'ref', 'signed-at', 'expires-at']);
      const signedAt = required(flags, 'signed-at', isoDateSchema);
      const expiresAt = required(flags, 'expires-at', isoDateSchema);
      if (expiresAt <= signedAt) throw new UsageError('--expires-at must be after --signed-at');
      const org = await setPartnerOrgAgreement({
        stableId: required(flags, 'org', stableIdSchema),
        agreementRef: required(flags, 'ref', z.string().trim().min(1).max(160)),
        signedAt,
        expiresAt,
        context,
      });
      io.stdout(`ok org:set-agreement stable_id=${org.stableId} expires=${org.agreementExpiresAt?.toISOString()}`);
      return;
    }
    case 'org:intake': {
      onlyFlags(flags, ['org', 'state']);
      const state = required(flags, 'state', z.enum(['on', 'off']));
      const org = await setPartnerOrgIntake({
        stableId: required(flags, 'org', stableIdSchema),
        enabled: state === 'on',
        context,
      });
      io.stdout(`ok org:intake stable_id=${org.stableId} intake=${org.intakeEnabled ? 'on' : 'off'}`);
      return;
    }
    case 'user:invite': {
      onlyFlags(flags, ['org', 'email', 'name', 'role', 'link-file']);
      const orgStableId = required(flags, 'org', stableIdSchema);
      const email = required(flags, 'email', emailSchema);
      const displayName = required(flags, 'name', nameSchema);
      const role = required(flags, 'role', z.enum(PARTNER_ROLES));
      const linkFile = required(flags, 'link-file', pathSchema);
      const { result: user, path, expiresAt } = await withEnrollmentLinkFile(
        linkFile, now,
        (enrollmentTokenHash, enrollmentExpiresAt) => invitePartnerUser({
          orgStableId, email, displayName, role, enrollmentTokenHash, enrollmentExpiresAt, context,
        }),
        invited => `${maskEmail(invited.email)} (${invited.role})`,
      );
      io.stdout(`ok user:invite id=${user.id} email=${maskEmail(user.email)} role=${user.role} org=${orgStableId} status=${user.status}`);
      io.stdout(`enrolment link written to ${path} (mode 0600, expires ${expiresAt.toISOString()}); it is not shown here`);
      return;
    }
    case 'org:mfa': {
      onlyFlags(flags, ['org', 'state']);
      const state = required(flags, 'state', z.enum(['required', 'off']));
      const result = await setPartnerOrgMfa({ org: required(flags, 'org', orgRefSchema), required: state === 'required', context });
      io.stdout(`ok org:mfa stable_id=${result.org.stableId} mfa=${state} changed=${result.changed ? 'yes' : 'no'} revoked_password_only_sessions=${result.revokedSessions}`);
      if (state === 'required' && result.usersWithoutTotp > 0) {
        io.stdout(`note: ${result.usersWithoutTotp} active user(s) have no authenticator yet; they will set one up at their next sign-in`);
      }
      if (state === 'off' && result.org.intakeEnabled) {
        io.stdout('warning: intake is on for this org; SafeRide recommends MFA required before real survivor cases flow');
      }
      return;
    }
    case 'user:set-password': {
      onlyFlags(flags, ['email', 'generate', 'out-file']);
      if (flags.generate !== true) {
        throw new UsageError('give --generate: passwords are only generated, never typed on the command line');
      }
      const email = required(flags, 'email', emailSchema);
      const file = await createPrivateFile(required(flags, 'out-file', pathSchema));
      let result: Awaited<ReturnType<typeof setPartnerUserPassword>>;
      try {
        const password = generatePartnerPassword(email);
        // The file is complete before anything is committed: a failed write changes nothing.
        await file.handle.writeFile([
          '# SafeRide partner dashboard password, issued by an operator.',
          `# For ${maskEmail(email)}. They must choose a new one at first sign-in.`,
          '# Hand it over in person or over an approved private channel, then delete this file.',
          password,
          '',
        ].join('\n'), 'utf8');
        await file.handle.close();
        result = await setPartnerUserPassword({ email, passwordHash: await hashPartnerPassword(password), context });
      } catch (error) {
        await discardPrivateFile(file);
        throw error;
      }
      io.stdout(`ok user:set-password id=${result.user.id} email=${maskEmail(result.user.email)} status=${result.user.status} must_change_password=yes revoked_sessions=${result.revokedSessions}${result.wasInvited ? ' activated=yes' : ''}`);
      io.stdout(`password written to ${file.path} (mode 0600); it is not shown here`);
      io.stdout(result.orgMfaRequired
        ? 'note: this org requires MFA: at first sign-in the user also sets up an authenticator app'
        : 'note: this org has MFA off: the password alone signs in');
      return;
    }
    case 'user:disable': {
      onlyFlags(flags, ['email']);
      const { user, revokedSessions, releasedAssignments } = await disablePartnerUser({ email: required(flags, 'email', emailSchema), context });
      io.stdout(`ok user:disable id=${user.id} email=${maskEmail(user.email)} status=${user.status} revoked_sessions=${revokedSessions} released_referrals=${releasedAssignments ?? 0}`);
      return;
    }
    case 'user:reset': {
      onlyFlags(flags, ['email', 'link-file']);
      const email = required(flags, 'email', emailSchema);
      const linkFile = required(flags, 'link-file', pathSchema);
      const { result, path, expiresAt } = await withEnrollmentLinkFile(
        linkFile, now,
        (enrollmentTokenHash, enrollmentExpiresAt) => resetPartnerUserEnrollment({
          email, enrollmentTokenHash, enrollmentExpiresAt, context,
        }),
        reset => `${maskEmail(reset.user.email)} (${reset.user.role}, re-enrolment)`,
      );
      io.stdout(`ok user:reset id=${result.user.id} email=${maskEmail(result.user.email)} status=${result.user.status} revoked_sessions=${result.revokedSessions} released_referrals=${result.releasedAssignments ?? 0}`);
      io.stdout(`enrolment link written to ${path} (mode 0600, expires ${expiresAt.toISOString()}); it is not shown here`);
      return;
    }
    case 'sessions:revoke': {
      onlyFlags(flags, ['email', 'org']);
      if ((flags.email === undefined) === (flags.org === undefined)) throw new UsageError('give exactly one of --email or --org');
      const target = flags.email !== undefined
        ? { email: required(flags, 'email', emailSchema) }
        : { orgStableId: required(flags, 'org', stableIdSchema) };
      const revoked = await revokePartnerSessions({ target, context });
      io.stdout(`ok sessions:revoke revoked_sessions=${revoked}`);
      return;
    }
    case 'audit:export': {
      onlyFlags(flags, ['org', 'since', 'until', 'out-file']);
      const since = required(flags, 'since', isoDateSchema);
      const until = flags.until === undefined ? now : required(flags, 'until', isoDateSchema);
      if (until <= since) throw new UsageError('--until must be after --since');
      const orgStableId = required(flags, 'org', stableIdSchema);
      const file = await createPrivateFile(required(flags, 'out-file', pathSchema));
      let rows;
      try {
        rows = await exportPartnerAudit({ orgStableId, since, until, context });
      } catch (error) {
        await discardPrivateFile(file);
        throw error;
      }
      await file.handle.writeFile(rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
      await file.handle.close();
      io.stdout(`ok audit:export rows=${rows.length} written to ${file.path} (mode 0600)`);
      return;
    }
    case 'referral:list': {
      onlyFlags(flags, ['org', 'status', 'limit']);
      const org = required(flags, 'org', orgRefSchema);
      const status = flags.status === undefined ? undefined : required(flags, 'status', z.enum(PARTNER_OPERATOR_REFERRAL_FILTERS));
      const limit = flags.limit === undefined ? REFERRAL_LIST_LIMIT.default : required(flags, 'limit', limitSchema);
      const page = await listPartnerReferralsForOperator({ org, status, limit, context });
      io.stdout(`ok referral:list org=${page.org.stableId} shown=${page.rows.length} more=${page.more ? 'yes' : 'no'}`);
      // Metadata only: the row type carries nothing else to print.
      for (const row of page.rows) {
        io.stdout([
          `reference=${row.reference}`,
          `pathway=${row.pathway ?? 'unknown'}`,
          `status=${row.status}`,
          `access=${row.access}`,
          `received=${row.receivedAt.toISOString()}`,
          `status_changed=${row.statusChangedAt.toISOString()}`,
        ].join(' '));
      }
      return;
    }
    case 'referral:revoke': {
      onlyFlags(flags, ['reference', 'reason', 'org', 'yes']);
      const reference = required(flags, 'reference', referenceSchema);
      const reason = required(flags, 'reason', z.enum(PARTNER_OPERATOR_REVOKE_REASONS));
      const org = flags.org === undefined ? undefined : required(flags, 'org', orgRefSchema);
      const result = await revokePartnerReferralByOperator({ reference, reason, org, confirm: flags.yes === true, context });
      if (!result.confirmed) {
        io.stdout(`check referral:revoke reference=${result.reference} org=${result.orgStableId} status=${result.status} access=${result.access} reason=${reason}`);
        io.stdout('not revoked: if that is the right referral and org, rerun with --yes');
        return EXIT_REFUSED;
      }
      io.stdout(`ok referral:revoke reference=${result.reference} org=${result.orgStableId} reason=${reason} state=${
        result.alreadyRevoked ? 'already_revoked' : 'revoked'} revoked_at=${result.revokedAt.toISOString()}`);
      io.stdout(result.alreadyRevoked
        ? 'partner access had already ended; nothing changed'
        : 'partner access ended: tombstone and 410 from now; callback and partner notes deleted; the survivor sees a status update');
      if (reason === 'partner_compromise') {
        // A hint only: ending every session of the org is a separate, deliberate command.
        io.stdout(`hint: partner_compromise: also end the org's partner sessions with sessions:revoke --operator <handle> --org ${result.orgStableId}`);
      }
      return;
    }
    default:
      throw new UsageError(`unknown command ${command}`);
  }
}

export async function runPartnerAdmin(argv: string[], io: PartnerAdminIo): Promise<number> {
  let command: string | undefined;
  let flags: Flags;
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        ...Object.fromEntries(FLAG_NAMES.map(name => [name, { type: 'string' as const }])),
        bootstrap: { type: 'boolean' as const },
        generate: { type: 'boolean' as const },
        yes: { type: 'boolean' as const },
      },
    });
    if (parsed.positionals.length !== 1) throw new UsageError('give exactly one command');
    command = parsed.positionals[0];
    flags = parsed.values as Flags;
    if (!(command in COMMAND_ACTIONS)) throw new UsageError(`unknown command ${command}`);
  } catch (error) {
    io.stderr(`error: ${error instanceof UsageError ? error.message : 'invalid arguments'}`);
    io.stderr(USAGE);
    return EXIT_USAGE;
  }

  let context: OperatorContext;
  try {
    context = { operatorRef: required(flags, 'operator', handleSchema), requestId: `cli-${randomUUID()}` };
  } catch (error) {
    io.stderr(`error: ${(error as Error).message}`);
    return EXIT_USAGE;
  }

  try {
    return (await runCommand(command, flags, context, io)) ?? EXIT_OK;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`error: ${error.message}`);
      return EXIT_USAGE;
    }
    const refused = error instanceof PartnerAdminError;
    try {
      await recordPartnerAccess({
        actor: { type: 'operator', operatorRef: context.operatorRef },
        action: COMMAND_ACTIONS[command],
        outcome: refused ? 'denied' : 'failed',
        requestId: context.requestId,
      });
    } catch {
      io.stderr('warning: the refusal could not be audited');
    }
    if (refused) {
      io.stderr(`refused (${error.code}): ${error.message}; nothing was changed`);
      return EXIT_REFUSED;
    }
    io.stderr(`failed: ${command} did not complete; nothing was committed (request ${context.requestId})`);
    return EXIT_FAILED;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const exitCode = await runPartnerAdmin(process.argv.slice(2), {
    stdout: line => process.stdout.write(`${line}\n`),
    stderr: line => process.stderr.write(`${line}\n`),
  });
  await closeDb();
  process.exitCode = exitCode;
}
