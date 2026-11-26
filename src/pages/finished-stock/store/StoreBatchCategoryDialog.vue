<template>
  <AdminDialog :visible="true" header="批量设置商品分类" width="min(920px, 94vw)"
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
    <t-space v-if="path.length" direction="vertical" size="medium" class="category-selection-summary">
      <div class="category-picker-path">已选择：{{ path.map(id => byId.get(id)?.name).join(' > ') }}</div>
      <t-alert v-if="leaf" theme="warning">
        <div class="category-warning-description">
          {{ leaf.coefficient == null
            ? '所选分类未设置价格系数，商品移入该分类，售价保持不变'
            : '所选分类已设置价格系数，商品移入该分类，售价将跟随该分类所设置系数，自动重算（手动设置的售价不变，不参与重算）。' }}
        </div>
      </t-alert>
    </t-space>
  </AdminDialog>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeCategoryTree } from './storeCategoryTree';
import type { StoreFinishedEditCategory as Category } from '@/services/storeFinishedStock';
import { AdminDialog } from '@/components/foundation';
import { operationConfirmation } from '@/components/foundation/actions/confirmation';
const props = defineProps<{ categories: Category[]; busy: boolean }>();
const emit = defineEmits<{ submit: [id: number]; cancel: [] }>();
const path = ref<number[]>([]);
const byId = computed(() => new Map(props.categories.map(c => [c.id, c])));
const tree = computed(() => storeCategoryTree(props.categories));
const available = computed(() => props.categories.filter(item => tree.value.enabledIds.has(item.id)));
function hasChildren(id: number) { return !tree.value.leafIds.has(id); }
const columns = computed(() => [null, path.value[0], path.value[1]].map(parent =>
  parent === undefined ? [] : tree.value.children.get(parent) ?? []));
const leaf = computed(() => {
  const id = path.value.at(-1);
  return id != null && tree.value.leafIds.has(id) ? byId.value.get(id) : undefined;
});
</script>
<style scoped>
@import url('../shared/category-picker.css');

.category-selection-summary {
  display: flex;
}

.category-warning-description {
  font: var(--td-font-body-small);
  color: var(--td-text-color-secondary);
}
</style>
