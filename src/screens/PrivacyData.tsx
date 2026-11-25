import React from 'react';
import { useState, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Alert,
  Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Screen from '../components/ui/Screen';
import Button from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { FeatureHeader, type FeatureHeaderStat } from '../components/ui/FeatureHeader';
import { Badge } from '../components/ui/Badge';
import { Label } from '../components/ui/Label';
import { Input } from '../components/ui/Input';
import { Checkbox } from '../components/ui/Checkbox';
import { RadioButton } from '../components/ui/RadioButton';
import { Alert as AlertBanner } from '../components/ui/Alert';
import { useTheme } from '../theme/SimpleThemeProvider';
import { useToast } from '../components/ui/Toast';
import { useNavigation } from '@react-navigation/native';
import { borders, elevation, radii, spacing, typography } from '../theme/tokens';
import {
  createLocalEncryptedBackup,
  LocalBackupError,
  LOCAL_BACKUP_INCLUDED_STORES,
  pickLocalEncryptedBackupFile,
  restoreLocalEncryptedBackupFromString,
} from '../utils/localEncryptedBackup';
import {
  createPrivacyDataExport,
  getPrivacyRetentionPreference,
  PrivacyDataShareResult,
  PrivacyDeleteFlowSnapshot,
  PrivacyRetentionPreference,
  PRIVACY_DATA_EXPORT_EXCLUDED_STORES,
  PRIVACY_DATA_EXPORT_INCLUDED_STORES,
  PRIVACY_DATA_DELETE_EXCLUDED_STORES,
  PRIVACY_DATA_DELETE_INCLUDED_STORES,
  privacyDeleteFlowController,
  savePrivacyRetentionPreference,
  sharePrivacyDataExportFile,
} from '../utils/privacyDataControls';
import { listPrivacyHistory, type PrivacyHistoryEntry } from '../utils/consentLedger';
import { fetchRightsRequests, type RightsRequest } from '../services/privacyRightsService';
import { RemoteConsentWithdrawalPendingError } from '../services/privacyConsentService';
import { withdrawConsentFromPrivacySettings } from '../services/partnerSharingService';
import { describeConsentEntry, selectPrivacyHistoryForDisplay } from '../utils/privacyHistoryDisplay';
import { captureMeasurementEvent } from '../lib/measurement/localEventStore';


export default function PrivacyData() {
  const navigation = useNavigation();
  const { colors } = useTheme();
  const toast = useToast();
  
  // State
  const [showBanner, setShowBanner] = useState(true);
  const [retention, setRetention] = useState<PrivacyRetentionPreference>('local-manual-v1');
  const [privacyHistory, setPrivacyHistory] = useState<PrivacyHistoryEntry[]>([]);
  const [rightsRequests, setRightsRequests] = useState<RightsRequest[]>([]);
  const [rightsHistoryStatus, setRightsHistoryStatus] = useState<'loading' | 'available' | 'unavailable'>('loading');
  const [backupPassphrase, setBackupPassphrase] = useState('');
  const [restorePassphrase, setRestorePassphrase] = useState('');
  const [pendingRestoreFile, setPendingRestoreFile] = useState<string | null>(null);
  const [pendingRestoreConflict, setPendingRestoreConflict] = useState<LocalBackupError | null>(null);
  const [showRestoreDialog, setShowRestoreDialog] = useState(false);
  const [includeMediaMetadata, setIncludeRawMedia] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  
  // Delete flow state
  const [showDeleteStep1, setShowDeleteStep1] = useState(false);
  const [showDeleteStep2, setShowDeleteStep2] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleteUnderstood, setDeleteUnderstood] = useState(false);
  const [deleteFlowSnapshot, setDeleteFlowSnapshot] = useState<PrivacyDeleteFlowSnapshot>(() => privacyDeleteFlowController.getSnapshot());
  const isDeleting = deleteFlowSnapshot.status === 'deleting';
  const isDeleteFlowActive = deleteFlowSnapshot.status === 'countdown' || deleteFlowSnapshot.status === 'deleting';
  const countdown = deleteFlowSnapshot.countdownRemaining;
  const showCountdown = deleteFlowSnapshot.status === 'countdown';

  const heroStats = useMemo<FeatureHeaderStat[]>(() => [
    {
      label: 'Retention',
      value: retention === 'local-manual-v1' ? 'Manual' : retention === 'local-30-days-v1' ? '30d' : '90d',
      icon: 'time-outline',
    },
    { label: 'Export stores', value: PRIVACY_DATA_EXPORT_INCLUDED_STORES.length, icon: 'download-outline' },
    { label: 'Backup stores', value: LOCAL_BACKUP_INCLUDED_STORES.length, icon: 'lock-closed-outline' },
  ], [retention]);

  useEffect(() => {
    let mounted = true;

    getPrivacyRetentionPreference()
      .then((preference) => {
        if (mounted) {
          setRetention(preference);
        }
      })
      .catch(() => {
        if (mounted) {
          setRetention('local-manual-v1');
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    listPrivacyHistory().then(setPrivacyHistory).catch(() => setPrivacyHistory([]));
    fetchRightsRequests()
      .then(requests => {
        setRightsRequests(requests);
        setRightsHistoryStatus('available');
      })
      .catch(() => setRightsHistoryStatus('unavailable'));
  }, []);

  useEffect(() => privacyDeleteFlowController.subscribe(setDeleteFlowSnapshot), []);

  useEffect(() => {
    if (deleteFlowSnapshot.status === 'completed') {
      const result = deleteFlowSnapshot.result;
      privacyDeleteFlowController.resetTerminalState();
      setDeleteConfirmText('');
      setDeleteUnderstood(false);

      const failures = result?.failures ?? [];
      const failureNote = failures.length > 0
        ? `\n\nSome local cleanup needs another attempt for: ${failures.join(', ')}. Please retry when you are ready.`
        : '';
      Alert.alert(
        "Local data deleted",
        "Cleared supported SafeRide local stores and app-managed files from this device. Remote records and files already shared outside SafeRide are not deleted." + failureNote,
        [{ text: 'OK', onPress: () => navigation.navigate('Splash' as never) }]
      );
      return;
    }

    if (deleteFlowSnapshot.status === 'failed') {
      privacyDeleteFlowController.resetTerminalState();
      Alert.alert(
        'Delete failed',
        'Unable to delete local SafeRide data. Please try again.'
      );
    }
  }, [deleteFlowSnapshot, navigation]);

  const handleRetentionChange = async (value: PrivacyRetentionPreference) => {
    const previous = retention;
    setRetention(value);
    const labels = {
      'local-30-days-v1': '30 days',
      'local-90-days-v1': '90 days',
      'local-manual-v1': 'Keep until you delete',
    };

    try {
      await savePrivacyRetentionPreference(value);
      toast.show({
        title: `Retention preference saved: ${labels[value]}.`,
        message: value === 'local-manual-v1'
          ? 'SafeRide will keep local data until you delete it.'
          : 'This automatic policy remains disabled until legal approval.',
        variant: 'info',
      });
    } catch (error) {
      setRetention(previous);
      toast.show({
        title: 'Could not save preference',
        message: (error as Error).message || 'Try again before relying on this setting.',
        variant: 'error',
      });
    }
  };

  const handleWithdrawConsent = (consentId: string) => {
    Alert.alert(
      'Withdraw future consent?',
      'This records a future-only withdrawal. It cannot recall information already shared outside SafeRide.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Withdraw',
          style: 'destructive',
          onPress: () => {
            // Also marks any report that used a partner consent as withdrawn.
            void withdrawConsentFromPrivacySettings(consentId)
              .then(() => toast.show({
                title: 'Consent withdrawn for future processing',
                message: 'Earlier external sharing cannot be recalled.',
                variant: 'info',
              }))
              .catch((error) => {
                if (error instanceof RemoteConsentWithdrawalPendingError) {
                  toast.show({
                    title: 'Local processing stopped',
                    message: 'Remote withdrawal is not confirmed. Reconnect and retry from consent history.',
                    variant: 'warning',
                  });
                  return;
                }
                toast.show({ title: 'Withdrawal not saved', message: 'Please try again.', variant: 'error' });
              })
              .finally(() => void listPrivacyHistory().then(setPrivacyHistory).catch(() => undefined));
          },
        },
      ],
    );
  };

  const showFileHandoffNotice = (
    kind: 'export' | 'backup',
    itemCount: number,
    shareResult: PrivacyDataShareResult,
  ) => {
    const itemLabel = itemCount + ' local data item' + (itemCount === 1 ? '' : 's');
    const subject = kind === 'backup'
      ? `Encrypted backup with ${itemLabel}`
      : `Scoped local JSON export with ${itemLabel}`;

    if (!shareResult.success) {
      toast.show({
        title: 'File saved locally',
        message: `${subject} was created in SafeRide local storage, but sharing did not open. Try again if you need to share it.`,
        variant: 'warning',
      });
      return;
    }

    if (shareResult.shared) {
      toast.show({
        title: kind === 'backup' ? 'Encrypted backup ready' : 'Export ready',
        message: `${subject} was created and handed to the selected share option.`,
        variant: 'success',
      });
      return;
    }

    if (shareResult.unavailable) {
      toast.show({
        title: 'File saved locally',
        message: `${subject} was created in SafeRide local storage. ${shareResult.unavailableReason ?? 'Sharing is not enabled on this device.'}`,
        variant: 'info',
      });
      return;
    }

    toast.show({
      title: 'File saved locally',
      message: `${subject} was created on this device. Sharing was canceled.`,
      variant: 'info',
    });
  };

  const getBackupErrorMessage = (error: unknown): string => {
    if (error instanceof LocalBackupError) {
      switch (error.code) {
        case 'wrong_passphrase':
          return 'The passphrase does not unlock this backup.';
        case 'corrupt_file':
          return 'The selected backup could not be verified. The file may be damaged.';
        case 'unsupported_version':
          return 'This backup was created by an unsupported SafeRide backup version.';
        case 'restore_conflict':
          return 'Restoring this backup would replace or remove local SafeRide data.';
        case 'empty_backup':
          return 'There is no local SafeRide data to back up on this device.';
        case 'file_cancelled':
          return 'No backup file was selected.';
        default:
          return error.message;
      }
    }

    return (error as Error).message || 'The backup action could not be completed.';
  };

  const resetRestoreFlow = () => {
    setShowRestoreDialog(false);
    setRestorePassphrase('');
    setPendingRestoreFile(null);
    setPendingRestoreConflict(null);
  };

  const handleBackupNow = async () => {
    setIsBackingUp(true);
    try {
      const result = await createLocalEncryptedBackup({ passphrase: backupPassphrase });
      setBackupPassphrase('');
      const shareResult = await sharePrivacyDataExportFile(result.filePath, 'SafeRide local encrypted backup');
      showFileHandoffNotice('backup', result.itemCount, shareResult);
    } catch (error) {
      toast.show({
        title: 'Backup failed',
        message: getBackupErrorMessage(error),
        variant: 'error',
      });
    } finally {
      setIsBackingUp(false);
    }
  };

  const handleRestoreBackup = () => {
    setPendingRestoreFile(null);
    setPendingRestoreConflict(null);
    setShowRestoreDialog(true);
  };

  const runRestore = async (conflictPolicy: 'fail-if-conflict' | 'replace' = 'fail-if-conflict') => {
    setIsRestoring(true);
    let rawFile = pendingRestoreFile;

    try {
      if (!rawFile) {
        rawFile = await pickLocalEncryptedBackupFile();
      }

      const result = await restoreLocalEncryptedBackupFromString(rawFile, {
        passphrase: restorePassphrase,
        conflictPolicy,
      });

      toast.show({
        title: 'Backup restored',
        message: 'Restored ' + result.restoredItemCount + ' local data item' + (result.restoredItemCount === 1 ? '' : 's') + '.',
        variant: 'success',
      });
      resetRestoreFlow();
    } catch (error) {
      if (error instanceof LocalBackupError && error.code === 'restore_conflict' && rawFile) {
        setPendingRestoreFile(rawFile);
        setPendingRestoreConflict(error);
        toast.show({
          title: 'Restore needs confirmation',
          message: 'Review the conflict warning before replacing local data.',
          variant: 'warning',
        });
        return;
      }

      if (error instanceof LocalBackupError && error.code === 'file_cancelled') {
        toast.show({ title: 'Restore cancelled', variant: 'info' });
        return;
      }

      toast.show({
        title: 'Restore failed',
        message: getBackupErrorMessage(error),
        variant: 'error',
      });
    } finally {
      setIsRestoring(false);
    }
  };

  const handleExport = async () => {
    captureMeasurementEvent({
      name: 'export_attempt',
      screenId: 'privacy-data',
      taskId: 'privacy-export',
      outcome: 'started',
    });
    setIsExporting(true);
    try {
      const result = await createPrivacyDataExport({
        includeMediaMetadata: includeMediaMetadata,
      });

      const shareResult = await sharePrivacyDataExportFile(result.filePath, 'SafeRide privacy data export');
      showFileHandoffNotice('export', result.itemCount, shareResult);
    } catch (error) {
      captureMeasurementEvent({
        name: 'error_outcome',
        screenId: 'privacy-data',
        taskId: 'privacy-export',
        outcome: 'failed',
        errorCode: 'storage_unavailable',
      });
      toast.show({
        title: 'Export failed',
        message: 'Unable to create the privacy export. Please try again.',
        variant: 'error',
      });
    } finally {
      setIsExporting(false);
    }
  };

  const handleDeleteStep1 = () => {
    if (!deleteUnderstood) {
      Alert.alert(
        "Confirmation required",
        "Please check the box to confirm you understand.",
        [{ text: 'OK' }]
      );
      return;
    }
    setShowDeleteStep1(false);
    setShowDeleteStep2(true);
  };

  const handleDeleteStep2 = () => {
    if (deleteConfirmText !== 'DELETE') {
      Alert.alert(
        "Type DELETE to confirm",
        "The text must match exactly.",
        [{ text: 'OK' }]
      );
      return;
    }
    
    const started = privacyDeleteFlowController.startCountdown();
    if (!started) {
      toast.show({
        title: 'Deletion already in progress',
        message: 'Use Undo before the countdown ends, or wait for local deletion to finish.',
        variant: 'info',
      });
      return;
    }

    setShowDeleteStep2(false);
  };

  const handleUndoDelete = () => {
    const canceled = privacyDeleteFlowController.cancelCountdown();
    if (!canceled) {
      toast.show({
        title: 'Deletion already started',
        message: 'Local deletion is already running and cannot be undone.',
        variant: 'warning',
      });
      return;
    }

    setDeleteConfirmText('');
    setDeleteUnderstood(false);
    toast.show({ title: 'Deletion canceled', variant: 'info' });
  };

  const resetDeleteFlow = () => {
    setShowDeleteStep1(false);
    setShowDeleteStep2(false);
    setDeleteConfirmText('');
    setDeleteUnderstood(false);
  };

  const styles = StyleSheet.create({
    content: {
      padding: spacing.md,
      gap: spacing.md,
    },
    card: {
      padding: spacing.md,
      shadowColor: colors.privacy,
    },
    bannerContent: {
      alignItems: 'flex-start',
    },
    bannerText: {
      ...typography.bodySmall,
      color: colors.foreground,
    },
    cardTitle: {
      ...typography.titleMedium,
      color: colors.foreground,
      marginBottom: 8,
    },
    cardDescription: {
      ...typography.bodySmall,
      color: colors.mutedForeground,
      marginBottom: spacing.md,
    },
    cardContent: {
      gap: spacing.md,
    },
    retentionOption: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      padding: 12,
      borderWidth: 1,
      borderColor: colors.input,
      borderRadius: radii.card,
      backgroundColor: colors.background,
    },
    retentionRadio: {
      marginRight: 12,
    },
    retentionOptionSelected: {
      borderColor: colors.primary,
      backgroundColor: colors.accent,
    },
    retentionLabel: {
      flex: 1,
    },
    retentionTitle: {
      ...typography.labelLarge,
      color: colors.foreground,
    },
    retentionSubtitle: {
      ...typography.bodySmall,
      color: colors.mutedForeground,
    },
    switchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      flexWrap: 'wrap',
    },
    switchLabel: {
      flex: 1,
      marginRight: 12,
    },
    actionButtons: {
      flexDirection: 'row',
      gap: 8,
      flexWrap: 'wrap',
    },
    settingsRow: {
      width: '100%',
      flexDirection: 'column',
      gap: 12,
    },
    settingsLabel: {
      alignSelf: 'flex-start',
    },
    frequencyButtons: {
      flexDirection: 'row',
      gap: 8,
      flexWrap: 'wrap',
      alignItems: 'flex-start',
    },
    encryptionButtons: {
      flexDirection: 'row',
      gap: 8,
      flexWrap: 'wrap',
      alignItems: 'flex-start',
    },
    passphraseRow: {
      flexDirection: 'row',
      gap: 8,
      flexWrap: 'wrap',
      alignItems: 'flex-start',
    },
    progressContainer: {
      gap: 8,
    },
    exportContent: {
      gap: 8,
    },
    exportList: {
      ...typography.bodySmall,
      color: colors.foreground,
    },
    dangerCard: {
      borderColor: colors.destructive,
      borderWidth: borders.emphasized,
    },
    dangerTitle: {
      color: colors.destructive,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    footer: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      paddingVertical: 16,
    },
    footerText: {
      ...typography.bodySmall,
      color: colors.mutedForeground,
    },
    modalOverlay: {
      flex: 1,
      backgroundColor: colors.scrim,
      justifyContent: 'center',
      alignItems: 'center',
    },
    modalContent: {
      backgroundColor: colors.surface,
      marginHorizontal: 24,
      borderColor: colors.divider,
      borderRadius: radii.card,
      borderWidth: borders.hairline,
      padding: spacing.lg,
      gap: spacing.md,
      overflow: 'hidden',
      position: 'relative',
      ...elevation.card,
    },
    modalTitle: {
      ...typography.titleSmall,
      color: colors.destructive,
    },
    modalDescription: {
      ...typography.bodyMedium,
      color: colors.mutedForeground,
    },
    deleteList: {
      gap: 4,
    },
    deleteListItem: {
      ...typography.bodySmall,
      color: colors.foreground,
    },
    checkboxRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    modalButtons: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
      justifyContent: 'flex-end',
    },
    countdownBar: {
      position: 'absolute',
      bottom: 16,
      left: 16,
      right: 16,
      backgroundColor: colors.destructive,
      padding: 16,
      borderRadius: 8,
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    countdownText: {
      flexShrink: 1,
      fontSize: 16,
      fontWeight: '500',
      color: colors.destructiveForeground,
    },
  });

  return (
    <Screen>

      <ScrollView style={{ flex: 1 }}>
        <View style={styles.content}>
          <FeatureHeader
            eyebrow="Local-first controls"
            title="Privacy & Data"
            description="Export, back up, restore, or delete supported SafeRide data with clear limits before anything leaves the device."
            icon="lock-closed-outline"
            tone="privacy"
            stats={heroStats}
          />

          {/* Trust Banner */}
          {showBanner && (
            <AlertBanner variant="info" dismissible onDismiss={() => setShowBanner(false)}>
              <View style={styles.bannerContent}>
                <Text style={styles.bannerText}>
                  Local-first. Nothing leaves your phone without consent.
                </Text>
                <Button variant="link" size="sm" title="Learn more" onPress={() => Alert.alert('Local-first privacy', 'SafeRide keeps drafts local unless you explicitly choose to export, share, or submit them through a consent step.')} />
              </View>
            </AlertBanner>
          )}

          {/* Retention */}
          <Card variant="elevated" style={styles.card}>
            <Text style={styles.cardTitle}>Retention</Text>
            <Text style={styles.cardDescription}>
              Only the manual policy is approved. Automatic policies stay disabled until legal review.
            </Text>
            <View style={styles.cardContent}>
              {[
                {id: 'local-30-days-v1' as const, title: '30 days', subtitle: 'Unavailable — pending legal approval', disabled: true},
                {id: 'local-90-days-v1' as const, title: '90 days', subtitle: 'Unavailable — pending legal approval', disabled: true},
                {id: 'local-manual-v1' as const, title: 'Keep until you delete', subtitle: 'Approved local policy', disabled: false},
              ].map((option) => (
                <Button
                  key={option.id}
                  variant="ghost"
                  disabled={option.disabled}
                  onPress={() => void handleRetentionChange(option.id)}
                  style={[
                    styles.retentionOption,
                    retention === option.id && styles.retentionOptionSelected
                  ]}
                >
                  <RadioButton
                    selected={retention === option.id}
                    onPress={() => { if (!option.disabled) void handleRetentionChange(option.id); }}
                    style={styles.retentionRadio}
                  />
                  <View style={styles.retentionLabel}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <Text style={styles.retentionTitle}>{option.title}</Text>
                      {option.disabled ? (
                        <Badge variant="secondary">Disabled</Badge>
                      ) : (
                        <Badge variant="warning">Warning</Badge>
                      )}
                    </View>
                    <Text style={styles.retentionSubtitle}>{option.subtitle}</Text>
                  </View>
                </Button>
              ))}
              
              {retention === 'local-manual-v1' && (
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
                  <Ionicons name="warning" size={16} color={colors.warning} style={{ marginTop: 2 }} />
                  <Text style={{ fontSize: 14, color: colors.warning }}>
                    Long retention increases risk. Consider exporting and deleting local case data when you no longer need it.
                  </Text>
                </View>
              )}
            </View>
          </Card>

          <Card variant="elevated" style={styles.card}>
            <Text style={styles.cardTitle}>Submitted-data rights</Text>
            <Text style={styles.cardDescription}>
              Access, export, correction, restriction, objection, and deletion intake is disabled pending legal process approval. Local export and local deletion remain available below.
            </Text>
            <View style={styles.cardContent}>
              {rightsHistoryStatus === 'loading' ? (
                <Text style={styles.retentionSubtitle}>Checking existing request status…</Text>
              ) : rightsHistoryStatus === 'unavailable' ? (
                <Text style={styles.retentionSubtitle}>No authenticated submitted-case request history is available on this device.</Text>
              ) : rightsRequests.length === 0 ? (
                <Text style={styles.retentionSubtitle}>No submitted-data rights requests.</Text>
              ) : rightsRequests.map(item => (
                <Text key={item.id} style={styles.retentionSubtitle}>
                  {item.requestType}: {item.status.replace(/_/g, ' ')} · target {item.dueAt.toLocaleDateString()}
                </Text>
              ))}
              <AlertBanner variant="warning">
                <Text style={{ color: colors.foreground }}>
                  SafeRide will not accept a remote request until identity verification, legal scope, response ownership, and the 30-day process are approved.
                </Text>
              </AlertBanner>
            </View>
          </Card>

          <Card variant="elevated" style={styles.card}>
            <Text style={styles.cardTitle}>Consent and policy history</Text>
            <Text style={styles.cardDescription}>
              Pathway choices are recorded separately from policy, analytics, research, training, and partner follow-up.
            </Text>
            <View style={styles.cardContent}>
              {privacyHistory.length === 0 ? (
                <Text style={styles.retentionSubtitle}>No local consent or policy-acceptance records yet.</Text>
              ) : selectPrivacyHistoryForDisplay(privacyHistory).map(entry => (
                <View key={entry.id} style={{ gap: 4 }}>
                  <Text style={styles.retentionSubtitle}>
                    {entry.recordType === 'consent'
                      ? describeConsentEntry(entry, date => date.toLocaleDateString())
                      : `${entry.documentType} ${entry.version}: accepted · ${new Date(entry.acceptedAt).toLocaleDateString()}`}
                  </Text>
                  {entry.recordType === 'consent' && (
                    entry.status === 'granted' || entry.remoteWithdrawalStatus === 'pending'
                  ) ? (
                    <Button
                      variant="outline"
                      size="sm"
                      title={entry.remoteWithdrawalStatus === 'pending'
                        ? 'Retry remote withdrawal'
                        : 'Withdraw for future processing'}
                      onPress={() => handleWithdrawConsent(entry.id)}
                    />
                  ) : null}
                </View>
              ))}
              <AlertBanner variant="info">
                <Text style={{ color: colors.foreground }}>
                  Privacy Policy and Terms are engineering drafts pending legal review, so policy acceptance is disabled.
                </Text>
              </AlertBanner>
            </View>
          </Card>

          {/* Local Encrypted Backup */}
          <Card variant="elevated" style={styles.card}>
            <Text style={styles.cardTitle}>Local encrypted backup</Text>
            <Text style={styles.cardDescription}>
              Create or restore an encrypted backup file stored only where you save it.
            </Text>
            <View style={styles.cardContent}>
              <AlertBanner variant="info">
                <Text style={{ color: colors.foreground }}>
                  Backup files are controlled by you. Store them somewhere private; SafeRide cannot recover a lost passphrase.
                </Text>
              </AlertBanner>

              <View style={styles.exportContent}>
                {LOCAL_BACKUP_INCLUDED_STORES.map((store) => (
                  <Text key={store} style={styles.exportList}>• {store}</Text>
                ))}
              </View>

              <View style={{ gap: 8 }}>
                <Label style={styles.settingsLabel}>Backup passphrase</Label>
                <Input
                  secureTextEntry
                  placeholder="Enter passphrase (8 characters or more)"
                  value={backupPassphrase}
                  onChangeText={setBackupPassphrase}
                />
                {backupPassphrase.length > 0 && backupPassphrase.length < 8 && (
                  <Text style={{ fontSize: 14, color: colors.warning }}>Use at least 8 characters.</Text>
                )}
              </View>

              <View style={styles.actionButtons}>
                <Button
                  onPress={handleBackupNow}
                  disabled={backupPassphrase.length < 8 || isBackingUp}
                  loading={isBackingUp}
                  style={{ flex: 1 }}
                  title={isBackingUp ? 'Backing up...' : 'Back up now'}
                />
                <Button
                  variant="outline"
                  onPress={handleRestoreBackup}
                  disabled={isRestoring}
                  style={{ flex: 1 }}
                  title="Restore from backup"
                />
              </View>

              <Text style={{ fontSize: 12, color: colors.mutedForeground }}>
                Restore checks the passphrase, backup version, file integrity, and local data conflicts before replacing anything. Not included: auth sessions, remote records, provider catalog caches, navigation state, or raw media file bytes.
              </Text>
            </View>
          </Card>

          {/* Export & Portability */}
          <Card variant="elevated" style={styles.card}>
            <Text style={styles.cardTitle}>Export my data</Text>
            <Text style={styles.cardDescription}>
              Create a local JSON export file you can keep or share yourself. It is not encrypted by SafeRide.
            </Text>
            <View style={styles.cardContent}>
              <View style={styles.exportContent}>
                {PRIVACY_DATA_EXPORT_INCLUDED_STORES.slice(0, 5).map((store) => (
                  <Text key={store} style={styles.exportList}>• {store}</Text>
                ))}
              </View>

              <AlertBanner variant="warning">
                <Text style={{ color: colors.foreground }}>
                  Not included: {PRIVACY_DATA_EXPORT_EXCLUDED_STORES.slice(0, 4).join('; ')}.
                </Text>
              </AlertBanner>

              <View style={styles.checkboxRow}>
                <Checkbox 
                  checked={includeMediaMetadata}
                  onCheckedChange={(checked) => setIncludeRawMedia(checked as boolean)}
                />
                <Label style={{ fontSize: 14 }}>
                  Include local media metadata and checksums when available
                </Label>
              </View>

              <Button onPress={handleExport} title={isExporting ? 'Exporting...' : 'Export'} loading={isExporting} />

              <Text style={{ fontSize: 12, color: colors.mutedForeground }}>
                The export file is created locally first. When sharing is available, SafeRide hands it to the selected share option. Android keeps this file in SafeRide local storage in this release. Use encrypted backup for protected local recovery.
              </Text>
            </View>
          </Card>

          {/* Danger Zone */}
          <Card variant="elevated" style={[styles.card, styles.dangerCard]}>
            <View style={styles.dangerTitle}>
              <Ionicons name="trash" size={20} color={colors.destructive} />
              <Text style={[styles.cardTitle, { color: colors.destructive, marginBottom: 0 }]}>
                Delete supported local data
              </Text>
            </View>
            <Text style={styles.cardDescription}>
              Removes supported SafeRide local stores and app-managed files from this device.
            </Text>
            <View style={styles.cardContent}>
              <Button 
                variant="destructive" 
                onPress={() => setShowDeleteStep1(true)}
                disabled={isDeleteFlowActive}
                title={isDeleting ? 'Deleting...' : showCountdown ? 'Deletion pending...' : 'Delete local data...'}
              />
              
              <Text style={{ fontSize: 12, color: colors.mutedForeground }}>
                This does not delete remote records, server audit logs, cloud evidence, OS clipboard contents, or files already shared outside SafeRide.
              </Text>
            </View>
          </Card>

          {/* Footer Note */}
          <View style={styles.footer}>
            <Ionicons name="shield-checkmark" size={16} color={colors.mutedForeground} />
            <Text style={styles.footerText}>
              You can export or delete supported local SafeRide data on this device.
            </Text>
          </View>
        </View>
      </ScrollView>

      {/* Restore Backup Modal */}
      <Modal
        visible={showRestoreDialog}
        transparent
        animationType="fade"
        onRequestClose={resetRestoreFlow}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>Restore encrypted backup</Text>
            <Text style={styles.modalDescription}>
              Choose a SafeRide backup file and enter its passphrase. Restore will stop if local data would be replaced.
            </Text>

            <View style={{ gap: 8 }}>
              <Label style={styles.settingsLabel}>Backup passphrase</Label>
              <Input
                secureTextEntry
                placeholder="Enter backup passphrase"
                value={restorePassphrase}
                onChangeText={setRestorePassphrase}
              />
            </View>

            {pendingRestoreConflict && (
              <AlertBanner variant="warning">
                <Text style={{ color: colors.foreground }}>
                  This backup would replace or remove {pendingRestoreConflict.conflicts.length} local data item{pendingRestoreConflict.conflicts.length === 1 ? '' : 's'} on this device. Continue only if you want the backup file to replace current local SafeRide data.
                </Text>
              </AlertBanner>
            )}

            <View style={styles.modalButtons}>
              <Button variant="outline" onPress={resetRestoreFlow} disabled={isRestoring} title="Cancel" />
              {pendingRestoreConflict ? (
                <Button
                  variant="destructive"
                  onPress={() => void runRestore('replace')}
                  disabled={restorePassphrase.length < 8 || isRestoring}
                  loading={isRestoring}
                  title={isRestoring ? 'Restoring...' : 'Replace local data'}
                />
              ) : (
                <Button
                  onPress={() => void runRestore()}
                  disabled={restorePassphrase.length < 8 || isRestoring}
                  loading={isRestoring}
                  title={isRestoring ? 'Restoring...' : 'Choose backup file'}
                />
              )}
            </View>
          </View>
        </View>
      </Modal>

      {/* Delete Step 1 Modal */}
      <Modal
        visible={showDeleteStep1}
        transparent
        animationType="fade"
        onRequestClose={resetDeleteFlow}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Delete supported local data?</Text>
            <Text style={styles.modalDescription}>
              This will remove supported local SafeRide data from this device:
            </Text>
            
            <View style={styles.deleteList}>
              {PRIVACY_DATA_DELETE_INCLUDED_STORES.slice(0, 5).map((store) => (
                <Text key={store} style={styles.deleteListItem}>• {store}</Text>
              ))}
            </View>

            <AlertBanner variant="warning">
              <Text style={{ color: colors.foreground }}>
                Not deleted: {PRIVACY_DATA_DELETE_EXCLUDED_STORES.slice(0, 3).join('; ')}.
              </Text>
            </AlertBanner>

            <View style={styles.checkboxRow}>
              <Checkbox 
                checked={deleteUnderstood}
                onCheckedChange={(checked) => setDeleteUnderstood(checked as boolean)}
              />
              <Label style={{ fontSize: 14 }}>
                I understand this deletes supported local SafeRide data on this device.
              </Label>
            </View>

            <View style={styles.modalButtons}>
              <Button variant="outline" onPress={resetDeleteFlow} title="Cancel" />
              <Button 
                variant="destructive" 
                onPress={handleDeleteStep1}
                disabled={!deleteUnderstood}
                title="Continue"
              />
            </View>
          </View>
        </View>
      </Modal>

      {/* Delete Step 2 Modal */}
      <Modal
        visible={showDeleteStep2}
        transparent
        animationType="fade"
        onRequestClose={resetDeleteFlow}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Type DELETE to confirm</Text>
            <Text style={styles.modalDescription}>
              This local deletion cannot be undone after the countdown.
            </Text>
            
            <View style={{ gap: 16 }}>
              <Input
                placeholder="Type DELETE in capital letters"
                value={deleteConfirmText}
                onChangeText={setDeleteConfirmText}
                style={{ fontFamily: 'monospace' }}
              />

              <View style={styles.modalButtons}>
                <Button variant="outline" onPress={resetDeleteFlow} title="Cancel" />
                <Button 
                  variant="destructive" 
                  onPress={handleDeleteStep2}
                  disabled={deleteConfirmText !== 'DELETE'}
                  title="Delete now"
                />
              </View>
            </View>
          </View>
        </View>
      </Modal>

      {/* Countdown Snackbar */}
      {showCountdown && (
        <View style={styles.countdownBar}>
          <Text style={styles.countdownText}>
            Deleting local data in {countdown}...
          </Text>
          <Button 
            variant="outline" 
            size="sm"
            onPress={handleUndoDelete}
            disabled={countdown === 0}
            style={{ backgroundColor: colors.background }}
            title="Undo"
          />
        </View>
      )}
    </Screen>
  );
}
