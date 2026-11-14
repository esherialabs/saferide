/**
 * Public legal pages for the app's About and legal screen. The runtime config
 * (GET /api/config/runtime) publishes no legal URLs, so these are fixed. The
 * pages are served by the SafeRide website (web/src/app/{privacy,terms}).
 */
export const LEGAL_LINKS = {
  terms: 'https://saferide.esheria.org/terms',
  privacy: 'https://saferide.esheria.org/privacy',
} as const;
