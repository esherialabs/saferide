import React from 'react';
import { AppRegistry, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaProvider, SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { HeaderShownContext } from '@react-navigation/elements';
import { useFonts } from 'expo-font';
import { SimpleThemeProvider, useTheme } from '../../src/theme/SimpleThemeProvider';
import DesignSystemFixtures from '../../src/screens/__fixtures__/DesignSystemFixtures';
import Button from '../../src/components/ui/Button';
import { spacing } from '../../src/theme/tokens';
import Onboarding from '../../src/screens/Onboarding';
import Auth from '../../src/screens/Auth';
import Home from '../../src/screens/Home';
import ReportHub from '../../src/screens/ReportHub';
import Learn from '../../src/screens/Learn';
import Settings from '../../src/screens/Settings';
import WhatHappened from '../../src/screens/WhatHappened';
import WhereWhen from '../../src/screens/WhereWhen';
import Landing from '../../src/screens/Landing';
import ChatLegalAid from '../../src/screens/ChatLegalAid';
import CaseTracker from '../../src/screens/CaseTracker';
import TipsRights from '../../src/screens/TipsRights';
import LaunchScreen from '../../src/components/LaunchScreen';
import Splash from '../../src/screens/Splash';
import DraftOverview from '../../src/screens/DraftOverview';
import EvidenceDetail from '../../src/screens/EvidenceDetail';
import ConsentGate from '../../src/screens/ConsentGate';
import ReferralPicker from '../../src/screens/ReferralPicker';
import EscalationForm from '../../src/screens/EscalationForm';
import StatementReview from '../../src/screens/StatementReview';
import EscalationConfirmation from '../../src/screens/EscalationConfirmation';
import CaseDetail from '../../src/screens/CaseDetail';
import PermissionGate from '../../src/screens/PermissionGate';
import StealthTriggerSetup from '../../src/screens/StealthTriggerSetup';
import FirstRunEmpty from '../../src/screens/FirstRunEmpty';
import SafetySettings from '../../src/screens/SafetySettings';
import PrivacyData from '../../src/screens/PrivacyData';
import LanguageAccessibility from '../../src/screens/LanguageAccessibility';
import AboutLegal from '../../src/screens/AboutLegal';
import IssueReport from '../../src/screens/IssueReport';
import TestMeasurementConsent from '../../src/screens/TestMeasurementConsent';
import TestSessionSummary from '../../src/screens/TestSessionSummary';
import Calculator from '../../src/screens/Calculator';
import { AppHeader } from '../../src/components/ui/AppShell';
import { BrandWordmark } from '../../src/components/BrandWordmark';
import { Ionicons } from '@expo/vector-icons';
import { ToastProvider } from '../../src/components/ui/Toast';
import { useNavigation } from './screen-contexts';

const query = new URLSearchParams(window.location.search);
const initialTheme = query.get('theme') === 'dark' ? 'dark' : query.get('theme') === 'highContrast' ? 'highContrast' : 'light';
const screens = { controls: DesignSystemFixtures, onboarding: Onboarding, 'sign-in': Auth, home: Home, report: ReportHub, support: ChatLegalAid, learn: Learn, settings: Settings, cases: CaseTracker, 'report-form': WhatHappened, 'place-time': WhereWhen, 'tips-rights': TipsRights, landing: Landing, launch: LaunchScreen, splash: Splash,
  'draft-overview': DraftOverview, evidence: EvidenceDetail, consent: ConsentGate, referral: ReferralPicker, escalation: EscalationForm, statement: StatementReview,
  confirmation: EscalationConfirmation, 'case-detail': CaseDetail, permissions: PermissionGate, stealth: StealthTriggerSetup, 'first-run': FirstRunEmpty,
  'safety-settings': SafetySettings, privacy: PrivacyData, language: LanguageAccessibility, about: AboutLegal, issue: IssueReport,
  'test-consent': TestMeasurementConsent, 'test-summary': TestSessionSummary, calculator: Calculator };
// Native stack titles for routes that production renders under a native header.
const stackTitles: Partial<Record<string, string>> = { settings: 'Settings', cases: 'Cases', 'tips-rights': 'Tips and rights', confirmation: 'Confirmation', 'case-detail': 'Case details', 'safety-settings': 'Safety settings', privacy: 'Privacy & data', language: 'Language & accessibility', about: 'About & legal', issue: 'Report an issue', 'test-consent': 'Moderated test', 'test-summary': 'Session summary' };
const reportStackScreens = ['report', 'report-form', 'place-time', 'draft-overview', 'evidence', 'consent', 'referral', 'escalation', 'statement'];
type PreviewScreen = keyof typeof screens;
const requestedScreen = query.get('screen') ?? 'controls';

function Preview() {
  const { colors, mode, setTheme } = useTheme();
  const [textScale, setTextScale] = React.useState(Number(query.get('scale')) || 1);
  const [screen, setScreen] = React.useState<PreviewScreen>((requestedScreen in screens ? requestedScreen : 'controls') as PreviewScreen);
  const [showControls, setShowControls] = React.useState(query.get('chrome') !== '0');
  const [loaded, error] = useFonts({ Inter: require('../../assets/fonts/Inter.ttf') });
  React.useEffect(() => {
    const root = document.body;
    if (!root) return;
    const scaleText = () => root.querySelectorAll<HTMLElement>('[dir="auto"]').forEach(element => {
      const computed = getComputedStyle(element);
      if (element.closest('#preview-toolbar')) return;
      if (/Ionicons/i.test(computed.fontFamily)) return;
      if (!element.dataset.previewFont) {
        element.dataset.previewFont = computed.fontSize;
        element.dataset.previewLine = computed.lineHeight;
      }
      const fontSize = `${parseFloat(element.dataset.previewFont) * textScale}px`;
      if (element.style.fontSize !== fontSize) element.style.fontSize = fontSize;
      const line = parseFloat(element.dataset.previewLine || '');
      if (Number.isFinite(line)) {
        const lineHeight = `${line * textScale}px`;
        if (element.style.lineHeight !== lineHeight) element.style.lineHeight = lineHeight;
      }
    });
    scaleText();
    const observer = new MutationObserver(scaleText);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [textScale, loaded]);
  if (error) return <Text accessibilityRole="alert">Preview font failed: {error.message}</Text>;
  if (!loaded) return <Text>Loading preview fonts…</Text>;
  const SelectedScreen = screens[screen];
  const hasTabs = ['home', 'support', 'learn', ...reportStackScreens].includes(screen);
  const selectedTab = reportStackScreens.includes(screen) ? 'report' : screen;
  return <View style={{ flex: 1, backgroundColor: colors.canvas }}>
    {showControls ? <>
    <View nativeID="preview-toolbar" style={{ padding: spacing.sm, gap: spacing.xs, borderBottomWidth: 1, borderColor: colors.divider }}>
      <Text style={{ color: colors.foreground }}>Synthetic preview · {mode} · no service actions</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs }}>
        {(['light', 'dark', 'highContrast'] as const).map(theme => <Button key={theme} title={theme} size="sm" variant={mode === theme ? 'primary' : 'outline'} onPress={() => setTheme(theme)} />)}
      </View>
      <Text style={{ color: colors.textSecondary }}>Browser text approximation: {Math.round(textScale * 100)}%</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs }}>
        {[1, 1.3, 2].map(scale => <Button key={scale} title={`${Math.round(scale * 100)}%`} size="sm" variant="outline" onPress={() => setTextScale(scale)} />)}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs }}>
        {(Object.keys(screens) as PreviewScreen[]).map(name => <Button key={name} title={name} size="sm" variant="outline" onPress={() => setScreen(name)} />)}
        <Button title="Hide preview controls" size="sm" variant="outline" onPress={() => setShowControls(false)} />
      </View>
    </View>
    </> : <Text nativeID="preview-toolbar" style={{ padding: 4, textAlign: 'center', color: colors.textSecondary, fontSize: 10 }}>Browser preview · synthetic data · {mode}</Text>}
    {hasTabs && <AppHeader title={screen === 'home' ? 'SafeRide' : reportStackScreens.includes(screen) ? 'Report' : screen === 'support' ? 'Support' : 'Learn'} subtitle={screen === 'home' ? undefined : reportStackScreens.includes(screen) ? 'Draft workspace' : screen === 'support' ? 'Providers and guidance' : 'Rights, guides and resources'} showAppearance={screen === 'home'} onSettingsPress={() => setScreen('settings')} showQuickExit={query.get('quick-exit') === '1'} onQuickExitPress={() => {}} withTopInset={query.get('top') === '24'} />}
    {stackTitles[screen] && <View style={{ backgroundColor: colors.background, minHeight: 56, paddingHorizontal: spacing.md, alignItems: 'center', justifyContent: 'space-between', flexDirection: 'row', gap: spacing.md, borderBottomColor: colors.divider, borderBottomWidth: 1 }}><Text style={{ color: colors.foreground, fontFamily: 'Inter', fontSize: 18, fontWeight: '700' }}>{stackTitles[screen]}</Text><BrandWordmark width={80} animated={false} /></View>}
    <HeaderShownContext.Provider value={hasTabs}><SelectedScreen navigation={useNavigation()} /></HeaderShownContext.Provider>
    {/* A visual shell only; production BottomTabs retains its native navigator. */}
    {hasTabs && <View style={{ backgroundColor: colors.surface, borderTopColor: colors.divider, borderTopWidth: 1, minHeight: 79, flexShrink: 0, paddingTop: 8, paddingBottom: 4, flexDirection: 'row' }}>
      {(['home', 'report', 'support', 'learn'] as const).map(name => <TouchableOpacity key={name} accessibilityRole="tab" accessibilityState={{ selected: name === selectedTab }} onPress={() => setScreen(name)} style={{ flex: 1, minWidth: 0, minHeight: 58, paddingHorizontal: 5, paddingVertical: 5, alignItems: 'center', gap: 2 }}>
        <View style={{ backgroundColor: name === selectedTab ? colors.primaryMuted : 'transparent', borderRadius: 100, minHeight: 30, minWidth: 56, alignItems: 'center', justifyContent: 'center' }}><Ionicons name={name === 'home' ? 'shield-checkmark-outline' : name === 'report' ? 'document-text-outline' : name === 'support' ? 'chatbubbles-outline' : 'book-outline'} size={22} color={name === selectedTab ? colors.primary : colors.textSecondary} /></View>
        <Text style={{ color: name === selectedTab ? colors.primary : colors.textSecondary, fontFamily: 'Inter', fontSize: 12, lineHeight: 16, fontWeight: '700', marginTop: 2, alignSelf: 'stretch', maxWidth: '100%', minWidth: 0, textAlign: 'center' }}>{name === 'home' ? 'Home' : name === 'report' ? 'Report' : name === 'support' ? 'Support' : 'Learn'}</Text>
      </TouchableOpacity>)}
    </View>}
  </View>;
}
function App() {
  const bottom = query.get('bottom') === '34' ? 34 : 0;
  const top = query.get('top') === '24' ? 24 : 0;
  return <SafeAreaProvider><SafeAreaInsetsContext.Provider value={{ top, left: 0, right: 0, bottom }}><SimpleThemeProvider initialTheme={initialTheme} initialVisualStyle={query.get('style') === 'classic' ? 'classic' : 'warm'}><ToastProvider><Preview /></ToastProvider></SimpleThemeProvider></SafeAreaInsetsContext.Provider></SafeAreaProvider>;
}
AppRegistry.registerComponent('SafeRideVisualPreview', () => App);
AppRegistry.runApplication('SafeRideVisualPreview', { rootTag: document.getElementById('root') });
