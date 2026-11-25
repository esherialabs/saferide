import { PathwayType } from '../types/pathways';
import type { NavigatorScreenParams } from '@react-navigation/native';

export type ReportDraftRouteParams = {
  draftId: string;
  editCompleted?: boolean;
};

export type ReportEntryRouteParams = {
  draftId?: string;
  editCompleted?: boolean;
};

export type RootStackParamList = {
  // Onboarding flow
  Splash: undefined;
  Landing: undefined;
  Onboarding: undefined;
  PermissionGate: undefined;
  StealthTriggerSetup: undefined;
  Auth: { action?: 'sign-in' | 'sign-up' } | undefined;
  
  // Main app
  MainTabs: undefined;
  
  // Incident reporting flow
  DraftOverview: { draftId?: string; editCompleted?: boolean };
  EvidenceDetail: ReportDraftRouteParams;
  WhatHappened: ReportEntryRouteParams | undefined;
  WhereWhen: ReportDraftRouteParams;
  ConsentGate: ReportDraftRouteParams & { pathway?: PathwayType };
  ReferralPicker: ReportDraftRouteParams & { contactReady?: boolean };
  EscalationForm: ReportDraftRouteParams;
  StatementReview: ReportDraftRouteParams;
  
  // Case management
  Cases: undefined;
  CaseDetail: { caseId: string; openAddInfo?: boolean };
  EscalationConfirmation: { isOffline?: boolean; caseId: string; contactMethod: string; draftId?: string };
  
  // Settings and info
  Settings: undefined;
  SafetySettings: undefined;
  PrivacyData: undefined;
  LanguageAccessibility: undefined;
  TestMeasurementConsent: undefined;
  IssueReport: undefined;
  TestSessionSummary: undefined;
  TipsRights: undefined;
  AboutLegal: undefined;
  
  // Quick exit
  Calculator: undefined;
  
  // Empty states
  FirstRunEmpty: undefined;
};

export type MainTabParamList = {
  Home: undefined;
  Report: NavigatorScreenParams<ReportStackParamList> | undefined;
  Support: undefined;
  Learn: undefined;
};

export type ReportStackParamList = {
  ReportHome: undefined;
  DraftOverview: RootStackParamList['DraftOverview'];
  EvidenceDetail: RootStackParamList['EvidenceDetail'];
  WhatHappened: RootStackParamList['WhatHappened'];
  WhereWhen: RootStackParamList['WhereWhen'];
  ConsentGate: RootStackParamList['ConsentGate'];
  ReferralPicker: RootStackParamList['ReferralPicker'];
  EscalationForm: RootStackParamList['EscalationForm'];
  StatementReview: RootStackParamList['StatementReview'];
};

export const SCREEN_NAMES = {
  // Onboarding
  SPLASH: 'Splash' as const,
  LANDING: 'Landing' as const,
  ONBOARDING: 'Onboarding' as const,
  PERMISSION_GATE: 'PermissionGate' as const,
  STEALTH_TRIGGER_SETUP: 'StealthTriggerSetup' as const,
  AUTH: 'Auth' as const,
  
  // Main tabs
  MAIN_TABS: 'MainTabs' as const,
  HOME: 'Home' as const,
  REPORT: 'Report' as const,
  CASES: 'Cases' as const,
  SUPPORT: 'Support' as const,
  SETTINGS: 'Settings' as const,
  
  // Incident flow
  DRAFT_OVERVIEW: 'DraftOverview' as const,
  EVIDENCE_DETAIL: 'EvidenceDetail' as const,
  WHAT_HAPPENED: 'WhatHappened' as const,
  WHERE_WHEN: 'WhereWhen' as const,
  CONSENT_GATE: 'ConsentGate' as const,
  REFERRAL_PICKER: 'ReferralPicker' as const,
  ESCALATION_FORM: 'EscalationForm' as const,
  STATEMENT_REVIEW: 'StatementReview' as const,
  
  // Case management
  CASE_DETAIL: 'CaseDetail' as const,
  ESCALATION_CONFIRMATION: 'EscalationConfirmation' as const,
  
  // Settings
  SETTINGS_HUB: 'Settings' as const,
  SAFETY_SETTINGS: 'SafetySettings' as const,
  PRIVACY_DATA: 'PrivacyData' as const,
  LANGUAGE_ACCESSIBILITY: 'LanguageAccessibility' as const,
  TEST_MEASUREMENT_CONSENT: 'TestMeasurementConsent' as const,
  ISSUE_REPORT: 'IssueReport' as const,
  TEST_SESSION_SUMMARY: 'TestSessionSummary' as const,
  LEARN: 'Learn' as const,
  TIPS_RIGHTS: 'TipsRights' as const,
  ABOUT_LEGAL: 'AboutLegal' as const,
  
  // Utility
  CALCULATOR: 'Calculator' as const,
  FIRST_RUN_EMPTY: 'FirstRunEmpty' as const,
} as const;
