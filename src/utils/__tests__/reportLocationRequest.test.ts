import { beforeEach, describe, expect, it, vi } from 'vitest';
const location = vi.hoisted(() => ({
  Accuracy: { Balanced: 3 },
  requestForegroundPermissionsAsync: vi.fn(),
  getCurrentPositionAsync: vi.fn(),
  reverseGeocodeAsync: vi.fn(),
}));
vi.mock('expo-location', () => location);
import { readCurrentReportLocation } from '../reportLocationRequest';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  location.requestForegroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
  location.getCurrentPositionAsync.mockResolvedValue({ coords: { latitude: 1, longitude: 2 } });
  location.reverseGeocodeAsync.mockResolvedValue([{ city: 'Synthetic city' }]);
});

describe('report location choice cancellation', () => {
  it('does not start GPS after the user changes their choice during permission', async () => {
    const permission = deferred<{ status: string }>();
    location.requestForegroundPermissionsAsync.mockReturnValue(permission.promise);
    let active = true;
    const request = readCurrentReportLocation(() => active);
    active = false;
    permission.resolve({ status: 'granted' });
    expect(await request).toBeNull();
    expect(location.getCurrentPositionAsync).not.toHaveBeenCalled();
  });

  it('discards a GPS result after the user chooses general or manual location', async () => {
    const position = deferred<{ coords: { latitude: number; longitude: number } }>();
    location.getCurrentPositionAsync.mockReturnValue(position.promise);
    let active = true;
    const request = readCurrentReportLocation(() => active);
    await vi.waitFor(() => expect(location.getCurrentPositionAsync).toHaveBeenCalled());
    active = false;
    position.resolve({ coords: { latitude: 1, longitude: 2 } });
    expect(await request).toBeNull();
    expect(location.reverseGeocodeAsync).not.toHaveBeenCalled();
  });

  it.each(['resolved', 'rejected'])('discards stale address lookup when %s', async outcome => {
    const address = deferred<Array<{ city: string }>>();
    location.reverseGeocodeAsync.mockReturnValue(address.promise);
    let active = true;
    const request = readCurrentReportLocation(() => active);
    await vi.waitFor(() => expect(location.reverseGeocodeAsync).toHaveBeenCalled());
    active = false;
    if (outcome === 'resolved') address.resolve([{ city: 'Synthetic city' }]);
    else address.reject(new Error('unavailable'));
    expect(await request).toBeNull();
  });

  it('returns only the explicitly requested location when active', async () => {
    expect(await readCurrentReportLocation(() => true)).toEqual({
      status: 'granted', address: 'Synthetic city', coordinates: { latitude: 1, longitude: 2 },
    });
    expect(location.getCurrentPositionAsync).toHaveBeenCalledWith({ accuracy: location.Accuracy.Balanced });
  });

  it('preserves the manual fallback on denial and coordinate fallback on failed address lookup', async () => {
    location.requestForegroundPermissionsAsync.mockResolvedValueOnce({ status: 'denied' });
    expect(await readCurrentReportLocation(() => true)).toEqual({ status: 'denied' });
    expect(location.getCurrentPositionAsync).not.toHaveBeenCalled();
    location.reverseGeocodeAsync.mockRejectedValueOnce(new Error('unavailable'));
    expect(await readCurrentReportLocation(() => true)).toMatchObject({ status: 'granted', address: 'Current device location' });
  });
});
