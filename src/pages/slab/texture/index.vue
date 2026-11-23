<template>
  <div class="admin-layout">
    <AdminTopNav />
    <div class="admin-shell">
      <AdminSideMenu />
      <main class="page">
        <section class="filter-card">
          <t-form class="zdm-admin-filter-form zdm-standard-query" label-width="80px" :data="searchForm" colon>
            <div class="filter-row">
              <div class="filter-fields">
                <t-form-item label="纹理" name="name">
                  <t-input v-model="searchForm.name" clearable placeholder="请输入纹理" />
                </t-form-item>
                <t-form-item label="别名" name="alias">
                  <t-input v-model="searchForm.alias" clearable placeholder="请输入别名" />
                </t-form-item>
                <t-form-item class="zdm-status-filter" label="状态" name="status">
                  <t-select v-model="searchForm.status" clearable placeholder="请选择状态">
                    <t-option label="启用" value="normal" />
                    <t-option label="停用" value="disabled" />
                  </t-select>
                </t-form-item>
              </div>
              <div class="filter-actions">
                <t-button :theme="buttonTheme('search')" @click="handleSearch"
                  ><template #icon><t-icon name="search" /></template>查询</t-button
                >
                <t-button :theme="buttonTheme('reset')" variant="base" @click="handleReset"
                  ><template #icon><t-icon name="refresh" /></template>重置</t-button
                >
              </div>
            </div>
          </t-form>
        </section>

        <section class="table-card">
          <AdminListToolbar :has-actions="canCreate"
            ><t-button v-if="canCreate" :theme="buttonTheme('create')" @click="openCreate"
              ><template #icon><t-icon name="add" /></template>新增</t-button
            ></AdminListToolbar
          >
          <t-table row-key="id" :data="pageData" :columns="columns" :loading="contentLoading || preparation.indicator.value" hover table-layout="fixed">
            <template #index="{ rowIndex }">{{
              (pagination.current - 1) * pagination.pageSize + rowIndex + 1
            }}</template>
            <template #status="{ row }">
              <t-tag :theme="row.status === 'normal' ? 'success' : 'danger'" variant="light">{{
                row.status === 'normal' ? '启用' : '停用'
              }}</t-tag>
            </template>
            <template #operation="{ row }">
              <div class="table-actions">
                <t-link v-if="canManageAliases" :theme="buttonTheme('aliases')" hover="color" @click="openAliases(row)"
                  >别名</t-link
                >
                <t-link v-if="canEdit" :theme="buttonTheme('edit')" hover="color" @click="openEdit(row)">编辑</t-link>
                <t-link
                  v-if="canToggle"
                  :theme="buttonTheme(row.status === 'normal' ? 'disable' : 'enable')"
                  hover="color"
                  @click="openConfirm(row, row.status === 'normal' ? 'disable' : 'enable')"
                  >{{ row.status === 'normal' ? '停用' : '启用' }}</t-link
                >
                <t-link
                  v-if="canDelete"
                  :theme="buttonTheme('delete')"
                  hover="color"
                  :disabled="operations.pending(`delete:${row.id}`)"
                    @click="openConfirm(row, 'delete')"
                  ><template #prefix-icon>
                    <span class="row-loading-slot">
                      <t-loading v-if="operations.checkingIndicator(`delete:${row.id}`)" size="small" />
                    </span>
                  </template>删除</t-link
                >
              </div>
            </template>
          </t-table>
          <AdminPagination
            v-model:current="pagination.current"
            v-model:page-size="pagination.pageSize"
            :total="filteredData.length"
            :page-size-options="[10, 20, 50]"
          />
        </section>
      </main>
    </div>

    <AdminDialog
      v-model:visible="formVisible"
      :confirmation="formConfirmation(editingId ? 'edit' : 'create')"
      confirm-function="submit"
      dialog-class-name="zdm-admin-dialog zdm-admin-single-form"
      width="480px"
      :header="editingId ? '编辑纹理' : '新增纹理'"
      :confirm-btn="{ loading: submitTexturePending }"
      @confirm="submitTextureOnce"
      @cancel="formVisible = false"
      @close="formVisible = false"
    >
      <t-form ref="formRef" :data="formData" :rules="formRules" label-width="100px" colon>
        <t-form-item label="标准纹理" name="name"
          ><t-input v-model="formData.name" clearable placeholder="请输入标准纹理"
        /></t-form-item>
        <t-form-item label="备注" name="remark"
          ><t-textarea v-model="formData.remark" placeholder="请输入备注" :maxlength="100" :autosize="{}"
        /></t-form-item>
      </t-form>
    </AdminDialog>

    <AdminDialog
      v-model:visible="aliasesVisible"
      :confirmation="{ kind: 'close', text: '关闭' }"
      confirm-function="close"
      :header="`别名管理 - ${activeTexture?.name ?? ''}`"
      width="680px"
      :cancel-btn="null"
      @confirm="aliasesVisible = false"
      @close="aliasesVisible = false"
    >
      <div class="table-toolbar">
        <t-button :theme="buttonTheme('create')" @click="openAliasForm()"
          ><template #icon><t-icon name="add" /></template>新增别名</t-button
        >
      </div>
      <t-table row-key="id" :data="aliases" :loading="aliasList.indicator.value" :columns="aliasColumns" table-layout="fixed">
        <template #operation="{ row }">
          <div class="table-actions">
            <t-link :theme="buttonTheme('edit')" hover="color" @click="openAliasForm(row)">编辑</t-link>
            <t-link :theme="buttonTheme('delete')" hover="color" @click="removeAlias(row)" :disabled="operations.pending(`remove-alias:${row.id}`)">
              <template #prefix-icon>
                <span class="row-loading-slot">
                  <t-loading v-if="operations.indicator(`remove-alias:${row.id}`)" size="small" />
                </span>
              </template>删除</t-link>
          </div>
        </template>
      </t-table>
    </AdminDialog>

    <AdminDialog
      v-model:visible="aliasFormVisible"
      :confirmation="formConfirmation(editingAliasId ? 'edit' : 'create')"
      confirm-function="submit"
      dialog-class-name="zdm-admin-dialog zdm-admin-single-form"
      width="480px"
      :header="editingAliasId ? '编辑别名' : '新增别名'"
      :confirm-btn="{ loading: submitAliasPending }"
      @confirm="submitAliasOnce"
      @cancel="aliasFormVisible = false"
      @close="aliasFormVisible = false"
    >
      <t-form ref="aliasFormRef" :data="aliasForm" :rules="aliasRules" label-width="100px" colon>
        <t-form-item label="别名" name="name"
          ><t-input v-model="aliasForm.name" clearable placeholder="请输入别名"
        /></t-form-item>
      </t-form>
    </AdminDialog>

    <AdminConfirmDialog
      v-model:visible="confirmVisible"
      :function="buttonFunctionFor('status', confirmType)"
      :action="confirmType === 'delete' ? '删除' : confirmType === 'disable' ? '停用' : '启用'"
      object-type="纹理"
      :object-name="confirmRow?.name"
      :loading="operations.pending(`${confirmType}:${confirmRow?.id}`)"
      @confirm="submitConfirm"
      @cancel="confirmVisible = false"
      @close="confirmVisible = false"
    >
      <template v-if="confirmType === 'delete'" #default>
        是否删除纹理“{{ confirmRow?.name }}”？删除标准纹理后，其全部别名也会被删除。
      </template>
    </AdminConfirmDialog>
  </div>
</template>

<script setup lang="ts">
import { useContentRequest } from '@/composables/useContentRequest';
import { usePendingAction } from '@/composables/usePendingAction';
import { getSafeErrorMessage } from '@/components/foundation/feedback/adminFeedback';
import { checkSlabTextureDelete } from '@/services/slabTextures';
import { useOperationPreflight, requireCondition } from '@/composables/useOperationPreflight';
import { formConfirmation } from '@/components/foundation/actions/confirmation';
import { buttonTheme, buttonFunctionFor } from '@/components/foundation/actions/buttonFunctions';
import { rejectFormSubmission } from '@/utils/submitValidation';
import AdminListToolbar from '@/components/foundation/AdminListToolbar.vue';
import type { FormInstanceFunctions, FormRule, PrimaryTableCol, TableRowData } from 'tdesign-vue-next';
import { computed, onMounted, reactive, ref } from 'vue';
import AdminSideMenu from '@/components/AdminSideMenu.vue';
import AdminTopNav from '@/components/AdminTopNav.vue';
import { adminFeedback, AdminConfirmDialog, AdminDialog, AdminPagination } from '@/components/foundation';
import { getLoginUser } from '@/services/auth';
import { hasPermission } from '@/services/adminPermissions';
import { sortByCreatedAtDesc } from '@/services/recordSorting';
import {
  createSlabTexture,
  createSlabTextureAlias,
  deleteSlabTexture,
  deleteSlabTextureAlias,
  listSlabTextureAliases,
  listSlabTextures,
  updateSlabTexture,
  updateSlabTextureAlias,
  updateSlabTextureStatus,
  type SlabTextureAliasRecord,
  type SlabTextureRecord,
} from '@/services/slabTextures';

type TextureItem = Omit<SlabTextureRecord, 'status'> & { status: 'normal' | 'disabled'; aliasCount: number };
type ConfirmType = 'enable' | 'disable' | 'delete';
const operations = useOperationPreflight();
const preparation = useContentRequest();
operations.onInvalidate(preparation.cancel);
const prefix = 'admin.product-data-center.slab-texture';
const user = computed(() => getLoginUser());
const canCreate = computed(() => hasPermission(user.value, `${prefix}.create`));
const canEdit = computed(() => hasPermission(user.value, `${prefix}.edit`));
const canToggle = computed(() => hasPermission(user.value, `${prefix}.toggle-status`));
const canDelete = computed(() => hasPermission(user.value, `${prefix}.delete`));
const canManageAliases = computed(() => hasPermission(user.value, `${prefix}.manage-aliases`));
const listRequest = useContentRequest();
const loading = listRequest.pending;
const tableData = ref<TextureItem[]>([]);
const aliasesByTexture = reactive<Record<number, SlabTextureAliasRecord[]>>({});
const searchForm = reactive({ name: '', alias: '', status: '' });
const applied = reactive({ ...searchForm });
const pagination = reactive({ current: 1, pageSize: 10 });
const columns = computed<PrimaryTableCol<TableRowData>[]>(() => [
  { colKey: 'index', title: '序号', width: 88, align: 'left' },
  { colKey: 'name', title: '标准纹理', minWidth: 200, align: 'left' },
  { colKey: 'aliasCount', title: '别名数量', width: 120 },
  { colKey: 'status', title: '状态', width: 120 },
  { colKey: 'createdByName', title: '创建人', width: 120 },
  { colKey: 'createdAt', title: '创建时间', width: 180 },
  {
    colKey: 'operation',
    title: '操作',
    width: 196,
    align: 'left',
    fixed: 'right',
  },
]);
const aliasColumns: PrimaryTableCol<TableRowData>[] = [
  { colKey: 'name', title: '别名', minWidth: 260, align: 'left' },
  { colKey: 'operation', title: '操作', width: 116, align: 'left' },
];
const filteredData = computed(() =>
  tableData.value.filter(
    (item) =>
      (!applied.name.trim() || item.name.includes(applied.name.trim())) &&
      (!applied.alias.trim() ||
        aliasesByTexture[item.id]?.some((alias) => alias.name.includes(applied.alias.trim()))) &&
      (!applied.status || item.status === applied.status),
  ),
);
const pageData = computed(() =>
  filteredData.value.slice((pagination.current - 1) * pagination.pageSize, pagination.current * pagination.pageSize),
);
const formatDate = (value?: string) => (value ? value.replace(/-/g, '/').replace('T', ' ').slice(0, 16) : '-');
const loadData = async () => {
  const request = listRequest.start();
  try {
    const records = sortByCreatedAtDesc(await listSlabTextures());
    const aliasLists = await Promise.all(records.map((item) => listSlabTextureAliases(item.id)));
    if (!request.current()) return;
    records.forEach((item, index) => {
      aliasesByTexture[item.id] = aliasLists[index];
    });
    tableData.value = records.map((item) => ({
      ...item,
      status: item.status === 'disabled' ? 'disabled' : 'normal',
      createdByName: item.createdByName ?? '-',
      createdAt: formatDate(item.createdAt),
      aliasCount: aliasesByTexture[item.id].length,
    }));
  } catch (error) {
    if (!request.current()) return;
    adminFeedback.error(error instanceof Error ? error.message : '纹理列表加载失败');
  } finally {
    request.finish();
  }
};
const handleSearch = () => {
  Object.assign(applied, searchForm);
  pagination.current = 1;
};
const handleReset = () => {
  Object.assign(searchForm, { name: '', alias: '', status: '' });
  pagination.pageSize = 10;
  handleSearch();
};

const formRef = ref<FormInstanceFunctions>();
const formVisible = ref(false);
const editingId = ref<number | null>(null);
const formData = reactive({ name: '', remark: '' });
const formRules: Record<string, FormRule[]> = {
  name: [{ required: true, message: '请输入标准纹理', type: 'error' }],
  remark: [{ max: 100, message: '备注最多输入100个汉字', type: 'error' }],
};
const openCreate = () => {
  editingId.value = null;
  Object.assign(formData, { name: '', remark: '' });
  formVisible.value = true;
};
const openEdit = (row: TextureItem) => {
  editingId.value = row.id;
  Object.assign(formData, { name: row.name, remark: row.remark ?? '' });
  formVisible.value = true;
};
const submitTexture = async () => {
  if ((await formRef.value?.validate()) !== true) return rejectFormSubmission(formRef.value);
  try {
    const payload = { name: formData.name.trim(), remark: formData.remark.trim(), status: 'enabled' as const };
    if (editingId.value) {
      await updateSlabTexture(editingId.value, payload);
      adminFeedback.actionSuccess({ action: '修改', target: payload.name });
    } else {
      await createSlabTexture(payload);
      adminFeedback.created(payload.name);
    }
    formVisible.value = false;
    await loadData();
  } catch (error) {
    adminFeedback.error(error instanceof Error ? error.message : '提交失败');
  }
};

const aliasesVisible = ref(false);
const activeTexture = ref<TextureItem | null>(null);
const aliases = ref<SlabTextureAliasRecord[]>([]);
const aliasList = useContentRequest();
async function refreshAliases(textureId: number) {
  const request = aliasList.start();
  try {
    const records = await listSlabTextureAliases(textureId);
    if (request.current() && activeTexture.value?.id === textureId) aliases.value = records;
  } catch (error) {
    if (request.current()) adminFeedback.error(error instanceof Error ? error.message : '别名列表加载失败');
  } finally {
    request.finish();
  }
}
const openAliases = async (row: TextureItem) => {
  const request = preparation.start();
  try {
    const records = await listSlabTextureAliases(row.id);
    if (!request.current()) return;
    activeTexture.value = row;
    aliases.value = records;
    aliasesVisible.value = true;
  } finally {
    request.finish();
  }
};
const aliasFormRef = ref<FormInstanceFunctions>();
const aliasFormVisible = ref(false);
const editingAliasId = ref<number | null>(null);
const aliasForm = reactive({ name: '' });
const aliasRules: Record<string, FormRule[]> = { name: [{ required: true, message: '请输入纹理别名', type: 'error' }] };
const openAliasForm = (row?: SlabTextureAliasRecord) => {
  editingAliasId.value = row?.id ?? null;
  aliasForm.name = row?.name ?? '';
  aliasFormVisible.value = true;
};
const submitAlias = async () => {
  if ((await aliasFormRef.value?.validate()) !== true) return rejectFormSubmission(aliasFormRef.value);
  if (!activeTexture.value) return;
  const name = aliasForm.name.trim();
  try {
    if (editingAliasId.value) {
      await updateSlabTextureAlias(activeTexture.value.id, editingAliasId.value, name);
      adminFeedback.actionSuccess({ action: '修改', target: name });
    } else {
      await createSlabTextureAlias(activeTexture.value.id, name);
      adminFeedback.created(name);
    }
    aliasFormVisible.value = false;
    await refreshAliases(activeTexture.value.id);
    await loadData();
  } catch (error) {
    adminFeedback.error(error instanceof Error ? error.message : '别名提交失败');
  }
};
const removeAlias = async (row: SlabTextureAliasRecord) => {
  const textureId = activeTexture.value?.id;
  if (!textureId) return;
  const key = `remove-alias:${row.id}`;
  await operations.execute(key, async (current) => {
    try {
      await deleteSlabTextureAlias(textureId, row.id);
    } catch (error) {
      if (current()) adminFeedback.error(error instanceof Error ? error.message : '删除失败');
      return;
    }
    if (!current()) return;
    adminFeedback.deleted(row.name);
    if (activeTexture.value?.id === textureId) void refreshAliases(textureId);
    void loadData();
  });
};

const confirmVisible = ref(false);
const confirmRow = ref<TextureItem | null>(null);
const confirmType = ref<ConfirmType>('disable');
const openConfirm = (row: TextureItem, type: ConfirmType) => {
  const key = `${type}:${row.id}`;
  const open = () => {
    confirmRow.value = row;
    confirmType.value = type;
    confirmVisible.value = true;
  };
  if (type === 'delete') {
    return operations.check(key, () => checkSlabTextureDelete(row.id).then(requireCondition), open);
  }
  operations.select(key);
  open();
};
const submitConfirm = async () => {
  if (!confirmRow.value) return;
  const target = confirmRow.value;
  const operationType = confirmType.value;
  await operations.execute(`${operationType}:${target.id}`, async (current) => {
    try {
      if (operationType === 'delete') {
        const deleted = await deleteSlabTexture(target.id);
        if (!current()) return;
        if (!deleted) throw new Error('纹理未删除，请刷新后重试');
        adminFeedback.deleted(target.name);
      } else {
        const next = operationType === 'disable' ? 'disabled' : 'enabled';
        await updateSlabTextureStatus(target.id, next);
        if (!current()) return;
        adminFeedback.actionSuccess({ action: next === 'enabled' ? '启用' : '停用', target: target.name });
      }
      confirmVisible.value = false;
      await loadData();
      if (!current()) return;
    } catch (error) {
      if (!current()) return;
      adminFeedback.error(getSafeErrorMessage(error, '操作失败'));
    }
  });
};

onMounted(loadData);

const contentLoading = listRequest.indicator;

const { pending: submitTexturePending, run: submitTextureOnce } = usePendingAction(submitTexture);
const { pending: submitAliasPending, run: submitAliasOnce } = usePendingAction(submitAlias);
</script>

<style scoped>
.filter-card,
.table-card {
  background: var(--td-bg-color-container);
  padding: var(--td-comp-paddingTB-xxl) var(--td-comp-paddingLR-xxl);
  border-radius: var(--td-radius-medium);
}
.table-card {
  margin-top: var(--td-comp-margin-xxl);
  padding: var(--td-comp-paddingTB-xxl) var(--td-comp-paddingLR-xxl);
  border-radius: var(--td-radius-medium);
}
.table-actions {
  display: flex;
  align-items: center;
  gap: var(--td-comp-margin-s) var(--td-comp-margin-l);
}
.table-toolbar {
  display: flex;
  justify-content: flex-start;
  align-items: center;
  margin-bottom: var(--td-comp-margin-xxl);
}
.table-actions {
  justify-content: flex-start;
  gap: var(--td-comp-margin-m) var(--td-comp-margin-l);
}
@media (max-width: 960px) {
  .page-header {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
