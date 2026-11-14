import { FastifyInstance } from 'fastify';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';

import { env } from '../config/env.js';
import { isPrivacyCapabilityEnabled } from '../config/privacyControls.js';
import { badRequest, forbidden, notImplemented, serviceUnavailable, unauthorized } from '../http/errors.js';
import { query } from '../plugins/db.js';

const scrypt = promisify(scryptCallback);
const jwtSecret = new TextEncoder().encode(env.authJwtSecret);
const ACCESS_TOKEN_SECONDS = 3600;
const REFRESH_TOKEN_SECONDS = 60 * 60 * 24 * 30;

type AuthUserRow = {
  id: string;
  email: string | null;
  password_hash: string | null;
  role: string;
  user_metadata: Record<string, unknown>;
  is_anonymous: boolean;
  created_at: string;
};

const signupSchema = z.object({
  email: z.string().email().optional(),
  password: z.string().min(8).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

const passwordTokenSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const refreshTokenSchema = z.object({
  refresh_token: z.string().min(20),
});

const recoverSchema = z.object({
  email: z.string().email(),
  redirect_to: z.string().optional(),
});

function normalizeEmail(email: string | null | undefined): string | null {
  return email ? email.trim().toLowerCase() : null;
}

export function indicatesMinor(data: Record<string, unknown> | undefined, now = new Date()): boolean {
  if (!data) return false;
  if (data.isMinor === true) return true;
  if (typeof data.age === 'number' && Number.isFinite(data.age) && data.age < 18) return true;
  const birthDate = typeof data.dateOfBirth === 'string'
    ? data.dateOfBirth
    : typeof data.birthDate === 'string'
      ? data.birthDate
      : null;
  if (!birthDate) return false;
  const parsed = new Date(`${birthDate}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  const eighteenthBirthday = new Date(parsed);
  eighteenthBirthday.setUTCFullYear(eighteenthBirthday.getUTCFullYear() + 18);
  return eighteenthBirthday > now;
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${derived.toString('hex')}`;
}

async function verifyPassword(password: string, storedHash: string | null): Promise<boolean> {
  if (!storedHash) return false;
  const [scheme, salt, key] = storedHash.split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(key, 'hex');
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function publicUser(row: AuthUserRow) {
  return {
    id: row.id,
    aud: 'authenticated',
    role: row.role,
    email: row.email ?? undefined,
    app_metadata: {
      provider: 'local',
      is_anonymous: row.is_anonymous,
    },
    user_metadata: row.user_metadata ?? {},
    created_at: row.created_at,
  };
}

async function ensureProfile(row: AuthUserRow): Promise<void> {
  await query(
    `
      insert into saferide.profiles (id, email, role, auth_provider)
      values ($1, $2, coalesce($3, 'survivor'), 'local')
      on conflict (id) do update
      set email = coalesce(excluded.email, saferide.profiles.email),
          role = coalesce(excluded.role, saferide.profiles.role),
          auth_provider = 'local',
          updated_at = now()
    `,
    [row.id, row.email, row.role],
  );
}

async function issueSession(row: AuthUserRow) {
  const expiresAt = Math.floor(Date.now() / 1000) + ACCESS_TOKEN_SECONDS;
  const refreshToken = randomBytes(32).toString('base64url');
  const refreshHash = hashRefreshToken(refreshToken);

  await query(
    `
      update saferide.auth_users
      set refresh_token_hash = $1,
          refresh_token_expires_at = now() + ($2 || ' seconds')::interval
      where id = $3
    `,
    [refreshHash, REFRESH_TOKEN_SECONDS, row.id],
  );
  await ensureProfile(row);

  const accessToken = await new SignJWT({
    email: row.email ?? undefined,
    role: row.role,
    aud: 'authenticated',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(row.id)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(jwtSecret);

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: ACCESS_TOKEN_SECONDS,
    expires_at: expiresAt,
    token_type: 'bearer',
    user: publicUser(row),
  };
}

async function findUserByEmail(email: string): Promise<AuthUserRow | null> {
  const result = await query<AuthUserRow>(
    `
      select id, email, password_hash, role, user_metadata, is_anonymous, created_at
      from saferide.auth_users
      where lower(email) = lower($1)
      limit 1
    `,
    [email],
  );
  return result.rows[0] ?? null;
}

async function findUserByRefreshToken(refreshToken: string): Promise<AuthUserRow | null> {
  const result = await query<AuthUserRow>(
    `
      select id, email, password_hash, role, user_metadata, is_anonymous, created_at
      from saferide.auth_users
      where refresh_token_hash = $1
        and refresh_token_expires_at > now()
      limit 1
    `,
    [hashRefreshToken(refreshToken)],
  );
  return result.rows[0] ?? null;
}

async function findUserByAccessToken(token: string): Promise<AuthUserRow | null> {
  let payload: Awaited<ReturnType<typeof jwtVerify>>['payload'];
  try {
    ({ payload } = await jwtVerify(token, jwtSecret));
  } catch {
    throw unauthorized('Invalid or expired token');
  }

  const userId = typeof payload.sub === 'string' ? payload.sub : null;
  if (!userId) return null;

  const result = await query<AuthUserRow>(
    `
      select id, email, password_hash, role, user_metadata, is_anonymous, created_at
      from saferide.auth_users
      where id = $1
      limit 1
    `,
    [userId],
  );
  return result.rows[0] ?? null;
}

function bearerToken(header: string | undefined): string {
  if (!header?.startsWith('Bearer ')) {
    throw unauthorized();
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) throw unauthorized();
  return token;
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/signup', async request => {
    const parsed = signupSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw badRequest('Invalid signup payload', parsed.error.flatten());
    if (!isPrivacyCapabilityEnabled('submitted_case_ingestion')) {
      throw serviceUnavailable('Remote account creation is disabled while report submission is unavailable', {
        handoffId: 'HANDOFF-PRIVACY-LEGAL-REVIEW',
      });
    }
    if (indicatesMinor(parsed.data.data)) {
      throw forbidden('Processing for minors is unavailable pending legal and safeguarding approval');
    }

    const email = normalizeEmail(parsed.data.email);
    const isAnonymous = !email;
    if (!isAnonymous && !parsed.data.password) {
      throw badRequest('Password is required for email signup');
    }

    const passwordHash = parsed.data.password ? await hashPassword(parsed.data.password) : null;

    try {
      const result = await query<AuthUserRow>(
        `
          insert into saferide.auth_users (email, password_hash, user_metadata, is_anonymous)
          values ($1, $2, $3::jsonb, $4)
          returning id, email, password_hash, role, user_metadata, is_anonymous, created_at
        `,
        [email, passwordHash, JSON.stringify(parsed.data.data ?? {}), isAnonymous],
      );

      return issueSession(result.rows[0]);
    } catch (error: any) {
      if (error?.code === '23505') {
        throw badRequest('An account already exists for this email');
      }
      throw error;
    }
  });

  app.post('/auth/token', async request => {
    const grantType = z
      .object({ grant_type: z.enum(['password', 'refresh_token']) })
      .parse(request.query).grant_type;

    if (grantType === 'refresh_token') {
      const parsed = refreshTokenSchema.safeParse(request.body);
      if (!parsed.success) throw badRequest('Invalid refresh token payload', parsed.error.flatten());
      const user = await findUserByRefreshToken(parsed.data.refresh_token);
      if (!user) throw unauthorized('Invalid or expired token');
      return issueSession(user);
    }

    const parsed = passwordTokenSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid password login payload', parsed.error.flatten());
    const user = await findUserByEmail(parsed.data.email);
    if (!user || !(await verifyPassword(parsed.data.password, user.password_hash))) {
      throw unauthorized('Invalid email or password');
    }
    return issueSession(user);
  });

  app.get('/auth/user', async request => {
    const token = bearerToken(request.headers.authorization);
    const user = await findUserByAccessToken(token);
    if (!user) throw unauthorized('Invalid or expired token');
    return publicUser(user);
  });

  app.post('/auth/recover', async request => {
    const parsed = recoverSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid password recovery payload', parsed.error.flatten());
    throw notImplemented('Password reset is not available in this build');
  });

  app.post('/auth/logout', async request => {
    const token = bearerToken(request.headers.authorization);
    const user = await findUserByAccessToken(token).catch(() => null);
    if (user) {
      await query(
        `
          update saferide.auth_users
          set refresh_token_hash = null,
              refresh_token_expires_at = null
          where id = $1
        `,
        [user.id],
      );
    }
    return {};
  });
}
