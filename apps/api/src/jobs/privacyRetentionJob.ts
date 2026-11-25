import { executePrivacyRetention } from '../services/privacyRetentionExecution.js';
import { closeDb } from '../plugins/db.js';

const mode = process.argv.includes('--mode=enforce') ? 'enforce' : 'dry-run';
if (process.argv.slice(2).some(arg => !['--mode=enforce', '--mode=dry-run'].includes(arg))) throw new Error('Use --mode=dry-run or --mode=enforce');
try {
  // Counts and policy versions only, never identifiers, content or storage keys.
  const result = await executePrivacyRetention({ mode });
  console.log(JSON.stringify(result));
  if (result.objects.retry > 0 || result.rightsRequests.failed > 0) process.exitCode = 1;
} catch {
  console.error('Privacy retention did not complete; inspect controls, holds, database and storage health. No content was logged.');
  process.exitCode = 1;
} finally { await closeDb(); }
