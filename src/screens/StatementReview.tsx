import React from 'react';
import { useState, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  TextInput,
  ActivityIndicator,
  Modal,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Crypto from 'expo-crypto';
import Screen from '../components/ui/Screen';
import Button from '../components/ui/Button';
import { Card, CardContent, CardDescription, CardTitle } from '../components/ui/Card';
import { FeatureHeader, type FeatureHeaderStat } from '../components/ui/FeatureHeader';
import { Badge } from '../components/ui/Badge';
import { useTheme } from '../theme/SimpleThemeProvider';
import { borders, elevation, radii, spacing, typography } from '../theme/tokens';
import { RootStackParamList } from '../navigation/routes';
import { useToast } from '../components/ui/Toast';
import { draftStorage, DraftData } from '../utils/draftStorage';
import {
  createStatementPdfExport,
  createStatementStructuredExport,
  getStatementExportShareNotice,
  shareStatementExportFile,
  StatementExportFormat,
} from '../utils/statementExport';
import {
  buildStatementReviewFromDraft,
  buildTranscriptSuggestions,
  countStatementWords,
  formatStatementTagLabel,
  getStatementReadingTime,
} from '../utils/statementReview';
import type { StatementReviewDraft } from '../utils/statementReview';

import { devPrivacyError, getPrivacySafeErrorReason } from '../utils/privacyLog';
type StatementReviewNavigationProp = NativeStackNavigationProp<RootStackParamList>;
type StatementReviewRouteProp = RouteProp<RootStackParamList, 'StatementReview'>;

interface ReviewHistory {
  id: string;
  action: 'loaded' | 'edited' | 'accepted' | 'closed' | 'exported';
  timestamp: string;
  note?: string;
}

function formatTimestamp(value?: Date): string {
  const date = value && !Number.isNaN(value.getTime()) ? value : new Date();
  return date.toLocaleString();
}

export default function StatementReviewScreen() {
  const navigation = useNavigation<StatementReviewNavigationProp>();
  const route = useRoute<StatementReviewRouteProp>();
  const { colors } = useTheme();
  const toast = useToast();
  const draftId = route.params?.draftId;

  const [draftData, setDraftData] = useState<DraftData | null>(null);
  const [statement, setStatement] = useState<StatementReviewDraft | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editedContent, setEditedContent] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [reviewHistory, setReviewHistory] = useState<ReviewHistory[]>([]);
  const [showSources, setShowSources] = useState(false);
  const [exportFormat, setExportFormat] = useState<'text' | StatementExportFormat>('text');
  const [isExporting, setIsExporting] = useState(false);
  const [showMaskedView, setShowMaskedView] = useState(false);
  const [showTranscriptPicker, setShowTranscriptPicker] = useState(false);
  const [transcriptSuggestions, setTranscriptSuggestions] = useState<string[]>([]);
  const [showVersionCompare, setShowVersionCompare] = useState(false);
  const [originalStatement, setOriginalStatement] = useState('');
  const [statementHash, setStatementHash] = useState('');
  const [isHashing, setIsHashing] = useState(false);
  const [hashError, setHashError] = useState<string | null>(null);
  const statementStats = useMemo<FeatureHeaderStat[]>(() => [
    { label: 'Words', value: statement?.wordCount ?? 0, icon: 'document-text-outline' },
    { label: 'Read time', value: statement ? `${statement.readingTime} min` : '0 min', icon: 'time-outline' },
    { label: 'Sources', value: statement?.sources.length ?? 0, icon: 'layers-outline' },
  ], [statement?.readingTime, statement?.sources.length, statement?.wordCount]);

  const styles = StyleSheet.create({
    container: {
      flex: 1,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: spacing.md,
      borderBottomWidth: borders.hairline,
      borderBottomColor: colors.divider,
    },
    headerTitle: {
      ...typography.titleMedium,
      color: colors.foreground,
    },
    loadingContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 24,
    },
    loadingText: {
      marginTop: 12,
      fontSize: 16,
      color: colors.mutedForeground,
      textAlign: 'center',
    },
    content: {
      flex: 1,
      padding: spacing.md,
    },
    heroSpacing: {
      marginBottom: spacing.md,
    },
    cardContentModern: {
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
    },
    statementCard: {
      marginBottom: spacing.md,
    },
    statementHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: spacing.sm,
      paddingBottom: spacing.sm,
      borderBottomWidth: borders.hairline,
      borderBottomColor: colors.divider,
    },
    statementTitle: {
      ...typography.titleSmall,
      color: colors.foreground,
    },
    statementContent: {
      ...typography.bodyMedium,
      color: colors.foreground,
      marginBottom: spacing.md,
    },
    editInput: {
      borderWidth: borders.hairline,
      borderColor: colors.divider,
      borderRadius: radii.input,
      padding: spacing.sm,
      ...typography.bodyMedium,
      color: colors.foreground,
      backgroundColor: colors.surfaceAlt,
      minHeight: 220,
      textAlignVertical: 'top',
      marginBottom: spacing.md,
    },
    metadataContainer: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
      marginBottom: spacing.md,
    },
    metadataItem: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
    },
    metadataText: {
      ...typography.caption,
      color: colors.mutedForeground,
    },
    tagsContainer: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
      marginBottom: spacing.md,
    },
    actionsContainer: {
      flexDirection: 'row',
      gap: spacing.xs,
      marginBottom: spacing.sm,
    },
    secondaryActions: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
      paddingTop: spacing.sm,
      borderTopWidth: borders.hairline,
      borderTopColor: colors.divider,
    },
    editActions: {
      flexDirection: 'row',
      gap: spacing.xs,
      marginBottom: spacing.md,
    },
    sourcesCard: {
      marginBottom: spacing.md,
    },
    sourcesHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: spacing.xs,
    },
    sourcesTitle: {
      ...typography.labelMedium,
      color: colors.foreground,
    },
    sourceItem: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      paddingVertical: spacing.xs,
      paddingHorizontal: spacing.xs,
      backgroundColor: colors.surfaceAlt,
      borderColor: colors.divider,
      borderRadius: radii.xs,
      borderWidth: borders.hairline,
      marginBottom: spacing.xxxs,
    },
    sourceText: {
      ...typography.caption,
      color: colors.foreground,
    },
    exportCard: {
      marginBottom: spacing.md,
    },
    exportHeader: {
      ...typography.labelMedium,
      color: colors.foreground,
      marginBottom: spacing.sm,
    },
    exportOptions: {
      flexDirection: 'row',
      gap: spacing.xs,
      marginBottom: spacing.sm,
    },
    exportOption: {
      flex: 1,
      padding: spacing.sm,
      borderRadius: radii.card,
      borderWidth: borders.hairline,
      borderColor: colors.divider,
      alignItems: 'center',
      gap: spacing.xxxs,
    },
    exportOptionSelected: {
      backgroundColor: colors.primaryMuted,
      borderColor: colors.primary,
    },
    exportOptionUnavailable: {
      opacity: 0.55,
    },
    exportOptionText: {
      ...typography.caption,
      color: colors.mutedForeground,
      fontWeight: '500',
    },
    exportOptionTextSelected: {
      color: colors.primary,
    },
    helperText: {
      ...typography.caption,
      color: colors.mutedForeground,
      marginTop: spacing.xs,
    },
    historyCard: {
      marginBottom: spacing.md,
    },
    historyHeader: {
      ...typography.labelMedium,
      color: colors.foreground,
      marginBottom: spacing.sm,
    },
    historyItem: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.xs,
      marginBottom: spacing.sm,
    },
    historyContent: {
      flex: 1,
    },
    historyAction: {
      ...typography.caption,
      fontWeight: '500',
      color: colors.foreground,
      textTransform: 'capitalize',
    },
    historyTimestamp: {
      ...typography.caption,
      color: colors.mutedForeground,
    },
    historyNote: {
      ...typography.caption,
      color: colors.mutedForeground,
      marginTop: 2,
    },
    finalActions: {
      flexDirection: 'row',
      gap: spacing.sm,
      marginTop: spacing.xs,
      paddingBottom: spacing.xxl,
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
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: spacing.md,
    },
    modalTitle: {
      ...typography.titleMedium,
      color: colors.foreground,
    },
    transcriptOption: {
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.md,
      marginBottom: spacing.xs,
      borderRadius: radii.card,
      borderWidth: borders.hairline,
      borderColor: colors.divider,
      backgroundColor: colors.surfaceAlt,
      overflow: 'hidden',
      position: 'relative',
    },
    compareBlock: {
      padding: spacing.sm,
      borderRadius: radii.card,
      backgroundColor: colors.surfaceAlt,
      borderLeftWidth: 3,
      marginBottom: spacing.lg,
    },
    compareLabel: {
      ...typography.labelMedium,
      color: colors.foreground,
      marginBottom: spacing.xs,
    },
    compareText: {
      ...typography.bodyS,
      color: colors.foreground,
    },
  });

  useEffect(() => {
    let isActive = true;

    const loadStatement = async () => {
      try {
        setIsLoading(true);
        if (!draftId) {
          setStatement(null);
          return;
        }

        const draft = await draftStorage.getDraft(draftId);
        if (!isActive) return;

        setDraftData(draft);
        if (!draft) {
          setStatement(null);
          setTranscriptSuggestions([]);
          return;
        }

        const nextStatement = buildStatementReviewFromDraft(draft);
        setStatement(nextStatement);
        setEditedContent(nextStatement?.content || '');
        setOriginalStatement(nextStatement?.content || '');
        setTranscriptSuggestions(buildTranscriptSuggestions(draft));
        setReviewHistory(
          nextStatement
            ? [{ id: 'loaded', action: 'loaded', timestamp: formatTimestamp(new Date()), note: 'Loaded from saved draft fields' }]
            : []
        );
      } catch (error) {
        devPrivacyError('statement draft load failed', { reason: getPrivacySafeErrorReason(error) });
        if (isActive) {
          setStatement(null);
          toast.show({ title: 'Statement unavailable', message: 'Unable to load this draft.', variant: 'error' });
        }
      } finally {
        if (isActive) setIsLoading(false);
      }
    };

    loadStatement();

    return () => {
      isActive = false;
    };
  }, [draftId, toast]);

  useEffect(() => {
    let isActive = true;

    const computeHash = async () => {
      if (!statement?.content) {
        if (isActive) {
          setStatementHash('');
          setHashError(null);
          setIsHashing(false);
        }
        return;
      }

      setIsHashing(true);
      setHashError(null);
      setStatementHash('');

      try {
        const digest = await Crypto.digestStringAsync(
          Crypto.CryptoDigestAlgorithm.SHA256,
          statement.content,
          { encoding: Crypto.CryptoEncoding.HEX }
        );
        if (isActive) setStatementHash(digest.toUpperCase());
      } catch (error) {
        devPrivacyError('statement hash generation failed', { reason: getPrivacySafeErrorReason(error) });
        if (isActive) {
          setHashError('Unable to compute hash');
          setStatementHash('');
        }
      } finally {
        if (isActive) setIsHashing(false);
      }
    };

    computeHash();

    return () => {
      isActive = false;
    };
  }, [statement?.content]);

  const addHistory = (action: ReviewHistory['action'], note?: string) => {
    setReviewHistory(current => [
      ...current,
      {
        id: Date.now().toString(),
        action,
        timestamp: formatTimestamp(new Date()),
        note,
      },
    ]);
  };

  const saveStatementToDraft = async (contentToSave: string) => {
    if (!draftData) {
      throw new Error('No draft is loaded.');
    }

    const wordCount = countStatementWords(contentToSave);
    const nextStatement: StatementReviewDraft = {
      ...(statement || {
        id: draftData.id,
        tags: [],
        sources: ['Saved draft fields'],
        timestamp: formatTimestamp(new Date()),
        isEdited: false,
        wordCount,
        readingTime: getStatementReadingTime(wordCount),
      }),
      content: contentToSave,
      isEdited: true,
      wordCount,
      readingTime: getStatementReadingTime(wordCount),
      timestamp: formatTimestamp(new Date()),
    };

    // Patch only the fields this screen owns. Spreading the mount-time
    // snapshot here previously overwrote data other screens saved meanwhile.
    const savedDraft = await draftStorage.saveDraft({
      id: draftData.id,
      textEvidence: contentToSave,
      currentStep: 'StatementReview',
    });
    setDraftData(savedDraft);
    setStatement(nextStatement);
    setEditedContent(contentToSave);
  };

  const handleEdit = () => {
    setEditedContent(statement?.content || '');
    setIsEditing(true);
  };

  const handleSaveEdit = async () => {
    const contentToSave = editedContent.trim();
    if (!contentToSave) {
      toast.show({ title: 'Statement is empty', variant: 'error' });
      return;
    }

    try {
      await saveStatementToDraft(contentToSave);
      setIsEditing(false);
      addHistory('edited', 'Manual edits saved to the draft');
      toast.show({ title: 'Statement saved', variant: 'success' });
    } catch (error) {
      toast.show({ title: 'Save failed', message: (error as Error).message, variant: 'error' });
    }
  };

  const handleCancelEdit = () => {
    setEditedContent(statement?.content || '');
    setIsEditing(false);
  };

  const acceptStatement = async () => {
    if (!statement) return;
    try {
      await saveStatementToDraft(statement.content);
      addHistory('accepted', 'Statement saved to the current draft');
      toast.show({ title: 'Statement saved', message: 'Saved to the current draft.', variant: 'success' });
      navigation.goBack();
    } catch (error) {
      toast.show({ title: 'Save failed', message: (error as Error).message, variant: 'error' });
    }
  };

  const handleAccept = () => {
    Alert.alert(
      'Save statement',
      'This statement will be saved to the current draft. It is not sent anywhere from this screen.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Save', onPress: () => { void acceptStatement(); } },
      ]
    );
  };

  const handleClose = () => {
    Alert.alert(
      'Close review',
      'Unsaved edits on this screen will be discarded. Your saved draft will remain unchanged.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Close', style: 'destructive', onPress: () => { addHistory('closed', 'Review closed without saving new edits'); navigation.goBack(); } },
      ]
    );
  };

  const handleExport = async () => {
    if (!statement) return;

    const hasUnsavedEdits = isEditing && editedContent.trim() !== statement.content.trim();
    if (hasUnsavedEdits) {
      Alert.alert(
        'Save changes before export',
        'Statement exports use the text saved in this draft. Save or cancel your edits before creating a file.'
      );
      return;
    }

    setIsExporting(true);
    try {
      if (exportFormat === 'text') {
        await Clipboard.setStringAsync(statement.content);
        addHistory('exported', 'Statement text copied to clipboard');
        toast.show({ title: 'Statement copied', message: 'Text copied to clipboard.', variant: 'success' });
        return;
      }

      if (!draftData) {
        Alert.alert('Export unavailable', 'No saved draft data is available for statement export.');
        return;
      }

      const result = exportFormat === 'pdf'
        ? await createStatementPdfExport(draftData)
        : await createStatementStructuredExport(draftData);

      if (!result.success || !result.filePath || !result.fileName) {
        toast.show({
          title: 'Export failed',
          message: result.error ?? 'Could not create the statement export. Please try again.',
          variant: 'error',
          duration: 4500,
        });
        return;
      }

      const formatLabel = exportFormat === 'pdf' ? 'PDF' : 'JSON';
      const shareResult = await shareStatementExportFile(
        result.filePath,
        `SafeRide statement ${formatLabel}`,
      );

      addHistory(
        'exported',
        shareResult.shared
          ? `${formatLabel} statement file saved locally and shared`
          : shareResult.unavailable
            ? `${formatLabel} statement file saved locally; sharing unavailable on this platform`
            : `${formatLabel} statement file saved locally`,
      );

      toast.show(getStatementExportShareNotice(formatLabel, result.fileName, shareResult));
    } catch (error) {
      toast.show({ title: 'Export failed', message: (error as Error).message, variant: 'error' });
    } finally {
      setIsExporting(false);
    }
  };


  const maskText = (text: string): string => {
    if (!showMaskedView) return text;

    return text
      .replace(/\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/g, '***')
      .replace(/\b\+?\d{9,}\b/g, '***')
      .replace(/\b[A-Z]{2,}\s?\d+[A-Z]?\b/g, '***');
  };

  const handleInsertFromTranscript = (text: string) => {
    const nextContent = (editedContent || statement?.content || '').trim();
    setEditedContent(nextContent ? nextContent + '\n\n' + text : text);
    setIsEditing(true);
    setShowTranscriptPicker(false);
    toast.show({ title: 'Transcript text inserted', variant: 'success' });
  };

  const handleAutoclean = () => {
    const source = (isEditing ? editedContent : statement?.content) || '';
    const cleanedContent = source
      .replace(/\s+/g, ' ')
      .replace(/([.!?])\s*([a-z])/g, (_match, punct, letter) => punct + ' ' + String(letter).toUpperCase())
      .trim();

    setEditedContent(cleanedContent);
    setIsEditing(true);
    toast.show({ title: 'Formatting cleaned', message: 'Review before saving.', variant: 'info' });
  };

  const handleCopyHash = async () => {
    if (isHashing) {
      Alert.alert('Hash generating', 'Please wait while we finish computing the SHA-256 hash.');
      return;
    }

    if (!statementHash) {
      Alert.alert('Hash unavailable', hashError ?? 'We could not compute a hash for this statement.');
      return;
    }

    try {
      await Clipboard.setStringAsync(statementHash);
      Alert.alert('Hash copied', 'SHA256: ' + statementHash + '\n\nThis has been copied to your clipboard for integrity verification.');
    } catch (error) {
      devPrivacyError('statement hash copy failed', { reason: getPrivacySafeErrorReason(error) });
      Alert.alert('Copy failed', 'Unable to copy the hash. Please try again.');
    }
  };

  const getActionIcon = (action: string) => {
    switch (action) {
      case 'loaded': return 'document-text-outline';
      case 'edited': return 'pencil-outline';
      case 'accepted': return 'checkmark-circle-outline';
      case 'closed': return 'close-circle-outline';
      case 'exported': return 'copy-outline';
      default: return 'time-outline';
    }
  };

  const exportButtonTitle = isExporting
    ? 'Exporting...'
    : exportFormat === 'text'
      ? 'Copy statement text'
      : exportFormat === 'pdf'
        ? 'Create PDF file'
        : 'Create JSON file';

  if (isLoading) {
    return (
      <Screen>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => navigation.goBack()}>
            <Ionicons name="arrow-back" size={24} color={colors.foreground} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Statement Review</Text>
          <View style={{ width: 24 }} />
        </View>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.loadingText}>Loading saved draft text...</Text>
        </View>
      </Screen>
    );
  }

  if (!statement) {
    return (
      <Screen>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => navigation.goBack()}>
            <Ionicons name="arrow-back" size={24} color={colors.foreground} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Statement Review</Text>
          <View style={{ width: 24 }} />
        </View>
        <View style={styles.loadingContainer}>
          <Ionicons name="document-text-outline" size={32} color={colors.mutedForeground} />
          <Text style={styles.loadingText}>No reviewable statement data is available yet.</Text>
          <Text style={[styles.helperText, { textAlign: 'center' }]}>Add incident details, evidence, transcript text, support selections, or notes before opening statement review.</Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Ionicons name="arrow-back" size={24} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Statement Review</Text>
        <TouchableOpacity onPress={() => Alert.alert('Help', 'Review text compiled from saved draft fields. This screen does not generate legal advice, certify the statement, or submit it anywhere.')}>
          <Ionicons name="help-circle-outline" size={24} color={colors.foreground} />
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
        <FeatureHeader
          eyebrow="Local statement"
          title="Statement review"
          description="Review, edit, mask, export, and verify the statement compiled from saved draft fields."
          icon="document-text-outline"
          tone="evidence"
          stats={statementStats}
          style={styles.heroSpacing}
        />

        <Card variant="elevated" style={styles.statementCard}>
          <CardContent style={styles.cardContentModern}>
            <View style={styles.statementHeader}>
              <Text style={styles.statementTitle}>Draft statement</Text>
              <Badge variant="secondary">From saved draft</Badge>
            </View>

            {isEditing ? (
              <View>
                <TextInput
                  style={styles.editInput}
                  value={editedContent}
                  onChangeText={setEditedContent}
                  multiline
                  placeholder="Edit your statement..."
                  placeholderTextColor={colors.mutedForeground}
                />
                <View style={styles.editActions}>
                  <Button title="Save Changes" onPress={handleSaveEdit} style={{ flex: 1 }} />
                  <Button title="Cancel" onPress={handleCancelEdit} variant="outline" style={{ flex: 1 }} />
                </View>
              </View>
            ) : (
              <View>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: colors.border }}>
                  <Text style={{ fontSize: 14, fontWeight: '500', color: colors.foreground }}>Statement content</Text>
                  <TouchableOpacity
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, backgroundColor: showMaskedView ? colors.primary + '20' : colors.muted }}
                    onPress={() => setShowMaskedView(!showMaskedView)}
                  >
                    <Ionicons name={showMaskedView ? 'eye-off-outline' : 'eye-outline'} size={14} color={showMaskedView ? colors.primary : colors.mutedForeground} />
                    <Text style={{ fontSize: 11, color: showMaskedView ? colors.primary : colors.mutedForeground }}>
                      {showMaskedView ? 'Masked' : 'Show masked'}
                    </Text>
                  </TouchableOpacity>
                </View>

                <Text style={styles.statementContent}>{maskText(statement.content)}</Text>

                <View style={styles.metadataContainer}>
                  <View style={styles.metadataItem}>
                    <Ionicons name="document-text-outline" size={14} color={colors.mutedForeground} />
                    <Text style={styles.metadataText}>{statement.wordCount} words</Text>
                  </View>
                  <View style={styles.metadataItem}>
                    <Ionicons name="time-outline" size={14} color={colors.mutedForeground} />
                    <Text style={styles.metadataText}>{statement.readingTime} min read</Text>
                  </View>
                  <View style={styles.metadataItem}>
                    <Ionicons name="calendar-outline" size={14} color={colors.mutedForeground} />
                    <Text style={styles.metadataText}>{statement.timestamp}</Text>
                  </View>
                </View>

                {statement.tags.length > 0 && (
                  <View style={styles.tagsContainer}>
                    {statement.tags.map(tag => (
                      <Badge key={tag} variant="outline">{formatStatementTagLabel(tag)}</Badge>
                    ))}
                    {statement.isEdited && <Badge variant="secondary">Edited</Badge>}
                  </View>
                )}

                <View style={styles.actionsContainer}>
                  <Button title="Edit Statement" onPress={handleEdit} variant="outline" style={{ flex: 1 }} />
                </View>

                <View style={styles.secondaryActions}>
                  <Button
                    title="Insert transcript"
                    variant="outline"
                    size="sm"
                    onPress={() => {
                      if (!transcriptSuggestions.length) {
                        Alert.alert('No transcript saved', 'This draft does not contain saved transcript text.');
                        return;
                      }
                      setShowTranscriptPicker(true);
                    }}
                  />
                  <Button title="Clean format" variant="outline" size="sm" onPress={handleAutoclean} />
                  <Button title="Compare" variant="outline" size="sm" onPress={() => setShowVersionCompare(true)} />
                </View>
              </View>
            )}
          </CardContent>
        </Card>

        <Card variant="elevated" style={styles.sourcesCard}>
          <CardContent style={styles.cardContentModern}>
            <TouchableOpacity style={styles.sourcesHeader} onPress={() => setShowSources(!showSources)}>
              <CardTitle variant="small" style={{ marginBottom: 0 }}>Sources used ({statement.sources.length})</CardTitle>
              <Ionicons name={showSources ? 'chevron-up-outline' : 'chevron-down-outline'} size={20} color={colors.foreground} />
            </TouchableOpacity>

            {showSources && (
              <View>
                {statement.sources.map(source => (
                  <View key={source} style={styles.sourceItem}>
                    <Ionicons name="document-outline" size={14} color={colors.mutedForeground} />
                    <Text style={styles.sourceText}>{source}</Text>
                  </View>
                ))}
              </View>
            )}
          </CardContent>
        </Card>

        <Card variant="elevated" style={styles.exportCard}>
          <CardContent style={styles.cardContentModern}>
            <View>
              <CardTitle variant="small">Export options</CardTitle>
              <CardDescription>Choose a local export format before opening share tools.</CardDescription>
            </View>
            <View style={styles.exportOptions}>
              {(['text', 'pdf', 'structured'] as const).map(format => {
                const label = format === 'structured' ? 'JSON' : format.toUpperCase();
                return (
                  <TouchableOpacity
                    key={format}
                    style={[styles.exportOption, exportFormat === format && styles.exportOptionSelected]}
                    onPress={() => setExportFormat(format)}
                  >
                    <Ionicons
                      name={format === 'text' ? 'document-text-outline' : format === 'pdf' ? 'document-outline' : 'code-outline'}
                      size={20}
                      color={exportFormat === format ? colors.primary : colors.mutedForeground}
                    />
                    <Text style={[styles.exportOptionText, exportFormat === format && styles.exportOptionTextSelected]}>{label}</Text>
                    {format === 'structured' && <Text style={styles.metadataText}>Structured</Text>}
                  </TouchableOpacity>
                );
              })}
            </View>

            <Button title={exportButtonTitle} onPress={handleExport} disabled={isExporting} loading={isExporting} />
            <Text style={styles.helperText}>PDF and JSON exports are generated locally from the saved draft statement and evidence metadata. Sharing opens only after the file is created.</Text>
          </CardContent>
        </Card>

        <Card variant="elevated" style={styles.exportCard}>
          <CardContent style={styles.cardContentModern}>
            <View>
              <CardTitle variant="small">Integrity verification</CardTitle>
              <CardDescription>Copy the hash when you need a reference for the displayed text.</CardDescription>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8, paddingVertical: 8, paddingHorizontal: 12, backgroundColor: colors.muted, borderRadius: 6 }}>
              <Ionicons name="shield-checkmark-outline" size={16} color={colors.primary} />
              <Text style={{ fontSize: 12, fontFamily: 'monospace', color: colors.foreground, flex: 1 }} numberOfLines={2}>
                SHA256: {isHashing ? 'Calculating...' : statementHash || (hashError ? 'Unavailable' : '')}
              </Text>
              <TouchableOpacity onPress={handleCopyHash}>
                <Ionicons name="copy-outline" size={16} color={colors.primary} />
              </TouchableOpacity>
            </View>
            <Text style={styles.helperText}>This hash is computed from the displayed statement text only. It does not certify legal accuracy.</Text>
          </CardContent>
        </Card>

        <Card variant="elevated" style={styles.historyCard}>
          <CardContent style={styles.cardContentModern}>
            <CardTitle variant="small">Review history</CardTitle>
            {reviewHistory.map(item => (
              <View key={item.id} style={styles.historyItem}>
                <Ionicons name={getActionIcon(item.action)} size={16} color={colors.mutedForeground} />
                <View style={styles.historyContent}>
                  <Text style={styles.historyAction}>{item.action}</Text>
                  <Text style={styles.historyTimestamp}>{item.timestamp}</Text>
                  {item.note && <Text style={styles.historyNote}>{item.note}</Text>}
                </View>
              </View>
            ))}
          </CardContent>
        </Card>

        <View style={styles.finalActions}>
          <Button title="Close" onPress={handleClose} variant="outline" style={{ flex: 1 }} />
          <Button title="Save Statement" onPress={handleAccept} style={{ flex: 2 }} />
        </View>
      </ScrollView>

      <Modal visible={showTranscriptPicker} transparent animationType="fade" onRequestClose={() => setShowTranscriptPicker(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Insert from transcript</Text>
              <TouchableOpacity onPress={() => setShowTranscriptPicker(false)}>
                <Ionicons name="close-outline" size={24} color={colors.foreground} />
              </TouchableOpacity>
            </View>
            <Text style={[styles.helperText, { marginBottom: 16 }]}>Select saved transcript text to add to the editable statement.</Text>
            <ScrollView style={{ maxHeight: 300 }}>
              {transcriptSuggestions.map(suggestion => (
                <TouchableOpacity key={suggestion} style={styles.transcriptOption} onPress={() => handleInsertFromTranscript(suggestion)}>
                  <Text style={{ fontSize: 14, color: colors.foreground, lineHeight: 20 }}>{suggestion}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal visible={showVersionCompare} transparent animationType="fade" onRequestClose={() => setShowVersionCompare(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Compare statement text</Text>
              <TouchableOpacity onPress={() => setShowVersionCompare(false)}>
                <Ionicons name="close-outline" size={24} color={colors.foreground} />
              </TouchableOpacity>
            </View>
            <ScrollView>
              <Text style={styles.compareLabel}>Original loaded text</Text>
              <View style={[styles.compareBlock, { borderLeftColor: colors.destructive }]}>
                <Text style={styles.compareText}>{originalStatement}</Text>
              </View>
              <Text style={styles.compareLabel}>Current text</Text>
              <View style={[styles.compareBlock, { borderLeftColor: colors.primary }]}>
                <Text style={styles.compareText}>{isEditing ? editedContent : statement.content}</Text>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </Screen>
  );
}
