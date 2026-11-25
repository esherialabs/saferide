import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavigationContainer, NavigationState, LinkingOptions, useNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Linking, Text, View } from 'react-native';
import { RootStackParamList } from './routes';
import { BottomTabs } from './BottomTabs';
import { useTheme } from '../theme/SimpleThemeProvider';
import { useAuth } from '../context/AuthProvider';
import { useOnboarding } from '../context/OnboardingProvider';
import { useLanguage } from '../context/LanguageProvider';
import { QuickExitManager } from '../utils/quickExit';
import { DecoyPinManager } from '../utils/decoyPin';
import { resetToCalculatorDecoyIfUnlockable } from './quickExitNavigation';
import { borders, fontFamilies, spacing, typography } from '../theme/tokens';
import { getRootRouteTitle } from '../i18n/appLanguage';
import { draftStorage } from '../utils/draftStorage';
import { isFinalReportDraftState } from './reportPathwayFlow';
import { devPrivacyInfo, devPrivacyWarn, getPrivacySafeErrorReason } from '../utils/privacyLog';
import { withStartupFallback } from '../utils/startupBudget';
import { encryptedAsyncStorage } from '../lib/encryptedAsyncStorage';
import {
  createNavigationStatePersister,
  normalizeRestoredNavigationState,
} from './navigationStatePersistence';

// Import all screens
import SplashScreen from '../screens/Splash';
import OnboardingScreen from '../screens/Onboarding';
import PermissionGateScreen from '../screens/PermissionGate';
import StealthTriggerSetupScreen from '../screens/StealthTriggerSetup';
import CaseTrackerScreen from '../screens/CaseTracker';
import CaseDetailScreen from '../screens/CaseDetail';
import SettingsScreen from '../screens/Settings';
import SafetySettingsScreen from '../screens/SafetySettings';
import PrivacyDataScreen from '../screens/PrivacyData';
import LanguageAccessibilityScreen from '../screens/LanguageAccessibility';
import TestMeasurementConsentScreen from '../screens/TestMeasurementConsent';
import IssueReportScreen from '../screens/IssueReport';
import TestSessionSummaryScreen from '../screens/TestSessionSummary';
import TipsRightsScreen from '../screens/TipsRights';
import AboutLegalScreen from '../screens/AboutLegal';
import FirstRunEmptyScreen from '../screens/FirstRunEmpty';
import EscalationConfirmationScreen from '../screens/EscalationConfirmation';
import CalculatorScreen from '../screens/Calculator';
import LandingScreen from '../screens/Landing';
import AuthScreen from '../screens/Auth';
import LaunchScreen from '../components/LaunchScreen';
import { BrandWordmark } from '../components/BrandWordmark';
import { getMeasurementModeDecision } from '../lib/measurement/measurementConfig';
import { getModeratedTestCopy } from '../i18n/languageAccessibilityCopy';

const Stack = createNativeStackNavigator<RootStackParamList>();

// Deep linking configuration
function buildLinkingOptions(measurementEnabled: boolean): LinkingOptions<RootStackParamList> {
  return {
    prefixes: ['saferide://', 'https://saferide.app'],
    config: {
      screens: {
      Landing: '',
      Auth: 'auth/:action?',
      // Onboarding
      Splash: 'splash',
      Onboarding: 'onboarding',
      PermissionGate: 'permissions',
      StealthTriggerSetup: 'stealth-setup',
      
      // Main app
      MainTabs: {
        screens: {
          Home: 'home',
          Report: {
            screens: {
              ReportHome: 'report',
              DraftOverview: 'report/draft/:draftId?',
              WhatHappened: 'report/:draftId/what-happened',
              WhereWhen: 'report/:draftId/where-when',
              EvidenceDetail: 'report/:draftId/evidence',
              ConsentGate: 'report/:draftId/review',
              ReferralPicker: 'report/:draftId/referral',
              EscalationForm: 'report/:draftId/escalation',
              StatementReview: 'report/:draftId/statement',
            },
          },
          Support: 'support',
          Learn: 'learn',
        },
      },
      
      // Case management
      Cases: 'cases',
      CaseDetail: 'case/:caseId',
      EscalationConfirmation: 'case/:caseId/confirmation',
      
      // Settings
      Settings: 'settings',
      SafetySettings: 'settings/safety',
      PrivacyData: 'settings/privacy',
      LanguageAccessibility: 'settings/accessibility',
      ...(measurementEnabled ? {
        TestMeasurementConsent: 'settings/moderated-test',
        IssueReport: 'settings/moderated-test/issue',
        TestSessionSummary: 'settings/moderated-test/summary',
      } : {}),
      TipsRights: 'settings/tips',
      AboutLegal: 'settings/about',
      
      // Utility
      Calculator: 'calculator',
      FirstRunEmpty: 'getting-started',
      },
    },
  };
}

type RootNavigatorProps = {
  onReady?: () => void;
};

const INITIAL_LINK_RESTORE_BUDGET_MS = 450;
const NAVIGATION_STATE_RESTORE_BUDGET_MS = 450;
const DRAFT_STATE_RESTORE_BUDGET_MS = 650;

export function RootNavigator({ onReady }: RootNavigatorProps) {
  const { colors } = useTheme();
  const { session, isLocalGuest, isHydrated: isAuthHydrated } = useAuth();
  const { isHydrated: isOnboardingHydrated, isComplete: isOnboardingComplete, nextStep } = useOnboarding();
  const { languageCode } = useLanguage();
  const measurementDecision = useMemo(() => getMeasurementModeDecision(), []);
  const linking = useMemo(() => buildLinkingOptions(measurementDecision.enabled), [measurementDecision.enabled]);
  const measurementCopy = getModeratedTestCopy(languageCode);
  const [initialState, setInitialState] = useState<NavigationState | undefined>();
  const [hasRestoredState, setHasRestoredState] = useState(false);
  const navigationRef = useNavigationContainerRef<RootStackParamList>();
  const quickExitManager = useMemo(() => QuickExitManager.getInstance(), []);
  const decoyPinManager = useMemo(() => DecoyPinManager.getInstance(), []);
  // Saved history carries draft IDs, so it is stored encrypted like drafts.
  const navigationStatePersister = useMemo(
    () => createNavigationStatePersister(encryptedAsyncStorage),
    [],
  );
  const quickExitPanHandlers = quickExitManager.getPanResponder()?.panHandlers ?? {};
  const routeTitle = useCallback(
    (routeName: keyof RootStackParamList) => getRootRouteTitle(routeName, languageCode),
    [languageCode],
  );

  const stage = useMemo<'signed-out' | 'onboarding' | 'main'>(() => {
    if (!session && !isLocalGuest) return 'signed-out';
    return isOnboardingComplete ? 'main' : 'onboarding';
  }, [session, isLocalGuest, isOnboardingComplete]);

  const navigationKey = useMemo(() => `nav-${stage}`, [stage]);
  const shouldUsePersistence = !!session && isOnboardingComplete;
  const initialRouteName = useMemo<keyof RootStackParamList>(() => {
    if (!session && !isLocalGuest) {
      return 'Landing';
    }
    if (!isOnboardingComplete) {
      return nextStep ?? 'Onboarding';
    }
    return 'MainTabs';
  }, [session, isLocalGuest, isOnboardingComplete, nextStep]);

  useEffect(() => {
    if (!shouldUsePersistence) {
      setInitialState(undefined);
      setHasRestoredState(true);
      return;
    }

    let isMounted = true;

    const restoreState = async () => {
      try {
        const initialUrl = await withStartupFallback(
          Linking.getInitialURL(),
          INITIAL_LINK_RESTORE_BUDGET_MS,
          null,
          () => {
            devPrivacyInfo('initial link restore released after budget', {
              reason: 'startup-budget-expired',
            });
          },
        );

        if (initialUrl == null) {
          const savedStateString = await withStartupFallback(
            navigationStatePersister.load(),
            NAVIGATION_STATE_RESTORE_BUDGET_MS,
            null,
            () => {
              devPrivacyInfo('navigation state restore released after budget', {
                reason: 'startup-budget-expired',
              });
            },
          );
          const localDrafts = savedStateString
            ? await withStartupFallback(
                draftStorage.getAllDrafts(),
                DRAFT_STATE_RESTORE_BUDGET_MS,
                [],
                () => {
                  devPrivacyInfo('navigation draft validation released after budget', {
                    reason: 'startup-budget-expired',
                  });
                },
              )
            : [];
          const availableDraftIds = new Set(localDrafts.map(draft => draft.id));
          const completedDraftIds = new Set(localDrafts.filter(isFinalReportDraftState).map(draft => draft.id));
          const state = savedStateString
            ? normalizeRestoredNavigationState(JSON.parse(savedStateString), availableDraftIds, completedDraftIds) as NavigationState | undefined
            : undefined;
          if (isMounted) {
            setInitialState(state);
          }
        } else if (isMounted) {
          setInitialState(undefined);
        }
      } catch (error) {
        devPrivacyWarn('navigation state restore failed', {
          reason: getPrivacySafeErrorReason(error),
        });
      } finally {
        if (isMounted) {
          setHasRestoredState(true);
        }
      }
    };

    setHasRestoredState(false);
    restoreState();

    return () => {
      isMounted = false;
    };
  }, [navigationStatePersister, shouldUsePersistence, navigationKey]);

  useEffect(() => {
    if (!shouldUsePersistence) {
      void navigationStatePersister.clear();
    }
  }, [navigationStatePersister, shouldUsePersistence]);

  useEffect(() => {
    let isMounted = true;

    quickExitManager.rehydrateFromStorage()
      .then(async () => {
        if (!isMounted) return;
        const canUnlockCalculator = await decoyPinManager.canUnlockCalculator();
        if (isMounted && !canUnlockCalculator && quickExitManager.getConfig().enabled) {
          await quickExitManager.setEnabled(false);
        }
      })
      .catch(() => {});

    const unsubscribe = quickExitManager.addListener(() => {
      if (stage === 'signed-out' || !navigationRef.isReady()) return;

      void resetToCalculatorDecoyIfUnlockable(navigationRef, () => decoyPinManager.canUnlockCalculator());
    });

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, [decoyPinManager, navigationRef, quickExitManager, stage]);

  const previousUserIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isAuthHydrated) return;

    const currentUserId = session?.user?.id ?? (isLocalGuest ? 'local-guest' : null);
    const previousUserId = previousUserIdRef.current;

    if (previousUserId && previousUserId !== currentUserId) {
      void navigationStatePersister.clear();
      setInitialState(undefined);
    }

    if (!currentUserId) {
      void navigationStatePersister.clear();
      setInitialState(undefined);
    }

    previousUserIdRef.current = currentUserId;
  }, [navigationStatePersister, session, isLocalGuest, isAuthHydrated]);

  if (!isAuthHydrated || !isOnboardingHydrated || !hasRestoredState) {
    return (
      <LaunchScreen
        message={languageCode === 'sw' ? 'Inarejesha eneo binafsi' : 'Restoring private workspace'}
      />
    );
  }

  return (
    <NavigationContainer
      ref={navigationRef}
      key={navigationKey}
      linking={linking}
      initialState={shouldUsePersistence ? initialState : undefined}
      onReady={() => {
        onReady?.();
      }}
      onStateChange={(state) => {
        if (shouldUsePersistence) {
          void navigationStatePersister.save(state);
        }
      }}
    >
      <View style={{ flex: 1 }} {...quickExitPanHandlers}>
        {measurementDecision.enabled ? (
          <View
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            style={{
              backgroundColor: colors.warningMuted,
              borderBottomColor: colors.warning,
              borderBottomWidth: borders.hairline,
              paddingHorizontal: spacing.md,
              paddingVertical: spacing.xs,
            }}
          >
            <Text style={[typography.labelSmall, { color: colors.textPrimary, textAlign: 'center' }]}>
              {measurementCopy.enabledBanner}
            </Text>
          </View>
        ) : null}
        <Stack.Navigator
        initialRouteName={initialRouteName}
        screenOptions={{
          headerStyle: {
            backgroundColor: colors.background,
          },
          headerTintColor: colors.foreground,
          headerRight: () => <BrandWordmark width={80} animated={false} />,
          headerTitleStyle: {
            fontFamily: fontFamilies.text,
            fontSize: typography.titleMedium.fontSize,
            fontWeight: '700',
          },
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        {!session && !isLocalGuest ? (
          <>
            <Stack.Screen
              name="Landing"
              component={LandingScreen}
              options={{ headerShown: false }}
            />
            <Stack.Screen
              name="Auth"
              component={AuthScreen}
              options={{ headerShown: false }}
            />
          </>
        ) : (
          <>
            {/* Onboarding flow */}
            <Stack.Screen 
              name="Splash" 
              component={SplashScreen}
              options={{ headerShown: false }}
            />
            <Stack.Screen 
              name="Onboarding" 
              component={OnboardingScreen}
              options={{ headerShown: false }}
            />
            <Stack.Screen 
              name="PermissionGate" 
              component={PermissionGateScreen}
              options={{ headerShown: false }}
            />
            <Stack.Screen 
              name="StealthTriggerSetup" 
              component={StealthTriggerSetupScreen}
              options={{ headerShown: false }}
            />
            
            {/* Main app */}
            <Stack.Screen 
              name="MainTabs" 
              component={BottomTabs}
              options={{ headerShown: false }}
            />
            
            {/* Case management */}
            <Stack.Screen
              name="Cases"
              component={CaseTrackerScreen}
              options={{ title: routeTitle('Cases') }}
            />
            <Stack.Screen 
              name="CaseDetail" 
              component={CaseDetailScreen}
              options={{ title: routeTitle('CaseDetail') }}
            />
            <Stack.Screen 
              name="EscalationConfirmation" 
              component={EscalationConfirmationScreen}
              options={{ title: routeTitle('EscalationConfirmation') }}
            />
            
            {/* Settings and info */}
            <Stack.Screen 
              name="Settings"
              component={SettingsScreen}
              options={{ title: routeTitle('Settings') }}
            />
            <Stack.Screen
              name="SafetySettings" 
              component={SafetySettingsScreen}
              options={{ title: routeTitle('SafetySettings') }}
            />
            <Stack.Screen 
              name="PrivacyData" 
              component={PrivacyDataScreen}
              options={{ title: routeTitle('PrivacyData') }}
            />
            <Stack.Screen 
              name="LanguageAccessibility" 
              component={LanguageAccessibilityScreen}
              options={{ title: routeTitle('LanguageAccessibility') }}
            />
            <Stack.Screen
              name="TestMeasurementConsent"
              component={TestMeasurementConsentScreen}
              options={{ title: routeTitle('TestMeasurementConsent') }}
            />
            <Stack.Screen
              name="IssueReport"
              component={IssueReportScreen}
              options={{ title: routeTitle('IssueReport') }}
            />
            <Stack.Screen
              name="TestSessionSummary"
              component={TestSessionSummaryScreen}
              options={{ title: routeTitle('TestSessionSummary') }}
            />
            <Stack.Screen 
              name="TipsRights" 
              component={TipsRightsScreen}
              options={{ title: routeTitle('TipsRights') }}
            />
            <Stack.Screen 
              name="AboutLegal" 
              component={AboutLegalScreen}
              options={{ title: routeTitle('AboutLegal') }}
            />
            
            {/* Utility screens */}
            <Stack.Screen 
              name="Calculator" 
              component={CalculatorScreen}
              options={{ headerShown: false }}
            />
            <Stack.Screen 
              name="FirstRunEmpty" 
              component={FirstRunEmptyScreen}
              options={{ headerShown: false }}
            />
          </>
        )}
        </Stack.Navigator>
      </View>
    </NavigationContainer>
  );
}
