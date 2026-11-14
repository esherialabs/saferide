import * as Location from 'expo-location';

type ReportLocationResult =
  | { status: 'denied' }
  | { status: 'granted'; address: string; coordinates: { latitude: number; longitude: number } };

// A location request must never outlive the user's latest location choice.
export async function readCurrentReportLocation(isActive: () => boolean): Promise<ReportLocationResult | null> {
  if (!isActive()) return null;
  const permission = await Location.requestForegroundPermissionsAsync();
  if (!isActive()) return null;
  if (permission.status !== 'granted') return { status: 'denied' };

  const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
  if (!isActive()) return null;
  const coordinates = { latitude: location.coords.latitude, longitude: location.coords.longitude };
  let address = 'Current device location';
  try {
    const places = await Location.reverseGeocodeAsync(coordinates);
    if (!isActive()) return null;
    if (places[0]) {
      const place = places[0];
      address = [place.name, place.street, place.city, place.region, place.postalCode]
        .filter(Boolean).join(', ') || address;
    }
  } catch {
    // Keep the explicitly requested coordinates when address lookup is unavailable.
  }
  return isActive() ? { status: 'granted', address, coordinates } : null;
}
