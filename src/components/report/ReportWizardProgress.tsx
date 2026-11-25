import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';

import Button from '../ui/Button';
import {
  getReportWizardProgress,
  type ReportStepName,
  type ReportWizardStepStatus,
} from '../../navigation/reportPathwayFlow';
import { useTheme } from '../../theme/SimpleThemeProvider';
import { radii, spacing, touchTargets, typography } from '../../theme/tokens';
import type { DraftData } from '../../utils/draftStorage';
import { getReportWizardSaveStatus, type ReportWizardSaveVariant } from './reportWizardSaveStatus';

type ReportWizardProgressProps = {
  draft: DraftData | null | undefined;
  currentStep: ReportStepName;
  isSaving?: boolean;
  lastSaved?: Date | null;
  error?: string | null;
  showSaveStatus?: boolean;
  onSkipOptionalSteps?: () => void;
  skipOptionalLabel?: string;
  skipOptionalDisabled?: boolean;
};

const SEGMENT_HEIGHT = 6;
// Each segment is a 48dp-tall target around a slim visible bar.
const SEGMENT_TARGET = touchTargets.minimum;

function getStatusLabel(status: ReportWizardStepStatus): string {
  switch (status) {
    case 'complete':
      return 'Done';
    case 'current':
      return 'Now';
    case 'skipped':
      return 'Skipped';
    case 'upcoming':
    default:
      return 'Next';
  }
}

function getSaveIcon(variant: ReportWizardSaveVariant): keyof typeof Ionicons.glyphMap {
  switch (variant) {
    case 'destructive':
      return 'alert-circle';
    case 'warning':
      return 'sync-outline';
    case 'secondary':
      return 'time-outline';
    case 'success':
    default:
      return 'checkmark-circle';
  }
}

/**
 * Slim step progress for the report wizard: a segmented bar (each segment
 * reopens a reachable step), "Step n of 4" with the step name, and one quiet
 * save-status line. The step question itself is the screen heading below.
 */
export function ReportWizardProgress({
  draft,
  currentStep,
  isSaving = false,
  lastSaved,
  error,
  showSaveStatus = true,
  onSkipOptionalSteps,
  skipOptionalLabel = 'Skip optional',
  skipOptionalDisabled = false,
}: ReportWizardProgressProps) {
  const { colors } = useTheme();
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const isEditingCompleted = route.params?.editCompleted === true;
  const progress = getReportWizardProgress(draft, currentStep);
  const saveStatus = getReportWizardSaveStatus({
    draft,
    isSaving,
    lastSaved,
    error,
  });

  const currentIndex = progress.steps.findIndex(step => step.status === 'current');
  const activeStep = currentIndex >= 0 ? progress.steps[currentIndex] : undefined;
  const saveColor = {
    success: colors.success,
    warning: colors.warning,
    destructive: colors.destructive,
    secondary: colors.textSecondary,
  }[saveStatus.variant];

  const openStep = (route?: string) => {
    if (!draft?.id || !route) return;
    navigation.navigate(route, {
      draftId: draft.id,
      ...(isEditingCompleted ? { editCompleted: true } : {}),
    });
  };

  return (
    <View style={styles.root}>
      <View style={styles.headerRow}>
        <Text accessibilityRole="header" style={[styles.stepText, { color: colors.textSecondary }]}>
          {activeStep ? (
            <>
              <Text style={[styles.stepCount, { color: colors.primary }]}>
                {`Step ${currentIndex + 1} of ${progress.totalSteps}`}
              </Text>
              {` · ${activeStep.label}`}
            </>
          ) : `${progress.completedSteps} of ${progress.totalSteps} steps done`}
        </Text>
        {onSkipOptionalSteps ? (
          <Button
            title={skipOptionalLabel}
            variant="ghost"
            size="xs"
            disabled={skipOptionalDisabled}
            icon={<Ionicons name="play-skip-forward-outline" size={15} color={colors.primary} />}
            onPress={onSkipOptionalSteps}
            accessibilityLabel={skipOptionalLabel}
          />
        ) : null}
      </View>

      <View
        style={styles.segments}
        accessibilityLabel={`${progress.completedSteps} of ${progress.totalSteps} steps done`}
      >
        {progress.steps.map((step, index) => {
          const canOpenStep = Boolean(
            draft?.id &&
            step.route &&
            (step.status === 'complete' || step.status === 'current' || step.status === 'skipped'),
          );
          const isCurrent = step.status === 'current';
          const isDone = step.status === 'complete' || step.status === 'skipped';
          const fill = isDone || isCurrent ? colors.primary : colors.divider;

          return (
            <Pressable
              key={step.id}
              accessibilityRole={canOpenStep ? 'button' : 'text'}
              accessibilityLabel={`Step ${index + 1}. ${step.label}. ${getStatusLabel(step.status)}`}
              accessibilityState={{ selected: isCurrent, disabled: !canOpenStep }}
              disabled={!canOpenStep}
              onPress={() => openStep(step.route)}
              style={styles.segmentTarget}
            >
              <View
                style={[
                  styles.segmentBar,
                  { backgroundColor: fill },
                  step.status === 'skipped' ? { opacity: 0.45 } : null,
                ]}
              />
            </Pressable>
          );
        })}
      </View>

      {showSaveStatus ? (
        <View style={styles.saveRow} accessible accessibilityLabel={`${saveStatus.label}. ${saveStatus.detail}`}>
          <Ionicons name={getSaveIcon(saveStatus.variant)} size={14} color={saveColor} />
          <Text style={[styles.saveText, { color: colors.textSecondary }]}>
            <Text style={[styles.saveLabel, { color: saveStatus.variant === 'destructive' ? colors.destructive : colors.foreground }]}>
              {saveStatus.label}
            </Text>
            {` · ${saveStatus.detail}`}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    marginBottom: spacing.xs,
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    justifyContent: 'space-between',
  },
  stepText: {
    ...typography.labelMedium,
    flexShrink: 1,
  },
  stepCount: {
    ...typography.labelMedium,
    fontWeight: '700',
  },
  segments: {
    flexDirection: 'row',
    gap: spacing.xxs,
    // Reserve the whole target: negative margins let the save line and
    // optional skip action cover parts of the step buttons.
    marginVertical: spacing.xxs,
  },
  segmentTarget: {
    flex: 1,
    height: SEGMENT_TARGET,
    justifyContent: 'center',
  },
  segmentBar: {
    borderRadius: radii.round,
    height: SEGMENT_HEIGHT,
  },
  saveRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxs,
  },
  saveText: {
    ...typography.caption,
    flex: 1,
  },
  saveLabel: {
    ...typography.caption,
    fontWeight: '600',
  },
});
