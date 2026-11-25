import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Card } from '../components/ui/Card';
import Button from '../components/ui/Button';
import { Chip } from '../components/ui/Chip';
import { FeatureHeader, type FeatureHeaderStat } from '../components/ui/FeatureHeader';
import { Input } from '../components/ui/Input';
import Screen from '../components/ui/Screen';
import {
  COMMUNITY_LEARNING_ENTRIES,
  SAFERIDE_LEARNING_ENTRIES,
  type LearningEntry,
  type LearningEntryFormat,
} from '../data/learningLibrary';
import { useToast } from '../components/ui/Toast';
import { useTheme } from '../theme/SimpleThemeProvider';
import { borders, elevation, radii, spacing, typography } from '../theme/tokens';

type ContentSource = 'community' | 'saferide';
type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

const SOURCE_OPTIONS: Array<{
  value: ContentSource;
  label: string;
  icon: IoniconName;
}> = [
  { value: 'community', label: 'Community', icon: 'library-outline' },
  { value: 'saferide', label: 'SafeRide', icon: 'shield-checkmark-outline' },
];

const FORMAT_ICONS: Record<LearningEntryFormat, IoniconName> = {
  Video: 'play-circle-outline',
  Guide: 'reader-outline',
  Toolkit: 'construct-outline',
  Report: 'document-text-outline',
  Service: 'heart-circle-outline',
  Policy: 'library-outline',
  Law: 'shield-checkmark-outline',
  Article: 'newspaper-outline',
  App: 'phone-portrait-outline',
};

const FORMAT_ORDER: LearningEntryFormat[] = [
  'Video',
  'Service',
  'Guide',
  'Toolkit',
  'Report',
  'Policy',
  'Law',
  'Article',
  'App',
];

function formatDuration(totalSeconds?: number): string | null {
  if (totalSeconds === undefined) {
    return null;
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  if (minutes > 0) {
    return `${minutes} min`;
  }

  return `${totalSeconds}s`;
}

function getEntryUrl(entry: LearningEntry): string | null {
  if (entry.youtubeId) {
    return `https://www.youtube.com/watch?v=${entry.youtubeId}`;
  }

  return entry.url ?? null;
}

function getActionLabel(entry: LearningEntry): string {
  if (entry.format === 'Video') {
    return 'Watch';
  }

  if (entry.format === 'App') {
    return 'Get app';
  }

  return 'Open';
}

export default function LearnScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [selectedFormat, setSelectedFormat] = useState<LearningEntryFormat | null>(
    null,
  );
  const [contentSource, setContentSource] = useState<ContentSource>('community');

  const activeEntries = useMemo(
    () =>
      contentSource === 'saferide'
        ? SAFERIDE_LEARNING_ENTRIES
        : COMMUNITY_LEARNING_ENTRIES,
    [contentSource],
  );

  const categories = useMemo(
    () => Array.from(new Set(activeEntries.map(entry => entry.category))).sort(),
    [activeEntries],
  );

  const formats = useMemo(() => {
    const activeFormats = new Set(activeEntries.map(entry => entry.format));
    return FORMAT_ORDER.filter(format => activeFormats.has(format));
  }, [activeEntries]);

  const filteredEntries = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    return activeEntries.filter(entry => {
      const searchableText = [
        entry.title,
        entry.description,
        entry.category,
        entry.format,
        entry.source,
        entry.region,
        ...entry.tags,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      const matchesQuery = query.length === 0 || searchableText.includes(query);
      const matchesCategory =
        !selectedCategory || entry.category === selectedCategory;
      const matchesFormat = !selectedFormat || entry.format === selectedFormat;

      return matchesQuery && matchesCategory && matchesFormat;
    });
  }, [activeEntries, searchQuery, selectedCategory, selectedFormat]);

  const filtersActive =
    searchQuery.trim().length > 0 ||
    selectedCategory !== null ||
    selectedFormat !== null;

  const featuredEntries = useMemo(
    () =>
      contentSource === 'community' && !filtersActive
        ? activeEntries.filter(entry => entry.featured).slice(0, 8)
        : [],
    [activeEntries, contentSource, filtersActive],
  );

  const visibleEntries = useMemo(() => {
    if (featuredEntries.length === 0) {
      return filteredEntries;
    }

    const featuredIds = new Set(featuredEntries.map(entry => entry.id));
    return filteredEntries.filter(entry => !featuredIds.has(entry.id));
  }, [featuredEntries, filteredEntries]);

  const videoCount = useMemo(
    () => activeEntries.filter(entry => entry.format === 'Video').length,
    [activeEntries],
  );

  const heroStats = useMemo<FeatureHeaderStat[]>(
    () => [
      { label: 'Videos', value: videoCount, icon: 'play-circle-outline' },
      { label: 'Topics', value: categories.length, icon: 'albums-outline' },
    ],
    [categories.length, videoCount],
  );

  useEffect(() => {
    setSelectedCategory(null);
    setSelectedFormat(null);
  }, [contentSource]);

  const clearFilters = useCallback(() => {
    setSelectedCategory(null);
    setSelectedFormat(null);
    setSearchQuery('');
  }, []);

  const handleOpenEntry = useCallback(
    async (entry: LearningEntry) => {
      const url = getEntryUrl(entry);
      if (!url) {
        toast.show({
          title: 'Resource unavailable',
          message: 'No link has been attached to this item yet.',
          variant: 'error',
        });
        return;
      }

      try {
        const supported = await Linking.canOpenURL(url);
        if (!supported) {
          console.warn(
            'Linking.canOpenURL returned false for learning URL; attempting to open anyway.',
          );
        }
        await Linking.openURL(url);
      } catch (error) {
        console.warn('Failed to open learning resource', error);
        toast.show({
          title: 'Unable to open resource',
          message:
            error instanceof Error ? error.message : 'Please try again later.',
          variant: 'error',
        });
      }
    },
    [toast],
  );

  const styles = useMemo(
    () =>
      StyleSheet.create({
        content: {
          gap: spacing.md,
          padding: spacing.md,
          paddingBottom: spacing.xxl,
        },
        controlsPanel: {
          // Controls sit on the canvas under the title, not in a boxed panel.
          gap: spacing.sm,
        },
        sourceSegment: {
          backgroundColor: colors.surfaceAlt,
          borderRadius: radii.round,
          flexDirection: 'row',
          gap: spacing.xxxs,
          padding: spacing.xxxs,
        },
        sourceOption: {
          alignItems: 'center',
          borderRadius: radii.round,
          flex: 1,
          justifyContent: 'center',
          minHeight: 44,
          paddingHorizontal: spacing.xs,
          paddingVertical: spacing.xxxs,
        },
        sourceOptionActive: {
          backgroundColor: colors.primary,
        },
        sourceOptionPressed: {
          backgroundColor: colors.chipPressedOverlay,
        },
        sourceOptionRow: {
          alignItems: 'center',
          flexDirection: 'row',
          gap: spacing.xs,
          justifyContent: 'center',
          minWidth: 0,
        },
        sourceOptionLabel: {
          ...typography.labelMedium,
          flexShrink: 1,
        },
        searchContainer: {
          marginBottom: 0,
        },
        filterGroup: {
          gap: spacing.xxxs,
        },
        filterLabelRow: {
          alignItems: 'center',
          flexDirection: 'row',
          gap: spacing.xs,
        },
        filterLabel: {
          ...typography.labelMedium,
          color: colors.textSecondary,
        },
        chipScrollContent: {
          gap: spacing.xs,
          paddingRight: spacing.md,
        },
        resultSummaryRow: {
          alignItems: 'center',
          flexDirection: 'row',
          gap: spacing.sm,
          justifyContent: 'space-between',
        },
        resultSummary: {
          ...typography.bodyS,
          color: colors.textSecondary,
          flex: 1,
        },
        clearButton: {
          alignItems: 'center',
          flexDirection: 'row',
          gap: spacing.xxxs,
          minHeight: 48,
          paddingHorizontal: spacing.xs,
        },
        clearButtonText: {
          ...typography.labelMedium,
          color: colors.primary,
        },
        featuredPanel: {
          gap: spacing.xs,
        },
        sectionHeader: {
          alignItems: 'center',
          flexDirection: 'row',
          gap: spacing.sm,
          justifyContent: 'space-between',
          paddingTop: spacing.xxxs,
        },
        sectionTitleRow: {
          alignItems: 'center',
          flex: 1,
          flexDirection: 'row',
          gap: spacing.sm,
          minWidth: 0,
        },
        sectionIconBox: {
          alignItems: 'center',
          backgroundColor: colors.supportMuted,
          borderRadius: radii.round,
          height: 32,
          justifyContent: 'center',
          width: 32,
        },
        sectionTitleCopy: {
          flex: 1,
          minWidth: 0,
        },
        sectionTitle: {
          ...typography.titleMedium,
          color: colors.foreground,
        },
        sectionMeta: {
          ...typography.caption,
          color: colors.textSecondary,
          flexShrink: 1,
        },
        featuredScrollContent: {
          gap: spacing.sm,
          paddingRight: spacing.md,
        },
        featuredCard: {
          backgroundColor: colors.surfaceAlt,
          borderColor: colors.divider,
          borderRadius: radii.card,
          borderWidth: borders.hairline,
          minHeight: 184,
          overflow: 'hidden',
          width: 220,
        },
        featuredCardPressed: {
          opacity: 0.86,
        },
        featuredMedia: {
          alignItems: 'center',
          backgroundColor: colors.supportMuted,
          height: 82,
          justifyContent: 'center',
          overflow: 'hidden',
          position: 'relative',
        },
        featuredThumbnail: {
          height: '100%',
          width: '100%',
        },
        featuredMediaScrim: {
          backgroundColor: '#00000033',
          bottom: 0,
          left: 0,
          position: 'absolute',
          right: 0,
          top: 0,
        },
        featuredPlayButton: {
          alignItems: 'center',
          backgroundColor: '#00000099',
          borderRadius: radii.round,
          height: 34,
          justifyContent: 'center',
          width: 34,
        },
        featuredIconBox: {
          alignItems: 'center',
          backgroundColor: colors.surface,
          borderColor: colors.divider,
          borderRadius: radii.card,
          borderWidth: borders.hairline,
          height: 48,
          justifyContent: 'center',
          width: 48,
        },
        featuredBadge: {
          alignItems: 'center',
          backgroundColor: colors.surface,
          borderColor: colors.divider,
          borderRadius: radii.badge,
          borderWidth: borders.hairline,
          flexDirection: 'row',
          gap: spacing.xxxs,
          left: spacing.xs,
          paddingHorizontal: spacing.xs,
          paddingVertical: spacing.xxxs,
          position: 'absolute',
          top: spacing.xs,
        },
        featuredBody: {
          gap: spacing.xs,
          padding: spacing.sm,
        },
        featuredFormat: {
          ...typography.caption,
          color: colors.textSecondary,
          fontWeight: '700',
          textTransform: 'uppercase',
        },
        featuredTitle: {
          ...typography.titleSmall,
          color: colors.foreground,
        },
        featuredDescription: {
          ...typography.bodyS,
          color: colors.textSecondary,
        },
        featuredFooter: {
          alignItems: 'center',
          flexDirection: 'row',
          gap: spacing.xs,
          marginTop: 'auto',
        },
        featuredSource: {
          ...typography.caption,
          color: colors.textSecondary,
          flex: 1,
        },
        list: {
          gap: spacing.sm,
        },
        entryCard: {
          shadowColor: colors.primary,
        },
        entrySurface: {
          borderColor: colors.divider,
        },
        entryRow: {
          alignItems: 'center',
          flexDirection: 'row',
          gap: spacing.md,
          padding: spacing.md,
        },
        videoEntry: {
          gap: spacing.none,
        },
        videoMediaBanner: {
          backgroundColor: colors.surfaceAlt,
          height: 132,
          overflow: 'hidden',
          position: 'relative',
        },
        videoMediaImage: {
          height: '100%',
          width: '100%',
        },
        videoMediaOverlay: {
          alignItems: 'center',
          backgroundColor: '#00000099',
          borderRadius: radii.round,
          bottom: spacing.sm,
          flexDirection: 'row',
          gap: spacing.xs,
          paddingHorizontal: spacing.sm,
          paddingVertical: spacing.xs,
          position: 'absolute',
          right: spacing.sm,
        },
        videoMediaOverlayText: {
          ...typography.caption,
          color: '#FFFFFF',
          fontWeight: '700',
        },
        videoContent: {
          gap: spacing.xs,
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.sm,
        },
        videoTitleRow: {
          alignItems: 'flex-start',
          flexDirection: 'row',
          gap: spacing.sm,
        },
        videoTitleCopy: {
          flex: 1,
          gap: spacing.xxxs,
          minWidth: 0,
        },
        videoDescription: {
          ...typography.bodyS,
          color: colors.textSecondary,
        },
        videoMetaFooter: {
          alignItems: 'center',
          flexDirection: 'row',
          gap: spacing.xs,
        },
        videoMetaPills: {
          alignItems: 'center',
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: spacing.xs,
        },
        mediaTile: {
          alignItems: 'center',
          backgroundColor: colors.surfaceAlt,
          borderColor: colors.divider,
          borderRadius: radii.card,
          borderWidth: borders.hairline,
          height: 78,
          justifyContent: 'center',
          overflow: 'hidden',
          width: 92,
        },
        thumbnail: {
          height: '100%',
          width: '100%',
        },
        playOverlay: {
          alignItems: 'center',
          backgroundColor: '#00000099',
          borderRadius: radii.round,
          bottom: spacing.xs,
          height: 28,
          justifyContent: 'center',
          position: 'absolute',
          right: spacing.xs,
          width: 28,
        },
        mediaFormatText: {
          ...typography.caption,
          color: colors.textSecondary,
          fontWeight: '700',
          marginTop: spacing.xs,
          textAlign: 'center',
        },
        entryBody: {
          flex: 1,
          gap: spacing.xs,
          minWidth: 0,
        },
        entryKicker: {
          ...typography.caption,
          color: colors.textSecondary,
          fontWeight: '700',
          textTransform: 'uppercase',
        },
        entryTitle: {
          ...typography.titleSmall,
          color: colors.foreground,
        },
        entryDescription: {
          ...typography.bodyS,
          color: colors.textSecondary,
        },
        entryMetaRow: {
          alignItems: 'center',
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: spacing.xs,
        },
        metaPill: {
          alignItems: 'center',
          backgroundColor: colors.surfaceAlt,
          borderColor: colors.divider,
          borderRadius: radii.badge,
          borderWidth: borders.hairline,
          flexDirection: 'row',
          gap: spacing.xxxs,
          maxWidth: '100%',
          paddingHorizontal: spacing.xs,
          paddingVertical: spacing.xxxs,
        },
        metaText: {
          ...typography.caption,
          color: colors.textSecondary,
          fontWeight: '600',
        },
        sourceLine: {
          ...typography.caption,
          color: colors.textTertiary,
        },
        entryAction: {
          alignItems: 'center',
          gap: spacing.xxxs,
          justifyContent: 'center',
          width: 28,
        },
        entryActionText: {
          ...typography.caption,
          color: colors.primary,
          fontWeight: '700',
        },
        emptyState: {
          alignItems: 'center',
          gap: spacing.md,
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.xxl,
        },
        emptyIcon: {
          alignItems: 'center',
          backgroundColor: colors.surfaceAlt,
          borderColor: colors.divider,
          borderRadius: radii.round,
          borderWidth: borders.hairline,
          height: 64,
          justifyContent: 'center',
          width: 64,
        },
        emptyText: {
          ...typography.bodyM,
          color: colors.textSecondary,
          textAlign: 'center',
        },
      }),
    [colors],
  );

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <FeatureHeader
          eyebrow={contentSource === 'community' ? 'Community library' : 'SafeRide guides'}
          title="Learn"
          description="Videos, rights, reporting, transport safety, and first-hour decisions."
          icon={contentSource === 'community' ? 'library-outline' : 'play-circle-outline'}
          tone={contentSource === 'community' ? 'support' : 'consent'}
          stats={heroStats}
        />

        <View style={styles.controlsPanel}>

          <View style={styles.sourceSegment}>
            {SOURCE_OPTIONS.map(option => {
              const isActive = contentSource === option.value;
              return (
                <Pressable
                  key={option.value}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isActive }}
                  onPress={() => setContentSource(option.value)}
                  style={({ pressed }) => [
                    styles.sourceOption,
                    isActive ? styles.sourceOptionActive : null,
                    pressed ? styles.sourceOptionPressed : null,
                  ]}
                >
                  <View style={styles.sourceOptionRow}>
                    <Ionicons
                      name={option.icon}
                      size={18}
                      color={isActive ? colors.primaryForeground : colors.textSecondary}
                    />
                    <Text
                      style={[
                        styles.sourceOptionLabel,
                        { color: isActive ? colors.primaryForeground : colors.textSecondary },
                      ]}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.86}
                    >
                      {option.label}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>

          <Input
            placeholder="Search topics, providers, videos"
            value={searchQuery}
            onChangeText={setSearchQuery}
            containerStyle={styles.searchContainer}
            startAdornment={
              <Ionicons
                name="search-outline"
                size={20}
                color={colors.textSecondary}
              />
            }
            endAdornment={
              searchQuery.length > 0 ? (
                <Ionicons
                  name="close-circle"
                  size={20}
                  color={colors.textTertiary}
                  onPress={() => setSearchQuery('')}
                />
              ) : undefined
            }
          />

          {formats.length > 1 ? (
            <View style={styles.filterGroup}>
              <View style={styles.filterLabelRow}>
                <Ionicons
                  name="grid-outline"
                  size={16}
                  color={colors.textSecondary}
                />
                <Text style={styles.filterLabel}>Types</Text>
              </View>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.chipScrollContent}
              >
                <Chip
                  label="All types"
                  selected={selectedFormat === null}
                  leadingIcon={selectedFormat === null ? 'checkmark' : undefined}
                  onPress={() => setSelectedFormat(null)}
                />
                {formats.map(format => (
                  <Chip
                    key={format}
                    label={format}
                    leadingIcon={FORMAT_ICONS[format]}
                    selected={selectedFormat === format}
                    onPress={() =>
                      setSelectedFormat(prev => (prev === format ? null : format))
                    }
                  />
                ))}
              </ScrollView>
            </View>
          ) : null}

          {categories.length > 1 ? (
            <View style={styles.filterGroup}>
              <View style={styles.filterLabelRow}>
                <Ionicons
                  name="albums-outline"
                  size={16}
                  color={colors.textSecondary}
                />
                <Text style={styles.filterLabel}>Topics</Text>
              </View>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.chipScrollContent}
              >
                <Chip
                  label="All topics"
                  selected={selectedCategory === null}
                  leadingIcon={selectedCategory === null ? 'checkmark' : undefined}
                  onPress={() => setSelectedCategory(null)}
                />
                {categories.map(category => (
                  <Chip
                    key={category}
                    label={category}
                    selected={selectedCategory === category}
                    onPress={() =>
                      setSelectedCategory(prev =>
                        prev === category ? null : category,
                      )
                    }
                  />
                ))}
              </ScrollView>
            </View>
          ) : null}

          <View style={styles.resultSummaryRow}>
            <Text style={styles.resultSummary} numberOfLines={1}>
              Showing {filteredEntries.length} of {activeEntries.length}
            </Text>
            {filtersActive ? (
              <Pressable
                accessibilityRole="button"
                onPress={clearFilters}
                style={styles.clearButton}
              >
                <Ionicons name="close" size={16} color={colors.primary} />
                <Text style={styles.clearButtonText}>Clear</Text>
              </Pressable>
            ) : null}
          </View>
        </View>

        {featuredEntries.length > 0 ? (
          <View style={styles.featuredPanel}>
            <View style={styles.sectionHeader}>
              <View style={styles.sectionTitleRow}>
                <View style={styles.sectionIconBox}>
                  <Ionicons
                    name="sparkles-outline"
                    size={20}
                    color={colors.support}
                  />
                </View>
                <View style={styles.sectionTitleCopy}>
                  <Text style={styles.sectionTitle}>Start here</Text>
                  <Text style={styles.sectionMeta} numberOfLines={1}>
                    Reviewed picks
                  </Text>
                </View>
              </View>
            </View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.featuredScrollContent}
            >
              {featuredEntries.map(entry => {
                const icon = FORMAT_ICONS[entry.format];
                const youtubeThumbnail = entry.youtubeId
                  ? `https://img.youtube.com/vi/${entry.youtubeId}/hqdefault.jpg`
                  : null;
                const visualUrl = youtubeThumbnail ?? entry.imageUrl ?? null;
                return (
                  <Pressable
                    key={entry.id}
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${entry.title}`}
                    onPress={() => handleOpenEntry(entry)}
                    style={({ pressed }) => [
                      styles.featuredCard,
                      pressed ? styles.featuredCardPressed : null,
                    ]}
                  >
                    <View style={styles.featuredMedia}>
                      {visualUrl ? (
                        <>
                          <Image
                            source={{ uri: visualUrl }}
                            style={styles.featuredThumbnail}
                            resizeMode="cover"
                          />
                          {youtubeThumbnail ? (
                            <>
                              <View pointerEvents="none" style={styles.featuredMediaScrim} />
                              <View style={styles.featuredPlayButton}>
                                <Ionicons name="play" size={16} color="#FFFFFF" />
                              </View>
                            </>
                          ) : null}
                        </>
                      ) : (
                        <View style={styles.featuredIconBox}>
                          <Ionicons name={icon} size={24} color={colors.support} />
                        </View>
                      )}
                      <View style={styles.featuredBadge}>
                        <Ionicons
                          name={icon}
                          size={13}
                          color={colors.textSecondary}
                        />
                        <Text style={styles.featuredFormat} numberOfLines={1}>
                          {entry.format}
                        </Text>
                      </View>
                    </View>

                    <View style={styles.featuredBody}>
                      <Text style={styles.featuredTitle} numberOfLines={2}>
                        {entry.title}
                      </Text>
                      <Text style={styles.featuredDescription} numberOfLines={1}>
                        {entry.description}
                      </Text>
                      <View style={styles.featuredFooter}>
                        <Text style={styles.featuredSource} numberOfLines={1}>
                          {entry.source}
                        </Text>
                        <Text style={styles.entryActionText}>
                          {getActionLabel(entry)}
                        </Text>
                        <Ionicons
                          name="open-outline"
                          size={16}
                          color={colors.primary}
                        />
                      </View>
                    </View>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        ) : null}

        {filteredEntries.length === 0 ? (
          <View style={styles.emptyState}>
            <View style={styles.emptyIcon}>
              <Ionicons
                name="search-outline"
                size={30}
                color={colors.textTertiary}
              />
            </View>
            <Text style={styles.emptyText}>
              No resources match those filters.
            </Text>
            <Button
              title="Clear filters"
              onPress={clearFilters}
              variant="secondary"
            />
          </View>
        ) : (
          <View style={styles.list}>
            {visibleEntries.map(entry => {
              const youtubeThumbnail = entry.youtubeId
                ? `https://img.youtube.com/vi/${entry.youtubeId}/hqdefault.jpg`
                : null;
              const visualUrl = youtubeThumbnail ?? entry.imageUrl ?? null;
              const durationLabel = formatDuration(entry.durationSeconds);
              const formatIcon = FORMAT_ICONS[entry.format];
              const isVideo = entry.format === 'Video' && youtubeThumbnail !== null;

              return (
                <Card
                  key={entry.id}
                  accessibilityLabel={`Open ${entry.title}`}
                  onPress={() => handleOpenEntry(entry)}
                  style={styles.entryCard}
                  surfaceStyle={styles.entrySurface}
                  variant="outlined"
                >
                  {isVideo ? (
                    <View style={styles.videoEntry}>
                      <View style={styles.videoMediaBanner}>
                        <Image
                          source={{ uri: youtubeThumbnail ?? '' }}
                          style={styles.videoMediaImage}
                          resizeMode="cover"
                        />
                        <View style={styles.videoMediaOverlay}>
                          <Ionicons name="play" size={14} color="#FFFFFF" />
                          <Text style={styles.videoMediaOverlayText}>Watch</Text>
                        </View>
                      </View>

                      <View style={styles.videoContent}>
                        <View style={styles.videoTitleRow}>
                          <View style={styles.videoTitleCopy}>
                            <Text style={styles.entryKicker} numberOfLines={1}>
                              {entry.category}
                            </Text>
                            <Text style={styles.entryTitle} numberOfLines={2}>
                              {entry.title}
                            </Text>
                          </View>
                          <View style={styles.entryAction}>
                            <Ionicons
                              name="open-outline"
                              size={22}
                              color={colors.primary}
                            />
                          </View>
                        </View>
                        <Text style={styles.videoDescription} numberOfLines={1}>
                          {entry.description}
                        </Text>
                        <View style={styles.videoMetaFooter}>
                          <View style={styles.videoMetaPills}>
                            {durationLabel ? (
                              <View style={styles.metaPill}>
                                <Ionicons
                                  name="time-outline"
                                  size={14}
                                  color={colors.textSecondary}
                                />
                                <Text style={styles.metaText}>{durationLabel}</Text>
                              </View>
                            ) : null}
                            {entry.region ? (
                              <View style={styles.metaPill}>
                                <Ionicons
                                  name="location-outline"
                                  size={14}
                                  color={colors.textSecondary}
                                />
                                <Text style={styles.metaText}>{entry.region}</Text>
                              </View>
                            ) : null}
                          </View>
                          <Text style={styles.sourceLine} numberOfLines={1}>
                            {entry.source}
                          </Text>
                        </View>
                      </View>
                    </View>
                  ) : (
                    <View style={styles.entryRow}>
                      <View style={styles.mediaTile}>
                        {visualUrl ? (
                          <>
                            <Image
                              source={{ uri: visualUrl }}
                              style={styles.thumbnail}
                              resizeMode="cover"
                            />
                            {youtubeThumbnail ? (
                              <View style={styles.playOverlay}>
                                <Ionicons name="play" size={14} color="#FFFFFF" />
                              </View>
                            ) : null}
                          </>
                        ) : (
                          <>
                            <Ionicons
                              name={formatIcon}
                              size={28}
                              color={colors.support}
                            />
                            <Text style={styles.mediaFormatText} numberOfLines={1}>
                              {entry.format}
                            </Text>
                          </>
                        )}
                      </View>

                      <View style={styles.entryBody}>
                        <Text style={styles.entryKicker} numberOfLines={1}>
                          {entry.category}
                        </Text>
                        <Text style={styles.entryTitle} numberOfLines={2}>
                          {entry.title}
                        </Text>
                        <Text style={styles.entryDescription} numberOfLines={2}>
                          {entry.description}
                        </Text>
                        <View style={styles.entryMetaRow}>
                          <View style={styles.metaPill}>
                            <Ionicons
                              name={formatIcon}
                              size={14}
                              color={colors.textSecondary}
                            />
                            <Text style={styles.metaText}>{entry.format}</Text>
                          </View>
                          {durationLabel ? (
                            <View style={styles.metaPill}>
                              <Ionicons
                                name="time-outline"
                                size={14}
                                color={colors.textSecondary}
                              />
                              <Text style={styles.metaText}>{durationLabel}</Text>
                            </View>
                          ) : null}
                          {entry.region ? (
                            <View style={styles.metaPill}>
                              <Ionicons
                                name="location-outline"
                                size={14}
                                color={colors.textSecondary}
                              />
                              <Text style={styles.metaText}>{entry.region}</Text>
                            </View>
                          ) : null}
                        </View>
                        <Text style={styles.sourceLine} numberOfLines={1}>
                          {entry.source}
                        </Text>
                      </View>

                      <View style={styles.entryAction}>
                        <Ionicons
                          name="open-outline"
                          size={22}
                          color={colors.primary}
                        />
                      </View>
                    </View>
                  )}
                </Card>
              );
            })}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}
