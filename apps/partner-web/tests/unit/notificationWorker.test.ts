import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';

it('the notification worker displays only fixed generic text and navigates only to this dashboard', async () => {
  const handlers: Record<string, (event: any) => void> = {};
  const shown: Array<{ title: string; options: any }> = [];
  const visited: string[] = [];
  const worker = {
    location: { origin: 'https://partners.example.invalid' },
    addEventListener(name: string, handler: (event: any) => void) { handlers[name] = handler; },
    registration: { async showNotification(title: string, options: any) { shown.push({ title, options }); } },
    clients: { async matchAll() { return []; }, async openWindow(url: string) { visited.push(url); } },
  };
  runInNewContext(readFileSync(new URL('../../public/notifications-sw.js', import.meta.url), 'utf8'), { self: worker, URL });
  assert.equal(handlers.fetch, undefined);
  let completion: Promise<unknown> = Promise.resolve();
  handlers.push!({ data: { json: () => ({ kind: 'attention', narrative: 'SENSITIVE TEST NARRATIVE', url: 'https://attacker.invalid' }) }, waitUntil: (work: Promise<unknown>) => { completion = work; } });
  await completion;
  assert.equal(shown[0]!.title, 'SafeRide');
  assert.equal(shown[0]!.options.body, 'A case needs attention. Open the dashboard to review.');
  assert.equal(JSON.stringify(shown).includes('SENSITIVE'), false);
  handlers.notificationclick!({ notification: { close() {}, data: { destination: 'https://attacker.invalid' } }, waitUntil: (work: Promise<unknown>) => { completion = work; } });
  await completion;
  assert.deepEqual(visited, ['https://partners.example.invalid/cases/']);
  let focused = false;
  worker.clients.matchAll = async () => [{ url: 'https://partners.example.invalid/case/?id=synthetic', focus: async () => { focused = true; }, navigate: async () => { throw new Error('Must preserve the draft'); } }] as never;
  handlers.notificationclick!({ notification: { close() {} }, waitUntil: (work: Promise<unknown>) => { completion = work; } });
  await completion;
  assert.equal(focused, true);
  assert.equal(visited.length, 1);
});
