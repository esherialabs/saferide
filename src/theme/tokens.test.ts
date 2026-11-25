import { describe, expect, it } from 'vitest';
import {
  accessibility,
  radii,
  semanticStates,
  themeColors,
  touchTargets,
  normalizeThemePreference,
  type SemanticStateName,
} from './tokens';
import { getVisualStyleColors, normalizeVisualStyle } from './visualStyles';

const requiredStates: SemanticStateName[] = [
  'critical',
  'safety',
  'warning',
  'offline',
  'queued',
  'consent',
  'evidence',
  'support',
  'case',
  'success',
  'destructive',
  'privacy',
  'info',
  'unavailable',
];

function contrast(first: string, second: string) {
  const luminance = (hex: string) => {
    const channels = hex.slice(1).match(/../g)!.map(value => parseInt(value, 16) / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('SafeRide design tokens', () => {
  for (const [mode, colors] of ['warm', 'classic'].flatMap(style =>
    (['light', 'dark', 'highContrast'] as const).map(mode =>
      [`${style}/${mode}`, getVisualStyleColors(style as 'warm' | 'classic', mode)] as const))) {
    it(`${mode}: keeps reading text and filled action labels at 4.5:1`, () => {
      for (const background of ['canvas', 'surface', 'surfaceAlt', 'parchment'] as const) {
        for (const text of ['foreground', 'textSecondary'] as const) {
          expect(contrast(colors[text], colors[background]), `${text} on ${background}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(contrast(colors.primaryForeground, colors.primary)).toBeGreaterThanOrEqual(4.5);
      for (const name of requiredStates) {
        const state = semanticStates[name];
        expect(contrast(colors[state.foreground], colors[state.color]), `${name} action`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(colors[state.color], colors[state.muted]), `${name} status`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`${mode}: keeps the second-pass page and card text pairs at 4.5:1`, () => {
      // Toned eyebrows and links sit on the canvas (page titles, step progress, privacy line).
      for (const tone of ['primary', 'support', 'evidence', 'privacy', 'safety', 'critical', 'consent'] as const) {
        expect(contrast(colors[tone], colors.canvas), `${tone} eyebrow on canvas`).toBeGreaterThanOrEqual(4.5);
      }
      // Home report card and selected choice cards use the primary tonal fill.
      for (const text of ['foreground', 'textSecondary', 'primary'] as const) {
        expect(contrast(colors[text], colors.primaryMuted), `${text} on primaryMuted`).toBeGreaterThanOrEqual(4.5);
      }
      // Emergency call tiles put labels on the support and critical tonal fills.
      for (const fill of ['supportMuted', 'criticalMuted'] as const) {
        expect(contrast(colors.foreground, colors[fill]), `foreground on ${fill}`).toBeGreaterThanOrEqual(4.5);
      }
      // Confirmation status value and report outline status labels.
      expect(contrast(colors.success, colors.surface), 'success on surface').toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.primary, colors.surface), 'primary on surface').toBeGreaterThanOrEqual(4.5);
      // Landing call pills print the number in textInverse on the tone fill.
      for (const fill of ['critical', 'support', 'safety'] as const) {
        expect(contrast(colors.textInverse, colors[fill]), `textInverse on ${fill}`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`${mode}: keeps input and selection outlines distinguishable at 3:1`, () => {
      for (const background of ['canvas', 'surface', 'surfaceAlt'] as const) {
        expect(contrast(colors.input, colors[background]), `input on ${background}`).toBeGreaterThanOrEqual(3);
        expect(contrast(colors.chipBorder, colors[background]), `chip on ${background}`).toBeGreaterThanOrEqual(3);
      }
    });
  }

  it('defines every required semantic state', () => {
    expect(Object.keys(semanticStates).sort()).toEqual([...requiredStates].sort());
  });

  it('resolves semantic state color roles for every theme mode', () => {
    Object.values(themeColors).forEach(colors => {
      requiredStates.forEach(stateName => {
        const state = semanticStates[stateName];

        expect(colors[state.color]).toBeTruthy();
        expect(colors[state.foreground]).toBeTruthy();
        expect(colors[state.muted]).toBeTruthy();
      });
    });
  });

  it('keeps controls inside the card radius and touch targets accessible', () => {
    expect(radii.input).toBeLessThanOrEqual(radii.card);
    expect(radii.button).toBeLessThanOrEqual(radii.card);
    expect(radii.round).toBe(999);
    expect(touchTargets.minimum).toBeGreaterThanOrEqual(48);
    expect(accessibility.minTouchTarget).toBe(touchTargets.minimum);
  });

  it('accepts high contrast and rejects corrupt persisted theme values', () => {
    expect(normalizeThemePreference('highContrast')).toBe('highContrast');
    expect(normalizeThemePreference('unsupported')).toBe('system');
  });

  it('defaults old settings to warm and keeps high contrast independent of visual style', () => {
    expect(normalizeVisualStyle(undefined)).toBe('warm');
    expect(normalizeVisualStyle('unknown')).toBe('warm');
    expect(normalizeVisualStyle('classic')).toBe('classic');
    expect(getVisualStyleColors('classic', 'highContrast')).toBe(themeColors.highContrast);
  });
});
