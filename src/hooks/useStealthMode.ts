import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DeviceEventEmitter, Alert } from 'react-native';
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import * as Location from 'expo-location';
import { Accelerometer } from 'expo-sensors';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { Storage } from '../lib/storage';
import { draftStorage } from '../utils/draftStorage';
import type { StealthSettings, StealthTrigger } from '../context/OnboardingProvider';
import { SCREEN_NAMES } from '../navigation/routes';
import { resetReportStackToRoute } from '../navigation/reportNavigation';
import { resetToCalculatorDecoyIfUnlockable } from '../navigation/quickExitNavigation';
import {
  APP_EVENT_STEALTH_SECRET_TAP,
  APP_EVENT_STEALTH_SETTINGS_CHANGED,
} from '../utils/appEvents';
import { devPrivacyError, devPrivacyWarn, getPrivacySafeErrorReason } from '../utils/privacyLog';
import { isStealthTriggerSupported, resolveStealthTrigger } from '../utils/stealthCapabilities';
import { DecoyPinManager } from '../utils/decoyPin';
import * as StealthHaptics from '../utils/stealthHaptics';

export function useStealthMode() {
  const [isRecording, setIsRecording] = useState(false);
  const [isArmed, setIsArmed] = useState(true);
  const [stealthTrigger, setStealthTrigger] = useState<StealthTrigger>(resolveStealthTrigger('shake'));
  const [hapticsEnabled, setHapticsEnabled] = useState(true);
  const [autoRecordEnabled, setAutoRecordEnabled] = useState(true);
  const [quickExitAvailable, setQuickExitAvailable] = useState(false);
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recordingRef = useRef<typeof audioRecorder | null>(null);
  const triggerStealthRecordingRef = useRef<() => Promise<void>>(async () => {});
  const hapticIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Timers outlive the render that created them, so they read the live setting from here.
  const hapticsEnabledRef = useRef(hapticsEnabled);
  hapticsEnabledRef.current = hapticsEnabled;
  const autoStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navigation = useNavigation();
  const decoyPinManager = useMemo(() => DecoyPinManager.getInstance(), []);

  const clearRecordingTimers = useCallback(() => {
    if (hapticIntervalRef.current) {
      clearInterval(hapticIntervalRef.current);
      hapticIntervalRef.current = null;
    }
    if (autoStopTimerRef.current) {
      clearTimeout(autoStopTimerRef.current);
      autoStopTimerRef.current = null;
    }
    StealthHaptics.cancel();
  }, []);

  useEffect(() => clearRecordingTimers, [clearRecordingTimers]);

  const refreshQuickExitAvailability = useCallback(() => {
    let isActive = true;

    decoyPinManager.canUnlockCalculator()
      .then((canUnlock) => {
        if (isActive) setQuickExitAvailable(canUnlock);
      })
      .catch(() => {
        if (isActive) setQuickExitAvailable(false);
      });

    return () => {
      isActive = false;
    };
  }, [decoyPinManager]);

  useEffect(() => refreshQuickExitAvailability(), [refreshQuickExitAvailability]);
  useFocusEffect(refreshQuickExitAvailability);

  useEffect(() => {
    let isMounted = true;

    const applySettings = (settings: Awaited<ReturnType<typeof Storage.getSettings>>) => {
      if (!isMounted) return;
      setStealthTrigger(resolveStealthTrigger(settings.stealthTrigger));
      setHapticsEnabled(settings.stealthHapticsEnabled);
      setAutoRecordEnabled(settings.stealthAutoRecordEnabled);
    };

    const loadSettings = async () => {
      try {
        const settings = await Storage.getSettings();
        applySettings(settings);
      } catch (error) {
        devPrivacyWarn('stealth settings load failed', { reason: getPrivacySafeErrorReason(error) });
      }
    };

    loadSettings();

    const subscription = DeviceEventEmitter.addListener(
      APP_EVENT_STEALTH_SETTINGS_CHANGED,
      (payload?: StealthSettings) => {
        if (payload && typeof payload === 'object') {
          setStealthTrigger(resolveStealthTrigger(payload.trigger));
          setHapticsEnabled(payload.enableVibration);
          setAutoRecordEnabled(payload.enableAutoRecord);
        } else {
          loadSettings();
        }
      },
    );

    return () => {
      isMounted = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (stealthTrigger !== 'shake' || !isStealthTriggerSupported('shake')) {
      return () => {};
    }

    let lastTriggerTime = 0;
    let subscription: ReturnType<typeof Accelerometer.addListener> | null = null;

    try {
      Accelerometer.setUpdateInterval(200);
      subscription = Accelerometer.addListener(({ x, y, z }) => {
        if (!isArmed) return;

        const magnitude = Math.sqrt(x * x + y * y + z * z);
        if (magnitude < 1.8) return;

        const now = Date.now();
        if (now - lastTriggerTime < 3000) {
          return;
        }

        lastTriggerTime = now;
        triggerStealthRecordingRef.current();
      });
    } catch (error) {
      devPrivacyWarn('stealth accelerometer unavailable', { reason: getPrivacySafeErrorReason(error) });
    }

    return () => {
      subscription?.remove();
    };
  }, [isArmed, stealthTrigger]);

  useEffect(() => {
    if (stealthTrigger !== 'tap' || !isStealthTriggerSupported('tap')) {
      return () => {};
    }

    let tapCount = 0;
    let resetTimer: ReturnType<typeof setTimeout> | null = null;

    const reset = () => {
      tapCount = 0;
      if (resetTimer) {
        clearTimeout(resetTimer);
        resetTimer = null;
      }
    };

    const subscription = DeviceEventEmitter.addListener(APP_EVENT_STEALTH_SECRET_TAP, () => {
      if (!isArmed) return;

      tapCount += 1;

      if (tapCount >= 5) {
        triggerStealthRecordingRef.current();
        reset();
        return;
      }

      if (resetTimer) {
        clearTimeout(resetTimer);
      }

      resetTimer = setTimeout(reset, 2500);
    });

    return () => {
      subscription.remove();
      if (resetTimer) {
        clearTimeout(resetTimer);
      }
    };
  }, [isArmed, stealthTrigger]);

  const triggerStealthRecording = async () => {
    try {
      // Haptic feedback. Not awaited: a cue that never settles must not delay recording.
      void StealthHaptics.triggerConfirm(hapticsEnabled);

      if (!autoRecordEnabled) {
        Alert.alert(
          'Stealth trigger detected',
          'Auto recording is disabled. Open SafeRide when you are ready to capture evidence.',
        );
        return;
      }

      if (!isRecording) {
        await startRecording();
      } else {
        await stopRecording();
      }
    } catch (error) {
      devPrivacyError('stealth trigger handling failed', { reason: getPrivacySafeErrorReason(error) });
    }
  };
  triggerStealthRecordingRef.current = triggerStealthRecording;

  const startRecording = async () => {
    try {
      // Request permissions
      const { status } = await requestRecordingPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Required', 'Microphone access is needed for recording.');
        return;
      }

      // Configure audio session
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
        allowsBackgroundRecording: true,
      });

      // Start recording
      await audioRecorder.prepareToRecordAsync();
      audioRecorder.record();

      recordingRef.current = audioRecorder;
      setIsRecording(true);

      // Double buzz every 30 seconds to confirm recording is still running
      if (hapticsEnabled) {
        hapticIntervalRef.current = setInterval(() => {
          if (recordingRef.current) {
            // Turning haptic feedback off mid-recording silences the next heartbeat.
            void StealthHaptics.recordingHeartbeat(hapticsEnabledRef.current);
          } else {
            clearRecordingTimers();
          }
        }, 30000);
      }

      // Auto-stop after 30 minutes for battery preservation
      autoStopTimerRef.current = setTimeout(async () => {
        if (recordingRef.current) {
          await stopRecording();
        }
      }, 30 * 60 * 1000);

    } catch (error) {
      devPrivacyError('stealth recording start failed', { reason: getPrivacySafeErrorReason(error) });
      clearRecordingTimers();
      recordingRef.current = null;
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
        allowsBackgroundRecording: false,
      }).catch((audioModeError) => {
        devPrivacyWarn('stealth audio mode reset failed', { reason: getPrivacySafeErrorReason(audioModeError) });
      });
      setIsRecording(false);
    }
  };

  const stopRecording = async () => {
    try {
      if (!recordingRef.current) return;

      await recordingRef.current.stop();
      const uri = recordingRef.current.uri;

      recordingRef.current = null;
      clearRecordingTimers();
      setIsRecording(false);

      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
        allowsBackgroundRecording: false,
      });

      // Save incident draft with recording
      if (uri) {
        const recordingInfo = await FileSystem.getInfoAsync(uri);
        if (!recordingInfo.exists || recordingInfo.isDirectory || recordingInfo.size <= 0) {
          Alert.alert(
            'Recording was not saved',
            'SafeRide could not find a completed audio file on this device. Check microphone permission and available storage, then test again.',
          );
          return;
        }
        await saveIncidentDraft(uri, recordingInfo.size);
      } else {
        Alert.alert(
          'Recording was not saved',
          'SafeRide did not receive an audio file from the recorder. Check microphone permission and try again.',
        );
      }

      // Haptic confirmation
      await StealthHaptics.stopConfirm(hapticsEnabledRef.current);

    } catch (error) {
      devPrivacyError('stealth recording stop failed', { reason: getPrivacySafeErrorReason(error) });
      clearRecordingTimers();
      recordingRef.current = null;
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
        allowsBackgroundRecording: false,
      }).catch((audioModeError) => {
        devPrivacyWarn('stealth audio mode reset failed', { reason: getPrivacySafeErrorReason(audioModeError) });
      });
      setIsRecording(false);
    }
  };

  const saveIncidentDraft = async (audioUri: string, audioSize: number) => {
    try {
      // Get current location
      let location = null;
      try {
        const { status } = await Location.getForegroundPermissionsAsync();
        if (status === 'granted') {
          const currentLocation = await Location.getCurrentPositionAsync({});
          location = {
            latitude: currentLocation.coords.latitude,
            longitude: currentLocation.coords.longitude,
          };
        }
      } catch (error) {
        devPrivacyWarn('stealth location capture failed', { reason: getPrivacySafeErrorReason(error) });
      }

      const draftId = draftStorage.generateDraftId();
      await draftStorage.saveDraft({
        id: draftId,
        currentStep: 'EvidenceDetail',
        mediaFiles: [
          {
            id: `audio_${Math.random().toString(36).slice(2)}`,
            type: 'audio',
            uri: audioUri,
            fileName: audioUri.split('/').pop() || 'recording.m4a',
            size: audioSize,
            timestamp: new Date(),
            description: 'Auto-recorded via stealth mode',
            captureSource: 'stealth_auto',
            isFromStealth: true,
            uploadStatus: 'pending',
          },
        ],
        textEvidence: 'Auto-recorded via stealth mode',
        location: {
          address: location ? 'Location captured' : 'Location not available',
          coordinates: location || undefined,
        },
        datetime: {
          date: new Date().toISOString().slice(0, 10),
          time: new Date().toISOString().slice(11, 16),
          accuracy: 'estimated',
        },
      });

      // Navigate to the incident flow after a short delay
      setTimeout(() => {
        resetReportStackToRoute(navigation as any, SCREEN_NAMES.WHAT_HAPPENED, { draftId });
      }, 1000);

    } catch (error) {
      devPrivacyError('stealth incident draft save failed', { reason: getPrivacySafeErrorReason(error) });
    }
  };

  const armStealthMode = () => setIsArmed(true);
  const disarmStealthMode = () => setIsArmed(false);

  const quickExit = () => {
    void resetToCalculatorDecoyIfUnlockable(navigation, () => decoyPinManager.canUnlockCalculator())
      .then((didReset) => {
        if (!didReset) setQuickExitAvailable(false);
      });
  };

  return {
    isRecording,
    isArmed,
    stealthTrigger,
    armStealthMode,
    disarmStealthMode,
    triggerStealthRecording,
    quickExit,
    quickExitAvailable,
  };
}
