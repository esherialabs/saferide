import React from 'react';
import { useState, useEffect, useMemo, useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView, Linking, TouchableOpacity, useWindowDimensions } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import Screen from '../components/ui/Screen';
import Button from '../components/ui/Button';
import { FeatureHeader, type FeatureHeaderStat } from '../components/ui/FeatureHeader';
import { Input } from '../components/ui/Input';
import { Badge } from '../components/ui/Badge';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '../components/ui/Sheet';
import { Chip } from '../components/ui/Chip';
import { useTheme } from '../theme/SimpleThemeProvider';
import { useToast } from '../components/ui/Toast';
import { useDebounce } from '../utils/performance';
import { getTips, getCatalogInfo, TipCard as CatalogTip } from '../lib/catalog';
import { useOnline } from '../context/OnlineProvider';
import { borders, elevation, radii, spacing, typography } from '../theme/tokens';

type TipCard = CatalogTip;
type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

interface FocusFilter {
  id: string;
  label: string;
  icon: IoniconName;
  categories?: string[];
  tags?: string[];
}

interface StartGuide {
  tipId: string;
  label: string;
  helper: string;
  icon: IoniconName;
  filterId: string;
}

const FOCUS_FILTERS: FocusFilter[] = [
  {
    id: 'urgent',
    label: 'Urgent',
    icon: 'time-outline',
    categories: ['Emergency contacts'],
    tags: ['time-sensitive', 'hotline', 'HIV-PEP', 'pregnancy-prevention', 'triage', 'same-day-care'],
  },
  {
    id: 'medical',
    label: 'Medical',
    icon: 'medkit-outline',
    categories: ['Medical care', 'Psychosocial'],
    tags: ['follow-up', 'testing', 'STIs', 'prophylaxis', 'counselling', 'aftercare', 'pregnancy', 'EC'],
  },
  {
    id: 'evidence',
    label: 'Evidence',
    icon: 'folder-open-outline',
    categories: ['Safety & evidence'],
    tags: ['evidence', 'documentation', 'checklist', 'forensics', 'screenshots', 'route-details'],
  },
  {
    id: 'reporting',
    label: 'Reporting',
    icon: 'document-text-outline',
    categories: ['Reporting', 'Legal process', 'Advocacy'],
    tags: ['reporting', 'police', 'P3', 'escalation', 'patient-rights', 'OB', 'transport-operator', 'witness-support'],
  },
  {
    id: 'rights',
    label: 'Rights',
    icon: 'shield-checkmark-outline',
    categories: ['Rights', 'Special populations'],
    tags: ['rights', 'consent', 'non-discrimination', 'accessibility', 'minors', 'interpretation', 'victim-rights'],
  },
  {
    id: 'privacy',
    label: 'Data',
    icon: 'lock-closed-outline',
    categories: ['Your data'],
    tags: ['privacy', 'digital-safety', 'data-minimization', 'data-rights', 'screenshots'],
  },
];

const START_HERE_GUIDES: StartGuide[] = [
  {
    tipId: '1',
    label: 'Care clock',
    helper: 'Time windows can affect PEP and emergency contraception options.',
    icon: 'time-outline',
    filterId: 'urgent',
  },
  {
    tipId: '2',
    label: '1195 support',
    helper: 'Keep the national GBV helpline steps close if referral support is needed.',
    icon: 'call-outline',
    filterId: 'urgent',
  },
  {
    tipId: '3',
    label: 'P3 and OB',
    helper: 'Review the document path before deciding what to report.',
    icon: 'document-text-outline',
    filterId: 'reporting',
  },
  {
    tipId: '4',
    label: 'Evidence care',
    helper: 'Simple handling notes can help preserve choices later.',
    icon: 'folder-open-outline',
    filterId: 'evidence',
  },
  {
    tipId: '6',
    label: 'Plain rights',
    helper: 'A short snapshot of consent, care, privacy, and representation.',
    icon: 'shield-checkmark-outline',
    filterId: 'rights',
  },
];

const initialCategories: string[] = [];
const NOTICE_AUTO_HIDE_MS = 7600;

function tipMatchesFilter(tip: TipCard, filter: FocusFilter): boolean {
  const normalizedTags = tip.tags.map(tag => tag.toLowerCase());
  const categoryMatch = filter.categories?.includes(tip.category) ?? false;
  const tagMatch =
    filter.tags?.some(tag => normalizedTags.includes(tag.toLowerCase())) ?? false;

  return categoryMatch || tagMatch;
}

function buildPreviewText(body: string, maxLength: number): { preview: string; truncated: boolean } {
  const normalized = body.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return { preview: normalized, truncated: false };
  }

  const clipped = normalized.slice(0, maxLength).replace(/\s+\S*$/, '').trim();
  return {
    preview: clipped || normalized.slice(0, maxLength).trim(),
    truncated: true,
  };
}

function formatCatalogDate(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export default function TipsRights() {
  const { colors } = useTheme();
  const toast = useToast();
  const { isOnline } = useOnline();
  const { width, height } = useWindowDimensions();

  const [searchQuery, setSearchQuery] = useState('');
  const [tips, setTips] = useState<TipCard[]>([]);
  const [categories, setCategories] = useState<string[]>(initialCategories);
  const [selectedFocus, setSelectedFocus] = useState<string | null>(null);
  const [savedItems, setSavedItems] = useState<string[]>([]);
  const [showSavedOnly, setShowSavedOnly] = useState(false);
  const [showOfflineBanner, setShowOfflineBanner] = useState(true);
  const [showGuidanceNotice, setShowGuidanceNotice] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [selectedTip, setSelectedTip] = useState<TipCard | null>(null);
  const [selectedSources, setSelectedSources] = useState<{ title: string; url: string }[]>([]);
  const [showSourcesSheet, setShowSourcesSheet] = useState(false);

  const debouncedQuery = useDebounce(searchQuery, 300);
  const startCardWidth = useMemo(() => Math.min(238, Math.max(214, width * 0.58)), [width]);
  const sheetMaxHeight = useMemo(() => Math.floor(height * 0.88), [height]);

  useEffect(() => {
    (async () => {
      try {
        const data = await getTips();
        setTips(data);
        setCategories(Array.from(new Set(data.map(tip => tip.category))));
        const info = await getCatalogInfo();
        setLastUpdated(info.tipsLastUpdated);
      } catch {
        setTips([]);
        setCategories([]);
      }
    })();
  }, []);

  useEffect(() => {
    if (!showGuidanceNotice) {
      return undefined;
    }

    const timeout = setTimeout(() => setShowGuidanceNotice(false), NOTICE_AUTO_HIDE_MS);
    return () => clearTimeout(timeout);
  }, [showGuidanceNotice]);

  useEffect(() => {
    if (isOnline || !showOfflineBanner) {
      return undefined;
    }

    const timeout = setTimeout(() => setShowOfflineBanner(false), NOTICE_AUTO_HIDE_MS);
    return () => clearTimeout(timeout);
  }, [isOnline, showOfflineBanner]);

  const activeFocusFilter = useMemo(
    () => FOCUS_FILTERS.find(filter => filter.id === selectedFocus) ?? null,
    [selectedFocus],
  );

  const filteredTips = useMemo(() => {
    let filtered = tips;

    if (debouncedQuery.trim()) {
      const query = debouncedQuery.toLowerCase();
      filtered = filtered.filter(tip => {
        const searchableText = [
          tip.title,
          tip.body,
          tip.category,
          ...tip.tags,
        ]
          .join(' ')
          .toLowerCase();

        return searchableText.includes(query);
      });
    }

    if (activeFocusFilter) {
      filtered = filtered.filter(tip => tipMatchesFilter(tip, activeFocusFilter));
    }

    if (showSavedOnly) {
      filtered = filtered.filter(tip => savedItems.includes(tip.id));
    }

    return filtered;
  }, [activeFocusFilter, debouncedQuery, savedItems, showSavedOnly, tips]);

  const filtersActive =
    debouncedQuery.trim().length > 0 || selectedFocus !== null || showSavedOnly;

  const startGuides = useMemo(
    () =>
      START_HERE_GUIDES.map(guide => ({
        guide,
        tip: tips.find(item => item.id === guide.tipId),
      })).filter((item): item is { guide: StartGuide; tip: TipCard } => Boolean(item.tip)),
    [tips],
  );

  const heroStats = useMemo<FeatureHeaderStat[]>(
    () => {
      const stats: FeatureHeaderStat[] = [
        { label: 'Guides', value: tips.length, icon: 'reader-outline' },
        { label: 'Topics', value: categories.length, icon: 'albums-outline' },
      ];

      if (savedItems.length > 0) {
        stats.push({ label: 'Saved', value: savedItems.length, icon: 'bookmark-outline' });
      }

      return stats;
    },
    [categories.length, savedItems.length, tips.length],
  );

  const catalogStatus = useMemo(() => {
    const formattedDate = formatCatalogDate(lastUpdated);
    if (formattedDate) {
      return `Catalog refreshed ${formattedDate}`;
    }

    return 'Bundled guide pack with source links';
  }, [lastUpdated]);

  const handleCopySteps = useCallback(
    async (steps: string[]) => {
      try {
        await Clipboard.setStringAsync(steps.join('\n'));
        toast.show({ title: 'Steps copied', variant: 'success' });
      } catch {
        toast.show({ title: "Couldn't copy to clipboard", variant: 'error' });
      }
    },
    [toast],
  );

  const handleSaveToggle = useCallback(
    (tipId: string) => {
      setSavedItems(prev => {
        const isSaved = prev.includes(tipId);
        const next = isSaved ? prev.filter(id => id !== tipId) : [...prev, tipId];

        toast.show({ title: isSaved ? 'Removed from saved' : 'Saved', variant: 'info' });

        return next;
      });
    },
    [toast],
  );

  const handleShowSources = useCallback((sources: { title: string; url: string }[]) => {
    setSelectedSources(sources);
    setShowSourcesSheet(true);
  }, []);

  const handleOpenTipDetail = useCallback((tip: TipCard) => {
    setSelectedTip(tip);
  }, []);

  const handleOpenSource = useCallback(
    (url: string) => {
      if (!url) {
        return;
      }

      Linking.openURL(url)
        .then(() => setShowSourcesSheet(false))
        .catch(() => {
          toast.show({
            title: 'Unable to open link',
            message: 'Check your connection and try again.',
            variant: 'error',
          });
        });
    },
    [toast],
  );

  const clearFilters = useCallback(() => {
    setSearchQuery('');
    setSelectedFocus(null);
    setShowSavedOnly(false);
  }, []);

  const getTipVisual = useCallback(
    (tip: TipCard) => {
      const tagSet = new Set(tip.tags.map(tag => tag.toLowerCase()));

      if (tagSet.has('time-sensitive')) {
        return {
          icon: 'time-outline' as IoniconName,
          color: colors.critical,
          background: colors.criticalMuted,
        };
      }

      if (tip.category === 'Medical care') {
        return {
          icon: 'medkit-outline' as IoniconName,
          color: colors.safety,
          background: colors.safetyMuted,
        };
      }

      if (tip.category === 'Emergency contacts') {
        return {
          icon: 'call-outline' as IoniconName,
          color: colors.support,
          background: colors.supportMuted,
        };
      }

      if (tip.category === 'Safety & evidence') {
        return {
          icon: 'folder-open-outline' as IoniconName,
          color: colors.evidence,
          background: colors.evidenceMuted,
        };
      }

      if (tip.category === 'Reporting' || tip.category === 'Legal process' || tip.category === 'Advocacy') {
        return {
          icon: 'document-text-outline' as IoniconName,
          color: colors.consent,
          background: colors.consentMuted,
        };
      }

      if (tip.category === 'Safety planning') {
        return {
          icon: 'map-outline' as IoniconName,
          color: colors.safety,
          background: colors.safetyMuted,
        };
      }

      if (tip.category === 'Rights' || tip.category === 'Special populations') {
        return {
          icon: 'shield-checkmark-outline' as IoniconName,
          color: colors.privacy,
          background: colors.privacyMuted,
        };
      }

      if (tip.category === 'Your data') {
        return {
          icon: 'lock-closed-outline' as IoniconName,
          color: colors.privacy,
          background: colors.privacyMuted,
        };
      }

      if (tip.category === 'Psychosocial') {
        return {
          icon: 'heart-outline' as IoniconName,
          color: colors.support,
          background: colors.supportMuted,
        };
      }

      return {
        icon: 'bulb-outline' as IoniconName,
        color: colors.primary,
        background: colors.primaryMuted,
      };
    },
    [colors],
  );

  const styles = StyleSheet.create({
    content: {
      gap: spacing.md,
      padding: spacing.md,
      paddingBottom: spacing.xxl,
    },
    heroActions: {
      alignItems: 'flex-start',
      gap: spacing.xs,
    },
    statusPill: {
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderColor: colors.divider,
      borderRadius: radii.chip,
      borderWidth: borders.hairline,
      flexDirection: 'row',
      gap: spacing.xs,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
    },
    statusPillText: {
      ...typography.caption,
      color: colors.textSecondary,
      fontWeight: '700',
    },
    noticeBanner: {
      alignItems: 'center',
      backgroundColor: colors.infoMuted,
      borderRadius: radii.card,
      flexDirection: 'row',
      gap: spacing.sm,
      overflow: 'hidden',
      padding: spacing.sm,
      position: 'relative',
    },
    noticeText: {
      ...typography.bodySmall,
      color: colors.textSecondary,
      flex: 1,
    },
    noticeDismiss: {
      alignItems: 'center',
      borderRadius: radii.round,
      height: 30,
      justifyContent: 'center',
      width: 30,
    },
    guidanceNotice: {
      alignItems: 'flex-start',
      backgroundColor: colors.surfaceAlt,
      borderRadius: radii.card,
      flexDirection: 'row',
      gap: spacing.sm,
      overflow: 'hidden',
      padding: spacing.sm,
      position: 'relative',
    },
    guidanceText: {
      ...typography.bodySmall,
      color: colors.textSecondary,
      flex: 1,
    },
    sectionHeader: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.sm,
      justifyContent: 'space-between',
    },
    sectionHeaderCopy: {
      flex: 1,
      minWidth: 0,
    },
    sectionTitle: {
      ...typography.titleSmall,
      color: colors.foreground,
    },
    sectionSubtitle: {
      ...typography.caption,
      color: colors.textSecondary,
      marginTop: spacing.xxxs,
    },
    sectionShell: {
      gap: spacing.sm,
    },
    horizontalScroller: {
      marginHorizontal: -spacing.sm,
    },
    carouselContent: {
      gap: spacing.sm,
      paddingHorizontal: spacing.sm,
      paddingRight: spacing.md,
    },
    startCard: {
      backgroundColor: colors.surface,
      borderColor: colors.divider,
      borderRadius: radii.card,
      borderWidth: borders.hairline,
      flexShrink: 0,
      gap: spacing.xs,
      padding: spacing.sm,
      paddingLeft: spacing.md,
      position: 'relative',
      overflow: 'hidden',
      ...elevation.card,
    },
    startTopLine: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.xs,
    },
    startIcon: {
      alignItems: 'center',
      borderRadius: radii.card,
      height: 30,
      justifyContent: 'center',
      width: 30,
    },
    startLabel: {
      ...typography.labelSmall,
      color: colors.textSecondary,
      textTransform: 'uppercase',
    },
    startTitle: {
      ...typography.titleSmall,
      color: colors.foreground,
    },
    startHelper: {
      ...typography.bodySmall,
      color: colors.textSecondary,
    },
    startActions: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
      marginTop: spacing.xs,
    },
    controlsPanel: {
      // Search and focus chips sit on the canvas under the title.
      gap: spacing.xs,
    },
    searchContainer: {
      position: 'relative',
    },
    searchField: {
      marginBottom: 0,
    },
    focusScroller: {
      marginHorizontal: 0,
    },
    focusChips: {
      flexDirection: 'row',
      gap: spacing.xs,
      paddingHorizontal: spacing.xs,
      paddingRight: spacing.md,
    },
    savedActionRow: {
      alignItems: 'center',
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
    },
    tipList: {
      gap: spacing.sm,
    },
    tipCard: {
      backgroundColor: colors.surface,
      borderColor: colors.divider,
      borderRadius: radii.card,
      borderWidth: borders.hairline,
      overflow: 'hidden',
      position: 'relative',
      ...elevation.card,
    },
    cardAccentLeft: {
      bottom: 0,
      left: 0,
      position: 'absolute',
      top: 0,
      width: 4,
    },
    tipRow: {
      alignItems: 'flex-start',
      paddingHorizontal: spacing.md,
      paddingLeft: spacing.lg,
      paddingVertical: spacing.sm,
    },
    tipMain: {
      flex: 1,
      minWidth: 0,
    },
    tipMetaRow: {
      alignItems: 'center',
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
      marginBottom: spacing.xxxs,
    },
    tipCategory: {
      ...typography.labelSmall,
      fontWeight: '800',
    },
    tipUpdated: {
      ...typography.caption,
      color: colors.textTertiary,
    },
    tipTitle: {
      ...typography.titleSmall,
      color: colors.foreground,
    },
    tipBody: {
      ...typography.bodySmall,
      color: colors.textSecondary,
      marginTop: spacing.xs,
    },
    tagRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xxxs,
      marginTop: spacing.sm,
    },
    actionButtons: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
      marginTop: spacing.sm,
    },
    actionButton: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.xxxs,
    },
    actionButtonText: {
      ...typography.caption,
      color: colors.foreground,
      fontWeight: '700',
    },
    linkButtonText: {
      ...typography.caption,
      color: colors.primary,
      fontWeight: '700',
    },
    inlineMoreText: {
      ...typography.bodySmall,
      color: colors.primary,
      fontWeight: '800',
    },
    sourcesButton: {
      height: 'auto',
      paddingHorizontal: 0,
    },
    emptyCard: {
      alignItems: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.xl,
    },
    emptyText: {
      ...typography.bodySmall,
      color: colors.mutedForeground,
      textAlign: 'center',
    },
    sourceRow: {
      alignItems: 'center',
      borderColor: colors.border,
      borderRadius: radii.card,
      borderWidth: borders.hairline,
      flexDirection: 'row',
      gap: spacing.sm,
      justifyContent: 'space-between',
      padding: spacing.sm,
    },
    sourceTitle: {
      ...typography.bodySmall,
      color: colors.foreground,
      flex: 1,
    },
    detailScroll: {
      flex: 1,
      minHeight: 0,
    },
    detailContent: {
      gap: spacing.md,
      paddingBottom: spacing.xl,
    },
    detailMetaRow: {
      alignItems: 'center',
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
    },
    detailBody: {
      ...typography.bodyMedium,
      color: colors.foreground,
      lineHeight: 22,
    },
    detailSection: {
      gap: spacing.xs,
    },
    detailSectionTitle: {
      ...typography.labelLarge,
      color: colors.foreground,
      fontWeight: '800',
    },
    detailStep: {
      ...typography.bodySmall,
      color: colors.textSecondary,
    },
    detailTags: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
    },
    detailActions: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
    },
    sheetHeaderRow: {
      alignItems: 'flex-start',
      flexDirection: 'row',
      gap: spacing.sm,
    },
    sheetHeaderCopy: {
      flex: 1,
      minWidth: 0,
    },
    sheetCloseButton: {
      alignItems: 'center',
      backgroundColor: colors.surfaceAlt,
      borderColor: colors.divider,
      borderRadius: radii.round,
      borderWidth: borders.hairline,
      height: 48,
      justifyContent: 'center',
      width: 48,
    },
  });

  return (
    <Screen>
      <ScrollView style={{ flex: 1 }}>
        <View style={styles.content}>
          <FeatureHeader
            eyebrow={isOnline ? 'Tips and rights' : 'Offline tips and rights'}
            title="Rights & next steps"
            description="Kenya-context guidance for care, reporting, evidence, contacts, and consent."
            icon="bulb-outline"
            tone="support"
            stats={heroStats}
          >
            <View style={styles.heroActions}>
              <View style={styles.statusPill}>
                <Ionicons
                  name={isOnline ? 'cloud-done-outline' : 'cloud-offline-outline'}
                  size={14}
                  color={colors.primary}
                />
                <Text style={styles.statusPillText}>{catalogStatus}</Text>
              </View>
            </View>
          </FeatureHeader>

          <View style={styles.controlsPanel}>

            <View style={styles.searchContainer}>
              <Input
                placeholder="Search guides"
                value={searchQuery}
                onChangeText={setSearchQuery}
                containerStyle={styles.searchField}
                startAdornment={<Ionicons accessible={false} name="search" size={18} color={colors.mutedForeground} />}
                endAdornment={searchQuery ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    style={{ minWidth: 48 }}
                    onPress={() => setSearchQuery('')}
                    accessibilityLabel="Clear guide search"
                  >
                    <Ionicons accessible={false} name="close" size={18} color={colors.mutedForeground} />
                  </Button>
                ) : undefined}
              />
            </View>

            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.focusScroller}
              contentContainerStyle={styles.focusChips}
            >
              {FOCUS_FILTERS.map(filter => (
                <Chip
                  key={filter.id}
                  label={filter.label}
                  leadingIcon={filter.icon}
                  selected={selectedFocus === filter.id}
                  onPress={() =>
                    setSelectedFocus(current => (current === filter.id ? null : filter.id))
                  }
                />
              ))}
            </ScrollView>

            {savedItems.length > 0 || filtersActive ? (
              <View style={styles.savedActionRow}>
                {savedItems.length > 0 ? (
                  <Button
                    variant={showSavedOnly ? 'secondary' : 'outline'}
                    size="xs"
                    onPress={() => setShowSavedOnly(current => !current)}
                  >
                    <View style={styles.actionButton}>
                      <Ionicons
                        name={showSavedOnly ? 'bookmark' : 'bookmark-outline'}
                        size={13}
                        color={colors.foreground}
                      />
                      <Text style={styles.actionButtonText}>
                        {showSavedOnly ? 'Showing saved' : `Saved (${savedItems.length})`}
                      </Text>
                    </View>
                  </Button>
                ) : null}

                {filtersActive ? (
                  <Button
                    variant="link"
                    size="xs"
                    onPress={clearFilters}
                    style={styles.sourcesButton}
                    title="Clear filters"
                  />
                ) : null}
              </View>
            ) : null}

          </View>

          {!isOnline && showOfflineBanner ? (
            <View style={styles.noticeBanner}>
              <Ionicons name="cloud-offline-outline" size={18} color={colors.info} />
              <Text style={styles.noticeText}>
                Saved tips remain available offline. Source links may need data.
              </Text>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Dismiss offline note"
                onPress={() => setShowOfflineBanner(false)}
                style={styles.noticeDismiss}
              >
                <Ionicons name="close" size={18} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>
          ) : null}

          {showGuidanceNotice ? (
            <View style={styles.guidanceNotice}>
              <Ionicons name="information-circle-outline" size={18} color={colors.primary} />
              <Text style={styles.guidanceText}>
                General information only. SafeRide does not give legal, medical, counselling, or emergency-response advice; you choose what to use.
              </Text>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Dismiss guidance note"
                onPress={() => setShowGuidanceNotice(false)}
                style={styles.noticeDismiss}
              >
                <Ionicons name="close" size={18} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>
          ) : null}

          {!filtersActive && startGuides.length > 0 ? (
            <View style={styles.sectionShell}>
              <View style={styles.sectionHeader}>
                <View style={styles.sectionHeaderCopy}>
                  <Text style={styles.sectionTitle}>Start here</Text>
                  <Text style={styles.sectionSubtitle}>
                    Priority guide cards before the full library.
                  </Text>
                </View>
                <Badge variant="secondary">{startGuides.length} priority</Badge>
              </View>

              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.horizontalScroller}
                contentContainerStyle={styles.carouselContent}
              >
                {startGuides.map(({ guide, tip }) => {
                  const visual = getTipVisual(tip);
                  const helperPreview = buildPreviewText(guide.helper, 88);

                  return (
                    <TouchableOpacity
                      key={guide.tipId}
                      accessibilityRole="button"
                      accessibilityLabel={`Open ${tip.title}`}
                      activeOpacity={0.82}
                      onPress={() => handleOpenTipDetail(tip)}
                      style={[styles.startCard, { width: startCardWidth }]}
                    >
                      <View
                        pointerEvents="none"
                        style={[styles.cardAccentLeft, { backgroundColor: visual.color }]}
                      />
                      <View style={styles.startTopLine}>
                        <View
                          style={[
                            styles.startIcon,
                            { backgroundColor: visual.background },
                          ]}
                        >
                          <Ionicons name={guide.icon} size={18} color={visual.color} />
                        </View>
                        <Text style={styles.startLabel}>{guide.label}</Text>
                      </View>

                      <Text style={styles.startTitle} numberOfLines={2}>
                        {tip.title}
                      </Text>
                      <Text style={styles.startHelper}>
                        {helperPreview.preview}
                        {helperPreview.truncated ? (
                          <Text style={styles.inlineMoreText} onPress={() => handleOpenTipDetail(tip)}>
                            ... More
                          </Text>
                        ) : null}
                      </Text>

                      <View style={styles.startActions}>
                        {tip.hasCopySteps && tip.copySteps ? (
                          <Button
                            variant="outline"
                            size="xs"
                            onPress={() => handleCopySteps(tip.copySteps!)}
                          >
                            <View style={styles.actionButton}>
                              <Ionicons name="copy-outline" size={13} color={colors.foreground} />
                              <Text style={styles.actionButtonText}>Copy</Text>
                            </View>
                          </Button>
                        ) : tip.sources?.length ? (
                          <Button
                            variant="outline"
                            size="xs"
                            onPress={() => handleShowSources(tip.sources!)}
                          >
                            <View style={styles.actionButton}>
                              <Ionicons name="open-outline" size={13} color={colors.foreground} />
                              <Text style={styles.actionButtonText}>Sources</Text>
                            </View>
                          </Button>
                        ) : null}

                        <Button
                          variant="link"
                          size="xs"
                          onPress={() => setSelectedFocus(guide.filterId)}
                        >
                          <View style={styles.actionButton}>
                            <Ionicons name="filter-outline" size={13} color={colors.primary} />
                            <Text style={styles.linkButtonText}>Related</Text>
                          </View>
                        </Button>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>
          ) : null}

          <View style={styles.sectionShell}>
            <View style={styles.sectionHeader}>
              <View style={styles.sectionHeaderCopy}>
                <Text style={styles.sectionTitle}>
                  {showSavedOnly ? 'Saved guides' : 'Guide library'}
                </Text>
                <Text style={styles.sectionSubtitle}>
                  Browse guides; filter above.
                </Text>
              </View>
              <Badge variant="secondary">{filteredTips.length}</Badge>
            </View>

            {filteredTips.length === 0 ? (
              <View style={styles.emptyCard}>
                <Text style={styles.emptyText}>
                  No matching tips found. Clear filters or try another term.
                </Text>
                <Button variant="outline" onPress={clearFilters} title="Clear filters" />
              </View>
            ) : (
              <View style={styles.tipList}>
                {filteredTips.map(tip => {
                  const visual = getTipVisual(tip);
                  const bodyPreview = buildPreviewText(tip.body, 165);
                  const visibleTags = tip.tags.slice(0, 4);

                  return (
                    <TouchableOpacity
                      key={tip.id}
                      accessibilityRole="button"
                      accessibilityLabel={`Open ${tip.title}`}
                      activeOpacity={0.82}
                      onPress={() => handleOpenTipDetail(tip)}
                      style={styles.tipCard}
                    >
                      <View
                        pointerEvents="none"
                        style={[styles.cardAccentLeft, { backgroundColor: visual.color }]}
                      />

                      <View style={styles.tipRow}>
                        <View style={styles.tipMain}>
                          <View style={styles.tipMetaRow}>
                            <Text style={[styles.tipCategory, { color: visual.color }]}>
                              {tip.category}
                            </Text>
                            <Text style={styles.tipUpdated}>Updated {tip.updated}</Text>
                          </View>

                          <Text style={styles.tipTitle} numberOfLines={2}>
                            {tip.title}
                          </Text>
                          <Text style={styles.tipBody}>
                            {bodyPreview.preview}
                            {bodyPreview.truncated ? (
                              <Text style={styles.inlineMoreText} onPress={() => handleOpenTipDetail(tip)}>
                                ... More
                              </Text>
                            ) : null}
                          </Text>

                          {visibleTags.length > 0 ? (
                            <View style={styles.tagRow}>
                              {visibleTags.map(tag => (
                                <Badge key={tag} variant="secondary">
                                  {tag}
                                </Badge>
                              ))}
                              {tip.tags.length > visibleTags.length ? (
                                <Badge variant="secondary">
                                  +{tip.tags.length - visibleTags.length}
                                </Badge>
                              ) : null}
                            </View>
                          ) : null}

                          <View style={styles.actionButtons}>
                            {tip.hasCopySteps && tip.copySteps ? (
                              <Button
                                variant="outline"
                                size="xs"
                                onPress={() => handleCopySteps(tip.copySteps!)}
                              >
                                <View style={styles.actionButton}>
                                  <Text style={styles.actionButtonText}>Copy steps</Text>
                                </View>
                              </Button>
                            ) : null}

                            <Button
                              variant="outline"
                              size="xs"
                              onPress={() => handleSaveToggle(tip.id)}
                            >
                              <View style={styles.actionButton}>
                                <Text style={styles.actionButtonText}>
                                  {savedItems.includes(tip.id) ? 'Saved' : 'Save'}
                                </Text>
                              </View>
                            </Button>

                            {tip.sources && tip.sources.length > 0 ? (
                              <Button
                                variant="link"
                                size="xs"
                                onPress={() => handleShowSources(tip.sources!)}
                                style={styles.sourcesButton}
                              >
                                <View style={styles.actionButton}>
                                  <Text style={styles.linkButtonText}>Sources</Text>
                                </View>
                              </Button>
                            ) : null}

                          </View>
                        </View>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
          </View>
        </View>
      </ScrollView>

      <Sheet
        open={Boolean(selectedTip)}
        onOpenChange={open => {
          if (!open) {
            setSelectedTip(null);
          }
        }}
      >
        <SheetContent
          snapPoints={[1]}
          initialSnapPoint={0}
          style={{ height: sheetMaxHeight, maxHeight: sheetMaxHeight }}
        >
          {selectedTip ? (
            <ScrollView
              style={styles.detailScroll}
              contentContainerStyle={styles.detailContent}
              showsVerticalScrollIndicator
            >
              <View style={styles.sheetHeaderRow}>
                <SheetHeader style={styles.sheetHeaderCopy}>
                  <SheetTitle>{selectedTip.title}</SheetTitle>
                  <SheetDescription>
                    {selectedTip.category} - Updated {selectedTip.updated}
                  </SheetDescription>
                </SheetHeader>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Close guide details"
                  activeOpacity={0.75}
                  onPress={() => setSelectedTip(null)}
                  style={styles.sheetCloseButton}
                >
                  <Ionicons name="close" size={20} color={colors.textSecondary} />
                </TouchableOpacity>
              </View>

              <View style={styles.detailMetaRow}>
                <Badge variant="secondary">{selectedTip.category}</Badge>
                <Badge variant="secondary">Updated {selectedTip.updated}</Badge>
              </View>

              <Text style={styles.detailBody}>{selectedTip.body}</Text>

              {selectedTip.tags.length > 0 ? (
                <View style={styles.detailSection}>
                  <Text style={styles.detailSectionTitle}>Topics</Text>
                  <View style={styles.detailTags}>
                    {selectedTip.tags.map(tag => (
                      <Badge key={tag} variant="secondary">
                        {tag}
                      </Badge>
                    ))}
                  </View>
                </View>
              ) : null}

              {selectedTip.hasCopySteps && selectedTip.copySteps?.length ? (
                <View style={styles.detailSection}>
                  <Text style={styles.detailSectionTitle}>Steps</Text>
                  {selectedTip.copySteps.map((step, index) => (
                    <Text key={`${selectedTip.id}_step_${index}`} style={styles.detailStep}>
                      {index + 1}. {step}
                    </Text>
                  ))}
                </View>
              ) : null}

              <View style={styles.detailActions}>
                {selectedTip.hasCopySteps && selectedTip.copySteps ? (
                  <Button
                    variant="outline"
                    size="xs"
                    onPress={() => handleCopySteps(selectedTip.copySteps!)}
                    title="Copy steps"
                  />
                ) : null}

                <Button
                  variant="outline"
                  size="xs"
                  onPress={() => handleSaveToggle(selectedTip.id)}
                  title={savedItems.includes(selectedTip.id) ? 'Saved' : 'Save'}
                />

                {selectedTip.sources?.length ? (
                  <Button
                    variant="link"
                    size="xs"
                    onPress={() => {
                      const sources = selectedTip.sources ?? [];
                      setSelectedTip(null);
                      handleShowSources(sources);
                    }}
                    style={styles.sourcesButton}
                    title="Sources"
                  />
                ) : null}

                <Button
                  variant="outline"
                  size="xs"
                  onPress={() => setSelectedTip(null)}
                  title="Close"
                />
              </View>
            </ScrollView>
          ) : null}
        </SheetContent>
      </Sheet>

      <Sheet open={showSourcesSheet} onOpenChange={setShowSourcesSheet}>
        <SheetContent snapPoints={[1]} style={{ height: sheetMaxHeight, maxHeight: sheetMaxHeight }}>
          <ScrollView
            style={styles.detailScroll}
            contentContainerStyle={styles.detailContent}
            showsVerticalScrollIndicator
          >
            <View style={styles.sheetHeaderRow}>
              <SheetHeader style={styles.sheetHeaderCopy}>
                <SheetTitle>Sources</SheetTitle>
                <SheetDescription>Referenced materials attached to this guide.</SheetDescription>
              </SheetHeader>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Close sources"
                activeOpacity={0.75}
                onPress={() => setShowSourcesSheet(false)}
                style={styles.sheetCloseButton}
              >
                <Ionicons name="close" size={20} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>

            <View style={{ gap: 12, marginTop: 16 }}>
              {selectedSources.map((source, index) => (
                <View key={`${source.title}_${index}`} style={styles.sourceRow}>
                  <Text style={styles.sourceTitle}>{source.title}</Text>
                  <Button
                    variant="outline"
                    size="xs"
                    onPress={() => handleOpenSource(source.url)}
                  >
                    <View style={styles.actionButton}>
                      <Ionicons name="open-outline" size={13} color={colors.foreground} />
                      <Text style={styles.actionButtonText}>View</Text>
                    </View>
                  </Button>
                </View>
              ))}
              <View style={styles.detailActions}>
                <Button
                  variant="outline"
                  size="xs"
                  onPress={() => setShowSourcesSheet(false)}
                  title="Close"
                />
              </View>
            </View>
          </ScrollView>
        </SheetContent>
      </Sheet>
    </Screen>
  );
}
