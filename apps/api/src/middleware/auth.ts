import { FastifyReply, FastifyRequest } from 'fastify';
import { jwtVerify } from 'jose';

import { env } from '../config/env.js';
import { unauthorized } from '../http/errors.js';
import { query } from '../plugins/db.js';
import { looksLikePartnerToken } from '../services/partnerTokens.js';

export type AuthContext = {
  userId: string;
  email?: string;
  role?: string;
};

const jwtSecret = new TextEncoder().encode(env.authJwtSecret);

export async function verifyBearerToken(token: string): Promise<AuthContext> {
  // Partner-realm tokens are never survivor credentials, whatever they contain.
  if (looksLikePartnerToken(token)) throw unauthorized('Invalid or expired token');
  const { payload } = await jwtVerify(token, jwtSecret);
  const userId = typeof payload.sub === 'string' ? payload.sub : null;
  if (!userId) {
    throw unauthorized('JWT is missing a subject');
  }

  return {
    userId,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    role: typeof payload.role === 'string' ? payload.role : undefined,
  };
}

export async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw unauthorized();
  }

  const token = header.slice('Bearer '.length).trim();
  try {
    const auth = await verifyBearerToken(token);
    (request as FastifyRequest & { auth: AuthContext }).auth = auth;
    await ensureProfile(auth);
  } catch (error) {
    if (error instanceof Error && error.name === 'AppError') throw error;
    request.log.warn({ err: error }, 'JWT verification failed');
    throw unauthorized('Invalid or expired token');
  }
}

export function getAuth(request: FastifyRequest): AuthContext {
  const auth = (request as FastifyRequest & { auth?: AuthContext }).auth;
  if (!auth) throw unauthorized();
  return auth;
}

async function ensureProfile(auth: AuthContext): Promise<void> {
  await query(
    `
      insert into saferide.profiles (id, email, role)
      values ($1, $2, coalesce($3, 'survivor'))
      on conflict (id) do update
      set email = coalesce(excluded.email, saferide.profiles.email),
          updated_at = now()
    `,
    [auth.userId, auth.email ?? null, auth.role ?? null],
  );
}
