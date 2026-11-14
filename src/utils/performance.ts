import { useCallback, useMemo, useRef, useEffect, useState } from 'react';
import { devPrivacyInfo } from './privacyLog';

// Debounce hook for performance optimization
export function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(handler);
    };
  }, [value, delay]);

  return debouncedValue;
}

// Throttle hook for limiting function calls
export function useThrottle<T extends (...args: any[]) => any>(
  func: T,
  delay: number
): T {
  const throttling = useRef(false);
  
  return useCallback((...args: Parameters<T>) => {
    if (!throttling.current) {
      func(...args);
      throttling.current = true;
      setTimeout(() => {
        throttling.current = false;
      }, delay);
    }
  }, [func, delay]) as T;
}

// Stable callback hook to prevent unnecessary re-renders
export function useStableCallback<T extends (...args: any[]) => any>(
  callback: T
): T {
  const callbackRef = useRef(callback);
  
  useEffect(() => {
    callbackRef.current = callback;
  });
  
  return useCallback((...args: Parameters<T>) => {
    return callbackRef.current(...args);
  }, []) as T;
}

// Previous value hook for comparison
export function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T | undefined>(undefined);
  
  useEffect(() => {
    ref.current = value;
  });
  
  return ref.current;
}

// Memoized search filter hook
export function useMemoizedFilter<T>(
  items: T[],
  searchQuery: string,
  searchFields: (keyof T)[],
  filters?: { [key: string]: any }
): T[] {
  return useMemo(() => {
    let filtered = items;

    // Apply search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(item =>
        searchFields.some(field => {
          const value = item[field];
          if (typeof value === 'string') {
            return value.toLowerCase().includes(query);
          }
          if (Array.isArray(value)) {
            return value.some(v => 
              typeof v === 'string' && v.toLowerCase().includes(query)
            );
          }
          return false;
        })
      );
    }

    // Apply additional filters
    if (filters) {
      Object.entries(filters).forEach(([key, filterValue]) => {
        if (filterValue !== null && filterValue !== undefined) {
          filtered = filtered.filter(item => {
            const itemValue = (item as any)[key];
            if (Array.isArray(filterValue)) {
              return filterValue.includes(itemValue);
            }
            return itemValue === filterValue;
          });
        }
      });
    }

    return filtered;
  }, [items, searchQuery, searchFields, filters]);
}

// Performance measurement hook for development
export function usePerformance(name: string, enabled: boolean = __DEV__) {
  const startTime = useRef<number | null>(null);
  
  useEffect(() => {
    if (!enabled) return;
    
    startTime.current = performance.now();
    
    return () => {
      if (startTime.current !== null) {
        const duration = performance.now() - startTime.current;
        devPrivacyInfo('performance measurement', {
          label: name,
          durationMs: Number(duration.toFixed(2)),
        });
      }
    };
  });
}

// Image loading optimization
export function useImageLoader() {
  const [loadedImages, setLoadedImages] = useState<Set<string>>(new Set());
  const [failedImages, setFailedImages] = useState<Set<string>>(new Set());

  const preloadImage = useCallback((uri: string) => {
    if (loadedImages.has(uri) || failedImages.has(uri)) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        setLoadedImages(prev => new Set(prev).add(uri));
        resolve();
      };
      image.onerror = () => {
        setFailedImages(prev => new Set(prev).add(uri));
        reject();
      };
      image.src = uri;
    });
  }, [loadedImages, failedImages]);

  const isLoaded = useCallback((uri: string) => loadedImages.has(uri), [loadedImages]);
  const hasFailed = useCallback((uri: string) => failedImages.has(uri), [failedImages]);

  return { preloadImage, isLoaded, hasFailed };
}

// List virtualization helper for large lists
export function useVirtualization<T>(
  items: T[],
  itemHeight: number,
  containerHeight: number,
  overscan: number = 3
) {
  const [scrollTop, setScrollTop] = useState(0);

  const visibleRange = useMemo(() => {
    const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
    const endIndex = Math.min(
      items.length - 1,
      Math.ceil((scrollTop + containerHeight) / itemHeight) + overscan
    );
    
    return { startIndex, endIndex };
  }, [scrollTop, itemHeight, containerHeight, items.length, overscan]);

  const visibleItems = useMemo(() => {
    return items.slice(visibleRange.startIndex, visibleRange.endIndex + 1);
  }, [items, visibleRange]);

  const totalHeight = items.length * itemHeight;
  const offsetY = visibleRange.startIndex * itemHeight;

  return {
    visibleItems,
    totalHeight,
    offsetY,
    setScrollTop,
    visibleRange,
  };
}

// Memory management for large datasets
export function useMemoryOptimization<T>(
  data: T[],
  maxItems: number = 1000
): T[] {
  return useMemo(() => {
    if (data.length <= maxItems) {
      return data;
    }
    
    // Keep most recent items
    return data.slice(-maxItems);
  }, [data, maxItems]);
}

// Batch updates to prevent excessive re-renders
export function useBatchedUpdates() {
  const updates = useRef<(() => void)[]>([]);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const batchUpdate = useCallback((updateFn: () => void) => {
    updates.current.push(updateFn);

    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    timeoutRef.current = setTimeout(() => {
      const currentUpdates = updates.current;
      updates.current = [];
      
      currentUpdates.forEach(update => update());
      timeoutRef.current = null;
    }, 0);
  }, []);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, []);

  return batchUpdate;
}
