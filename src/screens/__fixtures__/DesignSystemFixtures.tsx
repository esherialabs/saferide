import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  CaseTimelineItem,
  Checkbox,
  Chip,
  ConsentSummary,
  DashboardTemplate,
  EmptyState,
  ErrorState,
  EvidenceRow,
  FormSection,
  IconButton,
  Input,
  ListRow,
  LoadingState,
  OfflineBanner,
  ProgressStepper,
  ProviderRow,
  SafetyAction,
  Section,
  StatePill,
  StatusBanner,
  Select,
  Switch,
  Textarea,
  UnavailableState,
} from '../../components/ui';
import { useTheme } from '../../theme/SimpleThemeProvider';
import { borders, radii, spacing, typography } from '../../theme/tokens';
import { ActionSheet } from '../../components/ui/ActionSheet';
import { DateField, TimeField } from '../../components/ui/DateTimeField';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../../components/ui/Dialog';

const noop = () => {};

const reportSteps = [
  { id: 'what', label: 'What happened', status: 'complete' as const },
  { id: 'where', label: 'Place and time', status: 'complete' as const },
  { id: 'evidence', label: 'Evidence', status: 'current' as const },
  { id: 'consent', label: 'Consent review with a deliberately long label', status: 'error' as const },
];

const providerOptions = [
  { label: 'GBV support provider', value: 'gbv' },
  { label: 'Legal aid clinic', value: 'legal' },
  { label: 'Network-only referral', value: 'network', disabled: true },
];

export default function DesignSystemFixtures() {
  const { colors } = useTheme();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [fixtureDate, setFixtureDate] = useState(new Date(2026, 9, 1, 14, 30));

  return (
    <DashboardTemplate showNetworkStatus={false} contentStyle={styles.content}>
      <View style={styles.hero}>
        <View style={styles.heroCopy}>
          <Text accessibilityRole="header" style={[styles.title, { color: colors.foreground }]}>
            Design system fixtures
          </Text>
          <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
            Synthetic component states for SafeRide visual QA. Actions never send, delete, upload, or contact anyone.
          </Text>
        </View>
        <IconButton
          icon="calculator-outline"
          accessibilityLabel="Quick exit fixture"
          accessibilityHint="Fixture example only. Production quick exit opens the calculator decoy."
          onPress={noop}
          variant="outline"
        />
      </View>

      <Section title="Overlay and date controls" contentStyle={styles.stack}>
        <Button title="Open synthetic action sheet" onPress={() => setSheetOpen(true)} />
        <Button title="Open synthetic review dialog" variant="outline" onPress={() => setDialogOpen(true)} />
        <DateField label="Synthetic date" value={fixtureDate} onChange={setFixtureDate} />
        <TimeField label="Synthetic time" value={fixtureDate} onChange={setFixtureDate} />
        <ActionSheet visible={sheetOpen} onClose={() => setSheetOpen(false)} title="Synthetic evidence actions" message="These controls have no service side effects." actions={[
          { title: 'Keep this deliberately long synthetic evidence title private on the device', onPress: noop },
          { title: 'Unavailable action', onPress: noop, disabled: true },
          { title: 'Destructive appearance only — no deletion', onPress: noop, destructive: true },
        ]} />
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent>
            <DialogHeader><DialogTitle>Synthetic consent review with a long heading</DialogTitle><DialogDescription>No choice is saved or transmitted by this fixture.</DialogDescription></DialogHeader>
            <Button title="Close preview" onPress={() => setDialogOpen(false)} />
          </DialogContent>
        </Dialog>
      </Section>

      <Section
        title="Status and action states"
        description="Covers loading, empty, offline, error, success, disabled, destructive, and privacy-sensitive examples."
        contentStyle={styles.stack}
      >
        <OfflineBanner queuedCount={3} />
        <StatusBanner
          title="Evidence upload queued"
          message="Files stay local until SafeRide can reach the service."
          tone="queued"
          icon="cloud-upload-outline"
          actionLabel="Review"
          onAction={noop}
        />
        <StatusBanner
          title="Provider directory cached"
          message="Support options are from the last saved catalog. Confirm details before sharing."
          tone="support"
          icon="business-outline"
        />
        <View style={styles.actionGrid}>
          <Button title="Submit when online" loading onPress={noop} />
          <Button title="Save local draft" variant="secondary" onPress={noop} />
          <Button title="Unavailable export" variant="outline" disabled onPress={noop} />
          <Button title="Request deletion" variant="destructive" onPress={noop} />
        </View>
        <View style={styles.badgeWrap}>
          <StatePill label="Saved" tone="success" icon="checkmark-circle-outline" />
          <StatePill label="Queued" tone="queued" icon="time-outline" />
          <StatePill label="Consent needed" tone="consent" icon="document-lock-outline" />
          <StatePill label="Evidence" tone="evidence" icon="folder-outline" />
          <StatePill label="Case current" tone="case" icon="file-tray-full-outline" />
          <StatePill label="Unavailable" tone="unavailable" icon="remove-circle-outline" />
        </View>
        <View style={styles.chipWrap}>
          <Chip label="Selected pathway" selected leadingIcon="checkmark-circle-outline" onPress={noop} />
          <Chip label="Disabled route-safety signal" disabled leadingIcon="map-outline" />
          <Chip label="Long label wraps only inside owning rows, not compact chips" onPress={noop} />
        </View>
      </Section>

      <Section title="Report steps" description="Use for report and consent flow progress." contentStyle={styles.stack}>
        <ProgressStepper steps={reportSteps} currentStepId="evidence" />
        <FormSection
          title="Report form states"
          description="Helper, error, disabled, and privacy-sensitive fields."
          required
          footer={<StatePill label="Local draft" tone="privacy" icon="phone-portrait-outline" size="sm" />}
        >
          <Input
            label="Vehicle plate or route"
            value="KDA 123A, Route 111"
            onChangeText={noop}
            helperText="Optional. Keep local if you are not ready to share."
          />
          <Input
            label="Contact for provider follow-up"
            value=""
            onChangeText={noop}
            error="Add a contact method or choose private save."
          />
          <Select
            label="Support pathway"
            value="gbv"
            onValueChange={noop}
            options={providerOptions}
            helperText="Network-only pathways should be disabled while offline."
          />
          <Textarea
            label="Narrative"
            value="Describe only what you want to record. This fixture checks multi-line spacing."
            onChangeText={noop}
            helperText="Long text should expand without hiding the next control."
            rows={3}
          />
          <View style={styles.formControls}>
            <Checkbox
              checked
              onCheckedChange={noop}
              label="Include contact details"
              description="Shown in consent before anything leaves this device."
            />
            <Switch
              value={false}
              onValueChange={noop}
              disabled
              label="Protected export"
              description="Unavailable until the backed workflow exists."
            />
          </View>
        </FormSection>
      </Section>

      <Section title="Home and privacy actions" contentStyle={styles.stack}>
        <SafetyAction
          title="Continue saved report"
          description="Last saved locally 4 minutes ago. Evidence upload is still queued."
          icon="document-text-outline"
          statusLabel="Local only"
          onPress={noop}
        />
        <SafetyAction
          title="Add evidence before writing the full report"
          description="Photos, audio, or notes stay on this phone until consent is confirmed."
          icon="camera-outline"
          tone="evidence"
          statusLabel="Private"
          onPress={noop}
        />
        <SafetyAction
          title="Send protected export with a very long label"
          description="Unavailable until encrypted export is implemented and reviewed."
          icon="lock-closed-outline"
          tone="privacy"
          statusLabel="Unavailable"
          disabled
        />
        <SafetyAction
          title="Request deletion"
          description="Remote deletion is a request until the backend confirms completion."
          icon="trash-outline"
          tone="destructive"
          statusLabel="Destructive"
          onPress={noop}
        />
      </Section>

      <Section title="Evidence rows" contentStyle={styles.stack}>
        <EvidenceRow
          title="Vehicle plate photo"
          kind="Photo"
          status="local"
          detail="Stored on this device only"
          timestampLabel="4m"
          privacyLabels={['Metadata removal requested']}
          onPress={noop}
        />
        <EvidenceRow
          title="Audio note from the stop"
          kind="Audio"
          status="queued"
          detail="Will upload when SafeRide is online"
          timestampLabel="12m"
          privacyLabels={['Local copy kept']}
          onPress={noop}
        />
        <EvidenceRow
          title="Statement attachment with an intentionally long title for wrapping checks"
          kind="Document"
          status="failed"
          detail="Upload failed. Keep the retry action visible."
          timestampLabel="1h"
          privacyLabels={['Retry needed', 'Not shared']}
          onPress={noop}
        />
        <EvidenceRow
          title="Route screenshot"
          kind="Image"
          status="processing"
          detail="Processing requested. Do not claim redaction has completed yet."
          privacyLabels={['Redaction requested']}
        />
        <EvidenceRow
          title="Protected export file"
          kind="Export"
          status="unavailable"
          detail="Encrypted export is not available in this release scope."
        />
      </Section>

      <Section title="Consent summary" contentStyle={styles.stack}>
        <ConsentSummary
          pathwayLabel="Provider referral"
          recipientLabel="Verified support provider"
          retentionNote="You can request deletion later. Remote deletion is not instant."
          items={[
            {
              id: 'narrative',
              label: 'Report narrative',
              description: 'Included because the user selected provider referral.',
              included: true,
              tone: 'consent',
            },
            {
              id: 'evidence',
              label: 'Evidence files',
              description: 'Queued files will send after network recovery.',
              included: true,
              tone: 'evidence',
            },
            {
              id: 'identity',
              label: 'Legal name',
              description: 'Not added to this report.',
              included: false,
              tone: 'privacy',
            },
          ]}
        />
      </Section>

      <Section title="Provider and support rows" contentStyle={styles.stack}>
        <ProviderRow
          name="Nairobi survivor support provider"
          serviceType="GBV support"
          description="Provider directory row with verified and distance labels."
          distanceLabel="2.4 km"
          availabilityLabel="Open today"
          verified
          onPress={noop}
        />
        <ProviderRow
          name="Cached legal aid clinic with a long organization name"
          serviceType="Legal aid"
          description="Shown from cached catalog data while offline."
          availabilityLabel="Network required"
          cached
        />
        <ListRow
          title="Support chat"
          description="Guidance only. Does not provide emergency dispatch or legal advice."
          leadingIcon="chatbubbles-outline"
          tone="info"
          trailing={<Badge variant="warning">Unavailable offline</Badge>}
        />
      </Section>

      <Section title="Case timeline" contentStyle={styles.timelineStack}>
        <CaseTimelineItem
          title="Draft created"
          description="Local draft saved before sharing."
          timestampLabel="09:10"
          status="complete"
        />
        <CaseTimelineItem
          title="Evidence upload queued"
          description="The report can be reviewed while media waits for network."
          timestampLabel="09:18"
          status="current"
        />
        <CaseTimelineItem
          title="Provider referral pending"
          description="Consent is required before provider details are sent."
          timestampLabel="Next"
          status="pending"
        />
        <CaseTimelineItem
          title="Protected export blocked"
          description="Export stays unavailable until the supported workflow exists."
          timestampLabel="Blocked"
          status="blocked"
        />
        <CaseTimelineItem
          title="Evidence retry failed"
          description="Keep the failed state visible and retryable."
          timestampLabel="1h"
          status="failed"
        />
      </Section>

      <Section title="Empty and error states" contentStyle={styles.stateGrid}>
        <View style={[styles.statePanel, { borderColor: colors.divider, backgroundColor: colors.surface }]}>
          <EmptyState
            title="No saved reports yet"
            message="Start a local report or add evidence when you are ready."
            actionLabel="Start report"
            onAction={noop}
            tone="safety"
          />
        </View>
        <View style={[styles.statePanel, { borderColor: colors.divider, backgroundColor: colors.surface }]}>
          <LoadingState
            title="Checking saved work"
            message="Use for local-first refreshes without hiding cached content."
          />
        </View>
        <View style={[styles.statePanel, { borderColor: colors.divider, backgroundColor: colors.surface }]}>
          <ErrorState
            title="Upload needs attention"
            message="One evidence file could not upload."
            details="Keep local copy visible and retry when the connection is stable."
            onRetry={noop}
          />
        </View>
        <View style={[styles.statePanel, { borderColor: colors.divider, backgroundColor: colors.surface }]}>
          <UnavailableState
            title="Protected export unavailable"
            message="Use when a capability is not implemented or not available offline."
          />
        </View>
      </Section>

      <Section title="Small-screen text checks" contentStyle={styles.stack}>
        <ListRow
          title="Very long settings row title that should wrap without hiding the trailing unavailable status"
          description="Use this row to inspect compact Android widths and Extra Large text."
          leadingIcon="text-outline"
          tone="warning"
          trailing={<Badge variant="outline">Unavailable</Badge>}
        />
        <Card variant="outlined">
          <CardHeader>
            <CardTitle>Long footer actions</CardTitle>
            <CardDescription>
              Button text should wrap or scale within the action instead of overflowing.
            </CardDescription>
          </CardHeader>
          <CardFooter style={styles.cardFooter}>
            <Button title="Keep private on this device" variant="secondary" onPress={noop} />
            <Button
              title="Continue to consent review"
              onPress={noop}
              icon={<Ionicons name="arrow-forward" size={18} color={colors.primaryForeground} />}
              iconPosition="right"
            />
          </CardFooter>
        </Card>
      </Section>
    </DashboardTemplate>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: spacing.section,
  },
  hero: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: spacing.md,
  },
  heroCopy: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    ...typography.titleL,
  },
  subtitle: {
    ...typography.bodyS,
    marginTop: spacing.xxs,
  },
  stack: {
    gap: spacing.sm,
  },
  actionGrid: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  badgeWrap: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  chipWrap: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  formControls: {
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  timelineStack: {
    gap: spacing.xs,
  },
  stateGrid: {
    gap: spacing.sm,
  },
  statePanel: {
    borderRadius: radii.card,
    borderWidth: borders.standard,
    overflow: 'hidden',
  },
  cardFooter: {
    alignItems: 'stretch',
    flexWrap: 'wrap',
    gap: spacing.sm,
    justifyContent: 'flex-start',
  },
});
