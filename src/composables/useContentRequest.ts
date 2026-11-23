import { onScopeDispose, ref } from 'vue';
import { useDelayedLoading } from './useDelayedLoading';

/** Only the active request may populate the target area or finish its indicator. */
export function useContentRequest() {
  const pending = ref(false);
  const indicator = useDelayedLoading(() => pending.value);
  let version = 0;
  function cancel() {
    version++;
    pending.value = false;
  }
  function start() {
    const ticket = ++version;
    pending.value = false;
    pending.value = true;
    const current = () => version === ticket;
    return { current, finish: () => { if (current()) pending.value = false; } };
  }
  onScopeDispose(cancel);
  return { pending, indicator, start, cancel };
}
