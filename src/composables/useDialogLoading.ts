import { computed, shallowRef, watch } from 'vue';
import type { ButtonProps } from 'tdesign-vue-next';
import { useDelayedLoading } from './useDelayedLoading';

export function useDialogLoading(visible: () => boolean, button: () => ButtonProps | null) {
  const spinning = useDelayedLoading(() => visible() && Boolean(button()?.loading));
  const rendered = shallowRef<ButtonProps | null>(null);
  const current = computed(() => {
    const props = button();
    if (!props || props.loading === undefined) return props;
    return {
      ...props,
      'data-loading-button': '',
      'data-awaiting-feedback': props.loading && !spinning.value ? '' : undefined,
      disabled: props.disabled || props.loading,
      loading: spinning.value,
    };
  });
  // Keep the last visible footer during the dialog's leave transition.
  watch([visible, current], ([open, props]) => {
    if (open) rendered.value = props;
  }, { immediate: true });
  return rendered;
}
