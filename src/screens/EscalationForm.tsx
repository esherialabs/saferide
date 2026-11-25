import React from 'react';
import { useState, useEffect, useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Modal } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { ReportWizardProgress } from '../components/report/ReportWizardProgress';
import Screen from '../components/ui/Screen';
import Button from '../components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/Card';
import { FeatureHeader, type FeatureHeaderStat } from '../components/ui/FeatureHeader';
import { Input } from '../components/ui/Input';
import { Chip } from '../components/ui/Chip';
import { RadioButton } from '../components/ui/RadioButton';
import { Separator } from '../components/ui/Separator';
import { Slider } from '../components/ui/Slider';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme/SimpleThemeProvider';
import { RootStackParamList } from '../navigation/routes';
import { useReportWizardBack } from '../navigation/reportWizardBack';
import { useCompletedReportRedirect } from '../hooks/useCompletedReportRedirect';
import { useReportDraftIdentity } from '../hooks/useReportDraftIdentity';
import { draftStorage, DraftData } from '../utils/draftStorage';
import { formValidator, FieldValidation } from '../utils/formValidation';
import { useToast } from '../components/ui/Toast';
import { useOnline } from '../context/OnlineProvider';
import { getCompletedStepsBeforeConsent } from '../navigation/reportPathwayFlow';
import { borders, elevation, radii, spacing, typography } from '../theme/tokens';
import {
  buildEscalationHandoffStatus,
  buildEscalationPacket,
} from '../utils/escalationPacket';
import type { EscalationPacket } from '../utils/escalationPacket';
import { PartnerSharingOptIn } from '../components/report/PartnerSharingOptIn';
import { usePartnerSharingAvailability } from '../hooks/usePartnerSharingAvailability';
import { PARTNER_SHARING_COPY } from '../i18n/partnerSharingCopy';
import {
  buildPartnerSharingChoice,
  getPartnerSharingFormState,
  type PartnerSharingFormState,
} from '../utils/partnerSharing';

import { devPrivacyError, getPrivacySafeErrorReason } from '../utils/privacyLog';
type EscalationFormNavigationProp = NativeStackNavigationProp<RootStackParamList, 'EscalationForm'>;
type EscalationFormRouteProp = RouteProp<RootStackParamList, 'EscalationForm'>;

interface EscalationData {
  redactionLevel: 'none' | 'light' | 'heavy';
  vehiclePlate: string;
  saccoOperator: string;
  contactPreference: 'alias' | 'none';
  alias: string;
}

interface RedactionPreviewData {
  timeRange: string;
  location: string;
  tags: string[];
  identity: string;
  incidentDescription: string;
  statement: string;
  evidenceManifest: string[];
  handoffSend: string;
  handoffShare: string;
}

const redactionLevels = [
  {
    id: 'none',
    label: 'None',
    description: 'Full details shown',
    value: 0,
  },
  {
    id: 'light',
    label: 'Light',
    description: 'Names and phone-like values masked in preview',
    value: 1,
  },
  {
    id: 'heavy',
    label: 'Heavy', 
    description: 'Names, phone-like values, plate-like values, and location detail reduced in preview',
    value: 2,
  },
] as const;

export default function EscalationFormScreen() {
  const navigation = useNavigation<EscalationFormNavigationProp>();
  const route = useRoute<EscalationFormRouteProp>();
  const { colors } = useTheme();
  const toast = useToast();
  
  const [showInfoRibbon, setShowInfoRibbon] = useState(true);
  const [redactionLevel, setRedactionLevel] = useState<'none' | 'light' | 'heavy'>('light');
  const [vehiclePlate, setVehiclePlate] = useState('');
  const [saccoOperator, setSaccoOperator] = useState('');
  const [contactPreference, setContactPreference] = useState<'alias' | 'none'>('none');
  const [alias, setAlias] = useState('');
  const [draftData, setDraftData] = useState<DraftData | null>(null);
  const [showAliasEditor, setShowAliasEditor] = useState(false);
  const [showRedactionPreview, setShowRedactionPreview] = useState(false);
  const [showPacketPreview, setShowPacketPreview] = useState(false);
  const [plateValidationHint, setPlateValidationHint] = useState('');
  const { isOnline } = useOnline();
  const isOffline = !isOnline;
  const [isSaving, setIsSaving] = useState(false);
  const [errors, setErrors] = useState<{ [k: string]: string[] }>({});
  const partnerAvailability = usePartnerSharingAvailability();
  const [partnerForm, setPartnerForm] = useState<PartnerSharingFormState>(() => getPartnerSharingFormState(null));
  const [partnerPhoneError, setPartnerPhoneError] = useState<string | null>(null);
  const heroStats = useMemo<FeatureHeaderStat[]>(() => [
    {
      label: 'Redaction',
      value: redactionLevels.find(level => level.id === redactionLevel)?.label ?? 'Light',
      icon: 'eye-off-outline',
    },
    {
      label: 'Contact',
      value: contactPreference === 'alias' ? 'Alias' : 'None',
      icon: 'chatbubble-ellipses-outline',
    },
    {
      label: 'Network',
      value: isOffline ? 'Queued' : 'Online',
      icon: isOffline ? 'cloud-offline-outline' : 'cloud-done-outline',
    },
  ], [contactPreference, isOffline, redactionLevel]);
  
  const routeDraftId = typeof route.params?.draftId === 'string' && route.params.draftId.trim()
    ? route.params.draftId
    : undefined;
  const {
    draftId,
    isResolving: isResolvingDraftId,
    error: draftIdError,
  } = useReportDraftIdentity(routeDraftId, { initialStep: 'EscalationForm' });
  const isEditingCompleted = route.params?.editCompleted === true;
  useCompletedReportRedirect(navigation, draftData, { enabled: !isEditingCompleted });
  const goBackToPathway = useReportWizardBack(navigation, draftId ? {
    route: 'ConsentGate',
    params: { draftId, ...(isEditingCompleted ? { editCompleted: true } : {}) },
  } : undefined);

  const getCurrentEscalationData = (): EscalationData => ({
    redactionLevel,
    vehiclePlate: vehiclePlate.trim(),
    saccoOperator: saccoOperator.trim(),
    contactPreference,
    alias: alias.trim(),
  });

  const buildPreviewDraft = (): DraftData => {
    const now = new Date();
    const previewDraftId = draftId ?? draftData?.id ?? 'local-draft-unavailable';
    return {
      id: previewDraftId,
      createdAt: draftData?.createdAt ?? now,
      updatedAt: draftData?.updatedAt ?? now,
      ...(draftData ?? {}),
      escalationData: getCurrentEscalationData(),
    };
  };

  const getCurrentPacket = (): EscalationPacket => buildEscalationPacket(buildPreviewDraft());

  const getHandoffStatus = () => buildEscalationHandoffStatus({
    isOnline,
    packetReady: Boolean(draftData && draftId),
    hasCaseServiceEndpoint: true,
    shareSheetAvailable: false,
  });
  
  const styles = StyleSheet.create({
    container: {
      flex: 1,
      padding: spacing.md,
    },
    sectionTitle: {
      ...typography.titleMedium,
      color: colors.foreground,
      marginBottom: spacing.sm,
    },
    heroActions: {
      alignItems: 'center',
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.sm,
    },
    cardSpacing: {
      marginBottom: spacing.md,
    },
    infoRibbon: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      padding: spacing.sm,
      backgroundColor: colors.primaryMuted,
      borderWidth: borders.hairline,
      borderColor: colors.primary + '30',
      borderRadius: radii.card,
      marginBottom: spacing.md,
    },
    redactionSlider: {
      marginVertical: spacing.md,
    },
    sliderControl: {
      marginHorizontal: spacing.xs,
    },
    sliderLabels: {
      flexDirection: 'row',
      marginTop: spacing.xs,
    },
    sliderLabelButton: {
      alignItems: 'center',
      borderRadius: radii.button,
      flex: 1,
      justifyContent: 'center',
      minHeight: 44,
    },
    sliderLabelButtonSelected: {
      backgroundColor: colors.primaryMuted,
    },
    sliderLabel: {
      ...typography.caption,
      color: colors.mutedForeground,
      fontWeight: '600',
    },
    redactionChips: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
      marginTop: spacing.sm,
    },
    redactionChip: {
      marginRight: 0,
      marginBottom: 0,
    },
    formField: {
      marginBottom: spacing.md,
    },
    fieldLabel: {
      ...typography.labelMedium,
      color: colors.foreground,
      marginBottom: spacing.xs,
    },
    fieldHint: {
      ...typography.caption,
      color: colors.mutedForeground,
      marginTop: spacing.xxxs,
    },
    validationHint: {
      ...typography.caption,
      color: colors.warning,
      marginTop: spacing.xxxs,
    },
    radioGroup: {
      gap: spacing.md,
    },
    radioOption: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm,
    },
    radioContent: {
      flex: 1,
    },
    radioLabel: {
      ...typography.labelMedium,
      color: colors.foreground,
      marginBottom: spacing.xxxs,
    },
    radioDescription: {
      ...typography.caption,
      color: colors.mutedForeground,
    },
    aliasContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      marginTop: spacing.xs,
    },
    aliasChip: {
      marginRight: 8,
    },
    previewButtons: {
      gap: spacing.sm,
      marginTop: spacing.md,
    },
    navigationButtons: {
      flexDirection: 'row',
      gap: spacing.sm,
      marginTop: spacing.xl,
      paddingBottom: spacing.xl,
    },
    offlineChip: {
      marginBottom: 0,
    },
    backButton: {
      flex: 1,
    },
    sendButton: {
      flex: 2,
    },
    modalOverlay: {
      flex: 1,
      backgroundColor: colors.scrim,
      justifyContent: 'center',
      alignItems: 'center',
    },
    modalContent: {
      backgroundColor: colors.surface,
      borderColor: colors.divider,
      borderRadius: radii.sheet,
      borderWidth: borders.hairline,
      padding: spacing.lg,
      margin: spacing.lg,
      maxHeight: '80%',
      overflow: 'hidden',
      position: 'relative',
      width: '90%',
      ...elevation.floating,
    },
    modalHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: spacing.md,
    },
    modalTitle: {
      ...typography.titleMedium,
      color: colors.foreground,
    },
    previewGrid: {
      gap: spacing.sm,
      marginBottom: spacing.md,
    },
    previewField: {
      marginBottom: spacing.sm,
    },
    previewLabel: {
      ...typography.labelSmall,
      color: colors.foreground,
      marginBottom: spacing.xxxs,
    },
    previewValue: {
      ...typography.bodyS,
      color: colors.mutedForeground,
    },
    statementPreview: {
      padding: spacing.sm,
      backgroundColor: colors.surfaceAlt,
      borderColor: colors.divider,
      borderRadius: radii.card,
      borderWidth: borders.hairline,
      marginBottom: spacing.sm,
      overflow: 'hidden',
      position: 'relative',
    },
    evidenceHash: {
      ...typography.caption,
      fontFamily: 'monospace',
      color: colors.mutedForeground,
    },
  });

  useEffect(() => {
    loadFormData();
  }, [draftId, isResolvingDraftId]);

  const loadFormData = async () => {
    try {
      if (!draftId || isResolvingDraftId) {
        setDraftData(null);
        return;
      }

      const draft = await draftStorage.getDraft(draftId);
      setDraftData(draft);
      setPartnerForm(getPartnerSharingFormState(draft?.partnerSharing));
      if (draft?.escalationData) {
        const data = draft.escalationData;
        setRedactionLevel(data.redactionLevel || 'light');
        setVehiclePlate(data.vehiclePlate || '');
        setSaccoOperator(data.saccoOperator || '');
        setContactPreference(data.contactPreference || 'none');
        setAlias(data.alias || '');
      }
    } catch (error) {
      devPrivacyError('escalation form data load failed', { reason: getPrivacySafeErrorReason(error) });
    }
  };

  const truncate = (value: string, maxLength = 220) => {
    if (value.length <= maxLength) return value;
    return value.slice(0, maxLength).trimEnd() + '...';
  };

  const getRedactionPreview = () => getCurrentPacket().redaction.appliedLabels;

  const getStatementPreview = () => truncate(getCurrentPacket().content.statement);

  const getEvidenceManifestPreview = () => {
    const manifest = getCurrentPacket().evidenceManifest;
    if (!manifest.length) return ['No evidence files recorded in this draft.'];
    return manifest.map(item => {
      const checksum = item.checksum ? ` | checksum: ${item.checksum.slice(0, 16)}...` : '';
      return `${item.label} | ${item.metadataStatus}${checksum}`;
    });
  };

  const handlePlateValidation = () => {
    if (vehiclePlate && vehiclePlate.length > 0) {
      const platePattern = /^[A-Z]{3}\s?\d{3}[A-Z]?$/i;
      if (!platePattern.test(vehiclePlate.trim())) {
        setPlateValidationHint("Plate format looks off. Continue if you're unsure.");
      } else {
        setPlateValidationHint('');
      }
    } else {
      setPlateValidationHint('');
    }
  };

  const handleAliasChange = (newAlias: string) => {
    const phonePattern = /^\+?\d{9,}$/;
    if (!phonePattern.test(newAlias)) {
      setAlias(newAlias);
    }
  };

  // Patch only the fields this screen owns; draftStorage merges with the
  // persisted draft. Spreading the mount-time snapshot here previously
  // overwrote data other screens saved while this form was open.
  const buildDraftSavePayload = (updates: Partial<DraftData>): Partial<DraftData> & { id: string } => {
    if (!draftId) {
      throw new Error('Local draft id missing for escalation save');
    }

    return {
      id: draftId,
      ...updates,
    };
  };

  // The HURIA choice is saved only while the server offers it; otherwise the
  // stored choice is left alone and the consent review explains it.
  const getPartnerSharingUpdate = (): { ok: true; update: Partial<DraftData> } | { ok: false } => {
    if (!partnerAvailability.routing) return { ok: true, update: {} };
    const result = buildPartnerSharingChoice(draftData?.partnerSharing, partnerForm, partnerAvailability);
    if (!result.ok) {
      setPartnerPhoneError(PARTNER_SHARING_COPY.callback.invalidNumber);
      return { ok: false };
    }
    setPartnerPhoneError(null);
    return { ok: true, update: { partnerSharing: result.sharing } };
  };

  const getCompletedSteps = (step: string) => Array.from(new Set([...(draftData?.completedSteps || []), step]));

  const getValidationRules = (): FieldValidation => {
    const rules: FieldValidation = {
      redactionLevel: [
        { type: 'required', message: 'Choose a redaction level.' },
      ],
      contactPreference: [
        { type: 'required', message: 'Select a contact preference.' },
      ],
    };
    if (contactPreference === 'alias') {
      rules.alias = [
        { type: 'required', message: 'Alias is required for in-app messages.' },
        { type: 'minLength', value: 2, message: 'Alias must be at least 2 characters.' },
        { type: 'maxLength', value: 24, message: 'Alias must be at most 24 characters.' },
        { type: 'custom', message: 'Alias should not be a phone number.', validator: (v) => !/^\+?\d{9,}$/.test(String(v)) },
      ];
    }
    if (vehiclePlate.trim().length > 0) {
      rules.vehiclePlate = [
        { type: 'custom', message: 'Plate format looks off (e.g., KDD 123A).', validator: (v) => /^[A-Z]{3}\s?\d{3}[A-Z]?$/i.test(String(v).trim()) },
      ];
    }
    return rules;
  };

  const saveFormData = async () => {
    if (!draftId) {
      toast.show({
        title: 'Local draft unavailable',
        message: draftIdError ?? 'Return to Reports and open this draft again.',
        variant: 'warning',
      });
      return;
    }

    const partnerUpdate = getPartnerSharingUpdate();
    if (!partnerUpdate.ok) {
      toast.show({ title: PARTNER_SHARING_COPY.callback.invalidNumber, variant: 'error' });
      return;
    }

    try {
      setIsSaving(true);
      const formData = getCurrentEscalationData();

      const savedDraft = await draftStorage.saveDraft(buildDraftSavePayload({
        ...partnerUpdate.update,
        escalationData: formData,
        selectedPathway: 'escalate',
        completedSteps: getCompletedStepsBeforeConsent('escalate'),
        currentStep: 'EscalationForm',
      }));
      setDraftData(savedDraft);

      toast.show({ title: 'Draft saved', variant: 'success' });
    } catch (error) {
      toast.show({ title: 'Save failed', message: 'Please try again.', variant: 'error' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleSendSecurely = async () => {
    if (!draftId) {
      toast.show({
        title: 'Local draft unavailable',
        message: draftIdError ?? 'Return to Reports and open this draft again.',
        variant: 'warning',
      });
      return;
    }

    try {
      // Validate before proceeding
      const dataForValidation = {
        redactionLevel,
        vehiclePlate,
        saccoOperator,
        contactPreference,
        alias,
      } as any;
      const validation = formValidator.validateForm(dataForValidation, getValidationRules());
      setErrors(validation.errors);
      if (!validation.isValid) {
        toast.show({ title: validation.firstError || 'Please fix form errors', variant: 'error' });
        return;
      }

      const partnerUpdate = getPartnerSharingUpdate();
      if (!partnerUpdate.ok) {
        toast.show({ title: PARTNER_SHARING_COPY.callback.invalidNumber, variant: 'error' });
        return;
      }

      const formData = getCurrentEscalationData();

      // Save final form data and navigate to consent gate
      const savedDraft = await draftStorage.saveDraft(buildDraftSavePayload({
        ...partnerUpdate.update,
        escalationData: formData,
        selectedPathway: 'escalate',
        completedSteps: getCompletedStepsBeforeConsent('escalate'),
        currentStep: 'ConsentGate',
      }));
      setDraftData(savedDraft);

      navigation.navigate('ConsentGate', {
        draftId,
        ...(isEditingCompleted ? { editCompleted: true } : {}),
      });
    } catch (error) {
      toast.show({ title: 'Preparation failed', message: 'Please try again.', variant: 'error' });
    }
  };

  const renderRedactionSlider = () => {
    const currentLevel = redactionLevels.find(level => level.id === redactionLevel);
    const currentValue = currentLevel?.value ?? 1;
    const updateRedactionLevel = (nextValue: number) => {
      const nextLevel = redactionLevels.find(level => level.value === Math.round(nextValue));
      if (nextLevel) {
        setRedactionLevel(nextLevel.id);
      }
    };

    return (
      <View style={styles.redactionSlider}>
        <Slider
          value={[currentValue]}
          min={0}
          max={2}
          step={1}
          thumbSize={28}
          onValueChange={([nextValue]) => updateRedactionLevel(nextValue)}
          style={styles.sliderControl}
        />
        <View style={styles.sliderLabels}>
          {redactionLevels.map((level) => (
            <TouchableOpacity
              key={level.id}
              onPress={() => setRedactionLevel(level.id)}
              activeOpacity={0.72}
              accessibilityRole="radio"
              accessibilityState={{ checked: redactionLevel === level.id }}
              accessibilityLabel={`${level.label} redaction`}
              style={[
                styles.sliderLabelButton,
                redactionLevel === level.id ? styles.sliderLabelButtonSelected : null,
              ]}
            >
              <Text style={[
                styles.sliderLabel,
                { color: redactionLevel === level.id ? colors.primary : colors.mutedForeground }
              ]}>
                {level.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>
    );
  };

  const renderRedactionPreviewModal = () => (
    <Modal
      visible={showRedactionPreview}
      transparent
      animationType="fade"
      onRequestClose={() => setShowRedactionPreview(false)}
    >
      <View style={styles.modalOverlay}>
        <View style={styles.modalContent}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Redaction Preview</Text>
            <TouchableOpacity onPress={() => setShowRedactionPreview(false)}>
              <Ionicons name="close" size={24} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>
          
          <ScrollView>
            <View style={styles.statementPreview}>
              <Text style={[styles.previewLabel, { marginBottom: 8 }]}>Statement excerpt:</Text>
              <Text style={{ fontSize: 14, color: colors.foreground }}>
                "{getStatementPreview()}"
              </Text>
            </View>
            
            <View style={styles.redactionChips}>
              {getRedactionPreview().map((chip) => (
                <Chip key={chip} label={chip} style={styles.redactionChip} />
              ))}
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );

  const renderPacketPreviewModal = () => {
    const packet = getCurrentPacket();
    const handoff = getHandoffStatus();
    const previewData: RedactionPreviewData = {
      timeRange: packet.content.timeRange,
      location: packet.content.location,
      tags: packet.content.tags,
      identity: packet.contact.label,
      incidentDescription: truncate(packet.content.incidentDescription),
      statement: truncate(packet.content.statement),
      evidenceManifest: getEvidenceManifestPreview(),
      handoffSend: `${handoff.send.label}: ${handoff.send.reason ?? ''}`.trim(),
      handoffShare: `${handoff.share.label}: ${handoff.share.reason ?? ''}`.trim(),
    };

    return (
      <Modal
        visible={showPacketPreview}
        transparent
        animationType="fade"
        onRequestClose={() => setShowPacketPreview(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Packet Preview</Text>
              <TouchableOpacity onPress={() => setShowPacketPreview(false)}>
                <Ionicons name="close" size={24} color={colors.mutedForeground} />
              </TouchableOpacity>
            </View>
            
            <ScrollView>
              <View style={styles.previewGrid}>
                <View style={styles.previewField}>
                  <Text style={styles.previewLabel}>Time band:</Text>
                  <Text style={styles.previewValue}>{previewData.timeRange}</Text>
                </View>
                
                <View style={styles.previewField}>
                  <Text style={styles.previewLabel}>Location:</Text>
                  <Text style={styles.previewValue}>{previewData.location}</Text>
                </View>
                
                <View style={styles.previewField}>
                  <Text style={styles.previewLabel}>Tags:</Text>
                  <Text style={styles.previewValue}>{previewData.tags.length ? previewData.tags.join(', ') : 'No legal tags selected'}</Text>
                </View>
                
                <View style={styles.previewField}>
                  <Text style={styles.previewLabel}>Identity:</Text>
                  <Text style={styles.previewValue}>{previewData.identity}</Text>
                </View>
              </View>
              
              <View style={styles.previewField}>
                <Text style={styles.previewLabel}>Incident:</Text>
                <Text style={styles.previewValue}>{previewData.incidentDescription}</Text>
              </View>

              <View style={styles.previewField}>
                <Text style={styles.previewLabel}>Statement:</Text>
                <Text style={styles.previewValue}>{previewData.statement}</Text>
              </View>

              <View style={{ marginBottom: 16 }}>
                <Text style={styles.previewLabel}>Redaction summary:</Text>
                <View style={styles.redactionChips}>
                  {getRedactionPreview().map((chip) => (
                    <Chip key={chip} label={chip} style={styles.redactionChip} />
                  ))}
                </View>
              </View>
              
              <View style={styles.previewField}>
                <Text style={styles.previewLabel}>Evidence manifest:</Text>
                {previewData.evidenceManifest.map(item => (
                  <Text key={item} style={styles.evidenceHash}>{item}</Text>
                ))}
              </View>

              <View style={styles.previewField}>
                <Text style={styles.previewLabel}>Handoff:</Text>
                <Text style={styles.previewValue}>{previewData.handoffSend}</Text>
                <Text style={styles.previewValue}>{previewData.handoffShare}</Text>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>
    );
  };

  const renderAliasEditorModal = () => (
    <Modal
      visible={showAliasEditor}
      transparent
      animationType="fade"
      onRequestClose={() => setShowAliasEditor(false)}
    >
      <View style={styles.modalOverlay}>
        <View style={styles.modalContent}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Edit Alias</Text>
            <TouchableOpacity onPress={() => setShowAliasEditor(false)}>
              <Ionicons name="close" size={24} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>
          
          <View style={styles.formField}>
            <Text style={styles.fieldLabel}>Alias</Text>
            <Input
              value={alias}
              onChangeText={handleAliasChange}
              placeholder="Enter alias"
              maxLength={24}
            />
            <Text style={styles.fieldHint}>Avoid real names or phone numbers.</Text>
          </View>
          
          <View style={{ flexDirection: 'row', gap: 12, justifyContent: 'flex-end' }}>
            <Button
              title="Cancel"
              variant="outline"
              onPress={() => setShowAliasEditor(false)}
              style={{ flex: 1 }}
            />
            <Button
              title="Save"
              onPress={() => setShowAliasEditor(false)}
              style={{ flex: 1 }}
            />
          </View>
        </View>
      </View>
    </Modal>
  );

  return (
    <Screen>
      <ScrollView style={styles.container} showsVerticalScrollIndicator={false}>
        <ReportWizardProgress
          draft={draftData}
          currentStep="EscalationForm"
          isSaving={isSaving}
          lastSaved={draftData?.updatedAt}
          error={draftIdError}
        />

        <FeatureHeader
          eyebrow="Consent-gated packet"
          title="Escalation form"
          description="Prepare redaction, identifiers, and follow-up preferences before the consent review decides what leaves this device."
          icon="send-outline"
          tone="critical"
          stats={heroStats}
          style={styles.cardSpacing}
        >
          <View style={styles.heroActions}>
            <Button
              title={isSaving ? 'Saving...' : 'Save draft'}
              variant="outline"
              size="sm"
              onPress={saveFormData}
              disabled={isSaving || isResolvingDraftId || !draftId}
            />
            <Button
              title="Preview packet"
              variant="ghost"
              size="sm"
              onPress={() => setShowPacketPreview(true)}
            />
          </View>
        </FeatureHeader>

        {/* Info Ribbon */}
        {showInfoRibbon && (
          <View style={styles.infoRibbon}>
            <Ionicons name="information-circle" size={20} color={colors.primary} style={{ marginRight: 8 }} />
            <Text style={{ flex: 1, fontSize: 14, color: colors.primary }}>
              Local only until you consent to send.
            </Text>
            <TouchableOpacity onPress={() => setShowInfoRibbon(false)}>
              <Ionicons name="close" size={20} color={colors.primary} />
            </TouchableOpacity>
          </View>
        )}

        {/* Redaction Level Card */}
        <Card variant="elevated" style={styles.cardSpacing}>
          <CardHeader>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <CardTitle>Redaction level</CardTitle>
              <Button
                title="Preview"
                variant="ghost"
                size="sm"
                onPress={() => setShowRedactionPreview(true)}
                style={{ flexDirection: 'row', alignItems: 'center' }}
              />
            </View>
            <CardDescription>Pick how much identifying detail appears in the packet preview.</CardDescription>
          </CardHeader>
          <CardContent>
            {renderRedactionSlider()}
            
            <Text style={{ fontSize: 14, color: colors.mutedForeground, marginBottom: 12 }}>
              {redactionLevels.find(level => level.id === redactionLevel)?.description}
            </Text>
            
            {getRedactionPreview().length > 0 && (
              <View style={styles.redactionChips}>
                {getRedactionPreview().map((chip) => (
                  <Chip key={chip} label={chip} style={styles.redactionChip} />
                ))}
              </View>
            )}
            
            <Text style={{ fontSize: 12, color: colors.mutedForeground, marginTop: 12 }}>
              Packet redactions apply to saved draft text and evidence metadata before consent and submission. Media files are not visually transformed here.
            </Text>
          </CardContent>
        </Card>

        {/* Optional Identifiers Card */}
        <Card variant="elevated" style={styles.cardSpacing}>
          <CardHeader>
            <CardTitle>Identifiers (optional)</CardTitle>
            <CardDescription>Leave these blank when details are unsafe, unknown, or not useful.</CardDescription>
          </CardHeader>
          <CardContent>
            <View style={styles.formField}>
              <Text style={styles.fieldLabel}>Vehicle plate</Text>
              <Input
                value={vehiclePlate}
                onChangeText={setVehiclePlate}
                onBlur={handlePlateValidation}
                placeholder="e.g., KDD 123A"
                autoCapitalize="characters"
              />
              {plateValidationHint ? (
                <Text style={styles.validationHint}>{plateValidationHint}</Text>
              ) : null}
              {errors.vehiclePlate?.length ? (
                <Text style={styles.validationHint}>{errors.vehiclePlate[0]}</Text>
              ) : null}
              <Text style={styles.fieldHint}>If unsure, leave blank.</Text>
            </View>
            
            <View style={styles.formField}>
              <Text style={styles.fieldLabel}>SACCO / Operator</Text>
              <Input
                value={saccoOperator}
                onChangeText={setSaccoOperator}
                placeholder="e.g., Super Metro"
              />
            </View>
            
            <Text style={styles.fieldHint}>
              Identifiers help investigations but are never mandatory.
            </Text>
          </CardContent>
        </Card>

        {/* Contact Preference Card */}
        <Card variant="elevated" style={styles.cardSpacing}>
          <CardHeader>
            <CardTitle>How can they reach you?</CardTitle>
            <CardDescription>Choose whether any follow-up contact appears in the packet.</CardDescription>
          </CardHeader>
          <CardContent>
            <View style={styles.radioGroup}>
              <TouchableOpacity
                style={styles.radioOption}
                onPress={() => setContactPreference('alias')}
              >
                <RadioButton
                  selected={contactPreference === 'alias'}
                  onPress={() => setContactPreference('alias')}
                />
                <View style={styles.radioContent}>
                  <Text style={styles.radioLabel}>In-app messages (alias)</Text>
                  <Text style={styles.radioDescription}>
                    Include an alias for follow-up in the packet.
                  </Text>
              {contactPreference === 'alias' && (
                <View style={styles.aliasContainer}>
                  <Chip label={alias ? `Alias: ${alias}` : 'Alias not set'} style={styles.aliasChip} />
                  <Button
                    title="Change"
                    variant="ghost"
                    size="sm"
                    onPress={() => setShowAliasEditor(true)}
                  />
                </View>
              )}
              {contactPreference === 'alias' && errors.alias?.length ? (
                <Text style={styles.validationHint}>{errors.alias[0]}</Text>
              ) : null}
            </View>
          </TouchableOpacity>
              
              <TouchableOpacity
                style={styles.radioOption}
                onPress={() => setContactPreference('none')}
              >
                <RadioButton
                  selected={contactPreference === 'none'}
                  onPress={() => setContactPreference('none')}
                />
                <View style={styles.radioContent}>
                  <Text style={styles.radioLabel}>No contact</Text>
                  <Text style={styles.radioDescription}>
                    Do not include follow-up contact details in this packet.
                  </Text>
                </View>
              </TouchableOpacity>
            </View>
          </CardContent>
        </Card>

        {partnerAvailability.routing ? (
          <PartnerSharingOptIn
            pathway="escalate"
            value={partnerForm}
            onChange={next => {
              setPartnerForm(next);
              setPartnerPhoneError(null);
            }}
            callbackAvailable={partnerAvailability.callback}
            redactionLabel={redactionLevels.find(level => level.id === redactionLevel)?.label}
            phoneError={partnerPhoneError}
            style={styles.cardSpacing}
          />
        ) : null}

        {/* Handoff Status */}
        <Card variant="elevated" style={styles.cardSpacing}>
          <CardHeader>
            <CardTitle>Send and share status</CardTitle>
            <CardDescription>Review what is ready now and what may queue until later.</CardDescription>
          </CardHeader>
          <CardContent>
            <View style={styles.previewField}>
              <Text style={styles.previewLabel}>Send</Text>
              <Text style={styles.previewValue}>{getHandoffStatus().send.label}</Text>
              <Text style={styles.fieldHint}>{getHandoffStatus().send.reason}</Text>
            </View>
            <Separator />
            <View style={[styles.previewField, { marginTop: 12 }]}>
              <Text style={styles.previewLabel}>Separate export/share</Text>
              <Text style={styles.previewValue}>{getHandoffStatus().share.label}</Text>
              <Text style={styles.fieldHint}>{getHandoffStatus().share.reason}</Text>
            </View>
          </CardContent>
        </Card>

        {/* Footer Note */}
        {!showInfoRibbon && (
          <Text style={{ 
            fontSize: 12, 
            color: colors.mutedForeground, 
            textAlign: 'center',
            marginTop: 16 
          }}>
            Local only until you consent to send.
          </Text>
        )}

        {/* Navigation Buttons */}
        <View style={styles.navigationButtons}>
          <Button
            title="Back"
            variant="outline"
            onPress={goBackToPathway}
            style={styles.backButton}
          />
          <Button
            title="Review consent"
            onPress={handleSendSecurely}
            disabled={isSaving || isResolvingDraftId || !draftId}
            loading={isSaving || isResolvingDraftId}
            style={styles.sendButton}
          />
        </View>

        {/* Offline Indicator */}
        {isOffline && (
          <View style={{ alignItems: 'center', marginBottom: 24 }}>
            <Chip label="After consent, packet will queue until online" style={styles.offlineChip} />
          </View>
        )}
      </ScrollView>

      {/* Modals */}
      {renderRedactionPreviewModal()}
      {renderPacketPreviewModal()}
      {renderAliasEditorModal()}
    </Screen>
  );
}
