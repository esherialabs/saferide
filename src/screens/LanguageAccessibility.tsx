import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  Vibration,
  View,
} from 'react-native';
import * as Speech from 'expo-speech';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';

import { Alert as AlertBanner } from '../components/ui/Alert';
import { Badge } from '../components/ui/Badge';
import Button from '../components/ui/Button';
import { Card, CardContent, CardDescription, CardTitle, FeatureHeader, type FeatureHeaderStat } from '../components/ui';
import { Label } from '../components/ui/Label';
import Screen from '../components/ui/Screen';
import { Slider } from '../components/ui/Slider';
import { Switch } from '../components/ui/Switch';
import { useToast } from '../components/ui/Toast';
import {
  APP_LANGUAGES,
  LANGUAGE_UNAVAILABLE_MESSAGE,
  getLanguageByCode,
  getSpeechLocaleForLanguage,
} from '../config/languageAvailability';
import { useLanguage } from '../context/LanguageProvider';
import { getLanguageAccessHeaderCopy } from '../i18n/appLanguage';
import { getLanguageAccessibilityCopy } from '../i18n/languageAccessibilityCopy';
import { useTheme } from '../theme/SimpleThemeProvider';
import { borders, elevation, radii, spacing, typography } from '../theme/tokens';

const textSizes = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
const textSizeValues = [12, 14, 16, 18, 20, 24];

async function resolveSpeechLocale(languageCode: string) {
  const preferredLocale = getSpeechLocaleForLanguage(languageCode);
  if (languageCode !== 'sw') {
    return { locale: preferredLocale, usedFallback: false };
  }

  try {
    const voices = await Speech.getAvailableVoicesAsync();
    const swahiliVoice = voices.find((voice) => (
      typeof voice.language === 'string' &&
      voice.language.toLowerCase().startsWith('sw')
    ));

    if (swahiliVoice?.language) {
      return { locale: swahiliVoice.language, usedFallback: false };
    }
  } catch (error) {
    console.warn('Failed to inspect speech voices', error);
  }

  return { locale: 'en-US', usedFallback: true };
}

export default function LanguageAccessibility() {
  const navigation = useNavigation();
  const { colors, isHighContrast, setTheme } = useTheme();
  const toast = useToast();
  const { languageCode, setLanguage } = useLanguage();
  const copy = useMemo(() => getLanguageAccessibilityCopy(languageCode), [languageCode]);
  const headerCopy = useMemo(() => getLanguageAccessHeaderCopy(languageCode), [languageCode]);

  const [showBanner, setShowBanner] = useState(true);
  const [textSize, setTextSize] = useState(2);
  const [systemHighContrast, setSystemHighContrast] = useState(false);
  const [showA11yLabels, setShowA11yLabels] = useState(false);
  const [hapticsEnabled, setHapticsEnabled] = useState(true);
  const [systemHapticsDisabled, setSystemHapticsDisabled] = useState(false);
  const [savingDisplay, setSavingDisplay] = useState(false);
  const savingDisplayRef = useRef(false);
  const displaySaveError = languageCode === 'sw'
    ? 'Hali ya mwonekano haijahifadhiwa. Tafadhali jaribu tena.'
    : 'Could not save display mode. Please try again.';
  const selectedLanguage = useMemo(() => getLanguageByCode(languageCode), [languageCode]);
  const languageStats = useMemo<FeatureHeaderStat[]>(() => [
    { label: headerCopy.statLanguage, value: selectedLanguage?.name ?? headerCopy.fallbackLanguage, icon: 'language-outline' },
    { label: headerCopy.statTextPreview, value: textSizes[textSize], icon: 'text-outline' },
    { label: headerCopy.statHaptics, value: hapticsEnabled ? headerCopy.hapticsOn : headerCopy.hapticsOff, icon: 'phone-portrait-outline' },
  ], [hapticsEnabled, headerCopy, selectedLanguage?.name, textSize]);

  useEffect(() => {
    setSystemHighContrast(false);
    setSystemHapticsDisabled(false);
  }, []);

  const handleLanguageChange = async (nextLanguageCode: string) => {
    const language = getLanguageByCode(nextLanguageCode);
    if (!language?.available) {
      toast.show({
        title: copy.languageUnavailableToastTitle,
        message: LANGUAGE_UNAVAILABLE_MESSAGE,
        variant: 'warning',
      });
      return;
    }

    const didSetLanguage = await setLanguage(nextLanguageCode);
    const nextCopy = getLanguageAccessibilityCopy(nextLanguageCode);
    if (!didSetLanguage) {
      toast.show({
        title: nextCopy.languageUnavailableToastTitle,
        message: LANGUAGE_UNAVAILABLE_MESSAGE,
        variant: 'warning',
      });
      return;
    }

    toast.show({
      title: nextCopy.languageChangedToastTitle,
      message: language.name,
      variant: 'success',
    });
  };

  const handleTextSizeChange = (value: number[]) => {
    const newSize = value[0];
    setTextSize(newSize);
    toast.show({ title: `${copy.textSizeToastTitle}: ${textSizes[newSize]}`, variant: 'info' });
  };

  const handleHighContrastToggle = async (enabled: boolean) => {
    if (savingDisplayRef.current) return;
    savingDisplayRef.current = true;
    setSavingDisplay(true);
    try {
      await setTheme(enabled ? 'highContrast' : 'system');
      toast.show({
        title: enabled ? copy.highContrastEnabledToast : copy.highContrastDisabledToast,
        variant: 'info',
      });
    } catch {
      toast.show({ title: displaySaveError, variant: 'error' });
    } finally {
      savingDisplayRef.current = false;
      setSavingDisplay(false);
    }
  };

  const handlePlayDemo = async () => {
    const { locale, usedFallback } = await resolveSpeechLocale(languageCode);

    try {
      Speech.speak(copy.demoAnnouncement, {
        rate: 0.8,
        pitch: 1.0,
        language: locale,
      });

      if (usedFallback) {
        toast.show({
          title: copy.speechFallbackToastTitle,
          message: copy.speechFallbackToastMessage,
          variant: 'warning',
        });
      }
    } catch (error) {
      console.warn('Speech demo failed', error);
      toast.show({
        title: copy.speechFallbackToastTitle,
        message: copy.speechFallbackToastMessage,
        variant: 'warning',
      });
    }
  };

  const handleTestHaptic = () => {
    if (systemHapticsDisabled) {
      toast.show({ title: copy.hapticsOffToast, variant: 'warning' });
      return;
    }

    Vibration.vibrate(100);
    toast.show({ title: copy.hapticTestTitle, message: copy.hapticTestMessage, variant: 'info' });
  };

  const handleRestoreDefaults = async () => {
    if (savingDisplayRef.current) return;
    savingDisplayRef.current = true;
    setSavingDisplay(true);
    try {
      await setTheme('system');
      await setLanguage('en');
      setTextSize(2);
      setHapticsEnabled(true);
      setShowA11yLabels(false);
      toast.show({ title: copy.defaultsRestoredToast, variant: 'success' });
    } catch {
      toast.show({ title: displaySaveError, variant: 'error' });
    } finally {
      savingDisplayRef.current = false;
      setSavingDisplay(false);
    }
  };

  const isAACompliant = textSize >= 1;

  const styles = StyleSheet.create({
    content: {
      padding: spacing.md,
      gap: spacing.md,
      paddingBottom: 112,
    },
    bannerContent: {
      alignItems: 'flex-start',
    },
    bannerText: {
      ...typography.bodyS,
      color: colors.foreground,
    },
    cardContent: {
      gap: spacing.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
    },
    languageOption: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      minHeight: 52,
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.sm,
      borderRadius: radii.card,
      borderWidth: borders.hairline,
      borderColor: colors.divider,
      backgroundColor: colors.surface,
      overflow: 'hidden',
      position: 'relative',
    },
    languageOptionSelected: {
      borderColor: colors.primary,
      backgroundColor: colors.primaryMuted,
    },
    languageOptionDisabled: {
      opacity: 0.62,
    },
    languageLabel: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      flex: 1,
    },
    languageName: {
      ...typography.bodyM,
      color: colors.foreground,
      flexShrink: 1,
    },
    flag: {
      minWidth: 28,
      fontSize: 12,
      fontWeight: '700',
      color: colors.textSecondary,
      textAlign: 'center',
    },
    radioOuter: {
      alignItems: 'center',
      borderColor: colors.input,
      borderRadius: 11,
      borderWidth: borders.emphasized,
      height: 22,
      justifyContent: 'center',
      width: 22,
    },
    radioOuterSelected: {
      borderColor: colors.primary,
    },
    radioInner: {
      backgroundColor: colors.primary,
      borderRadius: 5,
      height: 10,
      width: 10,
    },
    sliderContainer: {
      gap: spacing.xs,
    },
    sliderLabels: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingHorizontal: 4,
    },
    sliderLabel: {
      ...typography.caption,
      color: colors.mutedForeground,
    },
    sliderLabelActive: {
      color: colors.primary,
      fontWeight: '500',
    },
    previewContainer: {
      gap: 12,
      padding: spacing.md,
      backgroundColor: colors.primaryMuted,
      borderColor: colors.divider,
      borderRadius: radii.card,
      borderWidth: borders.hairline,
      overflow: 'hidden',
      position: 'relative',
    },
    previewTitle: {
      fontWeight: '500',
      color: colors.foreground,
    },
    previewActions: {
      flexDirection: 'row',
      gap: spacing.xs,
      flexWrap: 'wrap',
    },
    previewAction: {
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      backgroundColor: colors.primaryMuted,
      borderColor: colors.primary + '22',
      borderRadius: radii.badge,
      borderWidth: borders.hairline,
      fontWeight: '500',
      color: colors.foreground,
    },
    previewText: {
      lineHeight: 22,
      color: colors.foreground,
    },
    complianceRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
    },
    complianceText: {
      fontSize: 12,
    },
    complianceGood: {
      color: colors.success || '#22c55e',
    },
    complianceWarning: {
      color: colors.warning,
    },
    switchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    previewSwatches: {
      flexDirection: 'row',
      gap: spacing.md,
      flexWrap: 'wrap',
    },
    swatchGroup: {
      gap: spacing.xs,
    },
    swatchLabel: {
      ...typography.caption,
      color: colors.mutedForeground,
    },
    swatchRow: {
      flexDirection: 'row',
      gap: spacing.xs,
      alignItems: 'center',
    },
    swatch: {
      width: 32,
      height: 32,
      borderRadius: radii.xs,
    },
    demoContainer: {
      padding: spacing.md,
      borderWidth: borders.hairline,
      borderColor: colors.divider,
      borderRadius: radii.card,
      backgroundColor: colors.surfaceAlt,
      overflow: 'hidden',
      position: 'relative',
    },
    demoTitle: {
      fontWeight: '500',
      color: colors.foreground,
    },
    a11yLabel: {
      marginTop: 8,
      ...typography.caption,
      fontFamily: 'monospace',
      color: colors.mutedForeground,
      backgroundColor: colors.surface,
      padding: spacing.xs,
      borderRadius: radii.xs,
      borderWidth: borders.hairline,
      borderColor: colors.divider,
    },
    demoButtons: {
      flexDirection: 'row',
      gap: spacing.xs,
      flexWrap: 'wrap',
    },
    footer: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      backgroundColor: colors.surface,
      borderTopWidth: borders.hairline,
      borderTopColor: colors.divider,
      padding: spacing.md,
      ...elevation.sheet,
    },
    footerContent: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    footerNote: {
      ...typography.caption,
      color: colors.mutedForeground,
      textAlign: 'center',
      marginTop: spacing.xs,
    },
    footnoteText: {
      ...typography.caption,
      color: colors.textSecondary,
    },
    warningFootnote: {
      ...typography.caption,
      color: colors.warning,
    },
  });

  const getTextSizeStyle = (size: number) => ({ fontSize: textSizeValues[size] });

  return (
    <Screen>
      <ScrollView style={{ flex: 1 }}>
        <View style={styles.content}>
          <FeatureHeader
            eyebrow={headerCopy.eyebrow}
            title={headerCopy.title}
            description={headerCopy.description}
            icon="accessibility-outline"
            tone="privacy"
            stats={languageStats}
          />

          {showBanner && (
            <AlertBanner variant="info" dismissible onDismiss={() => setShowBanner(false)} dismissLabel={copy.close}>
              <View style={styles.bannerContent}>
                <Text style={styles.bannerText}>{copy.bannerText}</Text>
                <Button
                  variant="link"
                  size="sm"
                  title={copy.learnMore}
                  onPress={() => Alert.alert(copy.previewAlertTitle, copy.previewAlertMessage)}
                />
              </View>
            </AlertBanner>
          )}

          <Card variant="elevated">
            <CardContent style={styles.cardContent}>
              <View>
                <CardTitle>{copy.languageTitle}</CardTitle>
                <CardDescription>{copy.languageDescription}</CardDescription>
              </View>
              {APP_LANGUAGES.map((language) => {
                const isSelected = languageCode === language.code;

                return (
                  <TouchableOpacity
                    key={language.code}
                    onPress={() => handleLanguageChange(language.code)}
                    style={[
                      styles.languageOption,
                      isSelected && styles.languageOptionSelected,
                      !language.available && styles.languageOptionDisabled,
                    ]}
                    accessibilityRole="radio"
                    accessibilityLabel={language.name}
                    accessibilityState={{
                      selected: isSelected,
                      disabled: !language.available,
                    }}
                    activeOpacity={0.78}
                  >
                    <View
                      style={[
                        styles.radioOuter,
                        isSelected && styles.radioOuterSelected,
                      ]}
                    >
                      {isSelected && <View style={styles.radioInner} />}
                    </View>
                    <View style={styles.languageLabel}>
                      <Text style={styles.flag}>{language.flag}</Text>
                      <Text style={styles.languageName}>{language.name}</Text>
                      {!language.available && (
                        <Badge variant="secondary" style={{ fontSize: 12 }}>
                          {copy.unavailableBadge}
                        </Badge>
                      )}
                    </View>
                  </TouchableOpacity>
                );
              })}

              <Text style={styles.footnoteText}>
                {copy.languageFootnote}
              </Text>
            </CardContent>
          </Card>

          <Card variant="elevated">
            <CardContent style={styles.cardContent}>
              <View>
                <CardTitle>{copy.textSizeTitle}</CardTitle>
                <CardDescription>{copy.textSizeDescription}</CardDescription>
              </View>
              <View style={styles.sliderContainer}>
                <View style={styles.sliderLabels}>
                  {textSizes.map((size, index) => (
                    <Text
                      key={size}
                      style={[
                        styles.sliderLabel,
                        textSize === index && styles.sliderLabelActive,
                      ]}
                    >
                      {size}
                    </Text>
                  ))}
                </View>
                <Slider
                  value={[textSize]}
                  onValueChange={handleTextSizeChange}
                  max={5}
                  min={0}
                  step={1}
                />
              </View>

              <View style={styles.previewContainer}>
                <Text style={[styles.previewTitle, getTextSizeStyle(textSize)]}>
                  {copy.previewTitle}
                </Text>

                <View style={styles.previewActions}>
                  {copy.previewActions.map((label) => (
                    <Text
                      key={label}
                      style={[
                        styles.previewAction,
                        getTextSizeStyle(textSize),
                      ]}
                    >
                      {label}
                    </Text>
                  ))}
                </View>

                <Text style={[styles.previewText, getTextSizeStyle(textSize)]}>
                  {copy.previewBody}
                </Text>
              </View>

              <View style={styles.complianceRow}>
                {isAACompliant ? (
                  <>
                    <Ionicons name="shield-checkmark" size={12} style={styles.complianceGood} />
                    <Text style={[styles.complianceText, styles.complianceGood]}>
                      {copy.complianceGood}
                    </Text>
                  </>
                ) : (
                  <>
                    <Ionicons name="warning" size={12} style={styles.complianceWarning} />
                    <Text style={[styles.complianceText, styles.complianceWarning]}>
                      {copy.complianceWarning}
                    </Text>
                  </>
                )}
              </View>
            </CardContent>
          </Card>

          <Card variant="elevated">
            <CardContent style={styles.cardContent}>
              <CardTitle>{copy.highContrastTitle}</CardTitle>
              <View style={styles.switchRow}>
                <Label>{copy.highContrastToggle}</Label>
                <Switch
                  value={isHighContrast}
                  onValueChange={enabled => { void handleHighContrastToggle(enabled); }}
                  disabled={savingDisplay}
                  accessibilityLabel={copy.highContrastToggle}
                  accessibilityHint="Applies the contrast setting throughout SafeRide"
                />
              </View>

              {systemHighContrast && (
                <Badge variant="secondary" style={{ fontSize: 12, alignSelf: 'flex-start' }}>
                  {copy.systemHighContrastActive}
                </Badge>
              )}

              <View style={styles.previewSwatches}>
                <View style={styles.swatchGroup}>
                  <Text style={styles.swatchLabel}>{copy.normalSwatch}</Text>
                  <View style={styles.swatchRow}>
                    <View style={[styles.swatch, { backgroundColor: colors.primary }]} />
                    <View style={[styles.swatch, { backgroundColor: colors.secondary }]} />
                    <Badge variant="outline">{copy.draftBadge}</Badge>
                  </View>
                </View>
                <View style={styles.swatchGroup}>
                  <Text style={styles.swatchLabel}>{copy.highContrastSwatch}</Text>
                  <View style={styles.swatchRow}>
                    <View style={[styles.swatch, { backgroundColor: '#000', borderWidth: 2, borderColor: colors.border }]} />
                    <View style={[styles.swatch, { backgroundColor: colors.muted, borderWidth: 2, borderColor: colors.border }]} />
                    <Badge variant="outline" style={{ borderWidth: 2, borderColor: '#000' }}>
                      {copy.draftBadge}
                    </Badge>
                  </View>
                </View>
              </View>

              <Text style={styles.footnoteText}>
                {copy.highContrastFootnote}
              </Text>
            </CardContent>
          </Card>

          <Card variant="elevated">
            <CardContent style={styles.cardContent}>
              <View>
                <CardTitle>{copy.screenReaderTitle}</CardTitle>
                <CardDescription>{copy.screenReaderDescription}</CardDescription>
              </View>
              <View style={styles.demoContainer}>
                <Text style={styles.demoTitle}>{copy.demoTitle}</Text>
                {showA11yLabels && (
                  <Text style={styles.a11yLabel}>{copy.demoAnnouncement}</Text>
                )}
              </View>

              <View style={styles.demoButtons}>
                <Button variant="outline" size="sm" onPress={handlePlayDemo}>
                  <Ionicons name="volume-high" size={16} color={colors.foreground} style={{ marginRight: 4 }} />
                  {copy.playDemo}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onPress={() => setShowA11yLabels(!showA11yLabels)}
                >
                  <Ionicons name="eye" size={16} color={colors.foreground} style={{ marginRight: 4 }} />
                  {showA11yLabels ? copy.hideLabels : copy.showLabels}
                </Button>
              </View>

              <Text style={styles.footnoteText}>
                {copy.screenReaderFootnote}
              </Text>
            </CardContent>
          </Card>

          <Card variant="elevated">
            <CardContent style={styles.cardContent}>
              <CardTitle>{copy.hapticsTitle}</CardTitle>
              <View style={styles.switchRow}>
                <Label>{copy.hapticsToggle}</Label>
                <Switch
                  value={hapticsEnabled}
                  onValueChange={setHapticsEnabled}
                />
              </View>

              <Button
                variant="outline"
                size="sm"
                onPress={handleTestHaptic}
                disabled={!hapticsEnabled}
                style={{ alignSelf: 'flex-start' }}
              >
                <Ionicons name="phone-portrait" size={16} color={colors.foreground} style={{ marginRight: 4 }} />
                {copy.testHaptic}
              </Button>

              <Text style={styles.warningFootnote}>
                {copy.hapticsFootnote}
              </Text>
            </CardContent>
          </Card>
        </View>
      </ScrollView>

      <View style={styles.footer}>
        <View style={styles.footerContent}>
          <Button variant="link" onPress={() => { void handleRestoreDefaults(); }} disabled={savingDisplay} loading={savingDisplay}>
            {copy.restoreDefaults}
          </Button>
          <Button onPress={() => navigation.goBack()}>
            {copy.done}
          </Button>
        </View>
        <Text style={styles.footerNote}>{copy.footerNote}</Text>
      </View>
    </Screen>
  );
}
