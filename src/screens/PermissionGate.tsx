import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, Vibration, Linking } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Location from 'expo-location';
import { getRecordingPermissionsAsync, requestRecordingPermissionsAsync } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import Screen from '../components/ui/Screen';
import Button from '../components/ui/Button';
import { Card, CardContent, CardDescription, CardTitle } from '../components/ui/Card';
import { FeatureHeader, type FeatureHeaderStat } from '../components/ui/FeatureHeader';
import { Alert as AlertComponent } from '../components/ui/Alert';
import { Badge } from '../components/ui/Badge';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme/SimpleThemeProvider';
import { useToast } from '../components/ui/Toast';
import { RootStackParamList } from '../navigation/routes';
import { PermissionStatus, useOnboarding } from '../context/OnboardingProvider';
import { borders, radii, spacing, typography } from '../theme/tokens';

type PermissionNavigationProp = NativeStackNavigationProp<RootStackParamList, 'PermissionGate'>;

export default function PermissionGateScreen() {
  const navigation = useNavigation<PermissionNavigationProp>();
  const { colors } = useTheme();
  const toast = useToast();
  const { state: onboardingState, updatePermissionStatus, markStepComplete } = useOnboarding();
  const [isRequesting, setIsRequesting] = useState(false);
  const [permissions, setPermissions] = useState<PermissionStatus>(onboardingState.permissionStatus);

  const styles = StyleSheet.create({
    container: {
      flex: 1,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.lg,
    },
    header: {
      marginBottom: spacing.md,
    },
    permissionsList: {
      gap: spacing.sm,
      marginBottom: spacing.lg,
    },
    footer: {
      gap: spacing.sm,
    },
    skipText: {
      ...typography.bodyS,
      color: colors.textSecondary,
      textAlign: 'center',
      marginTop: spacing.md,
    },
    permissionContent: {
      gap: spacing.sm,
    },
    permissionTopRow: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.sm,
    },
    permissionIcon: {
      alignItems: 'center',
      borderRadius: radii.card,
      height: 44,
      justifyContent: 'center',
      width: 44,
    },
    permissionCopy: {
      flex: 1,
      minWidth: 0,
    },
    permissionTitle: {
      marginBottom: spacing.xxxs,
    },
    permissionDetails: {
      backgroundColor: colors.privacyMuted,
      borderColor: colors.divider,
      borderRadius: radii.card,
      borderWidth: borders.hairline,
      gap: spacing.xs,
      overflow: 'hidden',
      padding: spacing.md,
      position: 'relative',
    },
    permissionDetailRow: {
      alignItems: 'flex-start',
      flexDirection: 'row',
      gap: spacing.xs,
    },
    permissionDetailText: {
      ...typography.bodySmall,
      color: colors.textSecondary,
      flex: 1,
    },
  });

  const permissionStats = useMemo<FeatureHeaderStat[]>(() => [
    {
      label: 'Location',
      value: permissions.location === 'granted' ? 'Ready' : permissions.location === 'denied' ? 'Off' : 'Ask',
      icon: 'location-outline',
    },
    {
      label: 'Microphone',
      value: permissions.audio === 'granted' ? 'Ready' : permissions.audio === 'denied' ? 'Off' : 'Ask',
      icon: 'mic-outline',
    },
  ], [permissions.audio, permissions.location]);

  useEffect(() => {
    setPermissions(onboardingState.permissionStatus);
  }, [onboardingState.permissionStatus]);

  useEffect(() => {
    checkExistingPermissions();
  }, []);

  useEffect(() => {
    if (onboardingState.steps.PermissionGate) {
      navigation.replace('StealthTriggerSetup');
    }
  }, [onboardingState.steps.PermissionGate, navigation]);

  // Toast-based stealth test, avoids modal alerts
  const handleTestStealthToast = async () => {
    if (permissions.audio !== 'granted') {
      toast.show({ title: 'Microphone required', message: 'Enable microphone to test stealth.', variant: 'error' });
      return;
    }

    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } catch {
      Vibration.vibrate(100);
    }

    toast.show({ title: 'Stealth test complete', message: 'Use shake or secret taps while SafeRide is open.', variant: 'info' });
  };


  const checkExistingPermissions = async () => {
    try {
      const { status: locationStatus } = await Location.getForegroundPermissionsAsync();
      const { status: audioStatus } = await getRecordingPermissionsAsync();

      const nextStatus: PermissionStatus = {
        location: locationStatus === 'granted' ? 'granted' : locationStatus === 'denied' ? 'denied' : 'pending',
        audio: audioStatus === 'granted' ? 'granted' : audioStatus === 'denied' ? 'denied' : 'pending',
      };

      setPermissions(nextStatus);
      updatePermissionStatus(nextStatus).catch((error) => {
        console.warn('Failed to persist permission status', error);
      });
    } catch (error) {
      console.warn('Failed to check existing permissions:', error);
    }
  };

  const requestPermissions = async () => {
    setIsRequesting(true);
    
    try {
      // Request location permission
      const { status: locationStatus } = await Location.requestForegroundPermissionsAsync();
      
      // Request audio recording permission
      const { status: audioStatus } = await requestRecordingPermissionsAsync();
      
      // Update permission status
      const nextStatus: PermissionStatus = {
        location: locationStatus === 'granted' ? 'granted' : 'denied',
        audio: audioStatus === 'granted' ? 'granted' : 'denied',
      };

      setPermissions(nextStatus);
      await updatePermissionStatus(nextStatus);
      await markStepComplete('PermissionGate');
      
      const essentialGranted = locationStatus === 'granted' && audioStatus === 'granted';
      
      if (essentialGranted) {
        toast.show({ title: 'Setup complete', message: 'Core permissions granted', variant: 'success' });
        navigation.replace('StealthTriggerSetup');
      } else {
        toast.show({ title: 'Permissions required', message: 'You can enable later in Settings.', variant: 'warning' });
        navigation.replace('StealthTriggerSetup');
      }
    } catch (error) {
      toast.show({ title: 'Permissions failed', message: 'Please try again.', variant: 'error' });
    } finally {
      setIsRequesting(false);
    }
  };

  const completeAndContinue = async () => {
    try {
      await updatePermissionStatus(permissions);
      await markStepComplete('PermissionGate');
    } catch (error) {
      console.warn('Failed to persist permission skip', error);
    } finally {
      navigation.replace('StealthTriggerSetup');
    }
  };

  const handleOpenSettings = () => {
    Linking.openSettings().catch(() => {
      toast.show({
        title: 'Unable to open settings',
        message: 'Update permissions manually from the system Settings app.',
        variant: 'error',
      });
    });
  };

  const getPermissionBadge = (status: 'pending' | 'granted' | 'denied') => {
    switch (status) {
      case 'granted':
        return <Badge variant="success">Granted</Badge>;
      case 'denied':
        return <Badge variant="destructive">Denied</Badge>;
      default:
        return <Badge variant="secondary">Pending</Badge>;
    }
  };

  const allPermissionsGranted = permissions.location === 'granted' && permissions.audio === 'granted';
  const anyPermissionDenied = permissions.location === 'denied' || permissions.audio === 'denied';
  const continueLabel = allPermissionsGranted ? 'Continue Setup' : 'Request Permissions';

  const getPermissionTone = (status: 'pending' | 'granted' | 'denied') => {
    if (status === 'granted') return colors.success;
    if (status === 'denied') return colors.destructive;
    return colors.warning;
  };

  const renderPermissionCard = (
    key: 'location' | 'audio',
    title: string,
    description: string,
    icon: keyof typeof Ionicons.glyphMap,
    detail?: React.ReactNode,
  ) => {
    const status = permissions[key];
    const tone = getPermissionTone(status);

    return (
      <Card
        key={key}
        variant="elevated"
        surfaceStyle={{ borderColor: tone + '33' }}
        style={{ shadowColor: tone }}
      >
        <CardContent style={styles.permissionContent}>
          <View style={styles.permissionTopRow}>
            <View
              style={[
                styles.permissionIcon,
                {
                  backgroundColor: tone + '16',
                  borderColor: tone + '33',
                  borderWidth: borders.hairline,
                },
              ]}
            >
              <Ionicons name={icon} size={21} color={tone} />
            </View>
            <View style={styles.permissionCopy}>
              <CardTitle variant="small" style={styles.permissionTitle}>{title}</CardTitle>
              <CardDescription>{description}</CardDescription>
            </View>
            {getPermissionBadge(status)}
          </View>
          {detail}
        </CardContent>
      </Card>
    );
  };

  return (
    <Screen scrollable brandHeader>
      <View style={styles.container}>
        <View style={styles.header}>
          <FeatureHeader
            eyebrow="Setup"
            title="Choose app permissions"
            description="Turn on only the tools you want. You can continue without granting everything."
            icon="shield-checkmark-outline"
            tone="privacy"
            stats={permissionStats}
          />
        </View>

        {anyPermissionDenied && (
          <AlertComponent variant="warning" style={{ marginBottom: 16 }}>
            <Text style={{ marginBottom: 12 }}>
              Some permissions were denied. You can enable them later in your device Settings to unlock full functionality.
            </Text>
            <Button title="Open Settings" onPress={handleOpenSettings} size="sm" />
          </AlertComponent>
        )}

        {allPermissionsGranted && (
          <AlertComponent variant="success" style={{ marginBottom: 16 }}>
            <Text>All permissions granted. SafeRide can use the enabled features.</Text>
          </AlertComponent>
        )}

        <View style={styles.permissionsList}>
          {renderPermissionCard(
            'location',
            'Location access',
            'Add a place automatically only when you choose to use device location.',
            'location-outline',
          )}

          {renderPermissionCard(
            'audio',
            'Microphone access',
            'Record audio only when you use a supported SafeRide capture action.',
            'mic-outline',
            permissions.audio === 'granted' ? (
              <View style={styles.permissionDetails}>
                {[
                  'Use shake or secret taps while SafeRide is open.',
                  'Audio stays in the local draft until a consent step.',
                  'Android may show the system microphone indicator.',
                ].map(item => (
                  <View key={item} style={styles.permissionDetailRow}>
                    <Ionicons name="checkmark-circle-outline" size={14} color={colors.success} />
                    <Text style={styles.permissionDetailText}>{item}</Text>
                  </View>
                ))}
                <Button
                  title="Test stealth buzz"
                  onPress={handleTestStealthToast}
                  variant="outline"
                  style={{ marginTop: spacing.xs }}
                />
              </View>
            ) : permissions.audio === 'denied' ? (
              <View style={styles.permissionDetails}>
                <Text style={styles.permissionDetailText}>
                  Text-only reporting still works. You can enable microphone access from system Settings later.
                </Text>
              </View>
            ) : null,
          )}

        </View>

        <View style={styles.footer}>
          <Button
            title={continueLabel}
            onPress={allPermissionsGranted ? completeAndContinue : requestPermissions}
            loading={!allPermissionsGranted && isRequesting}
            fullWidth
          />
          {!allPermissionsGranted && (
            <>
              <Button
                title="Skip for Now"
                onPress={completeAndContinue}
                variant="outline"
                fullWidth
              />
              <Text style={styles.skipText}>
                You can enable permissions later in Settings
              </Text>
            </>
          )}
        </View>
      </View>
    </Screen>
  );
}
