import React from 'react';
import { createContext, useContext } from 'react';
import { 
  Modal, 
  View, 
  Text, 
  TouchableOpacity, 
  TouchableWithoutFeedback,
  StyleSheet,
  Dimensions,
  ScrollView
} from 'react-native';
import { radii, touchTargets } from '../../theme/tokens';
import { useTheme } from '../../theme/SimpleThemeProvider';
import { Ionicons } from '@expo/vector-icons';

interface DialogContextType {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const DialogContext = createContext<DialogContextType | null>(null);

export interface DialogProps {
  children: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export interface DialogContentProps {
  children: React.ReactNode;
  showCloseButton?: boolean;
  style?: any;
}

export interface DialogHeaderProps {
  children: React.ReactNode;
  style?: any;
}

export interface DialogTitleProps {
  children: React.ReactNode;
  style?: any;
}

export interface DialogDescriptionProps {
  children: React.ReactNode;
  style?: any;
}

export interface DialogFooterProps {
  children: React.ReactNode;
  style?: any;
}

export interface DialogTriggerProps {
  children: React.ReactNode;
  asChild?: boolean;
}

export function Dialog({ children, open = false, onOpenChange }: DialogProps) {
  const [internalOpen, setInternalOpen] = React.useState(open);
  
  React.useEffect(() => {
    setInternalOpen(open);
  }, [open]);

  const setOpen = (newOpen: boolean) => {
    setInternalOpen(newOpen);
    onOpenChange?.(newOpen);
  };

  return (
    <DialogContext.Provider value={{ open: internalOpen, setOpen }}>
      {children}
    </DialogContext.Provider>
  );
}

export function DialogTrigger({ children }: DialogTriggerProps) {
  const context = useContext(DialogContext);
  
  if (!context) {
    throw new Error('DialogTrigger must be used within a Dialog component');
  }

  const { setOpen } = context;

  return (
    <TouchableOpacity onPress={() => setOpen(true)}>
      {children}
    </TouchableOpacity>
  );
}

export function DialogContent({ 
  children, 
  showCloseButton = true,
  style 
}: DialogContentProps) {
  const context = useContext(DialogContext);
  const { colors } = useTheme();
  
  if (!context) {
    throw new Error('DialogContent must be used within a Dialog component');
  }

  const { open, setOpen } = context;
  const { width, height } = Dimensions.get('window');

  const styles = StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: colors.scrim,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 16,
    },
    content: {
      backgroundColor: colors.surface,
      borderRadius: radii.sheet,
      maxWidth: Math.min(width - 32, 400),
      maxHeight: height - 64,
      width: '100%',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.25,
      shadowRadius: 16,
      elevation: 8,
    },
    closeButton: {
      position: 'absolute',
      top: 12,
      right: 12,
      width: touchTargets.minimum,
      height: touchTargets.minimum,
      borderRadius: radii.round,
      backgroundColor: colors.muted,
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 10,
    },
  });

  return (
    <Modal
      visible={open}
      transparent
      animationType="fade"
      onRequestClose={() => setOpen(false)}
    >
      <TouchableWithoutFeedback onPress={() => setOpen(false)}>
        <View style={styles.overlay}>
          <TouchableWithoutFeedback>
            <View accessibilityViewIsModal style={[styles.content, style]}>
              {showCloseButton && (
                <TouchableOpacity
                  style={styles.closeButton}
                  onPress={() => setOpen(false)}
                  accessibilityRole="button"
                  accessibilityLabel="Close dialog"
                >
                  <Ionicons name="close" size={16} color={colors.foreground} />
                </TouchableOpacity>
              )}
              <ScrollView contentContainerStyle={{ paddingBottom: 16 }} keyboardShouldPersistTaps="handled">
                {children}
              </ScrollView>
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

export function DialogHeader({ children, style }: DialogHeaderProps) {
  return (
    <View style={[{
      paddingHorizontal: 24,
      paddingRight: 72,
      paddingTop: 24,
      paddingBottom: 16,
    }, style]}>
      {children}
    </View>
  );
}

export function DialogTitle({ children, style }: DialogTitleProps) {
  const { colors } = useTheme();
  
  return (
    <Text style={[{
      fontSize: 20,
      fontWeight: '600',
      color: colors.foreground,
      marginBottom: 8,
      lineHeight: 28,
    }, style]}>
      {children}
    </Text>
  );
}

export function DialogDescription({ children, style }: DialogDescriptionProps) {
  const { colors } = useTheme();
  
  return (
    <Text style={[{
      fontSize: 16,
      color: colors.mutedForeground,
      lineHeight: 24,
    }, style]}>
      {children}
    </Text>
  );
}

export function DialogFooter({ children, style }: DialogFooterProps) {
  return (
    <View style={[{
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: 12,
      paddingHorizontal: 24,
      paddingBottom: 24,
      paddingTop: 16,
    }, style]}>
      {children}
    </View>
  );
}

// Utility components for common patterns
export function AlertDialog({ children, ...props }: DialogProps) {
  return <Dialog {...props}>{children}</Dialog>;
}

export const AlertDialogTrigger = DialogTrigger;
export const AlertDialogContent = DialogContent;
export const AlertDialogHeader = DialogHeader;
export const AlertDialogTitle = DialogTitle;
export const AlertDialogDescription = DialogDescription;
export const AlertDialogFooter = DialogFooter;
