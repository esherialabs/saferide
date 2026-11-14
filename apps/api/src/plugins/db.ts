import { Pool, QueryResult, QueryResultRow } from 'pg';

import { env } from '../config/env.js';

export const pool = new Pool({
  connectionString: env.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
});

/**
 * Bounds for partner sign-in statements. The reservations run while a
 * partner auth gate slot is held (services/partnerAuthGate.ts), so a
 * stalled or locked database must give the slot back within seconds
 * rather than hold it, and with it every queued sign-in, indefinitely.
 * Worst case for one reservation: connectMs waiting for a connection, then
 * queryMs for the statement that stalls (statement_timeout fires first on a
 * live server, including while waiting for a row lock; query_timeout covers
 * a server that stops answering).
 */
export const PARTNER_AUTH_DB_TIMEOUTS = {
  connectMs: 2_000,
  statementMs: 2_000,
  queryMs: 2_500,
  idleInTransactionMs: 5_000,
} as const;

/**
 * A separate small pool for partner sign-in, so its timeouts apply only to
 * those statements and a partner flood cannot take the survivor pool's
 * connections.
 */
export const partnerAuthPool = new Pool({
  connectionString: env.databaseUrl,
  max: 4,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: PARTNER_AUTH_DB_TIMEOUTS.connectMs,
  statement_timeout: PARTNER_AUTH_DB_TIMEOUTS.statementMs,
  query_timeout: PARTNER_AUTH_DB_TIMEOUTS.queryMs,
  idle_in_transaction_session_timeout: PARTNER_AUTH_DB_TIMEOUTS.idleInTransactionMs,
});

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<QueryResult<T>> {
  return pool.query<T>(text, values);
}

export async function closeDb(): Promise<void> {
  await Promise.all([pool.end(), partnerAuthPool.end()]);
}
