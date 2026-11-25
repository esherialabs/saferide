import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { closeDb } from '../plugins/db.js';
import { captureRestorePrivacyLedger, drainRestorePrivacy, replayRestorePrivacyLedger, validateRestorePrivacyLedger } from '../services/restorePrivacyLedger.js';

const [action,file] = process.argv.slice(2);
try {
  if(action==='export' && file) {
    const ledger=await captureRestorePrivacyLedger();
    writeFileSync(file,JSON.stringify(ledger),{mode:0o600,flag:'wx'});
    console.log(JSON.stringify({exported:true,schemaVersion:1}));
  } else if((action==='validate'||action==='replay')&&file) {
    if(statSync(file).size>20*1024*1024) throw new Error('Ledger too large');
    const ledger=validateRestorePrivacyLedger(JSON.parse(readFileSync(file,'utf8')));
    console.log(JSON.stringify(action==='replay'?await replayRestorePrivacyLedger(ledger):{valid:true,schemaVersion:1}));
  } else if(action==='drain'&&!file) {
    const result=await drainRestorePrivacy(); console.log(JSON.stringify(result)); if(!result.done) process.exitCode=2;
  } else throw new Error('Expected export FILE, validate FILE, replay FILE or drain');
} catch {
  console.error('Restore privacy reconciliation failed; keep ingress, API and dashboard stopped. No ledger data was logged.');
  process.exitCode=1;
} finally {await closeDb();}
