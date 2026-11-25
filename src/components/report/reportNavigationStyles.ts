import type { ViewStyle } from 'react-native';

import type { ThemeColors } from '../../theme/tokens';
import { borders, layout, spacing } from '../../theme/tokens';

/** Shared Back/Continue dock for every report step, so the footer matches across the wizard. */
export function getReportNavigationStyles(colors: ThemeColors): {
  navigationDock: ViewStyle;
  navigationButtons: ViewStyle;
} {
  return {
    navigationDock: {
      backgroundColor: colors.background,
      borderTopColor: colors.divider,
      borderTopWidth: borders.hairline,
      paddingBottom: spacing.xs,
      paddingHorizontal: layout.screenGutter,
      paddingTop: spacing.xs,
    },
    navigationButtons: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
    },
  };
}
