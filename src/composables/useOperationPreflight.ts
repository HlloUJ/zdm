import { useDelayedKeys } from './useDelayedKeys';
import { getCurrentScope, inject, onScopeDispose, reactive, watch } from 'vue';
import { routeLocationKey } from 'vue-router';
import { getLoginUser } from '@/services/auth';
import { OperationBlockedError, SessionExpiredError } from '@/services/http';
import { adminFeedback, getSafeErrorMessage } from '@/components/foundation/feedback/adminFeedback';

export const checkFailed = '操作条件检查失败，请稍后重试';

export function requireCondition(result: boolean) {
  if (result !== true) throw new Error(checkFailed);
}

export function useOperationPreflight(tab: () => unknown = () => undefined) {
  const route = inject(routeLocationKey, undefined);
  const running = reactive(new Map<string, symbol>());
  const indicator = useDelayedKeys(() => Array.from(running.keys()));
  const checkingIndicator = (key: string) => indicator('check:' + key);
  const resets: (() => void)[] = [];
  let selection = '';
  let version = 0;
  let context = 0;
  let checking: { key: string; ticket: symbol } | undefined;

  function select(key: string) {
    if (selection === key) return;
    selection = key;
    version++;
    checking = undefined;
  }

  function invalidate() {
    version++;
    context++;
    selection = '';
    checking = undefined;
    running.clear();
    resets.forEach((reset) => reset());
  }

  watch([getLoginUser, () => route?.fullPath, tab], invalidate, { flush: 'sync' });
  if (getCurrentScope()) onScopeDispose(invalidate);

  async function check<T>(key: string, inspect: () => T | Promise<T>, proceed: (value: T) => unknown) {
    select(key);
    if (checking?.key === key || running.has(key)) return;
    const selected = version;
    const ticket = Symbol(key);
    checking = { key, ticket };
    running.set('check:' + key, ticket);
    let value: T;
    try {
      value = await inspect();
    } catch (error) {
      if (version === selected && !(error instanceof SessionExpiredError)) {
        if (error instanceof OperationBlockedError) adminFeedback.warning(getSafeErrorMessage(error, '当前条件不允许操作'));
        else adminFeedback.error(checkFailed);
      }
      return;
    } finally {
      if (checking?.ticket === ticket) checking = undefined;
      if (running.get('check:' + key) === ticket) running.delete('check:' + key);
    }
    if (version !== selected) return false;
    await proceed(value);
    return version === selected;
  }

  async function execute(key: string, submit: (current: () => boolean) => Promise<void>) {
    if (running.has(key)) return;
    const ticket = Symbol(key);
    const started = context;
    const selected = version;
    running.set(key, ticket);
    try {
      await submit(() => started === context && selected === version);
    } finally {
      if (running.get(key) === ticket) running.delete(key);
    }
  }

  function capture() {
    const selected = version;
    return () => selected === version;
  }
  const onInvalidate = (reset: () => void) => { resets.push(reset); };
  const pending = (key: string) => running.has(key) || running.has('check:' + key);
  return { check, execute, pending, indicator, checkingIndicator, select, invalidate, capture, onInvalidate };
}
