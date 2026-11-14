import { createECDH, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import webpush from 'web-push';

const file = process.argv[2];
const subject = process.argv[3];
if (!file || !subject || !/^https:\/\/[a-z0-9.-]+$/.test(subject)) throw new Error('Expected destination file and https partner origin');
if (existsSync(file)) {
  const rows = readFileSync(file, 'utf8').trim().split('\n');
  const values = Object.fromEntries(rows.map(row => row.split('=')));
  const publicKey = values.SAFERIDE_PARTNER_PUSH_PUBLIC_KEY;
  const privateKey = values.SAFERIDE_PARTNER_PUSH_PRIVATE_KEY;
  const secret = values.SAFERIDE_PARTNER_PUSH_RELAY_SECRET;
  const storedSubject = values.SAFERIDE_PARTNER_PUSH_SUBJECT;
  let valid = rows.length === 4 && /^[a-f0-9]{64}$/.test(secret ?? '') && /^https:\/\/[a-z0-9.-]+$/.test(storedSubject ?? '');
  try {
    const curve = createECDH('prime256v1');
    curve.setPrivateKey(Buffer.from(privateKey, 'base64url'));
    valid = valid && curve.getPublicKey().toString('base64url') === publicKey;
  } catch { valid = false; }
  if (!valid) throw new Error('Existing push settings are invalid; preserve the file and repair manually. Keys were not replaced.');
  console.log('Push settings already exist; left unchanged (values not shown).');
} else {
  const pair = webpush.generateVAPIDKeys();
  const text = `SAFERIDE_PARTNER_PUSH_PUBLIC_KEY=${pair.publicKey}\nSAFERIDE_PARTNER_PUSH_PRIVATE_KEY=${pair.privateKey}\nSAFERIDE_PARTNER_PUSH_RELAY_SECRET=${randomBytes(32).toString('hex')}\nSAFERIDE_PARTNER_PUSH_SUBJECT=${subject}\n`;
  writeFileSync(file, text, { mode: 0o600, flag: 'wx' });
  console.log('Push settings created with mode 0600 (values not shown).');
}
