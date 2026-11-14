import { useCallback, useState } from 'react';
import type { DraftData } from '../../src/utils/draftStorage';
// Invented drafts only. No device storage, timers, autosave, or native APIs.
// Match the populated storage fixture so reachable steps and optional Skip
// can be checked instead of rendering those controls against an empty draft.
const withDraft = new URLSearchParams(window.location.search).get('draft') === '1';
export const fixtureDraft: DraftData = {
  id: 'synthetic-ui-draft', createdAt: new Date('2026-10-04T09:00:00Z'),
  updatedAt: new Date(withDraft ? '2026-10-04T09:30:00Z' : '2026-10-04T09:00:00Z'),
  currentStep: withDraft ? 'ConsentGate' : 'WhatHappened',
  completedSteps: withDraft ? ['WhatHappened', 'WhereWhen', 'EvidenceDetail'] : [], status: 'draft',
};
export const useReportDraftIdentity = () => ({ draftId: fixtureDraft.id, isResolving: false, error: null });
export const useCompletedReportRedirect = () => {};
export function useDraftState() {
  const [draftData, setDraftData] = useState(fixtureDraft);
  const updateDraft = useCallback((patch: Partial<DraftData>) => setDraftData(current => ({ ...current, ...patch })), []);
  return { draftData, updateDraft, saveDraftPatch: async () => draftData, isLoading: false, isSaving: false, lastSaved: draftData.updatedAt, error: null };
}
