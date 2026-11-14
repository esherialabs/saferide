import React, { useEffect, useMemo, useState } from 'react';
import { Alert, View, Text, StyleSheet, ScrollView, Pressable, Share } from 'react-native';
import Constants from 'expo-constants';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import Screen from '../components/ui/Screen';
import { useTheme } from '../theme/SimpleThemeProvider';
import { RootStackParamList } from '../navigation/routes';
import { useToast } from '../components/ui/Toast';
import { getCatalogInfo, refreshProviders, refreshLegalTags, refreshTips } from '../lib/catalog';
import { useAuth } from '../context/AuthProvider';
import { useOnline } from '../context/OnlineProvider';
import { useLanguage } from '../context/LanguageProvider';
import { getSettingsCopy } from '../i18n/appLanguage';
import { getModeratedTestCopy } from '../i18n/languageAccessibilityCopy';
import { getMeasurementModeDecision } from '../lib/measurement/measurementConfig';
import { buildCatalogFreshnessSummary, buildCatalogRefreshSummary } from '../utils/supportDiscovery';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { borders, elevation, radii, spacing, typography } from '../theme/tokens';
import { AppearanceControl } from '../components/ui/AppearanceControl';
import { getLocalAiPilotCopy } from '../i18n/localAiPilotCopy';
import {
  createAiPilotDiagnosticsExport,
  deleteAiPilotDiagnostics,
  isAiPilotDiagnosticsEnabled,
} from '../lib/localAssistant/pilotDiagnostics';
import { getLocalAssistantDescriptor } from '../services/localAssistantService';

type SettingsNavigationProp = NativeStackNavigationProp<RootStackParamList>;

type SettingRow = {
  key: string;
  title: string;
  icon: keyof typeof Ionicons.glyphMap;
  onPress?: () => void;
  meta?: string;
  disabled?: boolean;
  hideChevron?: boolean;
};

type SettingsSection = {
  key: string;
  label: string;
  rows: SettingRow[];
};

function confirmSettingsAction(
  title: string,
  message: string,
  cancelLabel: string,
  confirmLabel: string,
  destructive = false,
): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    Alert.alert(
      title,
      message,
      [
        { text: cancelLabel, style: 'cancel', onPress: () => settle(false) },
        { text: confirmLabel, style: destructive ? 'destructive' : 'default', onPress: () => settle(true) },
      ],
      { cancelable: true, onDismiss: () => settle(false) },
    );
  });
}

export default function SettingsScreen() {
  const navigation = useNavigation<SettingsNavigationProp>();
  const { colors } = useTheme();
  const toast = useToast();
  const { signOut, user } = useAuth();
  const { isOnline } = useOnline();
  const { languageCode } = useLanguage();
  const copy = getSettingsCopy(languageCode);
  const measurementCopy = getModeratedTestCopy(languageCode);
  const measurementDecision = useMemo(() => getMeasurementModeDecision(), []);
  const pilotCopy = getLocalAiPilotCopy(languageCode);
  const aiPilotDiagnosticsEnabled = useMemo(() => isAiPilotDiagnosticsEnabled(), []);

  const [updatingCatalogs, setUpdatingCatalogs] = useState(false);
  const [catalogStatusMessage, setCatalogStatusMessage] = useState<string>(copy.checkingCatalogStatus);

  useEffect(() => {
    (async () => {
      try {
        const info = await getCatalogInfo();
        setCatalogStatusMessage(buildCatalogFreshnessSummary(info));
      } catch {
        setCatalogStatusMessage(copy.catalogStatusUnavailable);
      }
    })();
  }, [copy.catalogStatusUnavailable]);

  const handleUpdateCatalogs = async () => {
    if (updatingCatalogs) return;
    setUpdatingCatalogs(true);
    try {
      const [providers, legalTags, tips] = await Promise.all([refreshProviders(), refreshLegalTags(), refreshTips()]);

      const summary = buildCatalogRefreshSummary([
        {
          label: 'Providers',
          source: providers.source,
          lastUpdated: providers.lastUpdated,
          itemCount: providers.items.length,
          error: providers.error,
        },
        {
          label: 'Rights tags',
          source: legalTags.source,
          lastUpdated: legalTags.lastUpdated,
          itemCount: legalTags.items.length,
          error: legalTags.error,
        },
        {
          label: 'Tips',
          source: tips.source,
          lastUpdated: tips.lastUpdated,
          itemCount: tips.items.length,
          error: tips.error,
        },
      ]);
      const offlinePrefix = isOnline ? '' : copy.offlinePrefix;
      setCatalogStatusMessage(`${offlinePrefix}${summary.message}`);
      toast.show({ title: summary.title, message: `${offlinePrefix}${summary.message}`, variant: summary.variant });
    } catch (e) {
      const message = copy.catalogUpdateFailed;
      setCatalogStatusMessage(message);
      toast.show({ title: copy.catalogUpdateFailedTitle, message, variant: 'error' });
    } finally {
      setUpdatingCatalogs(false);
    }
  };

  const handleSignOut = async () => {
    try {
      await AsyncStorage.removeItem('NAVIGATION_STATE');
      await signOut();
      toast.show({ title: copy.signedOut, variant: 'info' });
    } catch (error) {
      console.warn('Failed to sign out', error);
      toast.show({ title: copy.signOutFailed, variant: 'error' });
    }
  };

  const handleExportAiPilotDiagnostics = async () => {
    // Export needs explicit consent that names every included field; nothing is uploaded.
    const accepted = await confirmSettingsAction(
      pilotCopy.export.consentTitle,
      pilotCopy.export.consentMessage,
      pilotCopy.export.consentCancel,
      pilotCopy.export.consentConfirm,
    );
    if (!accepted) return;
    try {
      const descriptor = getLocalAssistantDescriptor();
      const summary = await createAiPilotDiagnosticsExport({
        consentConfirmedAt: new Date(),
        appVersion: Constants.expoConfig?.version ?? null,
        manifestId: descriptor.manifestId ?? null,
        artifactSha256: descriptor.artifactSha256 ?? null,
      });
      const result = await Share.share({ title: pilotCopy.export.shareTitle, message: summary });
      if (result.action === Share.sharedAction) {
        toast.show({ title: pilotCopy.export.shared, variant: 'success' });
      }
    } catch {
      toast.show({ title: pilotCopy.export.failed, variant: 'error' });
    }
  };

  const handleDeleteAiPilotDiagnostics = async () => {
    const accepted = await confirmSettingsAction(
      pilotCopy.export.deleteConfirmTitle,
      pilotCopy.export.deleteConfirmMessage,
      pilotCopy.export.consentCancel,
      pilotCopy.export.deleteConfirm,
      true,
    );
    if (!accepted) return;
    try {
      await deleteAiPilotDiagnostics();
      toast.show({ title: pilotCopy.export.deleted, variant: 'success' });
    } catch {
      toast.show({ title: pilotCopy.export.failed, variant: 'error' });
    }
  };

  const displayName =
    user?.user_metadata?.full_name ||
    user?.email?.split('@')?.[0] ||
    copy.noAccountRider;
  const email = user?.email ?? copy.noAccountSession;

  const settingSections: SettingsSection[] = [
    {
      key: 'profile',
      label: copy.profileAccount,
      rows: [
        {
          key: 'account',
          title: copy.account,
          meta: email,
          icon: 'person-circle-outline',
          hideChevron: true,
        },
        {
          key: 'sign-out',
          title: copy.signOut,
          icon: 'log-out-outline',
          onPress: handleSignOut,
        },
      ],
    },
    {
      key: 'preferences',
      label: copy.preferences,
      rows: [
        {
          key: 'safety-settings',
          title: copy.safetySettings,
          icon: 'shield-outline',
          onPress: () => navigation.navigate('SafetySettings'),
        },
        {
          key: 'privacy-data',
          title: copy.privacyData,
          icon: 'lock-closed-outline',
          onPress: () => navigation.navigate('PrivacyData'),
        },
        {
          key: 'update-catalogs',
          title: updatingCatalogs ? copy.refreshingCatalogs : copy.refreshSupportCatalogs,
          meta: copy.catalogMeta,
          icon: 'refresh-outline',
          onPress: handleUpdateCatalogs,
          disabled: updatingCatalogs,
        },
        {
          key: 'language-accessibility',
          title: copy.languageAccessibility,
          meta: copy.languageMeta,
          icon: 'globe-outline',
          onPress: () => navigation.navigate('LanguageAccessibility'),
        },
        ...(measurementDecision.enabled ? [{
          key: 'moderated-test',
          title: measurementCopy.settingsTitle,
          meta: measurementCopy.settingsMeta,
          icon: 'clipboard-outline',
          onPress: () => navigation.navigate('TestMeasurementConsent'),
        } satisfies SettingRow] : []),
        ...(aiPilotDiagnosticsEnabled ? [
          {
            key: 'ai-pilot-export',
            title: pilotCopy.export.settingsTitle,
            meta: pilotCopy.export.settingsMeta,
            icon: 'analytics-outline',
            onPress: () => { void handleExportAiPilotDiagnostics(); },
          } satisfies SettingRow,
          {
            key: 'ai-pilot-delete',
            title: pilotCopy.export.deleteTitle,
            meta: pilotCopy.export.deleteMeta,
            icon: 'trash-outline',
            onPress: () => { void handleDeleteAiPilotDiagnostics(); },
          } satisfies SettingRow,
        ] : []),
      ],
    },
    {
      key: 'waymo',
      label: copy.supportInfo,
      rows: [
        {
          key: 'tips-rights',
          title: copy.tipsRights,
          icon: 'bulb-outline',
          onPress: () => navigation.navigate('TipsRights'),
        },
        {
          key: 'about-legal',
          title: copy.aboutLegal,
          icon: 'information-circle-outline',
          onPress: () => navigation.navigate('AboutLegal'),
        },
      ],
    },
  ];

  const styles = StyleSheet.create({
    scrollContent: {
      paddingTop: spacing.sm,
      paddingBottom: spacing.xl,
      paddingHorizontal: spacing.gutter,
      backgroundColor: colors.canvas,
      gap: spacing.md,
    },
    header: {
      marginBottom: spacing.xs,
    },
    summaryCard: {
      backgroundColor: colors.privacyMuted,
      borderColor: colors.divider,
      borderRadius: radii.card,
      borderWidth: borders.hairline,
      gap: spacing.xs,
      overflow: 'hidden',
      padding: spacing.md,
      position: 'relative',
      ...elevation.card,
    },
    summaryTopRow: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.sm,
    },
    summaryIcon: {
      alignItems: 'center',
      backgroundColor: colors.privacyMuted,
      borderColor: colors.privacy + '33',
      borderRadius: radii.card,
      borderWidth: borders.hairline,
      height: 38,
      justifyContent: 'center',
      width: 38,
    },
    summaryCopy: {
      flex: 1,
      minWidth: 0,
    },
    summaryEyebrow: {
      ...typography.overline,
      color: colors.textSecondary,
      textTransform: 'uppercase',
    },
    summaryTitle: {
      ...typography.titleLarge,
      color: colors.textPrimary,
    },
    summaryMeta: {
      ...typography.bodySmall,
      color: colors.textSecondary,
      marginTop: spacing.xxxs,
    },
    summaryStatusRow: {
      alignItems: 'center',
      borderColor: colors.divider,
      borderRadius: radii.card,
      borderWidth: borders.hairline,
      flexDirection: 'row',
      gap: spacing.xs,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xxs,
    },
    catalogStatusText: {
      ...typography.caption,
      color: colors.textSecondary,
      flex: 1,
      lineHeight: 16,
    },
    section: {
      marginTop: spacing.xxs,
    },
    sectionLabel: {
      ...typography.labelSmall,
      color: colors.textSecondary,
      marginBottom: spacing.xs,
      textTransform: 'uppercase',
    },
    card: {
      backgroundColor: colors.surface,
      borderColor: colors.divider,
      borderRadius: radii.card,
      borderWidth: borders.hairline,
      overflow: 'hidden',
      paddingHorizontal: spacing.xs,
      paddingVertical: spacing.xxs,
      position: 'relative',
      ...elevation.card,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: 52,
      paddingVertical: spacing.xs,
      borderRadius: radii.sm,
      paddingHorizontal: spacing.xs,
    },
    rowPressed: {
      backgroundColor: colors.surfaceAlt,
    },
    rowDisabled: {
      opacity: 0.6,
    },
    rowIcon: {
      marginRight: 12,
    },
    rowContent: {
      flex: 1,
    },
    rowTitle: {
      ...typography.bodyM,
      color: colors.textPrimary,
    },
    rowMeta: {
      ...typography.caption,
      color: colors.textSecondary,
      marginTop: 2,
    },
    chevron: {
      marginLeft: 12,
    },
    divider: {
      height: 1,
      backgroundColor: colors.divider,
    },
  });

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <View style={styles.summaryCard}>
            <View style={styles.summaryTopRow}>
              <View style={styles.summaryIcon}>
                <Ionicons name="person-circle-outline" size={22} color={colors.privacy} />
              </View>
              <View style={styles.summaryCopy}>
                <Text style={styles.summaryEyebrow}>{copy.settingsEyebrow}</Text>
                <Text style={styles.summaryTitle}>{displayName}</Text>
                <Text style={styles.summaryMeta}>{email}</Text>
              </View>
            </View>
            <View style={styles.summaryStatusRow}>
              <Ionicons name={isOnline ? 'cloud-done-outline' : 'cloud-offline-outline'} size={15} color={colors.primary} />
              <Text style={styles.catalogStatusText}>{catalogStatusMessage}</Text>
            </View>
          </View>
        </View>

        <View style={styles.section}><AppearanceControl /></View>
        {settingSections.map((section) => (
          <View key={section.key} style={styles.section}>
            <Text style={styles.sectionLabel}>{section.label}</Text>
            <View style={styles.card}>
              {section.rows.map((row, index) => (
                <React.Fragment key={row.key}>
                  {index > 0 && <View style={styles.divider} />}
                  <Pressable
                    onPress={row.onPress}
                    disabled={!row.onPress || row.disabled}
                    accessibilityRole={row.onPress ? 'button' : undefined}
                    accessibilityLabel={row.meta ? `${row.title}. ${row.meta}` : row.title}
                    accessibilityState={{ disabled: !row.onPress || Boolean(row.disabled), busy: row.key === 'update-catalogs' && updatingCatalogs }}
                    style={({ pressed }) => [
                      styles.row,
                      pressed && !(row.disabled || !row.onPress) && styles.rowPressed,
                      row.disabled && styles.rowDisabled,
                    ]}
                  >
                    <Ionicons
                      accessible={false}
                      name={row.icon}
                      size={24}
                      color={colors.primary}
                      style={styles.rowIcon}
                    />
                    <View style={styles.rowContent}>
                      <Text style={styles.rowTitle}>{row.title}</Text>
                      {row.meta ? <Text style={styles.rowMeta}>{row.meta}</Text> : null}
                    </View>
                    {!row.hideChevron && (
                      <Ionicons
                        accessible={false}
                        name="chevron-forward"
                        size={18}
                        color={colors.textTertiary}
                        style={styles.chevron}
                      />
                    )}
                  </Pressable>
                </React.Fragment>
              ))}
            </View>
          </View>
        ))}
      </ScrollView>
    </Screen>
  );
}
