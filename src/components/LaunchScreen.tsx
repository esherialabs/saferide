import React, { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Image,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useTheme } from '../theme/SimpleThemeProvider';
import { spacing, typography } from '../theme/tokens';
import { BrandWordmark } from './BrandWordmark';

type LaunchScreenProps = {
  message?: string;
};

export default function LaunchScreen({ message = 'Preparing SafeRide' }: LaunchScreenProps) {
  const { colors } = useTheme();
  const [reduceMotion, setReduceMotion] = useState(false);
  const spinRef = useRef(new Animated.Value(0));
  const pulseRef = useRef(new Animated.Value(0));
  const progressRef = useRef(new Animated.Value(0));
  const spin = spinRef.current;
  const pulse = pulseRef.current;
  const progress = progressRef.current;

  useEffect(() => {
    let isMounted = true;

    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (isMounted) {
          setReduceMotion(enabled);
        }
      })
      .catch(() => undefined);

    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);

    return () => {
      isMounted = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (reduceMotion) {
      spin.stopAnimation();
      pulse.stopAnimation();
      progress.stopAnimation();
      spin.setValue(0);
      pulse.setValue(0);
      progress.setValue(1);
      return undefined;
    }

    spin.setValue(0);
    pulse.setValue(0);
    progress.setValue(0);

    const spinLoop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 4200,
        easing: Easing.linear,
        isInteraction: false,
        useNativeDriver: true,
      }),
      { resetBeforeIteration: true },
    );
    const pulseLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1300,
          easing: Easing.inOut(Easing.ease),
          isInteraction: false,
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 1300,
          easing: Easing.inOut(Easing.ease),
          isInteraction: false,
          useNativeDriver: true,
        }),
      ]),
    );
    const progressFill = Animated.timing(progress, {
      toValue: 1,
      duration: 1800,
      easing: Easing.inOut(Easing.ease),
      isInteraction: false,
      useNativeDriver: true,
    });

    spinLoop.start();
    pulseLoop.start();
    progressFill.start(({ finished }) => {
      if (finished) {
        progress.setValue(1);
      }
    });

    return () => {
      spinLoop.stop();
      pulseLoop.stop();
      progressFill.stop();
    };
  }, [progress, pulse, reduceMotion, spin]);

  const styles = StyleSheet.create({
    container: {
      alignItems: 'center',
      backgroundColor: colors.canvas,
      flex: 1,
      justifyContent: 'center',
      paddingHorizontal: spacing.xl,
    },
    markStage: {
      alignItems: 'center',
      height: 156,
      justifyContent: 'center',
      marginBottom: spacing.lg,
      width: 156,
    },
    orbit: {
      borderColor: colors.border,
      borderRadius: 64,
      borderWidth: 1,
      height: 128,
      position: 'absolute',
      width: 128,
    },
    orbitDot: {
      borderRadius: 6,
      height: 12,
      position: 'absolute',
      width: 12,
    },
    orbitDotTop: {
      left: 58,
      top: -6,
    },
    orbitDotRight: {
      right: -6,
      top: 58,
    },
    orbitDotBottom: {
      bottom: -6,
      left: 58,
    },
    markPlate: {
      alignItems: 'center',
      backgroundColor: '#FFF8F3',
      borderRadius: 52,
      height: 104,
      justifyContent: 'center',
      width: 104,
    },
    mark: {
      height: 92,
      width: 92,
    },
    message: {
      ...typography.label,
      color: colors.textSecondary,
      marginTop: spacing.xs,
      textAlign: 'center',
    },
    progressTrack: {
      backgroundColor: colors.divider,
      borderRadius: 999,
      height: 4,
      marginTop: spacing.lg,
      overflow: 'hidden',
      width: 148,
    },
    progressFill: {
      backgroundColor: colors.primary,
      borderRadius: 999,
      height: 4,
      width: 148,
    },
  });

  const spinRotation = spin.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });
  const pulseScale = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.035],
  });
  const progressScale = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 1],
  });

  return (
    <View
      style={styles.container}
      accessibilityRole="progressbar"
      accessibilityLabel={message}
    >
      <Animated.View style={[styles.markStage, { transform: [{ scale: pulseScale }] }]}>
        <Animated.View style={[styles.orbit, { transform: [{ rotate: spinRotation }] }]}>
          <View style={[styles.orbitDot, styles.orbitDotTop, { backgroundColor: '#F88539' }]} />
          <View style={[styles.orbitDot, styles.orbitDotRight, { backgroundColor: '#50C9F0' }]} />
          <View style={[styles.orbitDot, styles.orbitDotBottom, { backgroundColor: '#53E17C' }]} />
        </Animated.View>
        <View style={styles.markPlate}>
          <Image
            source={require('../../assets/adaptive-icon.png')}
            resizeMode="contain"
            style={styles.mark}
            accessibilityIgnoresInvertColors
          />
        </View>
      </Animated.View>
      <BrandWordmark width={200} />
      <Text style={styles.message}>{message}</Text>
      <View style={styles.progressTrack}>
        <Animated.View
          style={[
            styles.progressFill,
            {
              transform: [{ translateX: -74 }, { scaleX: progressScale }, { translateX: 74 }],
            },
          ]}
        />
      </View>
    </View>
  );
}
