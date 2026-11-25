import { lookup } from 'node:dns/promises';
import { buildPartnerPushRelay, vapidSender } from '../services/partnerPushRelay.js';

const publicKey = process.env.PARTNER_PUSH_PUBLIC_KEY ?? '';
const privateKey = process.env.PARTNER_PUSH_PRIVATE_KEY ?? '';
const subject = process.env.PARTNER_PUSH_SUBJECT ?? '';
if (!publicKey || !privateKey || !/^https:\/\/[^\s]+$/.test(subject)) throw new Error('Push relay VAPID settings are incomplete');
const app = buildPartnerPushRelay(process.env.PARTNER_PUSH_RELAY_SECRET ?? '', vapidSender({ publicKey, privateKey, subject }));
// Bind only the internal API-facing network, never the relay's internet-facing interface.
const { address } = await lookup('push-relay-internal', { family: 4 });
await app.listen({ host: address, port: 3335 });
process.on('SIGTERM', () => void app.close());
process.on('SIGINT', () => void app.close());
