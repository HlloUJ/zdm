import { defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { describe, expect, it, vi } from 'vitest';
import { useOperationPreflight, requireCondition } from './useOperationPreflight';
import { getLoginUser, setLoginUser } from '@/services/auth';

function gate() {
  let finish!: () => void;
  const wait = new Promise<void>((resolve) => { finish = resolve; });
  return { finish, wait };
}
describe('useOperationPreflight lifetime', () => {
  it('deduplicates a check and discards it after a route, tab, identity change or unmount', async () => {
    const router = createRouter({history:createMemoryHistory(), routes:[{path:'/:id',component:{render:()=>null}}]});
    await router.push('/a');
    const scope = ref(0);
    let operations!: ReturnType<typeof useOperationPreflight>;
    const wrapper = mount(defineComponent({ setup() { operations = useOperationPreflight(() => scope.value); return () => h('i'); } }), {global:{plugins:[router]}});
    const next = vi.fn();
    const previous = getLoginUser();
    for (const change of [() => router.push('/b'), () => { scope.value++; }, () => setLoginUser({...previous, identityId:99}), () => wrapper.unmount()]) {
      const hold = gate();
      const inspect = vi.fn(() => hold.wait);
      const first = operations.check('shelf:1', inspect, next);
      await operations.check('shelf:1', inspect, next);
      expect(inspect).toHaveBeenCalledTimes(1);
      expect(operations.pending('shelf:1')).toBe(true);
      await change();
      hold.finish();
      await first;
      expect(next).not.toHaveBeenCalled();
      expect(operations.pending('shelf:1')).toBe(false);
    }
    setLoginUser(previous);
  });
  it('keeps the newer execution locked when an invalidated execution finishes', async () => {
    let operations!: ReturnType<typeof useOperationPreflight>;
    const wrapper = mount(defineComponent({setup() { operations = useOperationPreflight(); return () => h('i'); }}));
    const old = gate(), fresh = gate();
    const writes: string[] = [];
    const first = operations.execute('delete:2', async (current) => { await old.wait; if (current()) writes.push('old'); });
    operations.invalidate();
    const second = operations.execute('delete:2', async (current) => { await fresh.wait; if (current()) writes.push('fresh'); });
    old.finish(); await first;
    expect(operations.pending('delete:2')).toBe(true);
    fresh.finish(); await second;
    expect(writes).toEqual(['fresh']);
    expect(() => requireCondition(false)).toThrow();
    wrapper.unmount();
  });
});
