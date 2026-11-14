import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { LEGAL_LINKS } from '../legalLinks';

describe('legal links', () => {
  it('point at the published SafeRide pages over https', () => {
    expect(LEGAL_LINKS).toEqual({
      terms: 'https://saferide.esheria.org/terms',
      privacy: 'https://saferide.esheria.org/privacy',
    });
  });

  it('are what the About and legal screen opens, with no placeholder domain left', () => {
    const screen = readFileSync(fileURLToPath(new URL('../../screens/AboutLegal.tsx', import.meta.url)), 'utf8');
    expect(screen).toContain('Linking.openURL(LEGAL_LINKS.terms)');
    expect(screen).toContain('Linking.openURL(LEGAL_LINKS.privacy)');
    expect(screen).not.toMatch(/example\.(com|org)/);
  });
});
