import { devPrivacyWarn, getPrivacySafeErrorReason } from '../utils/privacyLog';

export const PERSISTENCE_KEY = 'NAVIGATION_STATE';

export type NavigationStateStore = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

export type NavigationStatePersister = {
  load(): Promise<string | null>;
  save(state: unknown): Promise<void>;
  clear(): Promise<void>;
};

/**
 * Persists navigation state, which carries draft IDs, through an async store
 * such as encryptedAsyncStorage. Loads, writes and clears run strictly in call
 * order, so neither a slower encryption step nor the store's re-encryption of
 * legacy plaintext on first read can land an older state after a newer one or
 * after a sign-out clear. A load that fails (for example SecureStore is
 * unavailable, so legacy plaintext cannot be re-encrypted) removes the stored
 * value rather than leave it readable.
 */
export function createNavigationStatePersister(store: NavigationStateStore): NavigationStatePersister {
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (task: () => Promise<void>): Promise<void> => {
    queue = queue.then(task).catch(error => {
      devPrivacyWarn('navigation state persistence failed', {
        reason: getPrivacySafeErrorReason(error),
      });
    });
    return queue;
  };

  return {
    load() {
      const result = queue.then(async () => {
        try {
          return await store.getItem(PERSISTENCE_KEY);
        } catch (error) {
          await store.removeItem(PERSISTENCE_KEY).catch(() => undefined);
          throw error;
        }
      });
      queue = result.then(() => undefined, () => undefined);
      return result;
    },
    save(state) {
      const value = JSON.stringify(state);
      return enqueue(() => store.setItem(PERSISTENCE_KEY, value));
    },
    clear() {
      return enqueue(() => store.removeItem(PERSISTENCE_KEY));
    },
  };
}

type PersistedRouteParams = {
  draftId?: unknown;
  [key: string]: unknown;
};

export type PersistedNavigationRoute = {
  key?: string;
  name?: string;
  params?: PersistedRouteParams;
  state?: PersistedNavigationState;
  [key: string]: unknown;
};

export type PersistedNavigationState = {
  index?: number;
  routes?: PersistedNavigationRoute[];
  [key: string]: unknown;
};

const SUPPORTED_MAIN_TAB_ROUTES = new Set(['Home', 'Report', 'Support', 'Learn']);

const REPORT_ROUTES_REQUIRING_DRAFT = new Set([
  'DraftOverview',
  'WhereWhen',
  'EvidenceDetail',
  'ConsentGate',
  'ReferralPicker',
  'EscalationForm',
  'StatementReview',
]);

const COMPLETED_REPORT_EDITOR_ROUTES = new Set([
  'WhatHappened', 'DraftOverview', 'WhereWhen', 'EvidenceDetail', 'ConsentGate',
]);

function getActiveRouteIndex(state: PersistedNavigationState, routeCount: number): number {
  if (
    typeof state.index === 'number' &&
    Number.isInteger(state.index) &&
    state.index >= 0 &&
    state.index < routeCount
  ) {
    return state.index;
  }

  return Math.max(0, routeCount - 1);
}

function hasRestorableDraft(route: PersistedNavigationRoute, availableDraftIds: ReadonlySet<string>): boolean {
  return typeof route.params?.draftId === 'string' && availableDraftIds.has(route.params.draftId);
}

function requiresRestorableDraft(route: PersistedNavigationRoute): boolean {
  if (route.name === 'WhatHappened') {
    return typeof route.params?.draftId === 'string';
  }

  return Boolean(route.name && REPORT_ROUTES_REQUIRING_DRAFT.has(route.name));
}

function sanitizeStateRoutes(
  state: PersistedNavigationState,
  availableDraftIds: ReadonlySet<string>,
  options: { fallbackRoute?: PersistedNavigationRoute } = {},
  completedDraftIds: ReadonlySet<string> = new Set(),
): PersistedNavigationState | undefined {
  const routes = Array.isArray(state.routes) ? state.routes : [];
  if (routes.length === 0) {
    return options.fallbackRoute ? { ...state, index: 0, routes: [options.fallbackRoute] } : undefined;
  }

  const activeRouteIndex = getActiveRouteIndex(state, routes.length);
  let activeRouteReplacement: PersistedNavigationRoute | undefined;
  const sanitizedRoutes: PersistedNavigationRoute[] = [];

  routes.forEach((route, index) => {
    const sanitizedRoute = sanitizeRoute(route, availableDraftIds, completedDraftIds);
    if (!sanitizedRoute) return;

    sanitizedRoutes.push(sanitizedRoute);
    if (index === activeRouteIndex) {
      activeRouteReplacement = sanitizedRoute;
    }
  });

  if (sanitizedRoutes.length === 0) {
    return options.fallbackRoute ? { ...state, index: 0, routes: [options.fallbackRoute] } : undefined;
  }

  let nextIndex = activeRouteReplacement ? sanitizedRoutes.indexOf(activeRouteReplacement) : -1;
  if (nextIndex < 0) {
    const fallbackIndex = options.fallbackRoute?.name
      ? sanitizedRoutes.findIndex(route => route.name === options.fallbackRoute?.name)
      : -1;
    nextIndex = fallbackIndex >= 0 ? fallbackIndex : 0;
  }

  return {
    ...state,
    index: nextIndex,
    routes: sanitizedRoutes,
  };
}

function sanitizeReportStackState(
  state: PersistedNavigationState,
  availableDraftIds: ReadonlySet<string>,
  completedDraftIds: ReadonlySet<string>,
): PersistedNavigationState {
  return sanitizeStateRoutes(state, availableDraftIds, {
    fallbackRoute: { name: 'ReportHome' },
  }, completedDraftIds) ?? { ...state, index: 0, routes: [{ name: 'ReportHome' }] };
}

function sanitizeRoute(
  route: PersistedNavigationRoute,
  availableDraftIds: ReadonlySet<string>,
  completedDraftIds: ReadonlySet<string>,
): PersistedNavigationRoute | undefined {
  if (requiresRestorableDraft(route) && !hasRestorableDraft(route, availableDraftIds)) {
    return undefined;
  }
  if (
    Boolean(route.name && COMPLETED_REPORT_EDITOR_ROUTES.has(route.name)) &&
    typeof route.params?.draftId === 'string' && completedDraftIds.has(route.params.draftId) &&
    route.params.editCompleted !== true
  ) {
    return undefined;
  }

  if (!route.state) {
    return route;
  }

  const nestedState = route.name === 'Report'
    ? sanitizeReportStackState(route.state, availableDraftIds, completedDraftIds)
    : sanitizeStateRoutes(route.state, availableDraftIds, {}, completedDraftIds);

  if (!nestedState) {
    return undefined;
  }

  if (route.name === 'MainTabs' || route.name === 'Report') {
    // The materialized nested state is authoritative on restore. Old navigator
    // commands in params can otherwise replay the completed editor we removed.
    const params = route.params ? { ...route.params } : undefined;
    if (params) {
      delete params.state;
      delete params.screen;
      delete params.params;
      delete params.initial;
    }
    return { ...route, params, state: nestedState };
  }
  return nestedState === route.state ? route : { ...route, state: nestedState };
}

function hasUnsupportedMainTabRoute(state: PersistedNavigationState): boolean {
  const mainTabsRoute = state.routes?.find((route) => route.name === 'MainTabs');
  const tabRoutes = mainTabsRoute?.state?.routes;

  return Boolean(tabRoutes?.some((route) => route.name && !SUPPORTED_MAIN_TAB_ROUTES.has(route.name)));
}

function reconcileWorkspaceHistory(state: PersistedNavigationState): PersistedNavigationState {
  const routes = state.routes ?? [];
  const activeIndex = getActiveRouteIndex(state, routes.length);
  const activeHistory = routes.slice(0, activeIndex + 1);
  const hasDuplicateWorkspace = activeHistory.filter(route => route.name === 'MainTabs').length > 1;
  const hasDuplicateCases = activeHistory.filter(route => route.name === 'Cases').length > 1;
  if (!hasDuplicateWorkspace && !hasDuplicateCases) return state;
  const workspaceIndex = hasDuplicateWorkspace
    ? activeHistory.findLastIndex(route => route.name === 'MainTabs')
    : -1;
  // Old Cases-to-report navigation pushed a second MainTabs route. Retain the
  // current workspace (and its draft state), dropping the obsolete back loop.
  const currentHistory = activeHistory.filter((route, index) => (
    workspaceIndex < 0 || index >= workspaceIndex
  ));
  const casesIndex = currentHistory.findLastIndex(route => route.name === 'Cases');
  const reconciled = currentHistory.filter((route, index) => route.name !== 'Cases' || index === casesIndex);
  return { ...state, routes: reconciled, index: Math.max(0, reconciled.length - 1) };
}

export function normalizeRestoredNavigationState<State extends PersistedNavigationState | undefined>(
  state: State,
  availableDraftIds: ReadonlySet<string> = new Set<string>(),
  completedDraftIds: ReadonlySet<string> = new Set<string>(),
): State | undefined {
  if (!state) return undefined;

  if (hasUnsupportedMainTabRoute(state)) {
    return undefined;
  }

  return sanitizeStateRoutes(reconcileWorkspaceHistory(state), availableDraftIds, {}, completedDraftIds) as State | undefined;
}
