import React from 'react';
import { useState, useRef, useEffect } from 'react';
import { 
  View, 
  Text, 
  TouchableOpacity, 
  Modal,
  FlatList,
  StyleSheet, 
  Dimensions,
  ScrollView,
  TextInput,
} from 'react-native';
import { useTheme } from '../../theme/SimpleThemeProvider';
import { Ionicons } from '@expo/vector-icons';
import { radii, spacing, typography, shadows, fontFamilies } from '../../theme/tokens';

export interface SelectOption {
  label: string;
  value: string;
  disabled?: boolean;
  description?: string;
}

export interface SelectProps {
  value?: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  searchable?: boolean;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'default' | 'filled' | 'outlined';
  label?: string;
  error?: string;
  helperText?: string;
  multiple?: boolean;
  maxHeight?: number;
  style?: any;
  accessibilityLabel?: string;
}

export interface MultiSelectProps extends Omit<SelectProps, 'value' | 'onValueChange' | 'multiple'> {
  value?: string[];
  onValueChange: (value: string[]) => void;
  multiple: true;
}

export function Select({
  value,
  onValueChange,
  options,
  placeholder = 'Select an option...',
  disabled = false,
  searchable = false,
  size = 'md',
  variant = 'default',
  label,
  error,
  helperText,
  multiple = false,
  maxHeight = 300,
  style,
  accessibilityLabel,
}: SelectProps | MultiSelectProps) {
  const { colors } = useTheme();
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const triggerRef = useRef<View>(null);
  const [triggerLayout, setTriggerLayout] = useState({ x: 0, y: 0, width: 0, height: 0 });

  const selectedValues = multiple ? (value as string[] || []) : (value ? [value as string] : []);
  const filteredOptions = searchable 
    ? options.filter(option => 
        option.label.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : options;

  const getSizeStyles = () => {
    switch (size) {
      case 'sm':
        return {
          minHeight: 48,
          paddingHorizontal: spacing.lg,
          fontSize: typography.bodyS.fontSize,
          borderRadius: radii.input,
        };
      case 'lg':
        return {
          minHeight: 60,
          paddingHorizontal: spacing.xl,
          fontSize: typography.bodyM.fontSize,
          borderRadius: radii.input,
        };
      default:
        return {
          minHeight: 56,
          paddingHorizontal: spacing.xl,
          fontSize: typography.bodyM.fontSize,
          borderRadius: radii.input,
        };
    }
  };

  const getVariantStyles = () => {
    const baseStyle = {
      borderWidth: 1,
      borderColor: colors.input,
      backgroundColor: colors.surface,
    };

    switch (variant) {
      case 'filled':
        return {
          ...baseStyle,
          backgroundColor: colors.surfaceAlt,
        };
      case 'outlined':
        return {
          ...baseStyle,
          borderColor: error ? colors.destructive : colors.focusRing,
          borderWidth: 2,
          backgroundColor: colors.surface,
        };
      default:
        return {
          ...baseStyle,
          borderColor: colors.input,
        };
    }
  };

  const sizeStyles = getSizeStyles();
  const variantStyles = getVariantStyles();

  const getSelectedLabel = () => {
    if (selectedValues.length === 0) return placeholder;
    
    if (multiple) {
      if (selectedValues.length === 1) {
        const option = options.find(opt => opt.value === selectedValues[0]);
        return option?.label || selectedValues[0];
      }
      return `${selectedValues.length} items selected`;
    } else {
      const option = options.find(opt => opt.value === selectedValues[0]);
      return option?.label || selectedValues[0];
    }
  };

  const handleSelect = (optionValue: string) => {
    if (multiple) {
      const currentValues = selectedValues;
      const isSelected = currentValues.includes(optionValue);
      
      let newValues: string[];
      if (isSelected) {
        newValues = currentValues.filter(v => v !== optionValue);
      } else {
        newValues = [...currentValues, optionValue];
      }
      
      (onValueChange as (value: string[]) => void)(newValues);
    } else {
      (onValueChange as (value: string) => void)(optionValue);
      setIsOpen(false);
    }
  };

  const handleOpen = () => {
    if (!disabled) {
      triggerRef.current?.measure((x, y, width, height, pageX, pageY) => {
        setTriggerLayout({ x: pageX, y: pageY, width, height });
      });
      setIsOpen(true);
      setSearchQuery('');
    }
  };

  const styles = StyleSheet.create({
    container: {
      marginBottom: spacing.sm,
    },
    label: {
      ...typography.label,
      color: colors.textSecondary,
      marginBottom: spacing.xs,
    },
    trigger: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      ...sizeStyles,
      ...variantStyles,
      borderRadius: sizeStyles.borderRadius,
      ...(isOpen && !error
        ? { borderColor: colors.focusRing, borderWidth: 2 }
        : null),
      ...(error
        ? { borderColor: colors.destructive, borderWidth: 2 }
        : null),
      ...(disabled && {
        backgroundColor: colors.surfaceAlt,
        borderColor: colors.divider,
        opacity: 0.7,
      }),
    },
    triggerText: {
      flex: 1,
      color: selectedValues.length > 0 
        ? (disabled ? colors.textTertiary : colors.foreground)
        : colors.textTertiary,
      fontSize: sizeStyles.fontSize,
      fontWeight: typography.bodyM.fontWeight,
      fontFamily: fontFamilies.text,
    },
    icon: {
      marginLeft: spacing.xs,
      transform: [{ rotate: isOpen ? '180deg' : '0deg' }],
    },
    helperText: {
      ...typography.caption,
      marginTop: spacing.xs,
      color: error ? colors.destructive : colors.textSecondary,
    },
    
    // Modal styles
    modalOverlay: {
      flex: 1,
      backgroundColor: colors.scrim,
    },
    dropdown: {
      position: 'absolute',
      backgroundColor: colors.surface,
      borderRadius: radii.card,
      borderWidth: 1,
      borderColor: colors.divider,
      paddingVertical: spacing.xs,
      ...shadows.card,
      maxHeight,
    },
    searchContainer: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: colors.divider,
    },
    searchInput: {
      minHeight: 48,
      backgroundColor: colors.surfaceAlt,
      borderRadius: radii.input,
      paddingHorizontal: spacing.lg,
      fontSize: typography.bodyM.fontSize,
      color: colors.foreground,
      fontFamily: fontFamilies.text,
    },
    optionsList: {
      maxHeight: maxHeight - (searchable ? 60 : 0),
    },
    option: {
      minHeight: 48,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: colors.divider,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    lastOption: {
      borderBottomWidth: 0,
    },
    optionContent: {
      flex: 1,
    },
    optionLabel: {
      fontSize: typography.bodyM.fontSize,
      color: colors.foreground,
      fontWeight: '500',
      fontFamily: fontFamilies.text,
    },
    optionDescription: {
      ...typography.caption,
      color: colors.textSecondary,
      marginTop: spacing.xs / 2,
    },
    disabledOption: {
      opacity: 0.5,
    },
    selectedOption: {
      backgroundColor: colors.primaryMuted,
    },
    checkmark: {
      marginLeft: spacing.xs,
    },
  });

  const screenDimensions = Dimensions.get('window');
  const dropdownTop = triggerLayout.y + triggerLayout.height + 4;
  const dropdownLeft = triggerLayout.x;
  const dropdownWidth = Math.min(triggerLayout.width, screenDimensions.width - spacing.gutter * 2);

  // Adjust position if dropdown would go off screen
  const adjustedTop = dropdownTop + maxHeight > screenDimensions.height 
    ? triggerLayout.y - maxHeight - 4 
    : dropdownTop;

  const renderOption = ({ item, index }: { item: SelectOption; index: number }) => {
    const isSelected = selectedValues.includes(item.value);
    const isLast = index === filteredOptions.length - 1;
    
    return (
      <TouchableOpacity
        style={[
          styles.option,
          isLast && styles.lastOption,
          isSelected && styles.selectedOption,
          item.disabled && styles.disabledOption,
        ]}
        onPress={() => !item.disabled && handleSelect(item.value)}
        disabled={item.disabled}
        accessibilityRole={multiple ? 'checkbox' : 'radio'}
        accessibilityLabel={item.description ? `${item.label}. ${item.description}` : item.label}
        accessibilityState={{ disabled: item.disabled, checked: isSelected }}
      >
        <View style={styles.optionContent}>
          <Text style={styles.optionLabel}>{item.label}</Text>
          {item.description && (
            <Text style={styles.optionDescription}>{item.description}</Text>
          )}
        </View>
        {(isSelected || multiple) && (
          <View style={styles.checkmark}>
            <Ionicons
              name={isSelected ? 'checkmark' : 'checkmark-outline'}
              size={16}
              color={isSelected ? colors.primary : colors.mutedForeground}
            />
          </View>
        )}
      </TouchableOpacity>
    );
  };

  return (
    <View style={[styles.container, style]}>
      {label && <Text style={styles.label}>{label}</Text>}
      
      <TouchableOpacity
        ref={triggerRef}
        style={styles.trigger}
        onPress={handleOpen}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel || label}
        accessibilityHint="Double tap to open options"
        accessibilityState={{ disabled, expanded: isOpen }}
      >
        <Text style={styles.triggerText}>
          {getSelectedLabel()}
        </Text>
        <Ionicons
          name="chevron-down"
          size={16}
          color={colors.mutedForeground}
          style={styles.icon}
        />
      </TouchableOpacity>
      
      {(error || helperText) && (
        <Text style={styles.helperText}>
          {error || helperText}
        </Text>
      )}

      <Modal
        visible={isOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setIsOpen(false)}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setIsOpen(false)}
        >
          <View
            style={[
              styles.dropdown,
              {
                top: adjustedTop,
                left: dropdownLeft,
                width: dropdownWidth,
              },
            ]}
          >
            {searchable && (
              <View style={styles.searchContainer}>
                <TextInput
                  style={styles.searchInput}
                  placeholder="Search options..."
                  placeholderTextColor={colors.mutedForeground}
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  autoFocus
                />
              </View>
            )}
            
            <FlatList
              data={filteredOptions}
              renderItem={renderOption}
              keyExtractor={(item) => item.value}
              style={styles.optionsList}
              showsVerticalScrollIndicator={false}
              bounces={false}
            />
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

// Utility component for controlled select
export function ControlledSelect({
  defaultValue,
  onValueChange,
  multiple = false,
  ...props
}: Omit<SelectProps, 'value' | 'onValueChange'> & {
  defaultValue?: string | string[];
  onValueChange?: (value: string | string[]) => void;
  multiple?: boolean;
}) {
  const [value, setValue] = useState(
    multiple ? (defaultValue as string[] || []) : (defaultValue as string || '')
  );

  const handleValueChange = (newValue: string | string[]) => {
    setValue(newValue);
    onValueChange?.(newValue);
  };

  if (multiple) {
    return (
      <Select
        {...props}
        multiple
        value={value as string[]}
        onValueChange={handleValueChange as (value: string[]) => void}
      />
    );
  }

  return (
    <Select
      {...props}
      value={value as string}
      onValueChange={handleValueChange as (value: string) => void}
    />
  );
}
