import { computed, onScopeDispose, watch, type Ref, type WatchStopHandle } from 'vue';
import type { FormInstanceFunctions } from 'tdesign-vue-next';
import { fieldFeedback, useFormFeedback } from './formValidation';
import { ApiFieldError } from '@/services/http';
import { getSafeErrorMessage } from '@/components/foundation/feedback/adminFeedback';
import { rejectFormSubmission, type ValidationLocationOptions } from './submitValidation';

type Fields = () => Record<string, unknown>;

/** Snapshot only the editable controls when a specific form submits. */
export function useServerFields(
  active: () => boolean,
  root: Ref<unknown>,
  fields: Fields,
  show: (field: string, message: string) => void,
  location?: ValidationLocationOptions,
  clear?: (field: string) => void,
) {
  const currentFields = computed(fields);
  const clearing = new Map<string, WatchStopHandle>();
  let generation = 0;
  function invalidate() {
    generation++;
    for (const stop of clearing.values()) stop();
    clearing.clear();
  }
  watch(active, invalidate, { flush: 'sync' });
  onScopeDispose(invalidate);
  return (options: { inlineOnly?: boolean } = {}) => {
    const request = ++generation;
    const submitted = Object.fromEntries(Object.entries(currentFields.value).map(([key, value]) => [key, JSON.stringify(value)]));
    return async (error: unknown): Promise<boolean> => {
      if (!(error instanceof ApiFieldError)) return false;
      const known = error.fields.filter(item => Object.hasOwn(submitted, item.field));
      if (!known.length) return false;
      if (request !== generation || !active()) return true;
      if (!root.value) return false;
      const current = currentFields.value;
      const shown = new Set<string>();
      for (const { field, message } of known) {
        if (shown.has(field) || !Object.hasOwn(current, field) || JSON.stringify(current[field]) !== submitted[field]) continue;
        show(field, getSafeErrorMessage(new Error(message), '请检查此项内容'));
        if (clear) {
          clearing.get(field)?.();
          const stop = watch(() => JSON.stringify(currentFields.value[field]), () => {
            clearing.delete(field);
            clear(field);
          }, { once: true, flush: 'sync' });
          clearing.set(field, stop);
        }
        shown.add(field);
      }
      if (shown.size && !options.inlineOnly) await rejectFormSubmission(root.value, location);
      return true;
    };
  };
}

export function useServerFieldValidation(
  active: () => boolean,
  form: Ref<FormInstanceFunctions | undefined>,
  fields: Fields,
  options: { names?: Record<string, string>; messages?: Record<string, string> } = {},
) {
  return useServerFields(active, form, fields, (key, reason) => {
    const field = options.names?.[key] ?? key;
    const message = options.messages?.[reason] ?? reason;
    form.value?.setValidateMessage({ [field]: [{ type: 'error', message }] });
  }, undefined, key => form.value?.clearValidate([options.names?.[key] ?? key]));
}

/** Custom fields (uploads, rich text and table editors) share the same submit path. */
export function useBoundServerFields(
  active: Ref<boolean>,
  root: Ref<unknown>,
  fields: Fields,
  location?: ValidationLocationOptions,
) {
  const feedback = useFormFeedback(active);
  const values = computed(fields);
  const begin = useServerFields(() => active.value, root, () => values.value, (key, reason) => {
    feedback.reject(key, values.value[key], reason);
  }, location, key => feedback.clearField(key));
  function field(key: string, fallback?: ReturnType<typeof fieldFeedback>) {
    const result = feedback.field(key, values.value[key]);
    return result.status || !fallback ? result : fallback;
  }
  return { begin, field };
}
