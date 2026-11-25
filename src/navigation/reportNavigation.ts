import { CommonActions, StackActions } from '@react-navigation/native';
import type { MainTabParamList, ReportStackParamList } from './routes';

export type ReportRouteName = keyof ReportStackParamList;

type NavigationLike = {
  getState?: () => { routeNames?: string[] };
  dispatch?: (action: any) => void;
  navigate: (...args: any[]) => void;
  getParent?: () => NavigationLike | undefined;
};

function ownsRoute(navigation: NavigationLike, routeName: string): boolean {
  try {
    return Boolean(navigation.getState?.().routeNames?.includes(routeName));
  } catch {
    return false;
  }
}

export function navigateToReportRoute<RouteName extends ReportRouteName>(
  navigation: NavigationLike,
  routeName: RouteName,
  params: ReportStackParamList[RouteName],
) {
  if (ownsRoute(navigation, routeName)) {
    navigation.navigate(routeName, params);
    return;
  }

  if (ownsRoute(navigation, 'Report')) {
    navigation.navigate('Report' satisfies keyof MainTabParamList, {
      screen: routeName,
      params,
    });
    return;
  }

  navigation.navigate('MainTabs', {
    screen: 'Report',
    params: {
      screen: routeName,
      params,
    },
  }, { pop: true });
}

export function pushReportRoute<RouteName extends ReportRouteName>(
  navigation: NavigationLike,
  routeName: RouteName,
  params: ReportStackParamList[RouteName],
) {
  if (ownsRoute(navigation, routeName) && navigation.dispatch) {
    navigation.dispatch(StackActions.push(routeName, params));
    return;
  }

  navigateToReportRoute(navigation, routeName, params);
}

export function resetReportStackToRoute<RouteName extends ReportRouteName>(
  navigation: NavigationLike,
  routeName: RouteName,
  params: ReportStackParamList[RouteName],
) {
  const reportState = {
    index: 1,
    routes: [
      { name: 'ReportHome' },
      { name: routeName, params },
    ],
  };

  if (ownsRoute(navigation, 'ReportHome') && navigation.dispatch) {
    navigation.dispatch(CommonActions.reset(reportState));
    return;
  }

  if (ownsRoute(navigation, 'Report')) {
    navigation.navigate('Report' satisfies keyof MainTabParamList, {
      state: reportState,
    });
    return;
  }

  navigation.navigate('MainTabs', {
    screen: 'Report',
    params: {
      state: reportState,
    },
  }, { pop: true });
}

export function navigateToMainTab(
  navigation: NavigationLike,
  tabName: keyof MainTabParamList = 'Home',
) {
  const parent = navigation.getParent?.();
  if (parent && ownsRoute(parent, tabName)) {
    parent.navigate(tabName);
    return;
  }

  navigation.navigate('MainTabs', { screen: tabName }, { pop: true });
}

export function resetReportToWorkspace(navigation: NavigationLike) {
  let current: NavigationLike | undefined = navigation;
  const visited = new Set<NavigationLike>();
  while (current && !visited.has(current)) {
    visited.add(current);
    if (ownsRoute(current, 'ReportHome') && current.dispatch) {
      current.dispatch(CommonActions.reset({ index: 0, routes: [{ name: 'ReportHome' }] }));
      return;
    }
    current = current.getParent?.();
  }
}

// Remove completed editor routes before showing Cases. Otherwise Back reveals
// the old report screen, which immediately redirects to Cases again.
export function exitCompletedReportToCases(navigation: NavigationLike) {
  resetReportToWorkspace(navigation);
  navigation.navigate('Cases', undefined, { pop: true });
}
