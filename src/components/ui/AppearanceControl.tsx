import React, { useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useLanguage } from '../../context/LanguageProvider';
import { useTheme } from '../../theme/SimpleThemeProvider';
import { getVisualStyleColors, type VisualStyle } from '../../theme/visualStyles';
import { radii, spacing, touchTargets, typography } from '../../theme/tokens';
import type { ThemePreference } from '../../theme/tokens';
import Button from './Button';
import { IconButton } from './IconButton';

const copyByLanguage = {
  en: {
    appearance: 'Appearance', choose: 'Choose your look', warm: 'Warm safety', classic: 'Classic',
    warmDescription: 'Bright cream, lilac, clay and sage, with gentle illustrations.',
    classicDescription: 'Soft lilac and lavender, with simpler cards.',
    help: 'Your choice is saved on this device. Light, dark and high contrast stay as you set them.',
    contrast: 'High contrast stays active with either look.', done: 'Done', saving: 'Saving…',
    close: 'Close appearance options',
    error: 'Could not save your appearance. Please try again.',
    display: 'Display mode', light: 'Light', dark: 'Dark', system: 'Use device setting', highContrast: 'High contrast',
  },
  sw: {
    appearance: 'Mwonekano', choose: 'Chagua mwonekano wako', warm: 'Usalama wenye joto', classic: 'Wa kawaida',
    warmDescription: 'Rangi za krimu, zambarau hafifu, udongo na kijani, pamoja na michoro tulivu.',
    classicDescription: 'Rangi za zambarau hafifu, pamoja na kadi rahisi.',
    help: 'Chaguo linahifadhiwa kwenye kifaa hiki. Mwanga, giza na utofauti mkubwa hubaki kama ulivyoweka.',
    contrast: 'Utofauti mkubwa unabaki kwa mionekano yote.', done: 'Nimemaliza', saving: 'Inahifadhi…',
    close: 'Funga chaguo za mwonekano',
    error: 'Mwonekano haujahifadhiwa. Tafadhali jaribu tena.',
    display: 'Hali ya mwonekano', light: 'Mwanga', dark: 'Giza', system: 'Tumia mpangilio wa kifaa', highContrast: 'Utofauti mkubwa',
  },
};

export function AppearanceControl({ compact = false, inHeader = false }: { compact?: boolean; inHeader?: boolean }) {
  const { colors, mode, theme, setTheme, visualStyle, setVisualStyle, isHighContrast } = useTheme();
  const { languageCode } = useLanguage();
  const copy = copyByLanguage[languageCode];
  const [visible, setVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const savingRef = useRef(false);
  const chooseStyle = async (style: VisualStyle) => {
    if (savingRef.current || style === visualStyle) return;
    savingRef.current = true;
    setSaving(true);
    setError(false);
    try { await setVisualStyle(style); }
    catch { setError(true); }
    finally { savingRef.current = false; setSaving(false); }
  };
  const chooseTheme = async (preference: ThemePreference) => {
    if (savingRef.current || preference === theme) return;
    savingRef.current = true;
    setSaving(true);
    setError(false);
    try { await setTheme(preference); }
    catch { setError(true); }
    finally { savingRef.current = false; setSaving(false); }
  };
  const label = visualStyle === 'warm' ? copy.warm : copy.classic;
  const modeIcons: Record<ThemePreference, keyof typeof Ionicons.glyphMap> = {
    light: 'sunny-outline', dark: 'moon-outline', system: 'phone-portrait-outline', highContrast: 'contrast-outline',
  };

  return <>
    {inHeader ? <IconButton
      icon="color-palette-outline"
      accessibilityLabel={`${copy.appearance}: ${label}`}
      accessibilityHint={copy.choose}
      onPress={() => { setError(false); setVisible(true); }}
      variant="ghost"
      size="sm"
    /> : <Pressable
      accessibilityRole="button"
      accessibilityLabel={compact ? `${copy.appearance}: ${label}` : `${copy.appearance}: ${label}, ${copy[theme]}`}
      accessibilityHint={copy.choose}
      onPress={() => { setError(false); setVisible(true); }}
      style={({ pressed }) => [styles.trigger, compact ? styles.compact : styles.settings,
        { backgroundColor: colors.surface, borderColor: compact ? colors.input : colors.border, opacity: pressed ? 0.8 : 1 }]}
    >
      <Ionicons accessible={false} name="color-palette-outline" size={20} color={colors.primary} />
      <View style={[styles.triggerCopy, !compact && styles.triggerFill]}>
        {!compact && <Text style={[typography.titleSmall, { color: colors.foreground }]}>{copy.appearance}</Text>}
        <Text style={[typography.bodySmall, { color: compact ? colors.foreground : colors.textSecondary }]}>
          {compact ? label : `${label} · ${copy[theme]}`}
        </Text>
      </View>
      <Ionicons accessible={false} name={compact ? 'chevron-down' : 'chevron-forward'} size={18} color={colors.textSecondary} />
    </Pressable>}
    <Modal visible={visible} transparent animationType="none" onRequestClose={() => setVisible(false)}>
      <View style={[styles.overlay, { backgroundColor: colors.scrim }]}>
        <View accessibilityViewIsModal style={[styles.sheet, { backgroundColor: colors.surface }]}>
          <SafeAreaView edges={['bottom']} style={{ flexShrink: 1 }}>
            <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
              <View style={styles.sheetHeader}>
                <Text accessibilityRole="header" style={[typography.titleLarge, styles.triggerFill, { color: colors.foreground }]}>{copy.choose}</Text>
                <IconButton icon="close" accessibilityLabel={copy.close} onPress={() => setVisible(false)} variant="secondary" size="sm" />
              </View>
              <Text style={[typography.bodySmall, { color: colors.textSecondary }]}>{copy.help}</Text>
              {(['warm', 'classic'] as const).map(style => {
                const selected = visualStyle === style;
                const preview = getVisualStyleColors(style, mode === 'dark' ? 'dark' : 'light');
                return <Pressable key={style} accessibilityRole="radio"
                  accessibilityLabel={`${copy[style]}. ${style === 'warm' ? copy.warmDescription : copy.classicDescription}`}
                  aria-checked={selected}
                  accessibilityState={{ checked: selected, selected, disabled: saving }} disabled={saving}
                  onPress={() => { void chooseStyle(style); }}
                  style={({ pressed }) => [styles.option, { borderColor: selected ? colors.primary : colors.input,
                    backgroundColor: selected ? colors.primaryMuted : colors.surface, opacity: pressed ? 0.8 : 1 }]}>
                  <View accessible={false} style={styles.swatches}>
                    {[preview.canvas, preview.primary, preview.support].map(color => <View key={color} style={[styles.swatch, { backgroundColor: color, borderColor: colors.input }]} />)}
                  </View>
                  <View style={styles.optionHeading}>
                    <Text style={[typography.titleMedium, styles.triggerCopy, { color: colors.foreground }]}>{copy[style]}</Text>
                    <Ionicons accessible={false} name={selected ? 'radio-button-on' : 'radio-button-off'} size={24} color={selected ? colors.primary : colors.textSecondary} />
                  </View>
                  <Text style={[typography.bodySmall, { color: colors.textSecondary }]}>{style === 'warm' ? copy.warmDescription : copy.classicDescription}</Text>
                </Pressable>;
              })}
              {isHighContrast && <Text style={[typography.bodySmall, { color: colors.textSecondary }]}>{copy.contrast}</Text>}
              <Text accessibilityRole="header" style={[typography.titleMedium, { color: colors.foreground }]}>{copy.display}</Text>
              <View style={styles.modes}>
                {(['light', 'dark', 'system', 'highContrast'] as ThemePreference[]).map(preference => <Pressable
                  key={preference} accessibilityRole="radio" aria-checked={theme === preference}
                  accessibilityLabel={copy[preference]} accessibilityState={{ checked: theme === preference, selected: theme === preference, disabled: saving }}
                  disabled={saving} onPress={() => { void chooseTheme(preference); }} style={({ pressed }) => [styles.mode,
                    { borderColor: theme === preference ? colors.primary : colors.input,
                      backgroundColor: theme === preference ? colors.primaryMuted : colors.surface, opacity: pressed ? 0.8 : 1 }]}>
                  <Ionicons accessible={false} name={modeIcons[preference]} size={18} color={theme === preference ? colors.primary : colors.textSecondary} />
                  <Text style={[typography.labelMedium, styles.modeLabel, { color: colors.foreground }]}>{copy[preference]}</Text>
                  {theme === preference ? <Ionicons accessible={false} name="checkmark-circle" size={18} color={colors.primary} /> : null}
                </Pressable>)}
              </View>
              {saving && <Text accessibilityLiveRegion="polite" style={{ color: colors.textSecondary }}>{copy.saving}</Text>}
              {error && <Text accessibilityRole="alert" style={{ color: colors.destructive }}>{copy.error}</Text>}
              <Button title={copy.done} fullWidth onPress={() => setVisible(false)} />
            </ScrollView>
          </SafeAreaView>
        </View>
      </View>
    </Modal>
  </>;
}

const styles = StyleSheet.create({
  trigger: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: touchTargets.minimum, borderWidth: 1, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  compact: { alignSelf: 'flex-start', maxWidth: '100%', borderRadius: radii.round },
  settings: { borderRadius: radii.card, minHeight: 56 },
  triggerCopy: { flexShrink: 1, minWidth: 0 },
  triggerFill: { flex: 1 },
  overlay: { flex: 1, justifyContent: 'flex-end', alignItems: 'center' },
  sheet: { width: '100%', maxWidth: 560, maxHeight: '90%', borderTopLeftRadius: radii.sheet, borderTopRightRadius: radii.sheet, overflow: 'hidden' },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  content: { paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.md, gap: spacing.sm },
  option: { borderWidth: 2, borderRadius: radii.card, paddingHorizontal: spacing.sm, paddingVertical: spacing.sm, gap: spacing.xs },
  optionHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm },
  swatches: { flexDirection: 'row', gap: spacing.xs },
  swatch: { width: 24, height: 24, borderRadius: radii.round, borderWidth: 1 },
  modes: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  mode: { flexGrow: 1, flexBasis: '44%', flexDirection: 'row', gap: spacing.xs, minHeight: touchTargets.minimum, borderWidth: 1, borderRadius: radii.button, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, alignItems: 'center' },
  modeLabel: { flex: 1, minWidth: 0 },
});
