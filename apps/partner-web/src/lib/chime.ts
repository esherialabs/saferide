/**
 * The optional, quiet chime for new urgent cases: two soft sine notes made
 * with the Web Audio API (no audio file, nothing fetched, so the CSP needs
 * no media-src). Off by default. The switch lives in memory only, so it is
 * off again after a reload. It never uses browser notifications, which
 * would show on a lock screen.
 */
type AudioContextLike = AudioContext;

let context: AudioContextLike | null = null;

function audioContextClass(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  const candidate = (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
  return typeof candidate === 'function' ? candidate : null;
}

/** Called from the click that switches the chime on: browsers only allow audio after a user gesture. */
export function prepareChime(): void {
  const Context = audioContextClass();
  if (!Context) return;
  try {
    context ??= new Context();
    void context.resume().catch(() => undefined);
  } catch {
    context = null;
  }
}

function note(ctx: AudioContextLike, frequency: number, start: number): void {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(0.06, start + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.4);
  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start(start);
  oscillator.stop(start + 0.42);
}

export function playChime(): void {
  if (!context) return;
  try {
    const start = context.currentTime + 0.01;
    note(context, 660, start);
    note(context, 880, start + 0.18);
  } catch {
    // Audio is a nicety; the banner and count carry the alert.
  }
}
