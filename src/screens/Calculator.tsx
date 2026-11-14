import React from 'react';
import { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Screen from '../components/ui/Screen';
import { useTheme } from '../theme/SimpleThemeProvider';
import { DecoyCalculator, DecoyModeDetector } from '../utils/decoyPin';
import { RootStackParamList, SCREEN_NAMES } from '../navigation/routes';
import { useToast } from '../components/ui/Toast';

type CalculatorNavigationProp = NativeStackNavigationProp<RootStackParamList, 'Calculator'>;

export default function CalculatorScreen() {
  const { colors } = useTheme();
  const navigation = useNavigation<CalculatorNavigationProp>();
  const toast = useToast();
  const [display, setDisplay] = useState('0');
  const [calculator] = useState(() => DecoyCalculator.getInstance());
  const [detector] = useState(() => DecoyModeDetector.getInstance());

  const styles = StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    display: {
      flex: 1,
      backgroundColor: colors.background,
      justifyContent: 'flex-end',
      alignItems: 'flex-end',
      padding: 20,
    },
    displayText: {
      fontSize: 48,
      color: colors.foreground,
      fontWeight: '300',
    },
    buttonGrid: {
      flexDirection: 'column',
    },
    buttonRow: {
      flexDirection: 'row',
    },
    button: {
      flex: 1,
      height: 80,
      justifyContent: 'center',
      alignItems: 'center',
      borderWidth: 0.5,
      borderColor: colors.border,
      backgroundColor: colors.card,
    },
    buttonText: {
      fontSize: 24,
      fontWeight: '400',
      color: colors.foreground,
    },
  });

  useEffect(() => {
    // Listen for calculator state changes
    const unsubscribe = calculator.addListener((state) => {
      setDisplay(state.display);
    });

    // Initialize display
    setDisplay(calculator.getState().display);

    return unsubscribe;
  }, [calculator]);

  const handleNumberPress = (digit: string) => {
    void calculator.inputNumber(digit);
  };

  // Only "=" can unlock: ordinary sums and digit runs are never PIN attempts.
  const handleEqualsPress = async () => {
    const result = await calculator.submit();
    if (result.shouldUnlock) {
      // Successfully entered decoy PIN, unlock the real app
      const canExitDecoy = await detector.exitDecoyMode();
      if (!canExitDecoy) {
        toast.show({ title: 'Unlock cancelled', variant: 'warning' });
        return;
      }

      toast.show({ title: 'Unlocking SafeRide...', variant: 'success' });
      navigation.reset({
        index: 0,
        routes: [{ name: SCREEN_NAMES.MAIN_TABS }],
      });
    }
  };

  const Button = ({ text, onPress }: { text: string; onPress: () => void }) => (
    <TouchableOpacity style={styles.button} onPress={onPress}>
      <Text style={styles.buttonText}>{text}</Text>
    </TouchableOpacity>
  );

  return (
    <Screen edges={['top']}>
      <View style={styles.container}>
        <View style={styles.display}>
          <Text style={styles.displayText}>{display}</Text>
        </View>

        <View style={styles.buttonGrid}>
          <View style={styles.buttonRow}>
            <Button text="C" onPress={() => calculator.clear()} />
            <Button text="⌫" onPress={() => calculator.backspace()} />
            <Button text="%" onPress={() => calculator.inputOperation('%')} />
            <Button text="÷" onPress={() => calculator.inputOperation('÷')} />
          </View>
          <View style={styles.buttonRow}>
            <Button text="7" onPress={() => handleNumberPress('7')} />
            <Button text="8" onPress={() => handleNumberPress('8')} />
            <Button text="9" onPress={() => handleNumberPress('9')} />
            <Button text="×" onPress={() => calculator.inputOperation('×')} />
          </View>
          <View style={styles.buttonRow}>
            <Button text="4" onPress={() => handleNumberPress('4')} />
            <Button text="5" onPress={() => handleNumberPress('5')} />
            <Button text="6" onPress={() => handleNumberPress('6')} />
            <Button text="-" onPress={() => calculator.inputOperation('-')} />
          </View>
          <View style={styles.buttonRow}>
            <Button text="1" onPress={() => handleNumberPress('1')} />
            <Button text="2" onPress={() => handleNumberPress('2')} />
            <Button text="3" onPress={() => handleNumberPress('3')} />
            <Button text="+" onPress={() => calculator.inputOperation('+')} />
          </View>
          <View style={styles.buttonRow}>
            <TouchableOpacity 
              style={[styles.button, { flex: 2 }]} 
              onPress={() => handleNumberPress('0')}
            >
              <Text style={styles.buttonText}>0</Text>
            </TouchableOpacity>
            <Button text="." onPress={() => calculator.inputDecimal()} />
            <Button text="=" onPress={() => { void handleEqualsPress(); }} />
          </View>
        </View>
      </View>
    </Screen>
  );
}
