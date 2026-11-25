// Preview-only screen contexts. No accounts, navigation, or persistence.
import { useEffect } from 'react';
const noop = () => {};
const unavailable = async () => { throw new Error('Synthetic preview: account actions unavailable.'); };
const navigation = { navigate: noop, replace: noop, reset: noop, goBack: noop, setParams: noop, setOptions: noop, dispatch: noop, addListener: () => noop, getParent: () => null, canGoBack: () => false, isFocused: () => true };
export const useNavigation = () => navigation;
export const useIsFocused = () => true;
// Preview screens stay focused; match navigation's callback dependency contract.
export const useFocusEffect = (effect: () => void | (() => void)) => useEffect(effect, [effect]);
export const useRoute = () => ({ params: { action: 'sign-in', draftId: 'synthetic-ui-draft', caseId: 'synthetic-ui-case' } });
export const useOnboarding = () => ({
  state: { steps: { Onboarding: false, PermissionGate: false, StealthTriggerSetup: false }, permissionStatus: { location: 'pending', audio: 'pending' } },
  markStepComplete: async () => {},
  updatePermissionStatus: async () => {},
});
export const useAuth = () => ({
  signInWithPassword: unavailable, signUpWithPassword: unavailable,
  signInAnonymously: unavailable, isLocalGuest: true, isLoading: false,
  isAuthenticatingWithLink: false, linkError: null, clearLinkError: noop,
  user: null, signOut: unavailable,
});
export const useStealthMode = () => ({ quickExit: noop, quickExitAvailable: false });
export const useLanguage = () => ({ languageCode: new URLSearchParams(window.location.search).get('language') === 'sw' ? 'sw' : 'en' });
