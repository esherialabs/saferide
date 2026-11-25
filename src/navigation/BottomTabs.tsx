import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MainTabParamList, ReportStackParamList } from './routes';
import { MainTabName, getMainTabShell } from './shellRoutes';
import { resetToCalculatorDecoyIfUnlockable } from './quickExitNavigation';

import HomeScreen from '../screens/Home';
import ReportHubScreen from '../screens/ReportHub';
import DraftOverviewScreen from '../screens/DraftOverview';
import EvidenceDetailScreen from '../screens/EvidenceDetail';
import WhatHappenedScreen from '../screens/WhatHappened';
import WhereWhenScreen from '../screens/WhereWhen';
import ConsentGateScreen from '../screens/ConsentGate';
import ReferralPickerScreen from '../screens/ReferralPicker';
import EscalationFormScreen from '../screens/EscalationForm';
import StatementReviewScreen from '../screens/StatementReview';
import ChatLegalAidScreen from '../screens/ChatLegalAid';
import LearnScreen from '../screens/Learn';
import { AppHeader } from '../components/ui/AppShell';
import { useTheme } from '../theme/SimpleThemeProvider';
import { borders, radii, spacing, typography } from '../theme/tokens';
import { DecoyPinManager } from '../utils/decoyPin';
import { useLanguage } from '../context/LanguageProvider';

const Tab = createBottomTabNavigator<MainTabParamList>();
const ReportStack = createNativeStackNavigator<ReportStackParamList>();

function ReportStackScreen() {
  return (
    <ReportStack.Navigator
      initialRouteName="ReportHome"
      screenOptions={{ headerShown: false }}
    >
      <ReportStack.Screen name="ReportHome" component={ReportHubScreen} />
      <ReportStack.Screen name="DraftOverview" component={DraftOverviewScreen} />
      <ReportStack.Screen name="WhatHappened" component={WhatHappenedScreen} />
      <ReportStack.Screen name="WhereWhen" component={WhereWhenScreen} />
      <ReportStack.Screen name="EvidenceDetail" component={EvidenceDetailScreen} />
      <ReportStack.Screen name="ConsentGate" component={ConsentGateScreen} />
      <ReportStack.Screen name="ReferralPicker" component={ReferralPickerScreen} />
      <ReportStack.Screen name="EscalationForm" component={EscalationFormScreen} />
      <ReportStack.Screen name="StatementReview" component={StatementReviewScreen} />
    </ReportStack.Navigator>
  );
}

export function BottomTabs() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { fontScale, width } = useWindowDimensions();
  const { languageCode } = useLanguage();
  const decoyPinManager = useMemo(() => DecoyPinManager.getInstance(), []);
  const tabShell = useMemo(() => getMainTabShell(languageCode), [languageCode]);
  const labelLayoutKey = `${width}:${fontScale}:${languageCode}`;
  const [measuredLabelLines, setMeasuredLabelLines] = useState<Record<string, Record<string, number>>>({});
  const labelLines = Math.max(
    fontScale >= 1.6 && width < 390 ? 2 : 1,
    ...Object.values(measuredLabelLines[labelLayoutKey] ?? {}),
  );
  // UIKit navigator: 30dp icon slot + label + 5dp button padding on each side.
  const tabButtonHeight = Math.max(48, 30 + 2 + typography.labelSmall.lineHeight * fontScale * labelLines + 10);
  const tabBarHeight = insets.bottom + borders.hairline + spacing.xs + spacing.xxs + spacing.xxxs * 2 + tabButtonHeight;
  const [calculatorUnlockable, setCalculatorUnlockable] = useState(false);

  const refreshCalculatorUnlockable = useCallback(() => {
    let isActive = true;

    decoyPinManager.canUnlockCalculator()
      .then((canUnlock) => {
        if (isActive) setCalculatorUnlockable(canUnlock);
      })
      .catch(() => {
        if (isActive) setCalculatorUnlockable(false);
      });

    return () => {
      isActive = false;
    };
  }, [decoyPinManager]);

  useEffect(() => refreshCalculatorUnlockable(), [refreshCalculatorUnlockable]);
  useFocusEffect(refreshCalculatorUnlockable);

  return (
    <Tab.Navigator
      initialRouteName="Home"
      screenOptions={({ route, navigation }) => {
        const tabName = route.name as MainTabName;
        const shell = tabShell[tabName];

        return {
          header: () => (
            <AppHeader
              title={shell.title}
              subtitle={tabName === 'Home' ? undefined : shell.subtitle}
              showAppearance={tabName === 'Home'}
              onSettingsPress={() => (navigation.getParent() as any)?.navigate('Settings')}
              onQuickExitPress={() => {
                void resetToCalculatorDecoyIfUnlockable(navigation, () => decoyPinManager.canUnlockCalculator());
              }}
              showQuickExit={calculatorUnlockable}
            />
          ),
          tabBarActiveTintColor: colors.primary,
          tabBarInactiveTintColor: colors.textSecondary,
          title: shell.label,
          tabBarAccessibilityLabel: shell.label,
          tabBarLabelPosition: 'below-icon',
          tabBarIconStyle: { width: 56, height: 30 },
          // Keep the device's text size; the dock grows to fit the label beneath its icon.
          tabBarLabel: ({ color }) => (
            <Text
              style={[styles.tabLabel, { color }]}
              onTextLayout={({ nativeEvent }) => {
                const lines = Math.max(1, nativeEvent.lines.length);
                setMeasuredLabelLines(previous => previous[labelLayoutKey]?.[route.name] === lines
                  ? previous
                  : { ...previous, [labelLayoutKey]: { ...previous[labelLayoutKey], [route.name]: lines } });
              }}
            >
              {shell.label}
            </Text>
          ),
          tabBarItemStyle: styles.tabItem,
          tabBarStyle: {
            backgroundColor: colors.surface,
            borderTopColor: colors.divider,
            borderTopWidth: borders.hairline,
            // Custom padding replaces the navigator's default, so the system inset is added back here.
            height: tabBarHeight,
            paddingBottom: insets.bottom + spacing.xxs,
            paddingHorizontal: spacing.xs,
            paddingTop: spacing.xs,
          },
          tabBarIcon: ({ color, focused }) => (
            <View style={[styles.tabIconWrap, { backgroundColor: focused ? colors.primaryMuted : 'transparent' }]}>
              <Ionicons name={shell.icon as keyof typeof Ionicons.glyphMap} size={22} color={focused ? colors.primary : color} />
            </View>
          ),
        };
      }}
    >
      <Tab.Screen name="Home" component={HomeScreen} />
      <Tab.Screen name="Report" component={ReportStackScreen} />
      <Tab.Screen name="Support" component={ChatLegalAidScreen} />
      <Tab.Screen name="Learn" component={LearnScreen} />
    </Tab.Navigator>
  );
}

const styles = StyleSheet.create({
  tabLabel: {
    ...typography.labelSmall,
    flexShrink: 0,
    fontWeight: '700',
    lineHeight: typography.labelSmall.lineHeight,
    marginTop: 2,
    minHeight: typography.labelSmall.lineHeight,
    alignSelf: 'stretch',
    maxWidth: '100%',
    minWidth: 0,
    textAlign: 'center',
  },
  tabItem: {
    borderRadius: 0,
    flex: 1,
    minWidth: 0,
    paddingBottom: spacing.xxxs,
    paddingTop: spacing.xxxs,
  },
  tabIconWrap: {
    alignItems: 'center',
    borderRadius: radii.round,
    flexShrink: 0,
    justifyContent: 'center',
    minHeight: 30,
    minWidth: 56,
    position: 'relative',
  },
});
