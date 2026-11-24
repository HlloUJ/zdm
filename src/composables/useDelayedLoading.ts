import { onScopeDispose, ref, watch } from 'vue';

export const loadingDelayMs = 200;

/** Delay the indicator only. Business operations use their own immediate pending state. */
export function useDelayedLoading(pending: () => boolean) {
  const visible = ref(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  function clearTimer() {
    clearTimeout(timer);
    timer = undefined;
  }
  watch(pending, (waiting) => {
    clearTimer();
    if (!waiting) {
      visible.value = false;
      return;
    }
    timer = setTimeout(() => { visible.value = true; }, loadingDelayMs);
  }, { immediate: true, flush: 'sync' });
  onScopeDispose(clearTimer);
  return visible;
}
