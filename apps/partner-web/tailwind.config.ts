import type { Config } from 'tailwindcss';

// Colours are CSS variables (src/styles/globals.css) so light and dark mode
// share one set of class names. Fonts are self-hosted (public/fonts); nothing
// is downloaded from a font service.
const token = (name: string) => `rgb(var(--c-${name}) / <alpha-value>)`;
const tokens = (names: string[]) => Object.fromEntries(names.map(name => [name, token(name)]));

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: tokens([
        'canvas', 'surface', 'surface-2', 'surface-3',
        'ink', 'ink-2', 'ink-3', 'line', 'line-strong',
        'primary', 'primary-hover', 'on-primary', 'danger', 'danger-hover', 'on-danger',
        'link', 'focus', 'selected', 'on-selected',
        'brand-orange', 'brand-orange-strong', 'brand-blue', 'brand-green', 'brand-yellow',
        'info-bg', 'info-fg', 'info-line', 'success-bg', 'success-fg', 'success-line',
        'warning-bg', 'warning-fg', 'warning-line', 'error-bg', 'error-fg', 'error-line',
        'orange-bg', 'orange-fg', 'orange-line', 'neutral-bg', 'neutral-fg', 'neutral-line',
      ]),
      fontFamily: {
        sans: ['"Mozilla Text"', 'system-ui', '-apple-system', '"Segoe UI"', 'Roboto', 'Arial', 'sans-serif'],
        display: ['"Mozilla Headline"', '"Mozilla Text"', 'system-ui', '-apple-system', '"Segoe UI"', 'Arial', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', '"Liberation Mono"', 'monospace'],
      },
      // SafeRide radii (src/theme/tokens.ts): input 12, button 14, card 16, chip full.
      borderRadius: { input: '12px', button: '14px', card: '16px' },
      boxShadow: { 1: 'var(--shadow-1)', 2: 'var(--shadow-2)', 3: 'var(--shadow-3)' },
      maxWidth: { content: '80rem' },
      minHeight: { target: '44px' },
      minWidth: { target: '44px' },
    },
  },
  plugins: [],
};

export default config;
