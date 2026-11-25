<template>
  <t-image
    v-if="url"
    :src="url"
    :alt="service.name"
    :width="48"
    :height="48"
    fit="contain"
    role="button"
    tabindex="0"
    :aria-label="'预览' + service.name + '主图'"
    @keydown.enter.prevent="$emit('preview', url)"
    @keydown.space.prevent="$emit('preview', url)"
    @click="$emit('preview', url)"
  />
  <img v-else :src="defaultImage" width="48" height="48" :alt="service.imageId ? '服务主图' : '默认图片'" />
</template>
<script setup lang="ts">
import defaultImage from './default-image.png';
import { ref, watch } from 'vue';
import { loadServiceImage, type StoreService } from '@/services/storeServices';
import { getLoginUser } from '@/services/auth';
const props = defineProps<{ service: StoreService }>();
defineEmits<{ preview: [url: string] }>();
const url = ref('');
watch(
  [() => props.service.imageId, () => props.service.id, getLoginUser],
  async (_, __, cleanup) => {
    let current = true;
    url.value = '';
    cleanup(() => {
      current = false;
      if (url.value) URL.revokeObjectURL(url.value);
    });
    if (!props.service.imageId) return;
    try {
      const image = await loadServiceImage(props.service);
      if (current) url.value = image;
      else URL.revokeObjectURL(image);
    } catch {
      /* A protected image can disappear between list and image requests. */
    }
  },
  { immediate: true },
);
</script>
