// Preview-only, volatile settings. No production storage import or persistence.
import type { ThemePreference } from '../../src/theme/tokens';
import { normalizeVisualStyle, type VisualStyle } from '../../src/theme/visualStyles';
const requested = new URLSearchParams(window.location.search).get('theme');
let theme: ThemePreference = requested === 'dark' || requested === 'highContrast' ? requested : 'light';
let visualStyle: VisualStyle = normalizeVisualStyle(new URLSearchParams(window.location.search).get('style'));
export const Storage = {
  getSettings: async () => ({ theme, visualStyle }),
  saveSettings: async (settings: { theme?: ThemePreference; visualStyle?: VisualStyle }) => {
    if (settings.theme) theme = settings.theme;
    if (settings.visualStyle) visualStyle = settings.visualStyle;
  },
};
