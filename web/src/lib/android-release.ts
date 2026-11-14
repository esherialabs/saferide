import release from '../../public/releases/saferide-1.0.4-code26-android.json';

export const ANDROID_RELEASE = release;
export const ANDROID_RELEASE_RECORD_PATH = `/releases/saferide-${release.appVersion}-code${release.versionCode}-android.json`;

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${bytes.toLocaleString('en-US')} bytes`;
}
