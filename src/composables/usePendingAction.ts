import { ref } from 'vue';

export function usePendingAction<Args extends unknown[]>(submit: (...args: Args) => Promise<unknown>) {
  const pending = ref(false);
  async function run(...args: Args) {
    if (pending.value) return;
    pending.value = true;
    try {
      await submit(...args);
    } finally {
      pending.value = false;
    }
  }
  return { pending, run };
}
