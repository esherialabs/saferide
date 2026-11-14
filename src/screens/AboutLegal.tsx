import React, { useEffect, useMemo, useState } from 'react';
import { Linking, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import Screen from '../components/ui/Screen';
import { Badge, Card, CardContent, FeatureHeader, type FeatureHeaderStat } from '../components/ui';
import { useTheme } from '../theme/SimpleThemeProvider';
import { borders, radii, spacing, typography } from '../theme/tokens';
import { getCatalogInfo } from '../lib/catalog';
import { LEGAL_LINKS } from '../config/legalLinks';

type CatalogRow = {
  label: string;
  value: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
};

export default function AboutLegalScreen() {
  const { colors } = useTheme();
  const [providersUpdatedAt, setProvidersUpdatedAt] = useState<string | null>(null);
  const [tagsUpdatedAt, setTagsUpdatedAt] = useState<string | null>(null);
  const [tipsUpdatedAt, setTipsUpdatedAt] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const info = await getCatalogInfo();
        setProvidersUpdatedAt(info.providersLastUpdated);
        setTagsUpdatedAt(info.legalTagsLastUpdated);
        setTipsUpdatedAt(info.tipsLastUpdated);
      } catch {
        // Catalog timestamps are informational only.
      }
    })();
  }, []);

  const formatDate = (value: string | null) => (
    value ? new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Bundled'
  );

  const heroStats = useMemo<FeatureHeaderStat[]>(() => [
    { label: 'Local-first reports', value: 'Consent', icon: 'shield-checkmark-outline' },
    { label: 'Support data', value: 'Catalog', icon: 'people-outline' },
    { label: 'Release copy', value: 'Guidance', icon: 'document-text-outline' },
  ], []);

  const catalogRows = useMemo<CatalogRow[]>(() => [
    { label: 'Providers', value: formatDate(providersUpdatedAt), icon: 'people-outline' },
    { label: 'Legal tags', value: formatDate(tagsUpdatedAt), icon: 'pricetags-outline' },
    { label: 'Tips', value: formatDate(tipsUpdatedAt), icon: 'book-outline' },
  ], [providersUpdatedAt, tagsUpdatedAt, tipsUpdatedAt]);

  const styles = StyleSheet.create({
    scrollContent: {
      gap: spacing.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.lg,
    },
    cardContent: {
      gap: spacing.sm,
    },
    rowHeader: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.sm,
    },
    iconBox: {
      alignItems: 'center',
      backgroundColor: colors.primaryMuted,
      borderColor: colors.primary + '22',
      borderRadius: radii.card,
      borderWidth: borders.hairline,
      height: 42,
      justifyContent: 'center',
      width: 42,
    },
    title: {
      ...typography.titleMedium,
      color: colors.foreground,
      flex: 1,
    },
    body: {
      ...typography.bodySmall,
      color: colors.textSecondary,
    },
    catalogGrid: {
      gap: spacing.xs,
    },
    catalogRow: {
      alignItems: 'center',
      backgroundColor: colors.privacyMuted,
      borderColor: colors.divider,
      borderRadius: radii.card,
      borderWidth: borders.hairline,
      flexDirection: 'row',
      gap: spacing.sm,
      minHeight: 48,
      overflow: 'hidden',
      paddingHorizontal: spacing.sm,
      position: 'relative',
    },
    catalogCopy: {
      flex: 1,
      minWidth: 0,
    },
    catalogLabel: {
      ...typography.labelSmall,
      color: colors.foreground,
    },
    catalogValue: {
      ...typography.caption,
      color: colors.textSecondary,
    },
    linkRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
    },
    linkButton: {
      alignItems: 'center',
      backgroundColor: colors.primaryMuted,
      borderColor: colors.primary + '22',
      borderRadius: radii.card,
      borderWidth: borders.hairline,
      flexDirection: 'row',
      gap: spacing.xxs,
      minHeight: 38,
      paddingHorizontal: spacing.sm,
    },
    linkText: {
      ...typography.labelSmall,
      color: colors.primary,
    },
  });

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <FeatureHeader
          eyebrow="SafeRide"
          title="About and legal"
          description="Clear boundaries for reports, support resources, privacy, and release notices."
          icon="information-circle-outline"
          tone="privacy"
          stats={heroStats}
        />

        <Card variant="elevated">
          <CardContent style={styles.cardContent}>
            <View style={styles.rowHeader}>
              <View style={styles.iconBox}>
                <Ionicons name="lock-closed-outline" size={19} color={colors.primary} />
              </View>
              <Text style={styles.title}>What SafeRide is for</Text>
              <Badge variant="info" size="sm">Local first</Badge>
            </View>
            <Text style={styles.body}>
              SafeRide helps document incidents, organize evidence, review rights information, and choose support routes. Reports stay controlled by consent steps before export, referral, escalation, or sharing.
            </Text>
          </CardContent>
        </Card>

        <Card variant="elevated">
          <CardContent style={styles.cardContent}>
            <View style={styles.rowHeader}>
              <View style={styles.iconBox}>
                <Ionicons name="scale-outline" size={19} color={colors.primary} />
              </View>
              <Text style={styles.title}>Notices</Text>
            </View>
            <Text style={styles.body}>
              SafeRide provides information and workflow support. It is not a lawyer, clinician, counsellor, emergency responder, or provider. For legal or medical guidance, contact a qualified professional or support organization.
            </Text>
            <View style={styles.linkRow}>
              <TouchableOpacity style={styles.linkButton} onPress={() => Linking.openURL(LEGAL_LINKS.terms)}>
                <Ionicons name="document-text-outline" size={15} color={colors.primary} />
                <Text style={styles.linkText}>Terms</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.linkButton} onPress={() => Linking.openURL(LEGAL_LINKS.privacy)}>
                <Ionicons name="shield-outline" size={15} color={colors.primary} />
                <Text style={styles.linkText}>Privacy</Text>
              </TouchableOpacity>
            </View>
          </CardContent>
        </Card>

        <Card variant="elevated">
          <CardContent style={styles.cardContent}>
            <View style={styles.rowHeader}>
              <View style={styles.iconBox}>
                <Ionicons name="sync-outline" size={19} color={colors.primary} />
              </View>
              <Text style={styles.title}>Catalog status</Text>
            </View>
            <View style={styles.catalogGrid}>
              {catalogRows.map(row => (
                <View key={row.label} style={styles.catalogRow}>
                  <Ionicons name={row.icon} size={17} color={colors.primary} />
                  <View style={styles.catalogCopy}>
                    <Text style={styles.catalogLabel}>{row.label}</Text>
                    <Text style={styles.catalogValue}>{row.value}</Text>
                  </View>
                </View>
              ))}
            </View>
          </CardContent>
        </Card>
      </ScrollView>
    </Screen>
  );
}
