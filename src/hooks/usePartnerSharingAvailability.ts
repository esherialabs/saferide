import { useEffect, useState } from 'react';

import { getRuntimeConfigSnapshot, subscribeToRuntimeConfig } from '../config/runtime/runtimeConfigStore';
import { getPartnerSharingAvailability, type PartnerSharingAvailability } from '../utils/partnerSharing';

/** Whether the server currently offers sharing with HURIA (runtime-config flags, off by default). */
export function usePartnerSharingAvailability(): PartnerSharingAvailability {
  const [availability, setAvailability] = useState<PartnerSharingAvailability>(
    () => {
      const snapshot = getRuntimeConfigSnapshot();
      return getPartnerSharingAvailability(snapshot.features, snapshot.partnerConsentVersions);
    },
  );

  useEffect(() => {
    const unsubscribe = subscribeToRuntimeConfig(config => {
      const next = getPartnerSharingAvailability(config.features, config.partnerConsentVersions);
      setAvailability(current => (
        current.routing === next.routing && current.callback === next.callback ? current : next
      ));
    });
    return () => {
      unsubscribe();
    };
  }, []);

  return availability;
}
