<template>
  <AdminDialog :visible="true" header="批量设置分类" width="min(920px, 94vw)"
    confirm-function="batch-fill" :confirmation="operationConfirmation('设置分类', true)"
    :confirm-btn="{ disabled: !leaf || busy, loading: busy }"
    @confirm="leaf && !busy && emit('submit', leaf.id)" @close="!busy && emit('cancel')" @cancel="!busy && emit('cancel')">
    <t-empty v-if="!available.length" description="当前模块暂无可选分类" />
    <div v-else class="category-picker">
      <div v-for="(column, index) in columns" :key="index" class="category-column">
        <div class="category-column-title">第{{ index + 1 }}级分类</div>
        <div class="category-option-list">
          <button v-for="item in column" :key="item.id" type="button" :disabled="busy"
            :class="['category-option', path[index] === item.id && 'active']"
            @click="path = [...path.slice(0,index), item.id]">
            <span>{{ item.name }}</span><t-icon v-if="hasChildren(item.id)" name="chevron-right" />
          </button>
          <t-empty v-if="!column.length" description="请先选择上级分类" />
        </div>
      </div>
    </div>
    <div v-if="path.length" class="category-picker-path">已选择：{{ path.map(id => byId.get(id)?.name).join(' > ') }}</div>
    <t-alert v-if="leaf && leaf.coefficient == null" theme="warning" title="该分类未设置价格系数">
      <div>更换此分类，规格<strong>当前售价不变，但会转为手工定价</strong>。</div>
      <div>以后更换设有价格系数的分类，需主动切回自动定价才会重新计算。</div>
      <div>已有售价保留，未定价的规格继续留空。</div>
    </t-alert>
  </AdminDialog>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue';
import type { StoreFinishedEditCategory as Category } from '@/services/storeFinishedStock';
import { AdminDialog } from '@/components/foundation';
import { operationConfirmation } from '@/components/foundation/actions/confirmation';
const props = defineProps<{ categories: Category[]; busy: boolean }>();
const emit = defineEmits<{ submit: [id: number]; cancel: [] }>();
const path = ref<number[]>([]);
const byId = computed(() => new Map(props.categories.map(c => [c.id, c])));
const parents = computed(() => new Set(props.categories.map(category => category.parentId)));
const available = computed(() => {
  const result = new Set<number>();
  // Keep only enabled paths ending in a real leaf, including shallow categories.
  for (const item of props.categories) {
    if (hasChildren(item.id)) continue;
    const ancestors = new Set<number>();
    let node: Category | undefined = item;
    while (node && node.status === 'enabled' && !ancestors.has(node.id)) {
      ancestors.add(node.id);
      if (node.parentId == null) {
        ancestors.forEach(id => result.add(id));
        break;
      }
      node = byId.value.get(node.parentId);
    }
  }
  return props.categories.filter(c => result.has(c.id));
});
function hasChildren(id: number) { return parents.value.has(id); }
const columns = computed(() => [null, path.value[0], path.value[1]].map(parent =>
  parent === undefined ? [] : available.value.filter(item => item.parentId === parent)));
const leaf = computed(() => {
  const item = available.value.find(c => c.id === path.value.at(-1));
  return item && !hasChildren(item.id) ? item : undefined;
});
</script>
<style scoped>
@import url('../shared/category-picker.css');
</style>
