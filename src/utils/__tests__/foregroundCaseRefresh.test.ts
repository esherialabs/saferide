import { afterEach, expect, it, vi } from 'vitest';
import { startForegroundCaseRefresh } from '../foregroundCaseRefresh';
afterEach(() => vi.useRealTimers());

it('refreshes changed case status only in the foreground, with no overlapping reads or late page updates', async () => {
  vi.useFakeTimers();
  let active = false;
  let resolve!: (value: string) => void;
  const fetch = vi.fn(() => new Promise<string>(done => { resolve = done; }));
  const apply = vi.fn(); const unavailable = vi.fn();
  const polling = startForegroundCaseRefresh({ active: () => active, fetch, apply, unavailable });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetch).not.toHaveBeenCalled();
  active = true;
  await vi.advanceTimersByTimeAsync(30_000);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(fetch).toHaveBeenCalledTimes(1);
  resolve('acknowledged'); await Promise.resolve();
  expect(apply).toHaveBeenLastCalledWith('acknowledged');
  const next = polling.refresh(); polling.stop(); resolve('in_progress'); await next;
  expect(apply).toHaveBeenCalledTimes(1);
  expect(unavailable).not.toHaveBeenCalled();
});
