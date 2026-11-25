import { Platform, Vibration } from 'react-native';
import * as Haptics from 'expo-haptics';

import { devPrivacyWarn, getPrivacySafeErrorReason } from './privacyLog';

/**
 * Vibration cues for stealth recording.
 *
 * On Android, expo-haptics plays short, low-amplitude waveforms (Light impact is
 * 50 ms at amplitude 30/255), which are easy to miss with the phone in a pocket.
 * Android cues therefore use react-native's duration-based Vibration, which runs
 * at the device's default amplitude. iOS ignores Vibration durations and patterns,
 * so iOS keeps expo-haptics.
 *
 * Every cue takes the user's "Haptic feedback" setting and does nothing when it
 * is off. No cue ever throws or rejects: a vibration failure must never stop or
 * interrupt a recording.
 */

/** Android heartbeat as [wait, buzz, pause, buzz] in ms: two short, clearly separate pulses. */
export const ANDROID_HEARTBEAT_PATTERN: readonly number[] = [0, 80, 120, 80];
/** Android: one firm buzz when a stealth trigger is recognised. */
export const ANDROID_TRIGGER_MS = 150;
/** Android: one buzz when a stealth recording has stopped and been saved. */
export const ANDROID_STOP_MS = 200;
/** iOS: gap between the two Heavy impacts of the heartbeat. */
export const IOS_HEARTBEAT_GAP_MS = 150;
/** Settings preview: delay between the trigger buzz and the heartbeat. */
export const PREVIEW_HEARTBEAT_DELAY_MS = 1000;
/** Settings preview: delay between the trigger buzz and the stop buzz. */
export const PREVIEW_STOP_DELAY_MS = 2500;

const ANDROID_HEARTBEAT_TOTAL_MS = ANDROID_HEARTBEAT_PATTERN.reduce((total, ms) => total + ms, 0);

let pendingSecondPulse: ReturnType<typeof setTimeout> | null = null;
let pendingPreviewTimers: ReturnType<typeof setTimeout>[] = [];
let androidHeartbeatEndsAt = 0;

function reportFailure(cue: string, error: unknown): void {
  devPrivacyWarn('stealth haptic cue failed', { cue, reason: getPrivacySafeErrorReason(error) });
}

function vibrateAndroid(cue: string, pattern: number | number[]): boolean {
  try {
    Vibration.vibrate(pattern);
    return true;
  } catch (error) {
    reportFailure(cue, error);
    return false;
  }
}

/** A trigger or stop buzz replaces any heartbeat still playing on the Android vibrator. */
function vibrateAndroidConfirmation(cue: string, durationMs: number): void {
  if (vibrateAndroid(cue, durationMs)) {
    androidHeartbeatEndsAt = 0;
  }
}

async function heavyImpact(cue: string): Promise<void> {
  try {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
  } catch (error) {
    reportFailure(cue, error);
  }
}

function clearPendingSecondPulse(): void {
  if (pendingSecondPulse) {
    clearTimeout(pendingSecondPulse);
    pendingSecondPulse = null;
  }
}

function clearPendingPreview(): void {
  pendingPreviewTimers.forEach((timer) => clearTimeout(timer));
  pendingPreviewTimers = [];
}

function readSetting(isEnabled: () => boolean): boolean {
  try {
    return isEnabled() === true;
  } catch (error) {
    reportFailure('setting', error);
    return false;
  }
}

/** Periodic "still recording" cue: a double buzz. */
export async function recordingHeartbeat(enabled: boolean): Promise<void> {
  if (!enabled) return;

  if (Platform.OS === 'android') {
    if (vibrateAndroid('heartbeat', [...ANDROID_HEARTBEAT_PATTERN])) {
      androidHeartbeatEndsAt = Date.now() + ANDROID_HEARTBEAT_TOTAL_MS;
    }
    return;
  }

  clearPendingSecondPulse();
  const firstPulse = heavyImpact('heartbeat');
  pendingSecondPulse = setTimeout(() => {
    pendingSecondPulse = null;
    void heavyImpact('heartbeat');
  }, IOS_HEARTBEAT_GAP_MS);
  await firstPulse;
}

/** A stealth trigger (shake or secret tap) was recognised. */
export async function triggerConfirm(enabled: boolean): Promise<void> {
  if (!enabled) return;

  if (Platform.OS === 'android') {
    vibrateAndroidConfirmation('trigger', ANDROID_TRIGGER_MS);
    return;
  }

  await heavyImpact('trigger');
}

/** A stealth recording stopped and was saved as a draft. */
export async function stopConfirm(enabled: boolean): Promise<void> {
  if (!enabled) return;

  if (Platform.OS === 'android') {
    vibrateAndroidConfirmation('stop', ANDROID_STOP_MS);
    return;
  }

  try {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  } catch (error) {
    reportFailure('stop', error);
  }
}

/**
 * Lets the user feel the real cues from Safety Settings: the trigger buzz now,
 * the recording heartbeat after 1 s and the stop buzz after 2.5 s. `isEnabled`
 * is read again before each delayed cue, so turning the setting off
 * mid-preview silences the rest. A repeat tap restarts the sequence.
 */
export async function previewCues(isEnabled: () => boolean): Promise<void> {
  clearPendingPreview();
  if (!readSetting(isEnabled)) return;

  pendingPreviewTimers = [
    setTimeout(() => {
      void recordingHeartbeat(readSetting(isEnabled));
    }, PREVIEW_HEARTBEAT_DELAY_MS),
    setTimeout(() => {
      void stopConfirm(readSetting(isEnabled));
    }, PREVIEW_STOP_DELAY_MS),
  ];
  await triggerConfirm(true);
}

/**
 * Stops any heartbeat still in progress: pending preview cues, the
 * pending second iOS pulse, and an Android heartbeat pattern that is still
 * playing. Android's Vibration.cancel() stops every vibration from the app, so
 * it is only called while a heartbeat is the last thing played; a trigger or
 * stop buzz that is still playing is not cut short.
 */
export function cancel(): void {
  clearPendingSecondPulse();
  clearPendingPreview();

  const heartbeatPlaying = Date.now() < androidHeartbeatEndsAt;
  androidHeartbeatEndsAt = 0;
  if (Platform.OS !== 'android' || !heartbeatPlaying) return;

  try {
    Vibration.cancel();
  } catch (error) {
    reportFailure('cancel', error);
  }
}
