// One fade travels through S, a, f, e, R, i, d, e; adjacent fades overlap by 600ms.
export const WORDMARK_LETTER_COUNT = 8;
export const WORDMARK_LETTER_INTERVAL_MS = 1600;
export const WORDMARK_CYCLE_MS = WORDMARK_LETTER_COUNT * WORDMARK_LETTER_INTERVAL_MS;
export const WORDMARK_MIN_HIGHLIGHT_OPACITY = 0.38;

export function wordmarkHighlightKeyframes(index: number) {
  const start = index * WORDMARK_LETTER_INTERVAL_MS;
  const inputRange: number[] = [];
  const outputRange: number[] = [];
  const add = (time: number, opacity: number) => {
    if (time >= 0 && time <= WORDMARK_CYCLE_MS) {
      inputRange.push(time);
      outputRange.push(opacity);
    }
  };
  // Cosine easing sampled into native-driver interpolation: no per-frame JS.
  const sample = (from: number, to: number, elapsed: number, duration: number) => {
    for (let step = 0; step <= 16; step++) {
      const phase = step / 16;
      add(elapsed + phase * duration, from + (to - from) * (1 - Math.cos(Math.PI * phase)) / 2);
    }
  };
  const previousFadeEnd = start - WORDMARK_CYCLE_MS + 2200;
  if (previousFadeEnd > 0) {
    // Continue the last letter's return across the loop boundary without a jump.
    for (let time = 0; time <= previousFadeEnd; time += 50) {
      const phase = (time - (start - WORDMARK_CYCLE_MS + 1200)) / 1000;
      add(time, WORDMARK_MIN_HIGHLIGHT_OPACITY + (1 - WORDMARK_MIN_HIGHLIGHT_OPACITY) * (1 - Math.cos(Math.PI * phase)) / 2);
    }
  } else {
    add(0, 1);
  }
  if (start > 0) add(start, 1);
  sample(1, WORDMARK_MIN_HIGHLIGHT_OPACITY, start, 800);
  add(start + 1200, WORDMARK_MIN_HIGHLIGHT_OPACITY);
  sample(WORDMARK_MIN_HIGHLIGHT_OPACITY, 1, start + 1200, 1000);
  if (inputRange[inputRange.length - 1] < WORDMARK_CYCLE_MS) {
    const phase = (WORDMARK_CYCLE_MS - (start + 1200)) / 1000;
    add(WORDMARK_CYCLE_MS, phase >= 1 ? 1 : WORDMARK_MIN_HIGHLIGHT_OPACITY + (1 - WORDMARK_MIN_HIGHLIGHT_OPACITY) * (1 - Math.cos(Math.PI * phase)) / 2);
  }
  // Adjacent samples can share an endpoint; Animated expects strictly increasing times.
  return {
    inputRange: inputRange.filter((value, i) => i === 0 || value !== inputRange[i - 1]).map(value => value / WORDMARK_CYCLE_MS),
    outputRange: outputRange.filter((_, i) => i === 0 || inputRange[i] !== inputRange[i - 1]),
    extrapolate: 'clamp' as const,
  };
}
