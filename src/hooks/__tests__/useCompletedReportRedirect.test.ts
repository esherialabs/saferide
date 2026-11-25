import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  focused: true,
  ref: { current: null as string | null },
  effect: undefined as (() => void) | undefined,
}));

vi.mock('react', () => ({
  useRef: () => runtime.ref,
  useEffect: (effect: () => void) => { runtime.effect = effect; },
}));
vi.mock('@react-navigation/native', async () => ({
  ...await import('@react-navigation/routers'),
  useIsFocused: () => runtime.focused,
}));

import { useCompletedReportRedirect } from '../useCompletedReportRedirect';
import type { DraftData } from '../../utils/draftStorage';

const completedDraft: DraftData = {
  id: 'synthetic-completed-report',
  createdAt: new Date('2026-10-12T06:00:00Z'),
  updatedAt: new Date('2026-10-12T06:00:00Z'),
  completedSteps: ['WhatHappened', 'WhereWhen', 'EvidenceDetail', 'ConsentGate'],
  currentStep: 'completed',
};

function navigation() {
  return {
    navigate: vi.fn(), dispatch: vi.fn(),
    getState: () => ({ routeNames: ['ReportHome', 'WhatHappened', 'ConsentGate'] }),
  };
}

beforeEach(() => {
  runtime.focused = true;
  runtime.ref.current = null;
  runtime.effect = undefined;
});

describe('completed report redirect lifecycle', () => {
  it('does not let a mounted background step reopen Cases after a draft finishes', () => {
    const nav = navigation();
    runtime.focused = false;
    useCompletedReportRedirect(nav, completedDraft);
    runtime.effect!();
    expect(nav.navigate).not.toHaveBeenCalled();
    expect(nav.dispatch).not.toHaveBeenCalled();
    expect(runtime.ref.current).toBeNull();
  });

  it('clears the editor before opening Cases once when the completed step is focused', () => {
    const nav = navigation();
    useCompletedReportRedirect(nav, completedDraft);
    runtime.effect!();
    expect(nav.dispatch).toHaveBeenCalledWith({
      type: 'RESET', payload: { index: 0, routes: [{ name: 'ReportHome' }] },
    });
    expect(nav.navigate).toHaveBeenCalledWith('Cases', undefined, { pop: true });
    expect(nav.dispatch.mock.invocationCallOrder[0]).toBeLessThan(nav.navigate.mock.invocationCallOrder[0]);
    useCompletedReportRedirect(nav, { ...completedDraft });
    runtime.effect!();
    expect(nav.navigate).toHaveBeenCalledOnce();
  });

  it('leaves an explicitly edited completed record in the editor', () => {
    const nav = navigation();
    useCompletedReportRedirect(nav, completedDraft, { enabled: false });
    runtime.effect!();
    expect(nav.navigate).not.toHaveBeenCalled();
    expect(nav.dispatch).not.toHaveBeenCalled();
  });

  it('does not exit an incomplete draft or a consent checkpoint still being saved', () => {
    const nav = navigation();
    useCompletedReportRedirect(nav, { ...completedDraft, currentStep: 'ConsentGate' });
    runtime.effect!();
    useCompletedReportRedirect(nav, completedDraft, { enabled: false });
    runtime.effect!();
    expect(nav.navigate).not.toHaveBeenCalled();
    expect(nav.dispatch).not.toHaveBeenCalled();
  });
});
