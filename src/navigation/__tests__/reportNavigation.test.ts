import { describe, expect, it, vi } from 'vitest';
import { CommonActions, StackRouter } from '@react-navigation/routers';

vi.mock('@react-navigation/native', async () => import('@react-navigation/routers'));

import { exitCompletedReportToCases, navigateToMainTab, navigateToReportRoute, resetReportStackToRoute } from '../reportNavigation';

function rootHistory() {
  const router = StackRouter({ initialRouteName: 'MainTabs' });
  const options = {
    routeNames: ['MainTabs', 'Cases', 'CaseDetail'],
    routeParamList: {},
    routeGetIdList: {},
  };
  let state = router.getInitialState(options);
  const mainKey = state.routes[0].key;
  const dispatch = (action: any) => {
    const next = router.getStateForAction(state, action, options);
    if (!next) throw new Error('Unhandled test navigation action');
    state = router.getRehydratedState(next, options);
  };
  const navigation = {
    getState: () => state,
    dispatch,
    navigate: (...args: any[]) => dispatch((CommonActions.navigate as any)(...args)),
  };
  navigation.navigate('Cases');
  return { navigation, getState: () => state, mainKey };
}

describe('Report and Cases stack continuity', () => {
  it('resumes a draft in the existing main workspace instead of stacking it above Cases', () => {
    const history = rootHistory();
    resetReportStackToRoute(history.navigation, 'WhereWhen', { draftId: 'synthetic-draft' });
    expect(history.getState().routes.map(route => route.name)).toEqual(['MainTabs']);
    expect(history.getState().routes[0].key).toBe(history.mainKey);
    expect(history.getState().routes[0].params).toMatchObject({
      screen: 'Report', params: { state: { routes: [
        { name: 'ReportHome' },
        { name: 'WhereWhen', params: { draftId: 'synthetic-draft' } },
      ] } },
    });
    history.navigation.navigate('Cases');
    history.navigation.dispatch(CommonActions.goBack());
    expect(history.getState().routes.map(route => route.name)).toEqual(['MainTabs']);
  });

  it('starts a fresh report without putting a previous Cases screen in its back history', () => {
    const history = rootHistory();
    resetReportStackToRoute(history.navigation, 'WhatHappened', undefined);
    expect(history.getState().routes.map(route => route.name)).toEqual(['MainTabs']);
  });

  it('returns to Home from a case detail using the original main route', () => {
    const history = rootHistory();
    history.navigation.navigate('CaseDetail', { caseId: 'synthetic-case' });
    navigateToMainTab(history.navigation, 'Home');
    expect(history.getState().routes.map(route => route.name)).toEqual(['MainTabs']);
    expect(history.getState().routes[0].key).toBe(history.mainKey);
  });

  it('opens a report route from Cases without duplicating the main workspace', () => {
    const history = rootHistory();
    navigateToReportRoute(history.navigation, 'ReportHome', undefined);
    expect(history.getState().routes.map(route => route.name)).toEqual(['MainTabs']);
  });

  it('removes completed steps before Cases so Back returns to the report workspace', () => {
    const root = rootHistory();
    root.navigation.dispatch(CommonActions.goBack());
    const reportRouter = StackRouter({ initialRouteName: 'ReportHome' });
    const options = {
      routeNames: ['ReportHome', 'WhatHappened', 'WhereWhen', 'ConsentGate'],
      routeParamList: {}, routeGetIdList: {},
    };
    let reportState = reportRouter.getInitialState(options);
    for (const name of ['WhatHappened', 'WhereWhen', 'ConsentGate']) {
      reportState = reportRouter.getRehydratedState(
        reportRouter.getStateForAction(reportState, CommonActions.navigate(name), options)!, options,
      );
    }
    const reportNavigation = {
      getState: () => reportState,
      dispatch: (action: any) => {
        const next = reportRouter.getStateForAction(reportState, action, options);
        if (!next) throw new Error('Unhandled report navigation action');
        reportState = reportRouter.getRehydratedState(next, options);
      },
      navigate: root.navigation.navigate,
    };
    exitCompletedReportToCases(reportNavigation);
    expect(root.getState().routes.map(route => route.name)).toEqual(['MainTabs', 'Cases']);
    expect(reportState.routes.map(route => route.name)).toEqual(['ReportHome']);
    root.navigation.dispatch(CommonActions.goBack());
    expect(root.getState().routes.map(route => route.name)).toEqual(['MainTabs']);
    expect(reportState.routes[reportState.index].name).toBe('ReportHome');
  });
});
