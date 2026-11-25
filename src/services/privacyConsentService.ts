import { request, setAuthToken } from '../lib/api/httpClient';
import { authClient } from '../lib/auth/authClient';
import {
  confirmRemoteConsentWithdrawal,
  type ConsentLedgerEntry,
  requiresRemoteWithdrawal,
  withdrawConsent as withdrawLocalConsent,
} from '../utils/consentLedger';

export class RemoteConsentWithdrawalPendingError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super('Local future processing is stopped, but remote withdrawal is not yet confirmed.');
    this.name = 'RemoteConsentWithdrawalPendingError';
    this.cause = cause;
  }
}

async function requireOwnedApiToken(): Promise<void> {
  const { data, error } = await authClient.getSession();
  const token = error ? null : data.session?.access_token ?? null;
  if (!token) throw new Error('User is not authenticated');
  setAuthToken(token);
}

export type ServerConsentRecord = {
  id: string;
  purpose: string;
  status: string;
};

/** GET /api/privacy/consents: the survivor's consent records held by the server. */
export async function listServerConsents(): Promise<ServerConsentRecord[]> {
  await requireOwnedApiToken();
  const result = await request<{ consents?: Array<Record<string, unknown>> }>({ path: '/privacy/consents' });
  return (result?.consents ?? [])
    .filter(row => typeof row.id === 'string' && typeof row.purpose === 'string' && typeof row.status === 'string')
    .map(row => ({ id: row.id as string, purpose: row.purpose as string, status: row.status as string }));
}

/** POST /api/privacy/consents/:id/withdraw. Idempotent on the server. */
export async function withdrawServerConsent(consentId: string): Promise<void> {
  await requireOwnedApiToken();
  const result = await request<{ withdrawal?: { status?: string } }>({
    path: `/privacy/consents/${encodeURIComponent(consentId)}/withdraw`,
    method: 'POST',
  });
  if (result.withdrawal?.status !== 'withdrawn') {
    throw new Error('Consent service returned an invalid withdrawal acknowledgement.');
  }
}

/**
 * Withdraws a consent for future processing. Server-held purposes
 * (anonymous aggregate signals and partner sharing) are withdrawn on the
 * server too; until that is confirmed the local record stays "pending".
 */
export async function withdrawConsentForFutureProcessing(
  consentId: string,
): Promise<{ consent: ConsentLedgerEntry; remote: 'not_applicable' | 'confirmed' }> {
  const local = await withdrawLocalConsent(consentId);
  if (!requiresRemoteWithdrawal(local.purpose)) {
    return { consent: local, remote: 'not_applicable' };
  }
  if (local.remoteWithdrawalStatus === 'confirmed') {
    return { consent: local, remote: 'confirmed' };
  }

  try {
    await withdrawServerConsent(consentId);
    const confirmed = await confirmRemoteConsentWithdrawal(consentId);
    return { consent: confirmed, remote: 'confirmed' };
  } catch (error) {
    throw new RemoteConsentWithdrawalPendingError(error);
  }
}
