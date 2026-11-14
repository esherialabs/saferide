import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import Screen from '../components/ui/Screen';
import Button from '../components/ui/Button';
import { SafetyIllustration } from '../components/ui/SafetyIllustration';
import { borders, radii, spacing, typography } from '../theme/tokens';
import { useTheme } from '../theme/SimpleThemeProvider';
import { RootStackParamList } from '../navigation/routes';
import { PARTNER_SHARING_COPY } from '../i18n/partnerSharingCopy';
import { useOnline } from '../context/OnlineProvider';
import { resolveConfirmationState } from '../utils/caseSubmissionFlow';
import { draftStorage, type DraftData } from '../utils/draftStorage';
import { buildSubmissionConfirmationCopy, type PartnerSharingDraft } from '../utils/partnerSharing';
import { devPrivacyWarn, getPrivacySafeErrorReason } from '../utils/privacyLog';

type EscalationConfirmationNavigationProp = NativeStackNavigationProp<RootStackParamList>;

interface EscalationConfirmationRouteParams {
  isOffline?: boolean;
  caseId: string;
  contactMethod: string;
  /** Local draft of this report; its HURIA outcome (and reference) is read from the phone, not the route. */
  draftId?: string;
}

export default function EscalationConfirmationScreen() {
  const navigation = useNavigation<EscalationConfirmationNavigationProp>();
  const route = useRoute();
  const { colors } = useTheme();

  const { isOffline: routeIsOffline = false, caseId: routeCaseId, contactMethod, draftId } = route.params as EscalationConfirmationRouteParams;
  const { syncStatus } = useOnline();
  const [draft, setDraft] = useState<DraftData | null>(null);
  const [partnerSharing, setPartnerSharing] = useState<PartnerSharingDraft | null>(null);
  // Until the local draft is read, say nothing about partners either way.
  const [sharingKnown, setSharingKnown] = useState(false);

  // Re-read the draft whenever the send queue moves, so "Queued" becomes "Sent" honestly.
  useEffect(() => {
    let active = true;
    if (!draftId) return undefined;
    draftStorage.getDraft(draftId)
      .then(loaded => {
        if (!active || !loaded) return;
        setDraft(loaded);
        setPartnerSharing(loaded.partnerSharing ?? null);
        setSharingKnown(true);
      })
      .catch(error => devPrivacyWarn('confirmation draft lookup failed', { reason: getPrivacySafeErrorReason(error) }));
    return () => {
      active = false;
    };
  }, [draftId, syncStatus]);

  const { queued: isOffline, caseId } = resolveConfirmationState({ routeIsOffline, routeCaseId, draft });
  // "Sent to SafeRide", never "Delivered": SafeRide received it; no one has acted on it yet.
  const confirmation = buildSubmissionConfirmationCopy({ isOffline, sharing: partnerSharing, sharingKnown });
  const statusColor = isOffline ? colors.primary : colors.success;
  const summaryRows = [
    { label: 'Status', value: confirmation.statusLabel },
    { label: 'Case ID', value: caseId },
    // Older routes may omit the contact method; never print "undefined".
    ...(contactMethod ? [{ label: 'Contact', value: contactMethod }] : []),
    ...(confirmation.reference
      ? [{ label: PARTNER_SHARING_COPY.confirmation.referenceLabel, value: confirmation.reference }]
      : []),
  ];

  const styles = StyleSheet.create({
    content: {
      flexGrow: 1,
      justifyContent: 'center',
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xl,
    },
    hero: {
      alignItems: 'center',
      gap: spacing.xs,
    },
    art: {
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: 88,
    },
    statusIcon: {
      alignItems: 'center',
      borderColor: colors.canvas,
      borderRadius: radii.round,
      borderWidth: 3,
      height: 48,
      justifyContent: 'center',
      width: 48,
    },
    statusIconOnArt: {
      bottom: -6,
      position: 'absolute',
      right: -10,
    },
    title: {
      ...typography.headlineLarge,
      color: colors.foreground,
      marginTop: spacing.sm,
      textAlign: 'center',
    },
    subtitle: {
      ...typography.bodyMedium,
      color: colors.textSecondary,
      textAlign: 'center',
    },
    summary: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: radii.card,
      borderWidth: borders.hairline,
      marginTop: spacing.lg,
      paddingHorizontal: spacing.md,
    },
    summaryRow: {
      alignItems: 'center',
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
      justifyContent: 'space-between',
      minHeight: 48,
      paddingVertical: spacing.sm,
    },
    summaryDivider: {
      borderTopColor: colors.divider,
      borderTopWidth: borders.hairline,
    },
    summaryLabel: {
      ...typography.bodySmall,
      color: colors.textSecondary,
    },
    summaryValue: {
      ...typography.labelLarge,
      color: colors.foreground,
      flexShrink: 1,
      textAlign: 'right',
    },
    buttonsContainer: {
      gap: spacing.xs,
      marginTop: spacing.lg,
    },
    microcopy: {
      ...typography.bodySmall,
      color: colors.textSecondary,
      marginTop: spacing.md,
      textAlign: 'center',
    },
  });

  const handleViewCase = () => {
    navigation.navigate('CaseDetail', { caseId });
  };

  const handleDone = () => {
    navigation.navigate('MainTabs');
  };

  const statusBadge = (
    <View style={[styles.statusIcon, { backgroundColor: statusColor }]}>
      <Ionicons
        name={isOffline ? 'time' : 'checkmark'}
        size={26}
        color={colors.primaryForeground}
      />
    </View>
  );

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.hero}>
          <View style={styles.art}>
            <SafetyIllustration kind="evidence" size={88} responsive />
            <View style={styles.statusIconOnArt}>{statusBadge}</View>
          </View>

          <Text accessibilityRole="header" style={styles.title}>
            {confirmation.title}
          </Text>
          <Text style={styles.subtitle}>
            {confirmation.subtitle}
          </Text>
          {confirmation.referenceHint ? (
            <Text style={styles.subtitle}>{confirmation.referenceHint}</Text>
          ) : null}
          {confirmation.callbackNote ? (
            <Text style={styles.subtitle}>{confirmation.callbackNote}</Text>
          ) : null}
        </View>

        <View style={styles.summary}>
          {summaryRows.map((row, index) => (
            <View
              key={row.label}
              style={[styles.summaryRow, index > 0 && styles.summaryDivider]}
              accessible
              accessibilityLabel={`${row.label}: ${row.value}`}
            >
              <Text style={styles.summaryLabel}>{row.label}</Text>
              <Text style={[styles.summaryValue, row.label === 'Status' ? { color: statusColor } : null]}>
                {row.value}
              </Text>
            </View>
          ))}
        </View>

        <View style={styles.buttonsContainer}>
          <Button
            title="View case"
            onPress={handleViewCase}
            size="lg"
            fullWidth
          />
          <Button
            title="Done"
            onPress={handleDone}
            variant="ghost"
            fullWidth
          />
        </View>

        <Text style={styles.microcopy}>
          Case details show available local draft actions. Open a submitted case detail to request manual deletion review.
        </Text>
      </ScrollView>
    </Screen>
  );
}
