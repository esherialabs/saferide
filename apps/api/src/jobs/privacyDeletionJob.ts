import { executeVerifiedReportDeletion } from '../services/privacyDeletionExecution.js';
import { closeDb } from '../plugins/db.js';

const requestId = process.argv[2];
if (!requestId || !/^[0-9a-f-]{36}$/.test(requestId) || process.argv.length !== 3) throw new Error('Expected one verified rights-request UUID');
try {
  const result = await executeVerifiedReportDeletion(requestId);
  console.log(JSON.stringify({ status: result.status, evidenceSha256: result.evidenceSha256 }));
} catch {
  console.error('Report deletion did not complete. The request must be verified, not held, and execution enabled. No content was logged.');
  process.exitCode = 1;
} finally { await closeDb(); }
