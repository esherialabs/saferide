import { useEffect, useRef } from 'react';
import { useIsFocused } from '@react-navigation/native';

import { isFinalReportDraftState } from '../navigation/reportPathwayFlow';
import { exitCompletedReportToCases } from '../navigation/reportNavigation';
import type { DraftData } from '../utils/draftStorage';

type NavigationLike = {
  navigate: (...args: any[]) => void;
  getParent?: () => NavigationLike | undefined;
  getState?: () => { routeNames?: string[] };
  dispatch?: (action: any) => void;
};

export function useCompletedReportRedirect(
  navigation: NavigationLike,
  draft: DraftData | null | undefined,
  options: { enabled?: boolean } = {},
) {
  const redirectedDraftRef = useRef<string | null>(null);
  const isFocused = useIsFocused();
  const enabled = options.enabled ?? true;

  useEffect(() => {
    if (!enabled || !isFocused || !draft?.id || !isFinalReportDraftState(draft)) {
      return;
    }

    if (redirectedDraftRef.current === draft.id) {
      return;
    }

    redirectedDraftRef.current = draft.id;
    exitCompletedReportToCases(navigation);
  }, [draft, enabled, isFocused, navigation]);
}
