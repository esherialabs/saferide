import React from 'react';
import { View, ScrollView, StyleSheet, StatusBar } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { HeaderShownContext } from '@react-navigation/elements';
import { useTheme } from '../../theme/SimpleThemeProvider';
import { BrandBar } from '../BrandWordmark';

interface ScreenProps {
  children: React.ReactNode;
  scrollable?: boolean;
  edges?: ('top' | 'bottom' | 'left' | 'right')[];
  statusBarStyle?: 'auto' | 'inverted';
  className?: string;
  brandHeader?: boolean;
}

export default function Screen({ 
  children, 
  scrollable = false, 
  edges = ['top', 'bottom', 'left', 'right'],
  statusBarStyle = 'auto',
  className,
  brandHeader = false,
}: ScreenProps) {
  const { colors, colorScheme } = useTheme();
  const headerShown = React.useContext(HeaderShownContext);
  // Navigator headers already include the top inset, including a parent tab
  // header above the report stack. Headerless screens retain their own inset.
  const safeAreaEdges = headerShown ? edges.filter(edge => edge !== 'top') : edges;

  const containerStyle = {
    flex: 1,
    backgroundColor: colors.background,
  };

  const contentStyle = {
    flexGrow: 1,
    backgroundColor: colors.background,
  };

  return (
    <SafeAreaView style={containerStyle} edges={safeAreaEdges}>
      <StatusBar 
        barStyle={
          statusBarStyle === 'auto' 
            ? colorScheme === 'dark' ? 'light-content' : 'dark-content'
            : colorScheme === 'dark' ? 'dark-content' : 'light-content'
        }
        backgroundColor={colors.canvas}
      />
      {brandHeader && !headerShown ? <BrandBar /> : null}
      {scrollable ? (
        <ScrollView
          style={containerStyle}
          contentContainerStyle={contentStyle}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          accessible={false}
          contentInsetAdjustmentBehavior="automatic"
        >
          {children}
        </ScrollView>
      ) : (
        <View style={containerStyle}>
          {children}
        </View>
      )}
    </SafeAreaView>
  );
}
