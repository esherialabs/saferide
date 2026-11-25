import React from 'react';
import { createContext, useContext, useRef, useEffect } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  StyleSheet,
  useWindowDimensions,
  Animated,
  PanResponder,
  LayoutChangeEvent,
} from 'react-native';
import { useTheme } from '../../theme/SimpleThemeProvider';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { spacing, radii, shadows, typography } from '../../theme/tokens';

interface SheetContextType {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const SheetContext = createContext<SheetContextType | null>(null);

export interface SheetProps {
  children: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export interface SheetContentProps {
  children: React.ReactNode;
  showDragIndicator?: boolean;
  snapPoints?: number[];
  initialSnapPoint?: number;
  style?: any;
}

export interface SheetHeaderProps {
  children: React.ReactNode;
  style?: any;
}

export interface SheetTitleProps {
  children: React.ReactNode;
  style?: any;
}

export interface SheetDescriptionProps {
  children: React.ReactNode;
  style?: any;
}

export interface SheetFooterProps {
  children: React.ReactNode;
  style?: any;
}

export interface SheetTriggerProps {
  children: React.ReactNode;
  asChild?: boolean;
}

export function Sheet({ children, open = false, onOpenChange }: SheetProps) {
  const [internalOpen, setInternalOpen] = React.useState(open);
  
  React.useEffect(() => {
    setInternalOpen(open);
  }, [open]);

  const setOpen = (newOpen: boolean) => {
    setInternalOpen(newOpen);
    onOpenChange?.(newOpen);
  };

  return (
    <SheetContext.Provider value={{ open: internalOpen, setOpen }}>
      {children}
    </SheetContext.Provider>
  );
}

export function SheetTrigger({ children }: SheetTriggerProps) {
  const context = useContext(SheetContext);
  
  if (!context) {
    throw new Error('SheetTrigger must be used within a Sheet component');
  }

  const { setOpen } = context;

  return (
    <TouchableOpacity onPress={() => setOpen(true)}>
      {children}
    </TouchableOpacity>
  );
}

export function SheetContent({ 
  children, 
  showDragIndicator = true,
  snapPoints = [0.3, 0.6, 0.9],
  initialSnapPoint = 0,
  style 
}: SheetContentProps) {
  const context = useContext(SheetContext);
  const { colors } = useTheme();
  const reducedMotion = useReducedMotion();
  const { height: screenHeight } = useWindowDimensions();
  const [contentHeight, setContentHeight] = React.useState(0);
  
  if (!context) {
    throw new Error('SheetContent must be used within a Sheet component');
  }

  const { open, setOpen } = context;

  // Animation values
  const translateY = useRef(new Animated.Value(screenHeight)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const currentSnapPoint = useRef(initialSnapPoint);

  const snapPositions = React.useMemo(() => {
    if (!snapPoints.length) {
      return [0];
    }

    const positions = snapPoints.map(rawPoint => {
      const point = Number(rawPoint);
      if (!Number.isFinite(point)) {
        return 0;
      }

      // Allow absolute pixel snap points (>1) or fractional heights (0-1)
      if (point > 1) {
        return Math.max(0, Math.min(point, screenHeight));
      }

      const fraction = Math.max(0, Math.min(point, 1));

      if (contentHeight <= 0) {
        return Math.max(0, Math.min(screenHeight * (1 - fraction), screenHeight));
      }

      const translation = contentHeight - screenHeight * fraction;
      if (translation <= 0) {
        return 0;
      }
      if (translation >= screenHeight) {
        return screenHeight;
      }
      return translation;
    });

    if (!positions.includes(0)) {
      positions.push(0);
    }

    const unique = Array.from(new Set(positions));
    unique.sort((a, b) => a - b);
    return unique;
  }, [contentHeight, screenHeight, snapPoints]);

  // Keep the stable responder current after layout, rotation and controlled updates.
  const snapPositionsRef = useRef(snapPositions);
  const setOpenRef = useRef(setOpen);
  const reducedMotionRef = useRef(reducedMotion);
  snapPositionsRef.current = snapPositions;
  setOpenRef.current = setOpen;
  reducedMotionRef.current = reducedMotion;

  useEffect(() => {
    if (!snapPositions.length) return;
    if (currentSnapPoint.current >= snapPositions.length) {
      currentSnapPoint.current = snapPositions.length - 1;
    }
  }, [snapPositions]);

  useEffect(() => {
    if (reducedMotion) {
      opacity.stopAnimation();
      translateY.stopAnimation();
      opacity.setValue(open ? 1 : 0);
      translateY.setValue(open ? snapPositions[currentSnapPoint.current] ?? 0 : screenHeight);
      return;
    }
    if (open) {
      const target = snapPositions[currentSnapPoint.current] ?? 0;
      // Show sheet
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.spring(translateY, {
          toValue: target,
          tension: 100,
          friction: 8,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      // Hide sheet
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 0,
          duration: 250,
          useNativeDriver: true,
        }),
        Animated.spring(translateY, {
          toValue: screenHeight,
          tension: 100,
          friction: 8,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [open, screenHeight, snapPositions, opacity, translateY, reducedMotion]);

  const handleContentLayout = React.useCallback((event: LayoutChangeEvent) => {
    const height = event.nativeEvent.layout.height;
    if (height !== contentHeight) {
      setContentHeight(height);
    }
  }, [contentHeight]);

  // PanResponder for gesture handling
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (evt, gestureState) => {
        // Allow pan gestures when moving vertically
        return Math.abs(gestureState.dy) > Math.abs(gestureState.dx) && Math.abs(gestureState.dy) > 10;
      },
      onPanResponderGrant: () => {
        // Set offset to current value when gesture starts
        const positions = snapPositionsRef.current;
        const safeIndex = Math.min(
          Math.max(currentSnapPoint.current, 0),
          Math.max(positions.length - 1, 0),
        );
        const currentOffset = positions[safeIndex] ?? 0;
        translateY.setOffset(currentOffset);
        translateY.setValue(0);
      },
      onPanResponderMove: Animated.event(
        [null, { dy: translateY }],
        { useNativeDriver: false }
      ),
      onPanResponderRelease: (evt, gestureState) => {
        // Remove offset
        translateY.flattenOffset();
        
        const { dy, vy } = gestureState;
        const positions = snapPositionsRef.current;
        const safeIndex = Math.min(
          Math.max(currentSnapPoint.current, 0),
          Math.max(positions.length - 1, 0),
        );
        const basePosition = positions[safeIndex] ?? 0;
        const currentY = basePosition + dy;
        
        // Determine closest snap point
        let closestSnapIndex = 0;
        if (positions.length > 0) {
          let minDistance = Math.abs(currentY - positions[0]);
          
          for (let i = 1; i < positions.length; i++) {
            const distance = Math.abs(currentY - positions[i]);
            if (distance < minDistance) {
              minDistance = distance;
              closestSnapIndex = i;
            }
          }
        }
        
        // Consider velocity for snap point selection
        if (vy > 0.5 && closestSnapIndex < positions.length - 1) {
          closestSnapIndex += 1; // Snap to lower position (more closed)
        } else if (vy < -0.5 && closestSnapIndex > 0) {
          closestSnapIndex -= 1; // Snap to higher position (more open)
        }
        
        // If dragged significantly down, close the sheet
        if (dy > 150 || (vy > 0.8 && dy > 50)) {
          setOpenRef.current(false);
          return;
        }
        
        currentSnapPoint.current = closestSnapIndex;

        if (reducedMotionRef.current) {
          translateY.setValue(positions[closestSnapIndex] ?? 0);
          return;
        }
        
        Animated.spring(translateY, {
          toValue: positions[closestSnapIndex] ?? 0,
          tension: 100,
          friction: 8,
          useNativeDriver: true,
        }).start();
      },
    })
  ).current;

  const styles = StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: 'transparent',
    },
    backdrop: {
      ...StyleSheet.absoluteFill,
      backgroundColor: colors.scrim,
    },
    container: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      backgroundColor: colors.surface,
      borderTopLeftRadius: radii.sheet,
      borderTopRightRadius: radii.sheet,
      minHeight: screenHeight * 0.3,
      paddingBottom: spacing.xl,
      ...shadows.floating,
    },
    dragIndicator: {
      width: 36,
      height: 5,
      backgroundColor: colors.input,
      borderRadius: 8,
      alignSelf: 'center',
    },
    dragHandle: {
      minHeight: 48,
      justifyContent: 'center',
    },
    content: {
      flex: 1,
      minHeight: 0,
      paddingHorizontal: spacing.md,
      paddingBottom: spacing.md,
    },
  });

  return (
    <Modal
      visible={open}
      transparent
      animationType="none"
      onRequestClose={() => setOpen(false)}
    >
      <View style={styles.overlay}>
        <Animated.View style={[styles.backdrop, { opacity }]} />
        
        <TouchableWithoutFeedback onPress={() => setOpen(false)}>
          <View style={styles.overlay} />
        </TouchableWithoutFeedback>

        <Animated.View
          accessibilityViewIsModal
          style={[
            styles.container, 
            { transform: [{ translateY }] },
            style
          ]}
        >
          <View style={styles.content} onLayout={handleContentLayout}>
            {showDragIndicator && (
              // Body drags belong to nested ScrollViews; only the handle moves the sheet.
              <View style={styles.dragHandle} {...panResponder.panHandlers}>
                <View style={styles.dragIndicator} />
              </View>
            )}
            {children}
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

export function SheetHeader({ children, style }: SheetHeaderProps) {
  const { colors } = useTheme();

  return (
    <View style={[{
      paddingHorizontal: spacing.md,
      paddingTop: spacing.sm,
      paddingBottom: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: colors.divider,
      marginBottom: spacing.sm,
    }, style]}>
      {children}
    </View>
  );
}

export function SheetTitle({ children, style }: SheetTitleProps) {
  const { colors } = useTheme();
  
  return (
    <Text accessibilityRole="header" style={[{
      ...typography.titleLarge,
      textAlign: 'left',
      color: colors.foreground,
      marginBottom: spacing.xxs,
    }, style]}>
      {children}
    </Text>
  );
}

export function SheetDescription({ children, style }: SheetDescriptionProps) {
  const { colors } = useTheme();
  
  return (
    <Text style={[{
      ...typography.bodyS,
      color: colors.textSecondary,
      textAlign: 'left',
    }, style]}>
      {children}
    </Text>
  );
}

export function SheetFooter({ children, style }: SheetFooterProps) {
  const { colors } = useTheme();
  
  return (
    <View style={[{
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: 12,
      paddingTop: spacing.md,
      paddingBottom: spacing.sm,
      paddingHorizontal: spacing.md,
      borderTopWidth: 1,
      borderTopColor: colors.divider,
      marginTop: spacing.md,
    }, style]}>
      {children}
    </View>
  );
}

// Utility component for bottom sheet pattern
export function BottomSheet({ children, ...props }: SheetProps) {
  return <Sheet {...props}>{children}</Sheet>;
}

export const BottomSheetTrigger = SheetTrigger;
export const BottomSheetContent = SheetContent;
export const BottomSheetHeader = SheetHeader;
export const BottomSheetTitle = SheetTitle;
export const BottomSheetDescription = SheetDescription;
export const BottomSheetFooter = SheetFooter;
