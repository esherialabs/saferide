import { devPrivacyError, devPrivacyWarn, getPrivacySafeErrorReason } from '../utils/privacyLog';
import { isCaseSubmissionEnabled } from '../config/runtime/caseSubmissionGate';
import { subscribeToRuntimeConfig } from '../config/runtime/runtimeConfigStore';
import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type SyncStatus = "idle" | "syncing" | "success" | "error";
// Sending reports used to be a hard-coded BACKEND_SYNC_ENABLED = false. It is
// now the server's runtime-config `features.caseSubmission`, read through a
// fail-closed gate (off when the config is missing, stale or not exactly true).
const STALENESS_RECHECK_MS = 60_000;

export type EnqueueSubmitResult = 'queued' | 'sending_off';

// Type definitions only - no actual imports
type NetInfoState = {
  isConnected?: boolean | null;
};

interface OnlineContextValue {
  isOnline: boolean;
  queueSize: number;
  syncStatus: SyncStatus;
  syncMessage: string | null;
  syncNow: () => Promise<void>;
  /** Queues a report to send to SafeRide, or does nothing while sending is switched off. */
  enqueueSubmit: (params: {
    draftId: string;
    pathway: string;
    payload?: any;
  }) => Promise<EnqueueSubmitResult>;
  caseSubmissionEnabled: boolean;
}

const OnlineContext = createContext<OnlineContextValue | undefined>(undefined);

export function OnlineProvider({ children }: { children: React.ReactNode }) {
  const [isOnline, setIsOnline] = useState(true);
  const [queueSize, setQueueSize] = useState(0);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle");
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [caseSubmissionEnabled, setCaseSubmissionEnabled] = useState(() => isCaseSubmissionEnabled());
  const syncManagerLoadedRef = useRef(false);

  // Follow the server switch, and drop it once the config goes stale.
  useEffect(() => {
    const update = () => setCaseSubmissionEnabled(isCaseSubmissionEnabled());
    const unsubscribe = subscribeToRuntimeConfig(update);
    const timer = setInterval(update, STALENESS_RECHECK_MS);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let unsubNet: (() => void) | undefined;
    let mounted = true;

    const initializeNetworkHandling = async () => {
      try {
        // Lazy load NetInfo to avoid module-level imports
        const NetInfoModule = await import("../utils/netinfoShim");
        const NetInfo = NetInfoModule.default;

        if (!mounted) return;

        // Get initial state
        try {
          const state = await NetInfo.fetch();
          if (mounted) {
            setIsOnline(!!state.isConnected);
          }
        } catch {
          if (mounted) {
            setIsOnline(true); // Assume online if can't determine
          }
        }

        // Set up listener
        unsubNet = NetInfo.addEventListener((state: NetInfoState) => {
          if (mounted) {
            setIsOnline(!!state.isConnected);
          }
        });
      } catch (error) {
        devPrivacyWarn('network handling initialization failed', {
          reason: getPrivacySafeErrorReason(error),
        });
        // Continue with defaults
      }
    };

    // Start initialization
    initializeNetworkHandling();

    // Cleanup
    return () => {
      mounted = false;
      try {
        unsubNet?.();
      } catch {
        // Ignore cleanup errors
      }
    };
  }, []); // Only run once on mount

  // The offline sync manager is loaded only once sending is switched on, as
  // before. If the switch turns off later, queued reports stay paused here.
  useEffect(() => {
    let mounted = true;
    let unsubSync: (() => void) | undefined;

    const wireSync = async () => {
      if (!caseSubmissionEnabled && !syncManagerLoadedRef.current) {
        setQueueSize(0);
        setSyncMessage(null);
        setSyncStatus("idle");
        return;
      }
      try {
        const { offlineSyncManager } = await import("../utils/offlineSync");
        syncManagerLoadedRef.current = true;
        if (!mounted) return;

        setQueueSize(offlineSyncManager.getSyncQueueSize());
        setSyncMessage(offlineSyncManager.getSyncQueueRecoveryMessage());
        unsubSync = offlineSyncManager.addSyncCallback((status: SyncStatus) => {
          if (mounted) {
            setSyncStatus(status);
            setQueueSize(offlineSyncManager.getSyncQueueSize());
            setSyncMessage(offlineSyncManager.getSyncQueueRecoveryMessage());
          }
        });

        // Sending is on, online, and reports are waiting: send them. startSync re-checks the switch itself.
        if (caseSubmissionEnabled && offlineSyncManager.getSyncQueueSize() > 0) {
          offlineSyncManager.startSync().catch(() => {
            // Failures stay on the queue with a recovery message.
          });
        }
      } catch (error) {
        devPrivacyWarn('offline sync initialization failed', {
          reason: getPrivacySafeErrorReason(error),
        });
      }
    };

    void wireSync();
    return () => {
      mounted = false;
      unsubSync?.();
    };
  }, [caseSubmissionEnabled]);

  const syncNow = async () => {
    if (!isCaseSubmissionEnabled()) {
      if (!syncManagerLoadedRef.current) {
        setQueueSize(0);
        setSyncMessage(null);
        setSyncStatus("idle");
        return;
      }
      // Marks waiting reports as paused; nothing is sent.
      const { offlineSyncManager } = await import("../utils/offlineSync");
      await offlineSyncManager.startSync(true).catch(() => undefined);
      setQueueSize(offlineSyncManager.getSyncQueueSize());
      setSyncMessage(offlineSyncManager.getSyncQueueRecoveryMessage());
      setSyncStatus(offlineSyncManager.getSyncQueueSize() > 0 ? "error" : "idle");
      return;
    }

    setSyncStatus("syncing");
    try {
      const { offlineSyncManager } = await import("../utils/offlineSync");
      await offlineSyncManager.startSync(true);
      setQueueSize(offlineSyncManager.getSyncQueueSize());
      setSyncMessage(offlineSyncManager.getSyncQueueRecoveryMessage());
      setSyncStatus(offlineSyncManager.getSyncQueueSize() > 0 ? "error" : "success");
    } catch {
      try {
        const { offlineSyncManager } = await import("../utils/offlineSync");
        setQueueSize(offlineSyncManager.getSyncQueueSize());
        setSyncMessage(offlineSyncManager.getSyncQueueRecoveryMessage());
      } catch {
        // Keep the current queue state when recovery details are unavailable.
      }
      setSyncStatus("error");
    }
  };

  const enqueueSubmit = async (params: {
    draftId: string;
    pathway: string;
    payload?: any;
  }): Promise<EnqueueSubmitResult> => {
    if (!isCaseSubmissionEnabled()) {
      // Exactly as before the switch existed: the report stays on this phone.
      return 'sending_off';
    }

    try {
      const { offlineSyncManager } = await import("../utils/offlineSync");
      syncManagerLoadedRef.current = true;
      await offlineSyncManager.addToSyncQueue({
        id: `submit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: "submit",
        data: { draftId: params.draftId, pathway: params.pathway, ...params.payload },
        maxRetries: 3,
      } as any);
      setQueueSize(offlineSyncManager.getSyncQueueSize());
      setSyncMessage(offlineSyncManager.getSyncQueueRecoveryMessage());
      return 'queued';
    } catch (error) {
      devPrivacyError('offline submission enqueue failed', {
        reason: getPrivacySafeErrorReason(error),
      });
      throw error;
    }
  };

  const value = useMemo<OnlineContextValue>(
    () => ({
      isOnline,
      queueSize,
      syncStatus,
      syncMessage,
      syncNow,
      enqueueSubmit,
      caseSubmissionEnabled,
    }),
    [isOnline, queueSize, syncStatus, syncMessage, caseSubmissionEnabled]
  );

  return (
    <OnlineContext.Provider value={value}>{children}</OnlineContext.Provider>
  );
}

export function useOnline() {
  const ctx = useContext(OnlineContext);
  if (!ctx) {
    throw new Error("useOnline must be used within OnlineProvider");
  }
  return ctx;
}
