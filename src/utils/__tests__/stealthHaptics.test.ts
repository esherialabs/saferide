import * as Haptics from 'expo-haptics';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ OS: 'android' as string }));
const vibration = vi.hoisted(() => ({
  vibrate: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock('react-native', () => ({
  Platform: platform,
  Vibration: vibration,
}));

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success' },
  impactAsync: vi.fn(async () => undefined),
  notificationAsync: vi.fn(async () => undefined),
}));

import {
  ANDROID_HEARTBEAT_PATTERN,
  ANDROID_STOP_MS,
  ANDROID_TRIGGER_MS,
  IOS_HEARTBEAT_GAP_MS,
  PREVIEW_HEARTBEAT_DELAY_MS,
  PREVIEW_STOP_DELAY_MS,
  cancel,
  previewCues,
  recordingHeartbeat,
  stopConfirm,
  triggerConfirm,
} from '../stealthHaptics';

const impactAsync = vi.mocked(Haptics.impactAsync);
const notificationAsync = vi.mocked(Haptics.notificationAsync);

function setDev(value: boolean) {
  (globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__ = value;
}

describe('stealthHaptics', () => {
  beforeEach(() => {
    platform.OS = 'android';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T08:00:00.000Z'));
  });

  afterEach(() => {
    cancel();
    vibration.vibrate.mockReset();
    vibration.cancel.mockReset();
    impactAsync.mockReset();
    notificationAsync.mockReset();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('on Android', () => {
    it('plays the heartbeat as a duration-based double buzz, not a haptic tick', async () => {
      await recordingHeartbeat(true);

      expect(ANDROID_HEARTBEAT_PATTERN).toEqual([0, 80, 120, 80]);
      expect(vibration.vibrate).toHaveBeenCalledTimes(1);
      expect(vibration.vibrate).toHaveBeenCalledWith([0, 80, 120, 80]);
      expect(impactAsync).not.toHaveBeenCalled();
      expect(notificationAsync).not.toHaveBeenCalled();
    });

    it('confirms a trigger with a 150 ms buzz and a stop with a 200 ms buzz', async () => {
      await triggerConfirm(true);
      await stopConfirm(true);

      expect(vibration.vibrate).toHaveBeenNthCalledWith(1, ANDROID_TRIGGER_MS);
      expect(vibration.vibrate).toHaveBeenNthCalledWith(2, ANDROID_STOP_MS);
      expect(ANDROID_TRIGGER_MS).toBe(150);
      expect(ANDROID_STOP_MS).toBe(200);
      expect(ANDROID_STOP_MS).toBeGreaterThan(ANDROID_TRIGGER_MS);
      expect(impactAsync).not.toHaveBeenCalled();
      expect(notificationAsync).not.toHaveBeenCalled();
    });

    it('cancel stops a heartbeat that is still playing', async () => {
      await recordingHeartbeat(true);
      vi.advanceTimersByTime(100);

      cancel();

      expect(vibration.cancel).toHaveBeenCalledTimes(1);
    });

    it('cancel leaves the vibrator alone once the heartbeat has finished', async () => {
      await recordingHeartbeat(true);
      vi.advanceTimersByTime(300);

      cancel();

      expect(vibration.cancel).not.toHaveBeenCalled();
    });

    it('cancel does not cut short a trigger confirmation', async () => {
      await triggerConfirm(true);

      cancel();

      expect(vibration.cancel).not.toHaveBeenCalled();
    });

    it.each([
      ['trigger', triggerConfirm],
      ['stop', stopConfirm],
    ] as const)('cancel does not cut short a %s buzz that replaced a playing heartbeat', async (_cue, confirm) => {
      await recordingHeartbeat(true);
      vi.advanceTimersByTime(50);
      await confirm(true);

      cancel();

      expect(vibration.vibrate).toHaveBeenCalledTimes(2);
      expect(vibration.cancel).not.toHaveBeenCalled();
    });

    it('swallows vibration errors', async () => {
      vibration.vibrate.mockImplementation(() => {
        throw new Error('vibrator unavailable');
      });
      vibration.cancel.mockImplementation(() => {
        throw new Error('vibrator unavailable');
      });

      await expect(recordingHeartbeat(true)).resolves.toBeUndefined();
      await expect(triggerConfirm(true)).resolves.toBeUndefined();
      await expect(stopConfirm(true)).resolves.toBeUndefined();
      expect(() => cancel()).not.toThrow();
      expect(vibration.vibrate).toHaveBeenCalledTimes(3);
    });

    it('previews the trigger buzz, the heartbeat after 1 s and the stop buzz after 2.5 s', async () => {
      await previewCues(() => true);

      expect(vibration.vibrate).toHaveBeenCalledTimes(1);
      expect(vibration.vibrate).toHaveBeenLastCalledWith(ANDROID_TRIGGER_MS);

      vi.advanceTimersByTime(PREVIEW_HEARTBEAT_DELAY_MS - 1);
      expect(vibration.vibrate).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1);
      expect(vibration.vibrate).toHaveBeenCalledTimes(2);
      expect(vibration.vibrate).toHaveBeenLastCalledWith([0, 80, 120, 80]);

      vi.advanceTimersByTime(PREVIEW_STOP_DELAY_MS - PREVIEW_HEARTBEAT_DELAY_MS - 1);
      expect(vibration.vibrate).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(1);
      expect(vibration.vibrate).toHaveBeenCalledTimes(3);
      expect(vibration.vibrate).toHaveBeenLastCalledWith(ANDROID_STOP_MS);
      expect(PREVIEW_HEARTBEAT_DELAY_MS).toBe(1000);
      expect(PREVIEW_STOP_DELAY_MS).toBe(2500);
    });

    it('a repeat preview tap restarts the sequence instead of stacking heartbeats', async () => {
      await previewCues(() => true);
      vi.advanceTimersByTime(500);
      await previewCues(() => true);
      vi.advanceTimersByTime(PREVIEW_STOP_DELAY_MS * 2);

      expect(vibration.vibrate.mock.calls).toEqual([
        [ANDROID_TRIGGER_MS],
        [ANDROID_TRIGGER_MS],
        [[0, 80, 120, 80]],
        [ANDROID_STOP_MS],
      ]);
    });

    it('re-reads the setting before the delayed preview heartbeat and stop buzz', async () => {
      let enabled = true;
      await previewCues(() => enabled);
      enabled = false;
      vi.advanceTimersByTime(PREVIEW_STOP_DELAY_MS * 2);

      expect(vibration.vibrate).toHaveBeenCalledTimes(1);
      expect(vibration.vibrate).toHaveBeenCalledWith(ANDROID_TRIGGER_MS);
    });

    it('treats a setting getter that throws as off', async () => {
      await expect(
        previewCues(() => {
          throw new Error('settings unavailable');
        }),
      ).resolves.toBeUndefined();
      vi.advanceTimersByTime(PREVIEW_STOP_DELAY_MS * 2);

      expect(vibration.vibrate).not.toHaveBeenCalled();
    });

    it('cancel drops the pending preview heartbeat and stop buzz', async () => {
      await previewCues(() => true);
      cancel();
      vi.advanceTimersByTime(PREVIEW_STOP_DELAY_MS * 2);

      expect(vibration.vibrate).toHaveBeenCalledTimes(1);
      expect(vibration.vibrate).toHaveBeenCalledWith(ANDROID_TRIGGER_MS);
    });

    it('cancel swallows errors while stopping a playing heartbeat', async () => {
      vibration.cancel.mockImplementation(() => {
        throw new Error('vibrator unavailable');
      });
      await recordingHeartbeat(true);

      expect(() => cancel()).not.toThrow();
      expect(vibration.cancel).toHaveBeenCalledTimes(1);
    });
  });

  describe('on iOS', () => {
    beforeEach(() => {
      platform.OS = 'ios';
    });

    it('plays the heartbeat as two Heavy impacts about 150 ms apart', async () => {
      await recordingHeartbeat(true);

      expect(impactAsync).toHaveBeenCalledTimes(1);
      expect(impactAsync).toHaveBeenLastCalledWith('heavy');

      vi.advanceTimersByTime(IOS_HEARTBEAT_GAP_MS - 1);
      expect(impactAsync).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1);
      expect(impactAsync).toHaveBeenCalledTimes(2);
      expect(impactAsync).toHaveBeenNthCalledWith(2, 'heavy');
      expect(IOS_HEARTBEAT_GAP_MS).toBe(150);
      expect(vibration.vibrate).not.toHaveBeenCalled();
    });

    it('keeps the existing Heavy trigger and Success stop confirmations', async () => {
      await triggerConfirm(true);
      await stopConfirm(true);

      expect(impactAsync).toHaveBeenCalledTimes(1);
      expect(impactAsync).toHaveBeenCalledWith('heavy');
      expect(notificationAsync).toHaveBeenCalledTimes(1);
      expect(notificationAsync).toHaveBeenCalledWith('success');
      expect(vibration.vibrate).not.toHaveBeenCalled();
    });

    it('previews a Heavy trigger, the double Heavy heartbeat, then the Success stop', async () => {
      await previewCues(() => true);
      expect(impactAsync).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(PREVIEW_HEARTBEAT_DELAY_MS);
      expect(impactAsync).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(IOS_HEARTBEAT_GAP_MS);
      expect(impactAsync).toHaveBeenCalledTimes(3);
      expect(impactAsync.mock.calls).toEqual([['heavy'], ['heavy'], ['heavy']]);
      expect(notificationAsync).not.toHaveBeenCalled();

      vi.advanceTimersByTime(PREVIEW_STOP_DELAY_MS - PREVIEW_HEARTBEAT_DELAY_MS - IOS_HEARTBEAT_GAP_MS);
      expect(notificationAsync).toHaveBeenCalledTimes(1);
      expect(notificationAsync).toHaveBeenCalledWith('success');
      expect(vibration.vibrate).not.toHaveBeenCalled();
    });

    it('cancel drops the pending second pulse', async () => {
      await recordingHeartbeat(true);
      cancel();
      vi.advanceTimersByTime(IOS_HEARTBEAT_GAP_MS * 2);

      expect(impactAsync).toHaveBeenCalledTimes(1);
      expect(vibration.cancel).not.toHaveBeenCalled();
    });

    it('swallows rejected and thrown haptics errors, including the delayed second pulse', async () => {
      impactAsync.mockRejectedValue(new Error('haptics unavailable'));
      notificationAsync.mockImplementation(() => {
        throw new Error('haptics unavailable');
      });

      await expect(recordingHeartbeat(true)).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(IOS_HEARTBEAT_GAP_MS);
      await expect(triggerConfirm(true)).resolves.toBeUndefined();
      await expect(stopConfirm(true)).resolves.toBeUndefined();

      expect(impactAsync).toHaveBeenCalledTimes(3);
      expect(notificationAsync).toHaveBeenCalledTimes(1);
    });
  });

  it.each(['android', 'ios'])('fires nothing on %s when haptic feedback is turned off', async (os) => {
    platform.OS = os;

    await recordingHeartbeat(false);
    await triggerConfirm(false);
    await stopConfirm(false);
    await previewCues(() => false);
    await vi.advanceTimersByTimeAsync(PREVIEW_STOP_DELAY_MS * 2);
    cancel();

    expect(vibration.vibrate).not.toHaveBeenCalled();
    expect(vibration.cancel).not.toHaveBeenCalled();
    expect(impactAsync).not.toHaveBeenCalled();
    expect(notificationAsync).not.toHaveBeenCalled();
  });

  it('logs only the error type, never the error message', async () => {
    setDev(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vibration.vibrate.mockImplementation(() => {
      throw new Error('content://private/recording.m4a is busy');
    });

    await recordingHeartbeat(true);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[privacy] stealth haptic cue failed', {
      cue: 'heartbeat',
      reason: 'Error',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('recording.m4a');
  });
});
