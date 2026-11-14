import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { CompositeNavigationProp, useFocusEffect, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';

import { Button, DashboardTemplate } from '../components/ui';
import { useToast } from '../components/ui/Toast';
import { MainTabParamList, RootStackParamList } from '../navigation/routes';
import { resetReportStackToRoute } from '../navigation/reportNavigation';
import {
  getReportWizardProgress,
  getReportWizardResumeTarget,
  type ReportWizardProgress,
  type ReportWizardStep,
} from '../navigation/reportPathwayFlow';
import { useTheme } from '../theme/SimpleThemeProvider';
import { borders, radii, spacing, typography } from '../theme/tokens';
import { draftStorage, type DraftData } from '../utils/draftStorage';
import { devPrivacyWarn, getPrivacySafeErrorReason } from '../utils/privacyLog';
import { getEditableReportDrafts } from '../utils/reportDraftSelection';

type ReportHubNavigationProp = CompositeNavigationProp<
  BottomTabNavigationProp<MainTabParamList, 'Report'>,
  NativeStackNavigationProp<RootStackParamList>
>;

function formatSavedAt(value?: Date | null): string {
  if (!value || Number.isNaN(value.getTime())) {
    return 'Saved locally';
  }

  const now = Date.now();
  const diffMs = now - value.getTime();
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;

  if (diffMs >= 0 && diffMs < minuteMs) {
    return 'Saved just now';
  }

  if (diffMs >= 0 && diffMs < hourMs) {
    const minutes = Math.max(1, Math.floor(diffMs / minuteMs));
    return `Saved ${minutes} min ago`;
  }

  const today = new Date(now);
  if (
    value.getFullYear() === today.getFullYear() &&
    value.getMonth() === today.getMonth() &&
    value.getDate() === today.getDate()
  ) {
    return `Saved ${value.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }

  return `Saved ${value.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

function getResumeStep(progress: ReportWizardProgress): ReportWizardStep | undefined {
  return progress.steps.find((step) => step.status === 'current') ??
    progress.steps.find((step) => step.status === 'upcoming') ??
    progress.steps.at(-1);
}

function getStepStatusLabel(status: ReportWizardStep['status']) {
  switch (status) {
    case 'complete':
      return 'Done';
    case 'current':
      return 'Next';
    case 'skipped':
      return 'Skipped';
    case 'upcoming':
    default:
      return 'Open';
  }
}

function getEvidenceSummary(draft: DraftData): string {
  const mediaCount = draft.mediaFiles?.length ?? 0;
  if (mediaCount > 0) {
    return `${mediaCount} evidence item${mediaCount === 1 ? '' : 's'}`;
  }

  if (draft.textEvidence?.trim()) {
    return 'Text evidence saved';
  }

  return 'No evidence yet';
}

export default function ReportHubScreen() {
  const navigation = useNavigation<ReportHubNavigationProp>();
  const { colors } = useTheme();
  const toast = useToast();
  const [drafts, setDrafts] = useState<DraftData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadDrafts = useCallback(async () => {
    const allDrafts = await draftStorage.getAllDrafts();
    return getEditableReportDrafts(allDrafts);
  }, []);

  // Refresh whenever a draft write commits so the workspace never shows a
  // stale draft list while it is on screen.
  useEffect(() => draftStorage.subscribe(() => {
    loadDrafts()
      .then((editableDrafts) => {
        setDrafts(editableDrafts);
        setLoadError(null);
      })
      .catch(() => {});
  }), [loadDrafts]);

  useFocusEffect(
    useCallback(() => {
      let isActive = true;
      setIsLoading(true);

      loadDrafts()
        .then((editableDrafts) => {
          if (!isActive) return;
          setDrafts(editableDrafts);
          setLoadError(null);
        })
        .catch((error) => {
          devPrivacyWarn('report workspace draft load failed', {
            reason: getPrivacySafeErrorReason(error),
          });
          if (!isActive) return;
          setLoadError('Draft progress could not be loaded.');
          toast.show({ title: 'Draft progress unavailable', variant: 'error' });
        })
        .finally(() => {
          if (isActive) {
            setIsLoading(false);
          }
        });

      return () => {
        isActive = false;
      };
    }, [loadDrafts, toast]),
  );

  const latestDraft = drafts[0] ?? null;
  const otherDrafts = drafts.slice(1, 3);
  const progress = useMemo(() => latestDraft ? getReportWizardProgress(latestDraft) : null, [latestDraft]);
  // Without a draft, the outline still shows the four steps ahead.
  const outline = useMemo(() => progress ?? getReportWizardProgress(null), [progress]);
  const resumeStep = useMemo(() => progress ? getResumeStep(progress) : undefined, [progress]);
  const progressLabel = progress ? `${progress.completedSteps}/${progress.totalSteps}` : '0/4';
  const draftCountLabel = drafts.length === 1 ? '1 draft in progress' : `${drafts.length} drafts in progress`;
  const latestSavedLabel = latestDraft ? formatSavedAt(latestDraft.updatedAt) : 'No draft in progress';

  const styles = StyleSheet.create({
    scrollContent: {
      gap: spacing.md,
      paddingBottom: spacing.xl,
    },
    header: {
      gap: spacing.xxs,
      paddingTop: spacing.xxs,
    },
    eyebrow: {
      ...typography.overline,
      color: colors.primary,
      letterSpacing: 0.6,
      textTransform: 'uppercase',
    },
    title: {
      ...typography.headlineMedium,
      color: colors.foreground,
      letterSpacing: -0.3,
    },
    subtitle: {
      ...typography.bodyMedium,
      color: colors.textSecondary,
    },
    loadingRow: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.sm,
    },
    loadingText: {
      ...typography.bodySmall,
      color: colors.textSecondary,
    },
    outlineCard: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: radii.card,
      borderWidth: borders.hairline,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    outlineHeader: {
      alignItems: 'center',
      columnGap: spacing.sm,
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'space-between',
      marginBottom: spacing.xs,
    },
    outlineTitle: {
      ...typography.titleSmall,
      color: colors.foreground,
    },
    outlineMeta: {
      ...typography.caption,
      color: colors.textSecondary,
    },
    stepRow: {
      flexDirection: 'row',
      gap: spacing.sm,
    },
    stepRail: {
      alignItems: 'center',
      width: 28,
    },
    stepDot: {
      alignItems: 'center',
      borderRadius: radii.round,
      borderWidth: borders.emphasized,
      height: 28,
      justifyContent: 'center',
      width: 28,
    },
    stepNumber: {
      ...typography.labelSmall,
      fontWeight: '700',
    },
    stepLine: {
      flex: 1,
      marginVertical: 2,
      minHeight: 12,
      width: 2,
    },
    stepCopy: {
      flex: 1,
      minWidth: 0,
      paddingBottom: spacing.sm,
    },
    stepTitleRow: {
      alignItems: 'center',
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
      minHeight: 28,
    },
    stepTitle: {
      ...typography.labelLarge,
      color: colors.foreground,
      flexShrink: 1,
    },
    stepStatus: {
      ...typography.labelSmall,
      borderRadius: radii.round,
      overflow: 'hidden',
      paddingHorizontal: spacing.xs,
      paddingVertical: 2,
    },
    stepDescription: {
      ...typography.bodySmall,
      color: colors.textSecondary,
    },
    actions: {
      gap: spacing.xs,
    },
    actionRow: {
      flexDirection: 'row',
      gap: spacing.sm,
    },
    actionButton: {
      flex: 1,
    },
    recentPanel: {
      backgroundColor: colors.surface,
      borderColor: colors.divider,
      borderRadius: radii.card,
      borderWidth: borders.hairline,
      overflow: 'hidden',
    },
    recentHeader: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.md,
      paddingTop: spacing.sm,
      paddingBottom: spacing.xs,
    },
    recentTitle: {
      ...typography.titleSmall,
      color: colors.foreground,
    },
    recentCount: {
      ...typography.caption,
      color: colors.textSecondary,
    },
    recentRow: {
      alignItems: 'center',
      borderTopColor: colors.divider,
      borderTopWidth: borders.hairline,
      flexDirection: 'row',
      gap: spacing.sm,
      minHeight: 56,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    recentIcon: {
      alignItems: 'center',
      backgroundColor: colors.surfaceAlt,
      borderRadius: radii.round,
      height: 36,
      justifyContent: 'center',
      width: 36,
    },
    recentCopy: {
      flex: 1,
      minWidth: 0,
    },
    recentName: {
      ...typography.labelLarge,
      color: colors.foreground,
    },
    recentMeta: {
      ...typography.caption,
      color: colors.textSecondary,
      marginTop: spacing.xxxs,
    },
    errorText: {
      ...typography.bodySmall,
      color: colors.destructive,
      marginTop: spacing.md,
    },
  });

  const openDraft = useCallback((draft: DraftData) => {
    const target = getReportWizardResumeTarget(draft);
    if (target.route === 'DraftOverview') {
      navigation.navigate('Cases');
      return;
    }
    resetReportStackToRoute(navigation, target.route, target.params as any);
  }, [navigation]);

  const openNewReport = useCallback(() => {
    resetReportStackToRoute(navigation, 'WhatHappened', undefined);
  }, [navigation]);

  const handleContinue = useCallback(() => {
    if (latestDraft) {
      openDraft(latestDraft);
      return;
    }

    openNewReport();
  }, [latestDraft, openDraft, openNewReport]);

  const openEvidence = useCallback(() => {
    if (!latestDraft) {
      openNewReport();
      return;
    }

    resetReportStackToRoute(navigation, 'EvidenceDetail', { draftId: latestDraft.id });
  }, [latestDraft, navigation, openNewReport]);

  const openCases = useCallback(() => {
    navigation.navigate('Cases');
  }, [navigation]);

  const actionsBlock = (
    <View style={styles.actions}>
      <Button
        title={latestDraft ? 'Continue draft' : 'Start report'}
        onPress={handleContinue}
        fullWidth
        icon={<Ionicons name="arrow-forward" size={18} color={colors.primaryForeground} />}
        iconPosition="right"
      />
      {latestDraft ? (
        <View style={styles.actionRow}>
          <Button
            title="Add evidence"
            variant="outline"
            onPress={openEvidence}
            style={styles.actionButton}
          />
          <Button
            title="Cases"
            variant="secondary"
            onPress={openCases}
            style={styles.actionButton}
          />
        </View>
      ) : (
        <Button title="Review cases" variant="secondary" onPress={openCases} fullWidth />
      )}
    </View>
  );

  return (
    <DashboardTemplate edges={['left', 'right']} scrollContentStyle={styles.scrollContent}>
      <View style={styles.header}>
        <Text style={styles.eyebrow}>{latestDraft ? 'Latest report' : 'New report'}</Text>
        <Text accessibilityRole="header" style={styles.title}>
          {latestDraft ? 'Continue where you stopped' : 'Start a report'}
        </Text>
        <Text style={styles.subtitle}>
          {latestDraft
            ? `${draftCountLabel} - ${getEvidenceSummary(latestDraft)}`
            : 'No editable draft is waiting on this device. Each step saves here as you go.'}
        </Text>
      </View>

      {isLoading ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={styles.loadingText}>Loading draft progress</Text>
        </View>
      ) : null}

      {loadError ? <Text style={styles.errorText}>{loadError}</Text> : null}

      {latestDraft ? null : actionsBlock}

      <View style={styles.outlineCard}>
        <View style={styles.outlineHeader}>
          <Text style={styles.outlineTitle}>
            {progress ? `${progressLabel} steps done` : 'Four short steps'}
          </Text>
          <Text style={styles.outlineMeta}>{latestSavedLabel}</Text>
        </View>
        {outline.steps.map((step, index) => {
          const isLast = index === outline.steps.length - 1;
          const isDone = step.status === 'complete' || step.status === 'skipped';
          const isCurrent = Boolean(progress) && step.id === resumeStep?.id;
          const dotColor = isDone ? colors.success : isCurrent ? colors.primary : colors.input;
          const statusLabel = progress ? getStepStatusLabel(isCurrent && !isDone ? 'current' : step.status) : null;
          return (
            <View
              key={step.id}
              style={styles.stepRow}
              accessible
              accessibilityLabel={`Step ${index + 1}. ${step.label}.${statusLabel ? ` ${statusLabel}.` : ''} ${step.description}`}
            >
              <View style={styles.stepRail}>
                <View
                  style={[
                    styles.stepDot,
                    {
                      borderColor: dotColor,
                      backgroundColor: isDone ? colors.success : isCurrent ? colors.primaryMuted : colors.surface,
                    },
                  ]}
                >
                  {isDone ? (
                    <Ionicons
                      name={step.status === 'skipped' ? 'play-skip-forward' : 'checkmark'}
                      size={14}
                      color={colors.successForeground}
                    />
                  ) : (
                    <Text style={[styles.stepNumber, { color: isCurrent ? colors.primary : colors.textSecondary }]}>
                      {index + 1}
                    </Text>
                  )}
                </View>
                {isLast ? null : (
                  <View style={[styles.stepLine, { backgroundColor: isDone ? colors.success : colors.divider }]} />
                )}
              </View>
              <View style={[styles.stepCopy, isLast && { paddingBottom: 0 }]}>
                <View style={styles.stepTitleRow}>
                  <Text style={styles.stepTitle}>{step.label}</Text>
                  {statusLabel && (isCurrent || isDone) ? (
                    <Text
                      style={[
                        styles.stepStatus,
                        isCurrent && !isDone
                          ? { backgroundColor: colors.primaryMuted, color: colors.primary }
                          : { backgroundColor: colors.successMuted, color: colors.success },
                      ]}
                    >
                      {statusLabel}
                    </Text>
                  ) : null}
                </View>
                {isCurrent || !progress ? (
                  <Text style={styles.stepDescription}>{step.description}</Text>
                ) : null}
              </View>
            </View>
          );
        })}
      </View>

      {latestDraft ? actionsBlock : null}

      {otherDrafts.length > 0 ? (
        <View style={styles.recentPanel}>
          <View style={styles.recentHeader}>
            <Text style={styles.recentTitle}>Other drafts</Text>
            <Text style={styles.recentCount}>
              {drafts.length - 1} more
            </Text>
          </View>
          {otherDrafts.map((draft) => {
            const draftProgress = getReportWizardProgress(draft);
            const draftStep = getResumeStep(draftProgress);

            return (
              <TouchableOpacity
                key={draft.id}
                accessibilityRole="button"
                accessibilityLabel={`Continue draft from ${draftStep?.label ?? 'next step'}`}
                activeOpacity={0.86}
                onPress={() => openDraft(draft)}
                style={styles.recentRow}
              >
                <View style={styles.recentIcon}>
                  <Ionicons name="document-text-outline" size={18} color={colors.textSecondary} />
                </View>
                <View style={styles.recentCopy}>
                  <Text style={styles.recentName}>
                    {draftStep?.label ?? 'Draft'}
                  </Text>
                  <Text style={styles.recentMeta}>
                    {draftProgress.completedSteps}/{draftProgress.totalSteps} steps - {formatSavedAt(draft.updatedAt)}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
              </TouchableOpacity>
            );
          })}
        </View>
      ) : null}
    </DashboardTemplate>
  );
}
