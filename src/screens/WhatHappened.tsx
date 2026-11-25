import React, { useEffect, useMemo, useRef, useState } from 'react';
import { getReportNavigationStyles } from '../components/report/reportNavigationStyles';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { RouteProp, useNavigation, useRoute } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { ReportWizardProgress } from '../components/report/ReportWizardProgress';
import { Badge } from '../components/ui/Badge';
import Button from '../components/ui/Button';
import { Card, CardContent } from '../components/ui/Card';
import { Checkbox } from '../components/ui/Checkbox';
import { Chip } from '../components/ui/Chip';
import { ChoiceCard } from '../components/ui/ChoiceCard';
import Screen from '../components/ui/Screen';
import { Textarea } from '../components/ui/Textarea';
import { useToast } from '../components/ui/Toast';
import { useCompletedReportRedirect } from '../hooks/useCompletedReportRedirect';
import { useDraftState } from '../hooks/useDraftState';
import { useReportDraftIdentity } from '../hooks/useReportDraftIdentity';
import { KENYA_IMMEDIATE_HELP_TEXT } from '../lib/supportResources';
import { pushReportRoute } from '../navigation/reportNavigation';
import { RootStackParamList } from '../navigation/routes';
import { borders, radii, spacing, typography } from '../theme/tokens';
import { useTheme } from '../theme/SimpleThemeProvider';
import { draftStorage, type DraftData } from '../utils/draftStorage';
import { captureMeasurementEvent } from '../lib/measurement/localEventStore';

type WhatHappenedNavigationProp = NativeStackNavigationProp<RootStackParamList, 'WhatHappened'>;
type WhatHappenedRouteProp = RouteProp<RootStackParamList, 'WhatHappened'>;

interface IncidentPattern {
  id: string;
  title: string;
  description: string;
  icon: keyof typeof Ionicons.glyphMap;
  followUpQuestions: string[];
}

interface IncidentDetails {
  patterns: string[];
  description: string;
  impact: string;
  contextTags: string[];
  witnesses: boolean;
  witnessDetails: string;
  severity: 'low' | 'medium' | 'high';
  immediateHelp: boolean;
}

const CONTEXT_TAG_KEY = 'coreContext';

const incidentPatterns: IncidentPattern[] = [
  {
    id: 'verbal_harassment',
    title: 'Verbal harassment',
    description: 'Comments, threats, slurs, or intimidation.',
    icon: 'chatbubble-ellipses-outline',
    followUpQuestions: ['What words or gestures do you remember?', 'Was anyone else close enough to hear?'],
  },
  {
    id: 'sexual_harassment',
    title: 'Unwanted sexual conduct',
    description: 'Sexual comments, touching, staring, or exposure.',
    icon: 'hand-left-outline',
    followUpQuestions: ['Was there contact or a threat of contact?', 'Did the person block your path?'],
  },
  {
    id: 'physical_threat',
    title: 'Physical threat or contact',
    description: 'Blocking, grabbing, pushing, assault, or threats.',
    icon: 'alert-circle-outline',
    followUpQuestions: ['What did the person do with their body or hands?', 'Were you able to leave safely?'],
  },
  {
    id: 'stalking',
    title: 'Followed or watched',
    description: 'Following, tracking, repeated contact, or monitoring.',
    icon: 'eye-outline',
    followUpQuestions: ['How often has this happened?', 'Did they follow you after the ride or stop?'],
  },
  {
    id: 'discrimination',
    title: 'Discrimination',
    description: 'Mistreatment linked to identity, disability, or status.',
    icon: 'people-outline',
    followUpQuestions: ['What made the treatment feel targeted?', 'Was service refused or delayed?'],
  },
  {
    id: 'unsafe_transport',
    title: 'Unsafe ride or route',
    description: 'Speeding, route refusal, unsafe stop, or crowding.',
    icon: 'bus-outline',
    followUpQuestions: ['What vehicle, route, or stage details do you remember?', 'Was the driver or conductor involved?'],
  },
  {
    id: 'property_damage',
    title: 'Property loss or damage',
    description: 'Theft, damage, forced payment, or withheld property.',
    icon: 'bag-handle-outline',
    followUpQuestions: ['What was taken or damaged?', 'Was payment demanded or refused?'],
  },
  {
    id: 'other',
    title: 'Something else',
    description: 'Use this if none of the other choices fit.',
    icon: 'ellipsis-horizontal-circle-outline',
    followUpQuestions: ['What name would you give what happened?', 'What detail feels most important to keep?'],
  },
];

const impactOptions = [
  {
    value: 'low',
    label: 'Low impact',
    description: 'Uncomfortable or concerning, but you feel able to continue.',
  },
  {
    value: 'medium',
    label: 'Moderate impact',
    description: 'Distressing, disruptive, or you want support deciding next steps.',
  },
  {
    value: 'high',
    label: 'High impact',
    description: 'You feel unsafe, threatened, hurt, or need urgent support.',
  },
] as const;

const contextOptions = [
  { id: 'vehicle_or_route', label: 'Vehicle or route details' },
  { id: 'driver_or_staff', label: 'Driver or staff involved' },
  { id: 'passengers_nearby', label: 'Passengers nearby' },
  { id: 'photo_or_recording', label: 'Photo, video, or audio exists' },
  { id: 'repeated_pattern', label: 'Repeated pattern' },
  { id: 'money_or_property', label: 'Money or property involved' },
] as const;

function parseContextTags(value?: string): string[] {
  if (!value) return [];
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

export default function WhatHappenedScreen() {
  const navigation = useNavigation<WhatHappenedNavigationProp>();
  const route = useRoute<WhatHappenedRouteProp>();
  const { colors } = useTheme();
  const { width, fontScale } = useWindowDimensions();
  // Two-up tiles while words fit; narrow screens and large text get full-width rows.
  const patternColumns = width >= 350 && fontScale < 1.3 ? 2 : 1;
  const toast = useToast();
  const followUpBaseRef = useRef<Record<string, string>>({});
  const draftCreationPromiseRef = useRef<Promise<string> | null>(null);
  const generatedDraftIdRef = useRef<string | null>(null);
  const [formData, setFormData] = useState<IncidentDetails>({
    patterns: [],
    description: '',
    impact: '',
    contextTags: [],
    witnesses: false,
    witnessDetails: '',
    severity: 'medium',
    immediateHelp: false,
  });
  const formDataRef = useRef(formData);
  const draftSaveWarningShownRef = useRef(false);
  const [showOptionalDetails, setShowOptionalDetails] = useState(false);
  const [isCreatingDraft, setIsCreatingDraft] = useState(false);
  const [isContinuing, setIsContinuing] = useState(false);

  const routeDraftId = typeof route.params?.draftId === 'string' && route.params.draftId.trim()
    ? route.params.draftId
    : undefined;
  const {
    draftId: initialDraftId,
    isResolving: isResolvingDraftId,
    error: draftIdError,
  } = useReportDraftIdentity(routeDraftId, {
    createIfMissing: false,
    initialStep: 'WhatHappened',
    useActiveDraftFallback: false,
  });
  const isEditingCompleted = route.params?.editCompleted === true;
  const isWaitingForRoutedDraft = Boolean(
    routeDraftId &&
    routeDraftId !== generatedDraftIdRef.current &&
    isResolvingDraftId
  );
  const { draftData, updateDraft, saveDraftPatch, isSaving, lastSaved, error } = useDraftState(initialDraftId, {
    createIfMissing: false,
    initialStep: 'WhatHappened',
  });
  const pendingDraftPreview = useMemo<DraftData | null>(() => {
    if (initialDraftId || draftIdError) return null;
    const now = new Date();
    return {
      id: 'pending-step-one-draft',
      createdAt: now,
      updatedAt: now,
      currentStep: 'WhatHappened',
      completedSteps: [],
      autoSaveEnabled: true,
    };
  }, [draftIdError, initialDraftId]);
  useCompletedReportRedirect(navigation, draftData, { enabled: !isEditingCompleted });

  useEffect(() => {
    if (initialDraftId && !routeDraftId) {
      navigation.setParams({ draftId: initialDraftId });
    }
  }, [initialDraftId, navigation, routeDraftId]);

  useEffect(() => {
    if (!initialDraftId) return;
    if (!draftData) return;
    followUpBaseRef.current = draftData.followUpAnswers ?? {};
    setFormData(prev => {
      const next = {
        ...prev,
        patterns: draftData.patterns || [],
        description: draftData.incidentDescription || '',
        impact: draftData.impactSummary || '',
        contextTags: parseContextTags(draftData.followUpAnswers?.[CONTEXT_TAG_KEY]),
        witnesses: draftData.witnesses || false,
        witnessDetails: draftData.witnessDetails || '',
        severity: draftData.impactLevel || 'medium',
        immediateHelp: draftData.immediateHelp || false,
      };
      formDataRef.current = next;
      return next;
    });
  }, [draftData?.id]);

  const selectedPatterns = useMemo(
    () => incidentPatterns.filter(pattern => formData.patterns.includes(pattern.id)),
    [formData.patterns],
  );

  const suggestedQuestions = useMemo(
    () => selectedPatterns.flatMap(pattern => pattern.followUpQuestions).slice(0, 4),
    [selectedPatterns],
  );

  const styles = StyleSheet.create({
    ...getReportNavigationStyles(colors),
    screenRoot: {
      flex: 1,
    },
    scroll: {
      flex: 1,
    },
    contentContainer: {
      paddingHorizontal: spacing.md,
      paddingTop: spacing.xxs,
      paddingBottom: spacing.md,
    },
    stepHeader: {
      gap: spacing.xxs,
      marginBottom: spacing.md,
    },
    eyebrowRow: {
      alignItems: 'center',
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
    },
    eyebrow: {
      ...typography.overline,
      color: colors.primary,
      letterSpacing: 0.6,
      textTransform: 'uppercase',
    },
    sectionTitle: {
      ...typography.headlineMedium,
      color: colors.foreground,
      letterSpacing: -0.3,
    },
    helperText: {
      ...typography.bodyMedium,
      color: colors.textSecondary,
    },
    patternGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
    },
    patternTile: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: radii.card,
      borderWidth: borders.hairline,
      gap: spacing.xs,
      padding: spacing.sm,
    },
    patternTileGrid: {
      // Two columns with one 8dp gutter.
      flexBasis: '48%',
      flexGrow: 1,
      minHeight: 132,
    },
    patternTileRow: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.sm,
      minHeight: 64,
      width: '100%',
    },
    patternTileSelected: {
      backgroundColor: colors.primaryMuted,
      borderColor: colors.primary,
      borderWidth: borders.emphasized,
      // Keep the content from shifting when the border thickens.
      padding: spacing.sm - 1,
    },
    patternTilePressed: {
      backgroundColor: colors.surfaceAlt,
    },
    patternTileTop: {
      alignItems: 'flex-start',
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    patternIcon: {
      alignItems: 'center',
      justifyContent: 'center',
      width: 44,
      height: 44,
      borderRadius: radii.round,
      backgroundColor: colors.surfaceAlt,
    },
    patternCopy: {
      flex: 1,
      gap: spacing.xxxs,
      minWidth: 0,
    },
    patternTitle: {
      ...typography.labelLarge,
      color: colors.textPrimary,
    },
    patternDescription: {
      ...typography.caption,
      color: colors.textSecondary,
      marginTop: 2,
    },
    patternSelectionIndicator: {
      alignItems: 'center',
      borderColor: colors.input,
      borderRadius: radii.round,
      borderWidth: borders.emphasized,
      height: 24,
      justifyContent: 'center',
      width: 24,
    },
    selectedSummary: {
      ...typography.labelMedium,
      color: colors.textSecondary,
      marginTop: spacing.sm,
    },
    chipWrap: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
    },
    formSection: {
      gap: spacing.sm,
      marginBottom: spacing.md,
    },
    formSectionCard: {
      marginBottom: spacing.md,
    },
    formSectionContent: {
      gap: spacing.sm,
    },
    promptList: {
      backgroundColor: colors.surfaceAlt,
      borderColor: colors.divider,
      borderRadius: radii.card,
      borderWidth: borders.hairline,
      gap: spacing.xs,
      overflow: 'hidden',
      padding: spacing.sm,
      position: 'relative',
    },
    promptRow: {
      flexDirection: 'row',
      gap: spacing.xs,
    },
    promptText: {
      ...typography.caption,
      color: colors.textSecondary,
      flex: 1,
    },
    impactCard: {
      marginBottom: spacing.sm,
    },
    impactContent: {
      gap: spacing.xs,
    },
    impactTitleRow: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.xs,
      justifyContent: 'space-between',
    },
    impactTitle: {
      ...typography.label,
      color: colors.textPrimary,
      flex: 1,
    },
    resourceNotice: {
      marginTop: spacing.md,
      padding: spacing.md,
      borderRadius: radii.card,
      backgroundColor: colors.dangerMuted,
      borderWidth: borders.hairline,
      borderColor: colors.destructive,
      overflow: 'hidden',
      position: 'relative',
    },
    resourceNoticeTitle: {
      ...typography.label,
      color: colors.destructive,
      marginBottom: spacing.xs,
    },
    resourceNoticeText: {
      ...typography.bodyS,
      color: colors.foreground,
    },
    optionalDetailsButton: {
      marginTop: spacing.sm,
    },
    backButton: {
      alignSelf: 'stretch',
      flex: 1,
    },
    nextButton: {
      alignSelf: 'stretch',
      flex: 2,
    },
  });

  const updateFormData = (updater: (previous: IncidentDetails) => IncidentDetails) => {
    setFormData(prev => {
      const next = updater(prev);
      formDataRef.current = next;
      return next;
    });
  };

  const handlePatternToggle = (patternId: string) => {
    updateFormData(prev => ({
      ...prev,
      patterns: prev.patterns.includes(patternId)
        ? prev.patterns.filter(id => id !== patternId)
        : [...prev.patterns, patternId],
    }));
  };

  const handlePatternPress = (patternId: string) => {
    handlePatternToggle(patternId);
  };

  const handleContextToggle = (contextId: string) => {
    updateFormData(prev => ({
      ...prev,
      contextTags: prev.contextTags.includes(contextId)
        ? prev.contextTags.filter(id => id !== contextId)
        : [...prev.contextTags, contextId],
    }));
  };

  const canProceed = () => {
    return formDataRef.current.patterns.length > 0;
  };

  const getCompletedSteps = () => {
    const completedSteps = draftData?.completedSteps ?? [];
    return completedSteps.includes('WhatHappened')
      ? completedSteps
      : [...completedSteps, 'WhatHappened'];
  };

  const buildWhatHappenedFields = (): Partial<DraftData> => {
    const currentFormData = formDataRef.current;
    return {
      patterns: currentFormData.patterns,
      incidentDescription: currentFormData.description,
      impactSummary: currentFormData.impact,
      witnesses: currentFormData.witnesses,
      witnessDetails: currentFormData.witnessDetails,
      impactLevel: currentFormData.severity,
      immediateHelp: currentFormData.immediateHelp,
      followUpAnswers: {
        ...followUpBaseRef.current,
        [CONTEXT_TAG_KEY]: currentFormData.contextTags.join(','),
      },
    };
  };

  const buildWhatHappenedPatch = (): Partial<DraftData> => {
    return {
      ...buildWhatHappenedFields(),
      completedSteps: getCompletedSteps(),
      currentStep: 'WhereWhen',
    };
  };

  const persistNewStepOneDraft = async (completed: boolean): Promise<string> => {
    if (initialDraftId) return initialDraftId;
    if (draftCreationPromiseRef.current) return draftCreationPromiseRef.current;
    if (generatedDraftIdRef.current) return generatedDraftIdRef.current;

    const nextDraftId = draftStorage.generateDraftId();
    generatedDraftIdRef.current = nextDraftId;
    const now = new Date();
    const createPromise = (async () => {
      setIsCreatingDraft(true);
      await draftStorage.saveDraft({
        id: nextDraftId,
        createdAt: now,
        updatedAt: now,
        autoSaveEnabled: true,
        ...buildWhatHappenedFields(),
        completedSteps: completed ? ['WhatHappened'] : [],
        currentStep: completed ? 'WhereWhen' : 'WhatHappened',
      });
      draftSaveWarningShownRef.current = false;
      navigation.setParams({ draftId: nextDraftId });
      return nextDraftId;
    })();

    draftCreationPromiseRef.current = createPromise;

    try {
      return await createPromise;
    } catch (error) {
      generatedDraftIdRef.current = null;
      throw error;
    } finally {
      draftCreationPromiseRef.current = null;
      setIsCreatingDraft(false);
    }
  };

  useEffect(() => {
    if (isResolvingDraftId) return;
    if (
      routeDraftId &&
      !initialDraftId &&
      routeDraftId !== generatedDraftIdRef.current
    ) return;

    if (initialDraftId) {
      updateDraft(buildWhatHappenedFields(), true);
      return;
    }

    if (formDataRef.current.patterns.length === 0) return;

    void persistNewStepOneDraft(false)
      .then(() => {
        draftSaveWarningShownRef.current = false;
      })
      .catch(() => {
        if (draftSaveWarningShownRef.current) return;
        draftSaveWarningShownRef.current = true;
        toast.show({
          title: 'Draft save unavailable',
          message: 'SafeRide could not save this report on the device yet.',
          variant: 'error',
        });
      });
  }, [formData, initialDraftId, isResolvingDraftId, updateDraft]);

  const finishWhatHappened = async () => {
    if (
      routeDraftId &&
      !initialDraftId &&
      routeDraftId !== generatedDraftIdRef.current
    ) {
      toast.show({
        title: 'Local draft unavailable',
        message: draftIdError ?? 'Return to Reports and start again.',
        variant: 'warning',
      });
      return;
    }

    try {
      const targetDraftId = initialDraftId ?? await persistNewStepOneDraft(true);
      const saved = initialDraftId && draftData
        ? await saveDraftPatch(buildWhatHappenedPatch())
        : await (async () => {
            await draftStorage.saveDraft({
              id: targetDraftId,
              ...buildWhatHappenedPatch(),
              autoSaveEnabled: true,
            });
            return draftStorage.getDraft(targetDraftId);
          })();

      if (!saved) {
        toast.show({
          title: 'Draft save unavailable',
          message: 'SafeRide could not save this step on the device yet.',
          variant: 'warning',
        });
        return;
      }
      captureMeasurementEvent({
        name: 'step_complete',
        screenId: 'what-happened',
        taskId: 'report-flow',
        outcome: 'completed',
      });
      pushReportRoute(navigation, 'WhereWhen', {
        draftId: saved.id,
        ...(isEditingCompleted ? { editCompleted: true } : {}),
      });
    } catch {
      captureMeasurementEvent({
        name: 'error_outcome',
        screenId: 'what-happened',
        taskId: 'report-flow',
        outcome: 'failed',
        errorCode: 'storage_unavailable',
      });
      toast.show({
        title: 'Save failed',
        message: 'SafeRide could not save this step yet. Try again before continuing.',
        variant: 'error',
      });
    }
  };

  const handleNext = async () => {
    if (!canProceed()) {
      toast.show({
        title: 'Choose at least one pattern',
        message: 'A broad pattern is enough. You can add details later.',
        variant: 'error',
      });
      return;
    }

    if (isContinuing) return;
    setIsContinuing(true);
    try {
      await finishWhatHappened();
    } finally {
      setIsContinuing(false);
    }
  };

  const handleBack = () => {
    if (showOptionalDetails) {
      setShowOptionalDetails(false);
    } else {
      navigation.goBack();
    }
  };

  const renderStepHeader = (title: string, helper: string, optional = false) => (
    <View style={styles.stepHeader}>
      {optional ? (
        <View style={styles.eyebrowRow}>
          <Text style={styles.eyebrow}>Optional details</Text>
        </View>
      ) : null}
      <Text accessibilityRole="header" style={styles.sectionTitle}>{title}</Text>
      <Text style={styles.helperText}>{helper}</Text>
    </View>
  );

  const renderCardSection = (children: React.ReactNode) => (
    <Card variant="outlined" hideAccent style={styles.formSectionCard}>
      <CardContent style={styles.formSectionContent}>
        {children}
      </CardContent>
    </Card>
  );

  const renderPatternSelection = () => (
    <View>
      {renderStepHeader(
        'What happened?',
        'Select all that apply. A broad pattern is enough, and you can change it before continuing.',
      )}

      <View style={styles.patternGrid} accessibilityLabel="Incident pattern choices. Select all that apply.">
        {incidentPatterns.map(pattern => {
          const isSelected = formData.patterns.includes(pattern.id);
          const indicator = (
            <View
              style={[
                styles.patternSelectionIndicator,
                isSelected ? {
                  backgroundColor: colors.primary,
                  borderColor: colors.primary,
                } : null,
              ]}
            >
              {isSelected ? (
                <Ionicons name="checkmark" size={16} color={colors.primaryForeground} />
              ) : null}
            </View>
          );
          const icon = (
            <View style={[styles.patternIcon, isSelected ? { backgroundColor: colors.surface } : null]}>
              <Ionicons
                name={pattern.icon}
                size={22}
                color={isSelected ? colors.primary : colors.textSecondary}
              />
            </View>
          );
          const copy = (
            <View style={patternColumns === 1 ? styles.patternCopy : null}>
              <Text style={styles.patternTitle}>{pattern.title}</Text>
              <Text style={styles.patternDescription}>{pattern.description}</Text>
            </View>
          );
          return (
            <Pressable
              key={pattern.id}
              onPress={() => handlePatternPress(pattern.id)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: isSelected }}
              accessibilityLabel={`${pattern.title}. ${pattern.description}. Select all that apply.`}
              accessibilityHint={isSelected ? 'Double tap to clear this pattern' : 'Double tap to select this pattern'}
              style={({ pressed }) => [
                styles.patternTile,
                patternColumns === 2 ? styles.patternTileGrid : styles.patternTileRow,
                pressed && !isSelected ? styles.patternTilePressed : null,
                isSelected ? styles.patternTileSelected : null,
              ]}
            >
              {patternColumns === 2 ? (
                <>
                  <View style={styles.patternTileTop}>
                    {icon}
                    {indicator}
                  </View>
                  {copy}
                </>
              ) : (
                <>
                  {icon}
                  {copy}
                  {indicator}
                </>
              )}
            </Pressable>
          );
        })}
      </View>
      {selectedPatterns.length > 0 ? (
        <Text style={styles.selectedSummary} accessibilityLiveRegion="polite">
          {selectedPatterns.length === 1 ? '1 pattern selected' : `${selectedPatterns.length} patterns selected`}
        </Text>
      ) : null}
    </View>
  );

  const renderIncidentDescription = () => (
    <View>
      {renderStepHeader(
        'Add details at your pace',
        'Short notes and chips are enough. Your own words are optional here.',
        true,
      )}

      {renderCardSection(
        <Textarea
          label="Your words (optional)"
          placeholder="A few words are okay. For example: conductor blocked the door near the stage."
          value={formData.description}
          onChangeText={(text) => updateFormData(prev => ({ ...prev, description: text }))}
          rows={5}
          helperText={`${formData.description.length}/1000 characters. You can leave this blank and continue.`}
          maxLength={1000}
        />
      )}

      {renderCardSection(
        <>
        <Text style={styles.helperText}>Helpful details (optional)</Text>
        <View style={styles.chipWrap}>
          {contextOptions.map(option => (
            <Chip
              key={option.id}
              label={option.label}
              selected={formData.contextTags.includes(option.id)}
              onPress={() => handleContextToggle(option.id)}
              testID={`what-context-${option.id}`}
            />
          ))}
        </View>
        </>
      )}

      {renderCardSection(
        <>
        <Checkbox
          checked={formData.witnesses}
          onCheckedChange={(checked) => updateFormData(prev => ({ ...prev, witnesses: checked === true }))}
          label="Someone else may have seen or heard it"
          description="Optional. You do not need names to continue."
          accessibilityLabel="Someone else may have seen or heard it"
        />
        {formData.witnesses ? (
          <Textarea
            label="Witness note (optional)"
            placeholder="Example: two passengers near the back row saw it."
            value={formData.witnessDetails}
            onChangeText={(text) => updateFormData(prev => ({ ...prev, witnessDetails: text }))}
            rows={3}
            helperText="Use general details if names do not feel safe to record."
          />
        ) : null}
        </>
      )}

      {suggestedQuestions.length > 0 ? (
        <View style={styles.promptList}>
          <Badge variant="outline" size="sm">Prompts you can skip</Badge>
          {suggestedQuestions.map(question => (
            <View key={question} style={styles.promptRow}>
              <Ionicons name="ellipse" size={6} color={colors.textSecondary} style={{ marginTop: 7 }} />
              <Text style={styles.promptText}>{question}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );

  const renderImpactAndSeverity = () => (
    <View>
      {renderStepHeader(
        'Impact and support',
        'Pick the closest impact level. The note and support tips are optional.',
        true,
      )}

      <View
        style={styles.formSection}
        accessibilityRole="radiogroup"
        accessibilityLabel="Choose one impact level"
      >
        {impactOptions.map(option => {
          const selected = formData.severity === option.value;
          return (
            <ChoiceCard
              key={option.value}
              title={option.label}
              description={option.description}
              selected={selected}
              style={styles.impactCard}
              onPress={() => updateFormData(prev => ({ ...prev, severity: option.value }))}
              accessibilityLabel={`${option.label}. ${option.description}`}
              accessibilityHint={selected ? 'Selected impact level' : 'Double tap to select this impact level'}
            />
          );
        })}
      </View>

      {renderCardSection(
        <Textarea
          label="Impact note (optional)"
          placeholder="Example: I felt unsafe getting off the vehicle."
          value={formData.impact}
          onChangeText={(text) => updateFormData(prev => ({ ...prev, impact: text }))}
          rows={3}
          helperText="Use this only if it helps you remember later."
          maxLength={500}
        />
      )}

      {renderCardSection(
        <Checkbox
          checked={formData.immediateHelp}
          onCheckedChange={(checked) => updateFormData(prev => ({ ...prev, immediateHelp: checked === true }))}
          label="I may need immediate support"
          description="Shows Kenya support contacts saved in the app catalog."
          variant="destructive"
        />
      )}

      {formData.immediateHelp ? (
        <View style={styles.resourceNotice}>
          <Text style={styles.resourceNoticeTitle}>Kenya immediate-help options</Text>
          <Text style={styles.resourceNoticeText}>{KENYA_IMMEDIATE_HELP_TEXT}</Text>
        </View>
      ) : null}
    </View>
  );

  const renderOptionalDetails = () => (
    <View>
      {renderIncidentDescription()}
      {renderImpactAndSeverity()}
    </View>
  );

  return (
    // BottomTabs already reserves the bottom safe area for the report stack.
    <Screen edges={['top', 'left', 'right']}>
      <View style={styles.screenRoot}>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.contentContainer}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <ReportWizardProgress
            draft={draftData ?? pendingDraftPreview}
            currentStep="WhatHappened"
            isSaving={isSaving || isCreatingDraft || isContinuing}
            lastSaved={lastSaved}
            error={error ?? (initialDraftId ? draftIdError : null)}
            showSaveStatus={Boolean(draftData || initialDraftId)}
          />

          {showOptionalDetails ? renderOptionalDetails() : renderPatternSelection()}

          {!showOptionalDetails && canProceed() ? (
            <Button
              title="Add optional details"
              variant="outline"
              onPress={() => setShowOptionalDetails(true)}
              style={styles.optionalDetailsButton}
              fullWidth
            />
          ) : null}
        </ScrollView>

        <View style={styles.navigationDock}>
          <View style={styles.navigationButtons}>
            <Button
              title="Back"
              variant="outline"
              onPress={handleBack}
              style={styles.backButton}
            />
            <Button
              title="Continue to location"
              onPress={handleNext}
              disabled={!canProceed() || isContinuing || isWaitingForRoutedDraft}
              loading={isContinuing || isWaitingForRoutedDraft}
              style={styles.nextButton}
            />
          </View>
        </View>
      </View>
    </Screen>
  );
}
