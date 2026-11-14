import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getReportNavigationStyles } from '../components/report/reportNavigationStyles';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { RouteProp, useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { ReportWizardProgress } from '../components/report/ReportWizardProgress';
import { ReportStepHeader } from '../components/report/ReportStepHeader';
import { ChoiceCard } from '../components/ui/ChoiceCard';
import { Alert as AlertComponent, AlertDescription, AlertTitle } from '../components/ui/Alert';
import { Badge } from '../components/ui/Badge';
import Button from '../components/ui/Button';
import { Card, CardContent } from '../components/ui/Card';
import { Checkbox } from '../components/ui/Checkbox';
import { Chip } from '../components/ui/Chip';
import { DateField, TimeField } from '../components/ui/DateTimeField';
import { Input } from '../components/ui/Input';
import Screen from '../components/ui/Screen';
import { useToast } from '../components/ui/Toast';
import { useCompletedReportRedirect } from '../hooks/useCompletedReportRedirect';
import { useDraftState } from '../hooks/useDraftState';
import { useReportDraftIdentity } from '../hooks/useReportDraftIdentity';
import { pushReportRoute } from '../navigation/reportNavigation';
import { useReportWizardBack } from '../navigation/reportWizardBack';
import { RootStackParamList } from '../navigation/routes';
import { borders, radii, spacing, typography } from '../theme/tokens';
import { useTheme } from '../theme/SimpleThemeProvider';
import type { DraftData } from '../utils/draftStorage';
import { formatDraftLocalDate, formatDraftLocalTime } from '../utils/reportDateTime';
import { readCurrentReportLocation } from '../utils/reportLocationRequest';
import { captureMeasurementEvent } from '../lib/measurement/localEventStore';

type WhereWhenNavigationProp = NativeStackNavigationProp<RootStackParamList, 'WhereWhen'>;
type WhereWhenRouteProp = RouteProp<RootStackParamList, 'WhereWhen'>;

type LocationMode = 'general' | 'manual' | 'current';
type LocationPermissionState = 'idle' | 'checking' | 'granted' | 'denied' | 'error';

interface LocationData {
  locationMode: LocationMode;
  customLocation: string;
  locationName: string;
  address: string;
  coordinates?: {
    latitude: number;
    longitude: number;
  };
  locationContext: string;
}

interface TimeData {
  useCurrentTime: boolean;
  incidentDate: Date;
  incidentTime: Date;
  duration: string;
  timeAccuracy: 'exact' | 'approximate' | 'unsure';
}

const locationContextOptions = [
  { label: 'Matatu, bus, or boda', value: 'public_transport' },
  { label: 'Stage, stop, or terminal', value: 'stage_or_stop' },
  { label: 'Street or walkway', value: 'street' },
  { label: 'Shop, office, or school', value: 'business_or_institution' },
  { label: 'Home or private place', value: 'private_place' },
  { label: 'Online or phone', value: 'online' },
  { label: 'Other place', value: 'other' },
] as const;

const durationOptions = [
  { label: 'Seconds', value: 'seconds' },
  { label: 'A few minutes', value: '1-5min' },
  { label: '5-15 minutes', value: '5-15min' },
  { label: '15-60 minutes', value: '15-60min' },
  { label: 'Over 1 hour', value: 'over_hour' },
  { label: 'Repeated or ongoing', value: 'ongoing' },
  { label: 'Unsure', value: 'unsure' },
] as const;

const timingAccuracyOptions = [
  { label: 'Exact', value: 'exact', description: 'You know the date and time.' },
  { label: 'Approximate', value: 'approximate', description: 'Close enough for your notes.' },
  { label: 'Unsure', value: 'unsure', description: 'You only remember part of it.' },
] as const;

const LOCATION_PRECISION_NOTICE_TIMEOUT_MS = 9000;

function mapDraftAccuracy(value?: NonNullable<DraftData['datetime']>['accuracy']): TimeData['timeAccuracy'] {
  if (value === 'exact' || value === 'approximate') return value;
  return 'unsure';
}

function toDraftAccuracy(value: TimeData['timeAccuracy']): NonNullable<DraftData['datetime']>['accuracy'] {
  return value === 'unsure' ? 'estimated' : value;
}

function parseDraftDateTime(datetime?: DraftData['datetime']) {
  if (!datetime?.date || !datetime.time) return null;
  const parsed = new Date(`${datetime.date}T${datetime.time}:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export default function WhereWhenScreen() {
  const navigation = useNavigation<WhereWhenNavigationProp>();
  const route = useRoute<WhereWhenRouteProp>();
  const { colors } = useTheme();
  const toast = useToast();

  const [locationData, setLocationData] = useState<LocationData>({
    locationMode: 'general',
    customLocation: '',
    locationName: '',
    address: '',
    locationContext: '',
  });
  const locationDataRef = useRef(locationData);

  const [timeData, setTimeData] = useState<TimeData>({
    useCurrentTime: false,
    incidentDate: new Date(),
    incidentTime: new Date(),
    duration: '',
    timeAccuracy: 'approximate',
  });
  const timeDataRef = useRef(timeData);

  const [isLocating, setIsLocating] = useState(false);
  const locationRequestId = useRef(0);
  const [permissionState, setPermissionState] = useState<LocationPermissionState>('idle');
  const [hasAskedForLocation, setHasAskedForLocation] = useState(false);
  const [timeConfirmed, setTimeConfirmed] = useState(false);
  const [showOptionalTimeDetails, setShowOptionalTimeDetails] = useState(false);
  const [showLocationPrecisionNotice, setShowLocationPrecisionNotice] = useState(true);

  const routeDraftId = typeof route.params?.draftId === 'string' && route.params.draftId.trim()
    ? route.params.draftId
    : undefined;
  const {
    draftId: initialDraftId,
    isResolving: isResolvingDraftId,
    error: draftIdError,
  } = useReportDraftIdentity(routeDraftId, { initialStep: 'WhereWhen' });
  const isEditingCompleted = route.params?.editCompleted === true;
  const { draftData, updateDraft, saveDraftPatch, isSaving, lastSaved, error } = useDraftState(initialDraftId);
  useCompletedReportRedirect(navigation, draftData, { enabled: !isEditingCompleted });

  const cancelLocationRequest = useCallback(() => {
    locationRequestId.current += 1;
    setIsLocating(false);
    setPermissionState(state => state === 'checking' ? 'idle' : state);
  }, []);

  useFocusEffect(useCallback(() => {
    cancelLocationRequest();
    return () => { locationRequestId.current += 1; };
  }, [cancelLocationRequest, initialDraftId]));

  useEffect(() => {
    if (initialDraftId && !routeDraftId) {
      navigation.setParams({ draftId: initialDraftId });
    }
  }, [initialDraftId, navigation, routeDraftId]);
  const goBackToWhatHappened = useReportWizardBack(navigation, initialDraftId ? {
    route: 'WhatHappened',
    params: { draftId: initialDraftId, ...(isEditingCompleted ? { editCompleted: true } : {}) },
  } : undefined);

  useEffect(() => {
    if (!initialDraftId) return;
    if (!draftData) return;
    const location = draftData.location;
    setLocationData(prev => {
      const next = {
        ...prev,
        address: location?.address || '',
        customLocation: location?.address || '',
        coordinates: location?.coordinates,
        locationName: location?.description === 'General area only' ? '' : location?.description || '',
        locationContext: location?.type === 'general_area' ? '' : location?.type || '',
        locationMode: (
          location?.coordinates ? 'current' : location?.address ? 'manual' : 'general'
        ) as LocationMode,
      };
      locationDataRef.current = next;
      return next;
    });

    const parsedDateTime = parseDraftDateTime(draftData.datetime);
    setTimeConfirmed(Boolean(parsedDateTime));
    if (parsedDateTime) {
      setTimeData(prev => {
        const next = {
          ...prev,
          incidentDate: parsedDateTime,
          incidentTime: parsedDateTime,
          duration: draftData.duration || (draftData.isOngoing ? 'ongoing' : ''),
          timeAccuracy: mapDraftAccuracy(draftData.datetime?.accuracy),
        };
        timeDataRef.current = next;
        return next;
      });
    }
  }, [draftData?.id]);

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
      gap: spacing.xs,
    },
    stepHeaderCard: {
      marginBottom: spacing.sm,
    },
    stepHeaderContent: {
      gap: spacing.xxs,
      paddingTop: spacing.sm,
    },
    eyebrowRow: {
      alignItems: 'center',
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
    },
    sectionTitle: {
      ...typography.headlineSmall,
      color: colors.foreground,
    },
    helperText: {
      ...typography.bodyMedium,
      color: colors.textSecondary,
    },
    section: {
      gap: spacing.sm,
      marginBottom: spacing.md,
    },
    modeGrid: {
      gap: spacing.sm,
    },
    modeContent: {
      gap: spacing.xs,
    },
    modeTitleRow: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.xs,
      justifyContent: 'space-between',
    },
    modeTitle: {
      ...typography.label,
      color: colors.textPrimary,
      flex: 1,
      minWidth: 0,
    },
    iconTitle: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.xs,
      flex: 1,
      minWidth: 0,
    },
    chipWrap: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
    },
    fieldGroup: {
      gap: spacing.xs,
    },
    fieldCard: {
      marginBottom: spacing.md,
    },
    fieldCardContent: {
      gap: spacing.sm,
    },
    timeSection: {
      flexDirection: 'row',
      gap: spacing.sm,
    },
    timeInput: {
      flex: 1,
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

  const dismissLocationPrecisionNotice = useCallback(() => {
    setShowLocationPrecisionNotice(false);
  }, []);

  const updateLocationData = (updater: (previous: LocationData) => LocationData) => {
    setLocationData(prev => {
      const next = updater(prev);
      locationDataRef.current = next;
      return next;
    });
  };

  const updateTimeData = (updater: (previous: TimeData) => TimeData) => {
    setTimeData(prev => {
      const next = updater(prev);
      timeDataRef.current = next;
      return next;
    });
  };

  const buildLocationPatch = (): Partial<DraftData> => {
    const currentLocation = locationDataRef.current;
    const locationAddress = currentLocation.locationMode === 'current'
      ? currentLocation.address
      : currentLocation.locationMode === 'manual'
        ? currentLocation.customLocation
        : '';
    const locationDescription = currentLocation.locationName.trim() ||
      (currentLocation.locationMode === 'general' ? 'General area only' : undefined);
    const locationType = currentLocation.locationContext ||
      (currentLocation.locationMode === 'general' ? 'general_area' : undefined);

    return {
      location: {
        address: locationAddress.trim() || undefined,
        description: locationDescription,
        type: locationType,
        coordinates: currentLocation.locationMode === 'current' ? currentLocation.coordinates : undefined,
      },
    };
  };

  const buildTimePatch = (): Partial<DraftData> => {
    const currentTime = timeDataRef.current;
    return {
      datetime: {
        date: formatDraftLocalDate(currentTime.incidentDate),
        time: formatDraftLocalTime(currentTime.incidentTime),
        accuracy: toDraftAccuracy(currentTime.timeAccuracy),
      },
      duration: currentTime.duration || undefined,
      isOngoing: currentTime.duration === 'ongoing',
    };
  };

  useEffect(() => {
    if (!initialDraftId || isResolvingDraftId) return;
    updateDraft(buildLocationPatch(), true);
  }, [locationData, updateDraft]);

  useEffect(() => {
    if (!initialDraftId || isResolvingDraftId) return;
    if (!timeConfirmed) return;
    updateDraft(buildTimePatch(), true);
  }, [timeConfirmed, timeData, updateDraft]);

  const getCurrentLocation = async () => {
    if (permissionState === 'denied' && hasAskedForLocation) {
      toast.show({
        title: 'Use manual location',
        message: 'Location permission was denied in this flow. You can still save a general or manual place.',
        variant: 'error',
      });
      return;
    }

    const requestId = ++locationRequestId.current;
    const isActive = () => locationRequestId.current === requestId;
    setIsLocating(true);
    setPermissionState('checking');
    setHasAskedForLocation(true);

    try {
      const result = await readCurrentReportLocation(isActive);
      if (!result || !isActive()) return;

      if (result.status === 'denied') {
        setPermissionState('denied');
        updateLocationData(prev => isActive() ? ({
          ...prev,
          locationMode: 'manual',
          coordinates: undefined,
          address: '',
        }) : prev);
        toast.show({
          title: 'Location not shared',
          message: 'Manual location is still available and exact location is optional.',
          variant: 'error',
        });
        return;
      }

      setPermissionState('granted');
      updateLocationData(prev => isActive() ? ({
        ...prev,
        locationMode: 'current',
        address: result.address,
        customLocation: '',
        coordinates: result.coordinates,
      }) : prev);
    } catch {
      if (!isActive()) return;
      setPermissionState('error');
      toast.show({
        title: 'Location not available',
        message: 'Please enter a place manually or save a general location type.',
        variant: 'error',
      });
    } finally {
      if (isActive()) setIsLocating(false);
    }
  };

  const canProceed = () => {
    if (!showOptionalTimeDetails) {
      const currentLocation = locationDataRef.current;
      return Boolean(
        currentLocation.locationMode === 'general' ||
        currentLocation.locationContext ||
        currentLocation.customLocation.trim() ||
        currentLocation.locationName.trim() ||
        currentLocation.coordinates,
      );
    }
    if (showOptionalTimeDetails) {
      return Boolean(timeDataRef.current.timeAccuracy);
    }
    return true;
  };

  const getCompletedSteps = () => {
    const completedSteps = draftData?.completedSteps ?? [];
    return completedSteps.includes('WhereWhen')
      ? completedSteps
      : [...completedSteps, 'WhereWhen'];
  };

  const finishWhereWhen = async (includeTimeDetails: boolean) => {
    cancelLocationRequest();
    if (!initialDraftId) {
      toast.show({
        title: 'Draft still opening',
        message: draftIdError ?? 'Wait a moment, then continue.',
        variant: 'warning',
      });
      return;
    }

    try {
      const saved = await saveDraftPatch({
        ...buildLocationPatch(),
        ...(includeTimeDetails ? buildTimePatch() : {}),
        completedSteps: getCompletedSteps(),
        currentStep: 'EvidenceDetail',
      });

      if (!saved) {
        toast.show({
          title: 'Draft still loading',
          message: 'Wait a moment, then continue.',
          variant: 'warning',
        });
        return;
      }
      captureMeasurementEvent({
        name: 'step_complete',
        screenId: 'where-when',
        taskId: 'report-flow',
        outcome: 'completed',
      });
      pushReportRoute(navigation, 'EvidenceDetail', {
        draftId: initialDraftId,
        ...(isEditingCompleted ? { editCompleted: true } : {}),
      });
    } catch {
      captureMeasurementEvent({
        name: 'error_outcome',
        screenId: 'where-when',
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
        title: showOptionalTimeDetails ? 'Choose timing accuracy' : 'Add a place clue',
        message: showOptionalTimeDetails
          ? 'Exact timing is optional. Choose approximate or unsure if needed.'
          : 'A location type, route, stage, or general area is enough.',
        variant: 'error',
      });
      return;
    }

    if (!showOptionalTimeDetails) {
      await finishWhereWhen(false);
      return;
    }

    if (showOptionalTimeDetails) {
      setTimeConfirmed(true);
      await finishWhereWhen(true);
      return;
    }
  };

  const handleBack = () => {
    cancelLocationRequest();
    if (showOptionalTimeDetails) {
      setShowOptionalTimeDetails(false);
    } else {
      goBackToWhatHappened();
    }
  };

  const handleAddTimeDetails = () => {
    if (!canProceed()) {
      toast.show({
        title: 'Add a place clue',
        message: 'A location type, route, stage, or general area is enough.',
        variant: 'error',
      });
      return;
    }

    cancelLocationRequest();
    setShowOptionalTimeDetails(true);
  };

  const selectLocationMode = (mode: LocationMode) => {
    cancelLocationRequest();
    updateLocationData(prev => ({
      ...prev,
      locationMode: mode,
      customLocation: mode === 'manual' ? prev.customLocation : '',
      address: mode === 'current' ? prev.address : '',
      coordinates: mode === 'current' ? prev.coordinates : undefined,
    }));
  };

  const renderStepHeader = (title: string, helper: string) => (
    <ReportStepHeader eyebrow="Exact details optional" title={title} helper={helper} />
  );

  const renderFieldCard = (children: React.ReactNode) => (
    <Card variant="outlined" hideAccent style={styles.fieldCard}>
      <CardContent style={styles.fieldCardContent}>
        {children}
      </CardContent>
    </Card>
  );

  const renderModeCard = (
    mode: LocationMode,
    title: string,
    description: string,
    icon: keyof typeof Ionicons.glyphMap,
    action?: React.ReactNode,
  ) => {
    const selected = locationData.locationMode === mode;
    return (
      <ChoiceCard
        title={title}
        description={description}
        icon={icon}
        selected={selected}
        onPress={mode === 'current' ? undefined : () => selectLocationMode(mode)}
        accessibilityLabel={`${title}. ${description}`}
      >
        {action}
      </ChoiceCard>
    );
  };

  const renderLocationStep = () => (
    <View>
      {renderStepHeader(
        'Where did it happen?',
        'A general place is enough. Only use device location if it feels safe and useful.',
      )}

      <View style={styles.section}>
        {showLocationPrecisionNotice ? (
          <AlertComponent
            variant="info"
            dismissible
            onDismiss={dismissLocationPrecisionNotice}
            autoDismissMs={LOCATION_PRECISION_NOTICE_TIMEOUT_MS}
          >
            <AlertTitle>Location precision</AlertTitle>
            <AlertDescription>
              SafeRide saves the place you provide in this draft. Device location may be approximate, and manual location remains available if permission is denied.
            </AlertDescription>
          </AlertComponent>
        ) : null}

        <View style={styles.modeGrid}>
          {renderModeCard(
            'general',
            'General area only',
            'Save the type of place, route, stage, or landmark without an exact address.',
            'map-outline',
          )}
          {renderModeCard(
            'manual',
            'Type a place manually',
            'Use your own words for an address, stage, route, vehicle, or nearby landmark.',
            'create-outline',
          )}
          {renderModeCard(
            'current',
            'Use current location once',
            'Requests foreground location only after you tap the button. SafeRide does not keep asking in this flow after denial.',
            'locate-outline',
            <Button
              title={isLocating ? 'Getting location...' : locationData.coordinates ? 'Refresh location' : 'Use current location'}
              onPress={getCurrentLocation}
              variant="outline"
              size="sm"
              fullWidth
              loading={isLocating}
              disabled={permissionState === 'denied' && hasAskedForLocation}
            />,
          )}
        </View>

        {permissionState === 'denied' ? (
          <AlertComponent variant="warning">
            <AlertTitle>Location permission was denied</AlertTitle>
            <AlertDescription>
              You can continue with a manual or general location. This screen will not ask again unless you leave and come back.
            </AlertDescription>
          </AlertComponent>
        ) : null}

        {locationData.locationMode === 'current' && locationData.coordinates ? (
          <AlertComponent variant="success">
            <AlertTitle>Device location saved to draft</AlertTitle>
            <AlertDescription>
              {locationData.address || 'Coordinates saved. Add a general label below if it helps you remember the place.'}
            </AlertDescription>
          </AlertComponent>
        ) : null}
      </View>

      {renderFieldCard(
        <>
        <View style={styles.fieldGroup}>
          <Text style={styles.helperText}>Location type</Text>
          <View style={styles.chipWrap}>
            {locationContextOptions.map(option => (
              <Chip
                key={option.value}
                label={option.label}
                selected={locationData.locationContext === option.value}
                onPress={() => updateLocationData(prev => ({ ...prev, locationContext: option.value }))}
                testID={`where-location-type-${option.value}`}
              />
            ))}
          </View>
        </View>

        <Input
          label="Area, route, stage, vehicle, or landmark (optional)"
          placeholder="Example: Route 111 near Kencom stage"
          value={locationData.locationName}
          onChangeText={(text) => updateLocationData(prev => ({ ...prev, locationName: text }))}
          helperText="Use general words if exact details feel unsafe to save."
        />

        {locationData.locationMode === 'manual' ? (
          <Input
            label="Exact place or address (optional)"
            placeholder="Example: outside a shop on Moi Avenue"
            value={locationData.customLocation}
            onChangeText={(text) => updateLocationData(prev => ({
              ...prev,
              customLocation: text,
              address: '',
              coordinates: undefined,
              locationMode: 'manual',
            }))}
            helperText="Leave blank if a general place is enough."
          />
        ) : null}
        </>
      )}
    </View>
  );

  const renderTimeStep = () => (
    <View>
      {renderStepHeader(
        'When did it happen?',
        'Exact timing is optional. Add the closest details you remember.',
      )}

      {renderFieldCard(
        <>
        <Checkbox
          checked={timeData.useCurrentTime}
          onCheckedChange={(checked) => {
            const useCurrentTime = checked === true;
            const now = new Date();
            updateTimeData(prev => ({
              ...prev,
              useCurrentTime,
              incidentDate: useCurrentTime ? now : prev.incidentDate,
              incidentTime: useCurrentTime ? now : prev.incidentTime,
            }));
          }}
          label="Use current date and time"
          description="Optional. Turn this off to choose another date or time."
        />

        {!timeData.useCurrentTime ? (
          <View style={styles.timeSection}>
            <View style={styles.timeInput}>
              <DateField
                label="Date"
                value={timeData.incidentDate}
                onChange={(d) => updateTimeData(prev => ({ ...prev, incidentDate: d }))}
              />
            </View>
            <View style={styles.timeInput}>
              <TimeField
                label="Time"
                value={timeData.incidentTime}
                onChange={(d) => updateTimeData(prev => ({ ...prev, incidentTime: d }))}
              />
            </View>
          </View>
        ) : null}
        </>
      )}

      {renderFieldCard(
        <>
        <View style={styles.fieldGroup}>
          <Text style={styles.helperText}>Timing accuracy</Text>
          <View style={styles.modeGrid}>
            {timingAccuracyOptions.map(option => {
              const selected = timeData.timeAccuracy === option.value;
              return (
                <ChoiceCard
                  key={option.value}
                  title={option.label}
                  description={option.description}
                  selected={selected}
                  onPress={() => updateTimeData(prev => ({ ...prev, timeAccuracy: option.value }))}
                  accessibilityLabel={`${option.label}. ${option.description}`}
                />
              );
            })}
          </View>
        </View>

        <View style={styles.fieldGroup}>
          <Text style={styles.helperText}>Duration (optional)</Text>
          <View style={styles.chipWrap}>
            {durationOptions.map(option => (
              <Chip
                key={option.value}
                label={option.label}
                selected={timeData.duration === option.value}
                onPress={() => updateTimeData(prev => ({
                  ...prev,
                  duration: prev.duration === option.value ? '' : option.value,
                }))}
                testID={`where-duration-${option.value}`}
              />
            ))}
          </View>
        </View>
        </>
      )}
    </View>
  );

  const renderCurrentStep = () => (showOptionalTimeDetails ? renderTimeStep() : renderLocationStep());

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
            draft={draftData}
            currentStep="WhereWhen"
            isSaving={isSaving}
            lastSaved={lastSaved}
            error={error ?? draftIdError}
          />

          {renderCurrentStep()}

          {!showOptionalTimeDetails && canProceed() ? (
            <Button
              title={timeConfirmed ? 'Edit time details' : 'Add optional time details'}
              variant="outline"
              onPress={handleAddTimeDetails}
              disabled={isSaving}
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
              title="Continue to evidence"
              onPress={handleNext}
              disabled={!canProceed() || isSaving || isResolvingDraftId}
              loading={isSaving || isResolvingDraftId}
              style={styles.nextButton}
            />
          </View>
        </View>
      </View>
    </Screen>
  );
}
