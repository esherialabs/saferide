import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

export function useReducedMotion() {
  // Avoid starting motion before the device preference is known.
  const [reducedMotion, setReducedMotion] = useState(true);

  useEffect(() => {
    let mounted = true;
    let preferenceChanged = false;
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', enabled => {
      preferenceChanged = true;
      if (mounted) setReducedMotion(enabled);
    });
    AccessibilityInfo.isReduceMotionEnabled()
      .then(enabled => {
        if (mounted && !preferenceChanged) setReducedMotion(enabled);
      })
      .catch(() => undefined);

    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  return reducedMotion;
}
