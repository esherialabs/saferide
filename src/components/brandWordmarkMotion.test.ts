import { describe, expect, it } from 'vitest';
import { WORDMARK_CYCLE_MS, WORDMARK_LETTER_INTERVAL_MS, wordmarkHighlightKeyframes } from './brandWordmarkMotion';

function opacityAt(index: number, milliseconds: number) {
  const { inputRange, outputRange } = wordmarkHighlightKeyframes(index);
  const phase = (milliseconds % WORDMARK_CYCLE_MS) / WORDMARK_CYCLE_MS;
  const right = inputRange.findIndex(point => point >= phase);
  if (right === 0) return outputRange[0];
  const weight = (phase - inputRange[right - 1]) / (inputRange[right] - inputRange[right - 1]);
  return outputRange[right - 1] + weight * (outputRange[right] - outputRange[right - 1]);
}

describe('official wordmark fade sequence', () => {
  it('keeps every colour visible while each letter fades and returns in order', () => {
    for (let letter = 0; letter < 8; letter++) {
      const time = letter * WORDMARK_LETTER_INTERVAL_MS + 1000;
      expect(opacityAt(letter, time)).toBeCloseTo(0.38);
      for (let other = 0; other < 8; other++) {
        if (other !== letter) expect(opacityAt(other, time)).toBeCloseTo(1);
      }
    }
    for (let time = 0; time < WORDMARK_CYCLE_MS * 2; time += 50) {
      const values = Array.from({ length: 8 }, (_, index) => opacityAt(index, time));
      expect(values.every(value => value >= 0.38 && value <= 1)).toBe(true);
      expect(values.filter(value => value < 0.999).length).toBeLessThanOrEqual(2);
    }
  });

  it('continues the final letter into the first without a loop jump', () => {
    for (let letter = 0; letter < 8; letter++) {
      const frames = wordmarkHighlightKeyframes(letter);
      expect(frames.inputRange.every((value, index) => index === 0 || value > frames.inputRange[index - 1])).toBe(true);
      expect(frames.outputRange[0]).toBeCloseTo(frames.outputRange.at(-1)!, 8);
      expect(Math.abs(opacityAt(letter, WORDMARK_CYCLE_MS - 1) - opacityAt(letter, WORDMARK_CYCLE_MS + 1))).toBeLessThan(0.005);
    }
    expect(opacityAt(7, WORDMARK_CYCLE_MS + 300)).toBeLessThan(1);
    expect(opacityAt(0, WORDMARK_CYCLE_MS + 300)).toBeLessThan(1);
  });
});
