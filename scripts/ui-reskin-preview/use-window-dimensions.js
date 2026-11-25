// Preview only: Babel rewrites `react-native` imports to per-module
// react-native-web paths, so the font-scale input is injected here too.
import useWebWindowDimensions from '../../node_modules/react-native-web/dist/exports/useWindowDimensions/index.js';

export default function useWindowDimensions() {
  const dimensions = useWebWindowDimensions();
  const requestedScale = Number(new URLSearchParams(window.location.search).get('scale'));
  return {
    ...dimensions,
    fontScale: Number.isFinite(requestedScale) && requestedScale > 0 ? requestedScale : 1,
  };
}
