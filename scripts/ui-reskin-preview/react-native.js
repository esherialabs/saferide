// Preview only: pair browser text enlargement with the layout's font-scale input.
import { useWindowDimensions as useWebWindowDimensions } from 'react-native-web';

export * from 'react-native-web';

export function useWindowDimensions() {
  const dimensions = useWebWindowDimensions();
  const requestedScale = Number(new URLSearchParams(window.location.search).get('scale'));
  return {
    ...dimensions,
    fontScale: Number.isFinite(requestedScale) && requestedScale > 0 ? requestedScale : 1,
  };
}
