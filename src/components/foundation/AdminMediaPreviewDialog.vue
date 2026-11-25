<template>
  <AdminDialog
    :visible="visible"
    :header="header"
    :confirmation="{ kind: 'none' }"
    confirm-function="close"
    dialog-class-name="zdm-media-preview"
    width="min(960px, 94vw)"
    mode="modal"
    show-overlay
    close-on-overlay-click
    :footer="false"
  >
    <slot />
  </AdminDialog>
</template>

<script setup lang="ts">
import AdminDialog from './AdminDialog.vue';

defineProps<{ visible: boolean; header: string }>();
</script>

<style>
/* TDesign's centered dialog reserves 48px above and below the card. */
.t-dialog.zdm-media-preview {
  display: flex;
  flex-direction: column;
  max-height: calc(100dvh - 96px);
}

.zdm-media-preview .t-dialog__body,
.zdm-media-preview__group {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.zdm-media-preview .t-dialog__header,
.zdm-media-preview .t-dialog__body > .t-alert {
  flex-shrink: 0;
}

.zdm-media-preview :is(img, video) {
  display: block;
  align-self: center;
  max-width: 100%;
  min-height: 0;
  object-fit: contain;
}
</style>
