import React, { useState } from 'react';
import {
  BaseNavigationContainer, createNavigatorFactory, useNavigationBuilder, useNavigation, useIsFocused,
  StackRouter, TabRouter,
} from '@react-navigation/core';
import { resetReportStackToRoute, navigateToMainTab } from '../../src/navigation/reportNavigation';
import { useCompletedReportRedirect } from '../../src/hooks/useCompletedReportRedirect';
import { normalizeRestoredNavigationState } from '../../src/navigation/navigationStatePersistence';

const { createRoot } = require('react-dom/client') as {
  createRoot(container: Element): { render(children: React.ReactNode): void };
};

const Context = React.createContext<any>(null);
const initialDraft = { id: 'synthetic-draft', currentStep: 'WhereWhen', completedSteps: ['WhatHappened'], createdAt: new Date(), updatedAt: new Date() };
function Navigator({ router, ...props }: any) {
  const { state, descriptors, render } = useNavigationBuilder(router, props);
  return render(<>{state.routes.map((route: any, index: number) => <section key={route.key} hidden={index !== state.index}>{descriptors[route.key].render()}</section>)}</>);
}
const Stack = createNavigatorFactory((props: any) => <Navigator router={StackRouter} {...props} />)();
const Tabs = createNavigatorFactory((props: any) => <Navigator router={TabRouter} {...props} />)();
function Home() {
  const nav = useNavigation<any>();
  return <><h2>Home</h2><button onClick={() => nav.navigate('Cases')}>Open Cases</button><button onClick={() => resetReportStackToRoute(nav, 'WhereWhen', { draftId: 'synthetic-draft' })}>Resume report</button></>;
}
function Cases() {
  const nav = useNavigation<any>();
  const { draft } = React.useContext(Context);
  return <><h2>Cases</h2><p>Saved status: {draft.currentStep}</p><button onClick={() => nav.goBack()}>Close Cases</button><button onClick={() => resetReportStackToRoute(nav, 'WhereWhen', { draftId: draft.id })}>Resume draft</button><button onClick={() => resetReportStackToRoute(nav, 'WhatHappened', undefined)}>New report</button></>;
}
function Workspace() {
  const nav = useNavigation<any>();
  return <><h2>Report workspace</h2><button onClick={() => navigateToMainTab(nav, 'Home')}>Home tab</button><button onClick={() => nav.navigate('Cases')}>Open Cases</button><button onClick={() => resetReportStackToRoute(nav, 'WhatHappened', undefined)}>New report</button></>;
}
function Step({ route }: any) {
  const nav = useNavigation<any>();
  const focused = useIsFocused();
  const { draft, setDraft } = React.useContext(Context);
  useCompletedReportRedirect(nav, route.params?.draftId ? draft : null);
  return <><h2>{route.name === 'WhereWhen' ? 'Place and time' : 'What happened'}</h2><p>Focused: {String(focused)}</p><button onClick={() => nav.goBack()}>Back to workspace</button><button onClick={() => nav.navigate('ConsentGate', { draftId: draft.id })}>Review report</button></>;
}
function Review() {
  const nav = useNavigation<any>();
  const { draft, setDraft } = React.useContext(Context);
  useCompletedReportRedirect(nav, draft);
  return <><h2>Consent review</h2><p>Synthetic record only</p><button onClick={() => setDraft({ ...draft, currentStep: 'completed' })}>Complete synthetic report</button></>;
}
function Reports() {
  return <Stack.Navigator initialRouteName="ReportHome"><Stack.Screen name="ReportHome" component={Workspace}/><Stack.Screen name="WhatHappened" component={Step}/><Stack.Screen name="WhereWhen" component={Step}/><Stack.Screen name="ConsentGate" component={Review}/></Stack.Navigator>;
}
function Main() {
  return <Tabs.Navigator initialRouteName="Home"><Tabs.Screen name="Home" component={Home}/><Tabs.Screen name="Report" component={Reports}/></Tabs.Navigator>;
}
const restored = normalizeRestoredNavigationState({ index: 3, routes: [
  { name: 'MainTabs' }, { name: 'Cases' },
  { name: 'MainTabs', state: { index: 1, routes: [ { name: 'Home' }, { name: 'Report', state: { index: 1, routes: [{ name: 'ReportHome' }, { name: 'WhereWhen', params: { draftId: 'synthetic-draft' } }] } } ] } },
  { name: 'Cases' },
] }, new Set(['synthetic-draft']));
function App() {
  const [draft, setDraft] = useState(initialDraft);
  const [history, setHistory] = useState<any>(null);
  return <Context.Provider value={{ draft, setDraft }}><h1>Report / Cases regression</h1><p>Real React Navigation core and production navigation helpers. Synthetic data, DOM controls.</p><BaseNavigationContainer initialState={location.search.includes('restored') ? restored as any : undefined} onStateChange={state => { setHistory(state); (window as any).__NAV_STATE__ = state; }} theme={{ dark: false, colors: { primary: '#A75535', background: '#FCF6EE', card: '#FFFDFA', text: '#2D211B', border: '#DBCDC2', notification: '#A75535' }, fonts: {} } as any}><Stack.Navigator initialRouteName="MainTabs"><Stack.Screen name="MainTabs" component={Main}/><Stack.Screen name="Cases" component={Cases}/></Stack.Navigator></BaseNavigationContainer><pre id="history">{history ? JSON.stringify(history.routes.map((r: any) => r.name)) : 'Initial workspace'}</pre></Context.Provider>;
}
createRoot(document.getElementById('root')!).render(<App/>);
