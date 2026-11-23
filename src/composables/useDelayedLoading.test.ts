import { useContentRequest } from './useContentRequest';
import { useDelayedKeys } from './useDelayedKeys';
import { effectScope, nextTick, ref } from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useDelayedLoading } from './useDelayedLoading';
import { useDialogLoading } from './useDialogLoading';
import { usePendingAction } from './usePendingAction';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('discards a fast wait and gives the next request its own 200 ms', () => {
  const pending = ref(false);
  const scope = effectScope();
  const shown = scope.run(() => useDelayedLoading(() => pending.value))!;
  pending.value = true;
  vi.advanceTimersByTime(150);
  pending.value = false;
  pending.value = true;
  vi.advanceTimersByTime(199);
  expect(shown.value).toBe(false);
  vi.advanceTimersByTime(1);
  expect(shown.value).toBe(true);
  pending.value = false;
  expect(shown.value).toBe(false);
  pending.value = true;
  scope.stop();
  vi.advanceTimersByTime(200);
  expect(shown.value).toBe(false);
});

it('keeps the visible footer during exit and resets on reopening', async () => {
  const open = ref(true);
  const pending = ref(true);
  const scope = effectScope();
  const footer = scope.run(() => useDialogLoading(() => open.value, () => open.value ? { content: '确认删除', loading: pending.value } : null))!;
  expect(footer.value).toMatchObject({ disabled: true, loading: false });
  vi.advanceTimersByTime(200);
  await nextTick();
  expect(footer.value?.loading).toBe(true);
  open.value = false;
  pending.value = false;
  await nextTick();
  expect(footer.value).toMatchObject({ content: '确认删除', loading: true });
  open.value = true;
  await nextTick();
  expect(footer.value?.loading).toBe(false);
  scope.stop();
});

it('guards the first click, releases on failure and permits retry', async () => {
  let reject!: (error: Error) => void;
  const submit = vi.fn().mockImplementationOnce(() => new Promise<void>((_, no) => { reject = no; })).mockResolvedValue(undefined);
  const action = usePendingAction(submit);
  const first = action.run();
  await action.run();
  expect(submit).toHaveBeenCalledTimes(1);
  reject(new Error('提交失败'));
  await expect(first).rejects.toThrow('提交失败');
  await action.run();
  expect(submit).toHaveBeenCalledTimes(2);
});

it('tracks overlapping row operations independently', () => {
  const keys = ref<string[]>(['a']);
  const scope = effectScope();
  const visible = scope.run(() => useDelayedKeys(() => keys.value))!;
  vi.advanceTimersByTime(150);
  keys.value = ['a', 'b'];
  vi.advanceTimersByTime(50);
  expect(visible('a')).toBe(true);
  expect(visible('b')).toBe(false);
  keys.value = ['b'];
  vi.advanceTimersByTime(150);
  expect(visible('a')).toBe(false);
  expect(visible('b')).toBe(true);
  scope.stop();
});

it('ignores stale finishes when another item opens and cancels on close', () => {
  const scope = effectScope();
  const area = scope.run(useContentRequest)!;
  const first = area.start();
  vi.advanceTimersByTime(180);
  const next = area.start();
  first.finish();
  expect(first.current()).toBe(false);
  vi.advanceTimersByTime(199);
  expect(area.indicator.value).toBe(false);
  vi.advanceTimersByTime(1);
  expect(area.indicator.value).toBe(true);
  area.cancel();
  expect(next.current()).toBe(false);
  expect(area.indicator.value).toBe(false);
  scope.stop();
});
