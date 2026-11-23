import { getCurrentScope, onScopeDispose, reactive, watch } from 'vue';
import { loadingDelayMs } from './useDelayedLoading';

/** Each row has its own timer, so one slow action cannot animate another row. */
export function useDelayedKeys(pendingKeys: () => string[]) {
  const shown = reactive(new Set<string>());
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const stop = watch(pendingKeys, keys => {
    const pending = new Set(keys);
    for (const [key, timer] of timers) {
      if (!pending.has(key)) {
        clearTimeout(timer);
        timers.delete(key);
      }
    }
    for (const key of shown) if (!pending.has(key)) shown.delete(key);
    for (const key of pending) {
      if (shown.has(key) || timers.has(key)) continue;
      timers.set(key, setTimeout(() => {
        timers.delete(key);
        shown.add(key);
      }, loadingDelayMs));
    }
  }, { immediate: true, flush: 'sync' });
  if (getCurrentScope()) onScopeDispose(() => {
    stop();
    for (const timer of timers.values()) clearTimeout(timer);
  });
  return (key: string) => shown.has(key);
}
