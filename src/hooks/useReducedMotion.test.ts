import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  value: undefined as boolean | undefined,
  effect: undefined as (() => () => void) | undefined,
  listener: undefined as ((enabled: boolean) => void) | undefined,
  remove: vi.fn(),
  query: vi.fn(),
}));

vi.mock('react', () => ({
  useState: (initial: boolean) => {
    runtime.value ??= initial;
    return [runtime.value, (value: boolean) => { runtime.value = value; }];
  },
  useEffect: (effect: () => () => void) => { runtime.effect = effect; },
}));
vi.mock('react-native', () => ({
  AccessibilityInfo: {
    isReduceMotionEnabled: runtime.query,
    addEventListener: (_event: string, listener: (enabled: boolean) => void) => {
      runtime.listener = listener;
      return { remove: runtime.remove };
    },
  },
}));

import { useReducedMotion } from './useReducedMotion';

beforeEach(() => {
  runtime.value = undefined;
  runtime.effect = undefined;
  runtime.listener = undefined;
  runtime.query.mockReset();
  runtime.remove.mockReset();
});

describe('reduced-motion preference lifecycle', () => {
  it('suppresses motion until the device preference resolves and follows live updates', async () => {
    let resolvePreference!: (enabled: boolean) => void;
    runtime.query.mockReturnValue(new Promise<boolean>(resolve => { resolvePreference = resolve; }));
    expect(useReducedMotion()).toBe(true);
    const cleanup = runtime.effect!();
    resolvePreference(false);
    await Promise.resolve();
    expect(runtime.value).toBe(false);
    runtime.listener!(true);
    expect(runtime.value).toBe(true);
    cleanup();
    expect(runtime.remove).toHaveBeenCalledOnce();
  });

  it('does not overwrite a newer live preference with a late initial query', async () => {
    let resolvePreference!: (enabled: boolean) => void;
    runtime.query.mockReturnValue(new Promise<boolean>(resolve => { resolvePreference = resolve; }));
    useReducedMotion();
    const cleanup = runtime.effect!();
    runtime.listener!(true);
    resolvePreference(false);
    await Promise.resolve();
    expect(runtime.value).toBe(true);
    cleanup();
  });

  it('keeps motion suppressed when the query fails and ignores responses after unmount', async () => {
    runtime.query.mockRejectedValueOnce(new Error('Synthetic preference failure'));
    useReducedMotion();
    runtime.effect!();
    await Promise.resolve();
    await Promise.resolve();
    expect(runtime.value).toBe(true);

    let resolvePreference!: (enabled: boolean) => void;
    runtime.query.mockReturnValue(new Promise<boolean>(resolve => { resolvePreference = resolve; }));
    useReducedMotion();
    runtime.effect!()();
    resolvePreference(false);
    await Promise.resolve();
    expect(runtime.value).toBe(true);
  });
});
