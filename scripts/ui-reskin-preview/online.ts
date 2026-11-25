// Preview-only context: no subscriptions, network requests, queue, or sync.
export const useOnline = () => ({
  isOnline: false, queueSize: 0, syncStatus: 'idle' as const,
  syncMessage: null, syncNow: async () => {}, enqueueSubmit: async () => {},
});
