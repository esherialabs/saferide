/** Foreground-only, bounded polling; late responses never repopulate a page that was left. */
export function startForegroundCaseRefresh<T>(options: {
  active(): boolean;
  fetch(): Promise<T>;
  apply(value: T): void;
  unavailable(): void;
  intervalMs?: number;
}) {
  let stopped = false;
  let pending = false;
  async function refresh() {
    if (stopped || pending || !options.active()) return;
    pending = true;
    try {
      const value = await options.fetch();
      if (!stopped && options.active()) options.apply(value);
    } catch { if (!stopped && options.active()) options.unavailable(); }
    finally { pending = false; }
  }
  const timer = setInterval(() => void refresh(), options.intervalMs ?? 30_000);
  return { refresh, stop() { stopped = true; clearInterval(timer); } };
}
