<template>
  <AdminDialog
    :visible="visible"
    :confirm-function="props.function"
    :confirm-btn="{ loading }"
    :header="dialogTitle"
    :width="width"
    dialog-class-name="zdm-admin-confirm-dialog"
    :confirmation="confirmation"
    @update:visible="emit('update:visible', $event)"
    @confirm="emit('confirm')"
    @cancel="emit('cancel')"
    @close="emit('close')"
    @opened="emit('opened')"
    @closed="emit('closed')"
  >
    <div class="zdm-admin-confirm-dialog__content">
      <slot>{{ dialogDescription }}</slot>
    </div>
  </AdminDialog>
</template>

<script setup lang="ts">
import { confirmationQuestion, operationConfirmation, type Confirmation } from './actions/confirmation';
import { type ButtonFunction } from './actions/buttonFunctions';
import { computed } from 'vue';

import AdminDialog from './AdminDialog.vue';

const props = withDefaults(
  defineProps<{
    function: ButtonFunction;
    action: string;
    batch?: boolean;
    description?: string;
    loading?: boolean;
    objectName?: string;
    objectType?: string;
    title?: string;
    visible: boolean;
    width?: string;
  }>(),
  {
    batch: false,
    description: '',
    loading: false,
    objectName: '',
    objectType: '',
    title: '',
    width: '480px',
  },
);

const emit = defineEmits<{
  'update:visible': [value: boolean];
  cancel: [];
  close: [];
  closed: [];
  confirm: [];
  opened: [];
}>();

const targetText = computed(() => {
  const name = props.objectName ? `“${props.objectName}”` : '';
  return `${props.objectType}${name}`;
});
const dialogTitle = computed(() => props.title || confirmationQuestion(props.action, props.objectType, props.batch));
const confirmation = computed<Confirmation>(() =>
  props.visible ? operationConfirmation(props.action, props.batch) : { kind: 'none' },
);
const dialogDescription = computed(() => props.description || `是否${props.action}${targetText.value}？`);
</script>

<style scoped>
.zdm-admin-confirm-dialog__content {
  color: var(--td-text-color-secondary);
  font: var(--td-font-body-medium);
  overflow-wrap: anywhere;
}
</style>
