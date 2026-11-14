import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, AppState, Easing, Image, StyleSheet, View } from 'react-native';
import bounds from '../../assets/brand-wordmark/layers.json';
import { WORDMARK_CYCLE_MS, wordmarkHighlightKeyframes } from './brandWordmarkMotion';

const artwork = {
  light: {
    lettering: require('../../assets/brand-wordmark/light-letters.png'),
    highlights: [
      require('../../assets/brand-wordmark/light-highlight-0.png'),
      require('../../assets/brand-wordmark/light-highlight-1.png'),
      require('../../assets/brand-wordmark/light-highlight-2.png'),
      require('../../assets/brand-wordmark/light-highlight-3.png'),
      require('../../assets/brand-wordmark/light-highlight-4.png'),
      require('../../assets/brand-wordmark/light-highlight-5.png'),
      require('../../assets/brand-wordmark/light-highlight-6.png'),
      require('../../assets/brand-wordmark/light-highlight-7.png'),
    ],
  },
  dark: {
    lettering: require('../../assets/brand-wordmark/dark-letters.png'),
    highlights: [
      require('../../assets/brand-wordmark/dark-highlight-0.png'),
      require('../../assets/brand-wordmark/dark-highlight-1.png'),
      require('../../assets/brand-wordmark/dark-highlight-2.png'),
      require('../../assets/brand-wordmark/dark-highlight-3.png'),
      require('../../assets/brand-wordmark/dark-highlight-4.png'),
      require('../../assets/brand-wordmark/dark-highlight-5.png'),
      require('../../assets/brand-wordmark/dark-highlight-6.png'),
      require('../../assets/brand-wordmark/dark-highlight-7.png'),
    ],
  },
};

export function WordmarkHighlights({ width, inverted, accessible }: { width: number; inverted: boolean; accessible: boolean }) {
  const variant = inverted ? 'dark' : 'light';
  const source = artwork[variant];
  const progress = useRef(new Animated.Value(0)).current;
  const [motionAllowed, setMotionAllowed] = useState(false);
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const [loaded, setLoaded] = useState<Set<number>>(() => new Set());
  // One gentle pass, then the full official logo rests; motion never loops in the background.
  const [finished, setFinished] = useState(false);
  const ready = loaded.size === 9;
  const running = ready && motionAllowed && appActive && !finished;
  const opacity = useMemo(() => source.highlights.map((_, index) => progress.interpolate(wordmarkHighlightKeyframes(index))), [progress, source]);

  useEffect(() => {
    let mounted = true;
    let preferenceChanged = false;
    const changed = (reduced: boolean) => {
      preferenceChanged = true;
      if (mounted) setMotionAllowed(!reduced);
    };
    AccessibilityInfo.isReduceMotionEnabled().then(reduced => {
      if (mounted && !preferenceChanged) setMotionAllowed(!reduced);
    }).catch(() => undefined);
    const motionSubscription = AccessibilityInfo.addEventListener('reduceMotionChanged', changed);
    const appSubscription = AppState.addEventListener('change', state => setAppActive(state === 'active'));
    return () => { mounted = false; motionSubscription?.remove(); appSubscription?.remove(); };
  }, []);

  useEffect(() => {
    if (!running) return undefined;
    progress.setValue(0);
    const pass = Animated.timing(progress, {
      toValue: 1,
      duration: WORDMARK_CYCLE_MS,
      easing: Easing.linear,
      useNativeDriver: true,
      isInteraction: false,
    });
    pass.start(({ finished: completed }) => { if (completed) setFinished(true); });
    return () => { pass.stop(); progress.setValue(0); };
  }, [progress, running]);

  const markLoaded = (index: number) => setLoaded(previous => {
    if (previous.has(index)) return previous;
    return new Set(previous).add(index);
  });
  const size = { width, height: width * (bounds.height / bounds.width) };
  return (
    <View style={size} pointerEvents="none" accessible={accessible} accessibilityRole="image" accessibilityLabel={accessible ? 'SafeRide logo' : undefined}>
      <Image
        source={inverted ? require('../../assets/logo-inverted.png') : require('../../assets/logo.png')}
        resizeMode="contain" style={[StyleSheet.absoluteFill, size, { opacity: ready ? 0 : 1 }]}
        accessible={false} accessibilityIgnoresInvertColors
      />
      <View style={[StyleSheet.absoluteFill, { opacity: ready ? 1 : 0 }]} accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {source.highlights.map((asset, index) => {
          const box = bounds[variant][index];
          const scale = width / bounds.width;
          return <Animated.Image key={index} source={asset} onLoad={() => markLoaded(index)} resizeMode="contain" accessible={false} accessibilityIgnoresInvertColors style={{
            position: 'absolute', left: box.left * scale, top: box.top * scale, width: box.width * scale, height: box.height * scale,
            opacity: running ? opacity[index] : 1,
          }} />;
        })}
        <Image source={source.lettering} onLoad={() => markLoaded(8)} resizeMode="contain" style={[StyleSheet.absoluteFill, size]} accessible={false} accessibilityIgnoresInvertColors />
      </View>
    </View>
  );
}
