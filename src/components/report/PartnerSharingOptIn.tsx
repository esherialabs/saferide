import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Alert as AlertComponent } from '../ui/Alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/Card';
import { Input } from '../ui/Input';
import { Switch } from '../ui/Switch';
import { PARTNER_SHARING_COPY } from '../../i18n/partnerSharingCopy';
import { useTheme } from '../../theme/SimpleThemeProvider';
import { spacing, typography } from '../../theme/tokens';
import {
  buildPartnerConsentParagraphs,
  MAX_CALLBACK_INPUT_LENGTH,
  type PartnerSharingFormState,
} from '../../utils/partnerSharing';

type PartnerSharingOptInProps = {
  pathway: 'escalate' | 'referral';
  value: PartnerSharingFormState;
  onChange: (next: PartnerSharingFormState) => void;
  /** The server also offers the optional callback number. */
  callbackAvailable: boolean;
  /** Escalations: the redaction level label the survivor picked. */
  redactionLabel?: string;
  phoneError?: string | null;
  style?: object;
};

/**
 * "Also share with HURIA": an explicit opt-in, off by default, with the
 * plain-language consent text and the optional callback number. Rendered
 * only when the runtime config reports partner sharing on.
 */
export function PartnerSharingOptIn({
  pathway,
  value,
  onChange,
  callbackAvailable,
  redactionLabel,
  phoneError,
  style,
}: PartnerSharingOptInProps) {
  const { colors } = useTheme();
  const copy = PARTNER_SHARING_COPY;
  const styles = StyleSheet.create({
    section: {
      gap: spacing.sm,
      marginTop: spacing.md,
    },
    heading: {
      ...typography.labelMedium,
      color: colors.foreground,
    },
    paragraph: {
      ...typography.bodyS,
      color: colors.foreground,
      lineHeight: 20,
    },
    hint: {
      ...typography.caption,
      color: colors.mutedForeground,
    },
  });

  return (
    <Card variant="elevated" style={style}>
      <CardHeader>
        <CardTitle>{copy.optIn.cardTitle}</CardTitle>
        <CardDescription>{copy.optIn.toggleHint}</CardDescription>
      </CardHeader>
      <CardContent>
        <Switch
          value={value.requested}
          onValueChange={requested => onChange({
            ...value,
            requested,
            callbackRequested: requested ? value.callbackRequested : false,
          })}
          label={copy.optIn.toggleLabel}
          accessibilityLabel={copy.optIn.toggleLabel}
          accessibilityHint={copy.optIn.toggleHint}
        />

        {value.requested ? (
          <View style={styles.section}>
            <Text accessibilityRole="header" style={styles.heading}>{copy.consent.title}</Text>
            {buildPartnerConsentParagraphs({ pathway, redactionLabel }).map(paragraph => (
              <Text key={paragraph} style={styles.paragraph}>{paragraph}</Text>
            ))}

            {callbackAvailable ? (
              <View style={styles.section}>
                <Switch
                  value={value.callbackRequested}
                  onValueChange={callbackRequested => onChange({ ...value, callbackRequested })}
                  label={copy.callback.toggleLabel}
                  accessibilityLabel={copy.callback.toggleLabel}
                  accessibilityHint={copy.callback.toggleHint}
                />
                <Text style={styles.hint}>{copy.callback.toggleHint}</Text>

                {value.callbackRequested ? (
                  <>
                    <Input
                      label={copy.callback.inputLabel}
                      value={value.phoneInput}
                      onChangeText={phoneInput => onChange({ ...value, phoneInput })}
                      placeholder={copy.callback.inputPlaceholder}
                      keyboardType="phone-pad"
                      autoComplete="off"
                      textContentType="none"
                      maxLength={MAX_CALLBACK_INPUT_LENGTH}
                      error={phoneError ?? undefined}
                      accessibilityLabel={copy.callback.inputLabel}
                    />
                    <Text style={styles.paragraph}>{copy.callback.body}</Text>
                    <AlertComponent variant="warning">
                      <Text style={styles.paragraph}>{copy.callback.safetyTip}</Text>
                    </AlertComponent>
                  </>
                ) : null}
              </View>
            ) : null}
          </View>
        ) : null}
      </CardContent>
    </Card>
  );
}
