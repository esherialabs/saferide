import { describe, expect, it } from 'vitest';

import { MAX_SCRUB_INPUT, scrubCoordinates, scrubPacketLocation } from '../partnerLocationScrub.js';

// Synthetic positions (Mombasa and Nairobi CBD); no real report is implied.
const DIGITS = /4\.04|39\.66|1\.2863|36\.817|4°|39°|02'|40'/;

describe('coordinate scrubbing for partners', () => {
  it('drops the app’s "Coordinates: lat, lng" segment and keeps the place description (none/light packets)', () => {
    // Exactly what escalationPacket.ts buildLocation produces at none/light redaction.
    expect(scrubPacketLocation('Synthetic stage near the market | Moi Avenue, Mombasa | public_transport | Coordinates: -4.0435, 39.6682'))
      .toBe('Synthetic stage near the market | Moi Avenue, Mombasa | public_transport');
    expect(scrubPacketLocation('Matatu stage | Coordinates: -4.043477123456, 39.668206456789'))
      .toBe('Matatu stage');
    expect(scrubPacketLocation('Coordinates: -1.286389, 36.817223')).toBe('Place description not provided (coordinates withheld)');
    expect(scrubPacketLocation('Coordinates: -4, 39')).toBe('Place description not provided (coordinates withheld)');
  });

  it('removes coordinates written any other way inside the location', () => {
    for (const location of [
      'Bus stop at -4.0435, 39.6682',
      'Bus stop at -4.0435 39.6682',
      'Bus stop at 4.0435 S, 39.6682 E',
      'Bus stop at 4°02\'36.5"S 39°40\'05.5"E',
      'Bus stop at geo:-4.0435,39.6682',
      'Bus stop at https://maps.google.com/?q=-4.0435,39.6682',
      'Bus stop at https://www.google.com/maps/@-4.0435,39.6682,17z',
      'Bus stop at lat: -4.0435 lng: 39.6682',
      'Bus stop at −4.0435, 39.6682',
      'Bus stop | GPS -4.0435 39.6682',
      'Bus stop | latitude=-4.0435 | longitude=39.6682',
    ]) {
      const scrubbed = scrubPacketLocation(location);
      expect(scrubbed, location).toMatch(/^Bus stop/);
      expect(scrubbed, location).not.toMatch(DIGITS);
    }
  });

  it('scrubs coordinates from free text but keeps ordinary words and numbers', () => {
    expect(scrubCoordinates('He followed me from -4.043512, 39.668234 to the stage'))
      .toBe('He followed me from [coordinates withheld] to the stage');
    expect(scrubCoordinates('Pin: https://maps.app.goo.gl/SyntheticPin123 near the gate')).not.toMatch(/goo\.gl/);
    for (const text of [
      'Long Street, near Latema Road', 'I paid 50.00, then 20.00 more', 'Stage 2, 3rd Avenue', 'Around 7.30 pm, 2 people',
      'a long 4 hour wait', 'Platform 1.5',
    ]) {
      expect(scrubCoordinates(text)).toBe(text);
      expect(scrubPacketLocation(text)).toBe(text);
    }
  });

  describe('formats found in the re-review of #294 (best effort)', () => {
    const LEAK = /4[.,]04|39[.,]66|PR6C|6GCR|index\.home\.raft|deg|\bmin\b/i;
    const PROBES = [
      'S4.0435 E39.6682',
      's4.0435, e39.6682',
      '-4,0435 39,6682',
      '-4,04351, 39,66823',
      '-4.0435 and 39.6682',
      '-4.0435 na 39.6682',
      '-4.0435 & 39.6682',
      'lat-4.0435 long39.6682',
      'lat -4.0435 lon 39.6682',
      'Coordinates: -4.0435, 39.6682',
      '4 deg 2 min S, 39 deg 40 min E',
      '4 degrees 2 minutes south 39 degrees 40 minutes east',
      '4deg02min36sec S',
      '-4.0435|39.6682',
      '-4.0435 | 39.6682',
      '4.0435 South 39.6682 East',
      '4.0435° S, 39.6682° E',
      'https://www.bing.com/maps?cp=-4.0435~39.6682&lvl=17',
      'https://binged.it/SyntheticPin',
      '6GCRPR6C+24',
      'PR6C+24',
      '///index.home.raft',
      'w3w: index.home.raft',
      'https://w3w.co/index.home.raft',
      'https://maps.apple.com/?ll=-4.0435,39.6682',
      'https://example.invalid/?ll=-4.0435,39.6682',
    ];

    it('removes each format from free text', () => {
      for (const probe of PROBES) {
        const scrubbed = scrubCoordinates(`He waited at ${probe} for me`);
        expect(scrubbed, probe).not.toMatch(LEAK);
        expect(scrubbed, probe).toMatch(/^He waited at .*for me$/);
      }
    });

    it('removes each format from the location, keeping the place description', () => {
      for (const probe of PROBES) {
        expect(scrubPacketLocation(`Synthetic stage | ${probe}`), probe).toBe('Synthetic stage');
        expect(scrubPacketLocation(`Synthetic stage ${probe}`), probe).toBe('Synthetic stage');
      }
      expect(scrubPacketLocation('-4.0435|39.6682')).toBe('Place description not provided (coordinates withheld)');
      // A short plus code goes; the town it is relative to is a textual description and stays.
      expect(scrubPacketLocation('Synthetic stage | PR6C+24 Mombasa')).toBe('Synthetic stage | Mombasa');
    });

    it('keeps money, times, vehicle plates and other ordinary numbers', () => {
      for (const text of [
        'KSh 4,500', 'Paid KSh 4,500 and 3,200', 'Fare KES 4,500/3,200', 'Sh. 1,234,567 lost',
        'At 7.30 pm, 2 people', 'between 7.30 and 8.15', 'at 7.45am and 8.15am', 'from 18:45 to 19:10', 'around 4.30 pm and 5.15 pm',
        'Vehicle plates KCA 123A, KBZ 456Q and KDG 001X', 'Matatu route 46 and 111', 'Plot 4/500, Moi Avenue',
        '3.5 km and 2.25 km away', 'He paid 50.00, then 20.00 more', 'Phone battery at 40%, 2 bars',
        'Long Street, near Latema Road', 'a long 4 hour wait', 'Stage 2, 3rd Avenue', 'Platform 1.5',
        'Scored 4.25/5', 'Saw him on 21.10.2026',
      ]) {
        expect(scrubCoordinates(text), text).toBe(text);
        expect(scrubPacketLocation(text), text).toBe(text);
      }
    });

    it('needs a plausible latitude/longitude for a bare decimal pair', () => {
      expect(scrubCoordinates('Readings 123.4567, 456.7891 recorded')).toBe('Readings 123.4567, 456.7891 recorded');
      expect(scrubCoordinates('At 39.6682, -4.0435 near the gate')).toBe('At [coordinates withheld] near the gate');
    });
  });

  describe('review of #297: linear time, number boundaries and extra formats', () => {
    function timed(run: () => unknown): number {
      const started = performance.now();
      run();
      return performance.now() - started;
    }

    it('scrubs the reviewer’s adversarial fields in well under 50 ms each', () => {
      const fields = [
        `lat${' '.repeat(8000)}`,
        `Coordinates${' '.repeat(8000)}:`,
        `location${' '.repeat(8000)}pin`,
        ','.repeat(10000),
        `x${','.repeat(10000)}x`,
        `-4.0435${','.repeat(10000)}`,
        `${' '.repeat(8000)}|`,
        '1.1111 '.repeat(1140),
        '4,0435 '.repeat(1140),
        '-4.0435 '.repeat(1000),
        `4${'.1'.repeat(4000)}`,
        `${'1'.repeat(8000)}.5`,
        'S4.0435 E'.repeat(880),
        '4 deg '.repeat(1300),
        '///a.b.'.repeat(1100),
        'https://'.repeat(990),
        'www.'.repeat(2000),
        'CCCC'.repeat(2000),
        `${'[coordinates withheld]'.repeat(300)}${','.repeat(5000)}`,
      ];
      for (const field of fields) {
        // Warm once, then measure.
        scrubCoordinates(field);
        scrubPacketLocation(field);
        expect(timed(() => scrubCoordinates(field)), JSON.stringify(field.slice(0, 16))).toBeLessThan(50);
        expect(timed(() => scrubPacketLocation(field)), JSON.stringify(field.slice(0, 16))).toBeLessThan(50);
      }
    });

    it('withholds text too long to check instead of scanning it', () => {
      expect(scrubCoordinates('a'.repeat(MAX_SCRUB_INPUT + 1))).toBe('[text withheld: too long to check for coordinates]');
      expect(scrubPacketLocation('a'.repeat(MAX_SCRUB_INPUT + 1))).toBe('[text withheld: too long to check for coordinates]');
    });

    it('never starts or ends a match inside another number', () => {
      expect(scrubCoordinates('Paid $ 40.125, 50.250 in total')).toBe('Paid $ 40.125, 50.250 in total');
      expect(scrubCoordinates('Paid 40.125, 50.250 in total')).toBe('Paid 40.125, 50.250 in total');
      expect(scrubPacketLocation('Seen 1.10.2026, 5.10.2026 at the stage')).toBe('Seen 1.10.2026, 5.10.2026 at the stage');
      expect(scrubCoordinates('Seen 1.10.2026, 5.10.2026 at the stage')).toBe('Seen 1.10.2026, 5.10.2026 at the stage');
      expect(scrubCoordinates('Code 4567+89 on the receipt')).toBe('Code 4567+89 on the receipt');
      expect(scrubCoordinates('Ref 12.3456789.12, 3.4567')).toBe('Ref 12.3456789.12, 3.4567');
    });

    it('treats bare pairs outside East Africa as ordinary numbers (documented trade-off), but not labelled or marked ones', () => {
      expect(scrubCoordinates('Ratio 1.125 to 1.250')).toBe('Ratio 1.125 to 1.250');
      expect(scrubCoordinates('London 51.5072, -0.1276')).toBe('London 51.5072, -0.1276');
      expect(scrubCoordinates('Pin 51.5072 N, 0.1276 W')).toBe('Pin [coordinates withheld]');
      expect(scrubCoordinates('Coordinates: 51.5072, -0.1276')).toBe('[coordinates withheld]');
      expect(scrubCoordinates('Nairobi -1.286389, 36.817223')).toBe('Nairobi [coordinates withheld]');
    });

    it('also removes %2C and plus joins, to/then/au joins, compact pairs and Swahili hemisphere words', () => {
      for (const probe of [
        'https://example.invalid/search?q=-4.0435%2C39.6682',
        '-4.0435+39.6682',
        '-4.0435 to 39.6682',
        '-4.0435 then 39.6682',
        '-4.0435 au 39.6682',
        '4.0435S39.6682E',
        'S4.0435E39.6682',
        '4.0435 kusini, 39.6682 mashariki',
        '0.5123 kaskazini 34.7612 magharibi',
        'geo:-4.0435%2C39.6682',
      ]) {
        const scrubbed = scrubCoordinates(`He waited at ${probe} for me`);
        expect(scrubbed, probe).not.toMatch(/4[.,]04|39[.,]66|0\.512|34\.76/);
        expect(scrubPacketLocation(`Synthetic stage | ${probe}`), probe).toBe('Synthetic stage');
      }
    });
  });

  describe('E2E finding: a labelled pair in free text must not leave its second half', () => {
    it.each([
      ['X. Coordinates: -4.0435, 39.6682', 'X. [coordinates withheld]'],
      ['X. Coordinates: -4.0435, 39.6682.', 'X. [coordinates withheld].'],
      ['X. Coordinates: -4.0435,39.6682 then left', 'X. [coordinates withheld] then left'],
      ['X. Coordinates: -4.04, 39.66.', 'X. [coordinates withheld].'],
      ['X. Coordinates: -4, 39.', 'X. [coordinates withheld].'],
      ['X. coordinates -4.0435 39.6682', 'X. [coordinates withheld]'],
      ['lat: -4.0435, lng: 39.6682.', '[coordinates withheld].'],
      ['He waited at -4.0435, 39.6682. Then he left', 'He waited at [coordinates withheld]. Then he left'],
    ])('%j', (input, expected) => {
      expect(scrubCoordinates(input)).toBe(expected);
      expect(scrubPacketLocation(input)).not.toMatch(/\d/);
    });

    it('still keeps dates and ordinary decimals at the end of a sentence', () => {
      expect(scrubCoordinates('Seen 1.10.2026, 5.10.2026.')).toBe('Seen 1.10.2026, 5.10.2026.');
      expect(scrubCoordinates('It cost 4.50, then 3.25.')).toBe('It cost 4.50, then 3.25.');
    });
  });
});
