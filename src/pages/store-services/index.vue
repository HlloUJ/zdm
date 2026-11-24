<template>
  <div class="admin-layout">
    <AdminTopNav />
    <div class="admin-shell">
      <AdminSideMenu />
      <main class="page">
        <AdminListPage
          :table-props="{ rowKey: 'id', columns, data: rows, loading, pagination }"
          :actions="can('create') ? [{ id: 'create', label: '新增', function: 'create' }] : []"
          @action="openCreate"
          @page-change="
            (p) => {
              page = p.current;
              pageSize = p.pageSize;
            }
          "
        >
          <template #image="{ row }"><ServiceImage :service="row" @preview="preview = $event" /></template>
          <template #status="{ row }"
            ><t-tag :theme="row.status === 'enabled' ? 'success' : 'default'" variant="light">
              {{ row.status === 'enabled' ? '启用' : '停用' }}</t-tag
            ></template
          >
          <template #createdAt="{ row }">{{ row.createdAt.replace('T', ' ').slice(0, 19) }}</template>
          <template #operation="{ row }">
            <div class="table-actions">
              <t-link v-if="can('edit')" :theme="buttonTheme('edit')" @click="openEdit(row)">编辑</t-link>
              <t-link
                v-if="can('toggle-status')"
                :theme="buttonTheme(row.status === 'enabled' ? 'disable' : 'enable')"
                @click="check(row, row.status === 'enabled' ? '停用' : '启用')"
              >
                {{ row.status === 'enabled' ? '停用' : '启用' }}</t-link
              >
              <t-link v-if="can('delete')" :theme="buttonTheme('delete')" @click="check(row, '删除')">删除</t-link>
            </div>
          </template>
        </AdminListPage>
      </main>
    </div>
  </div>
  <AdminFormDialog
    :visible="visible"
    @update:visible="
      (v) => {
        if (!saving) visible = v;
      }
    "
    :data="form"
    :header="editId ? '编辑服务' : '新增服务'"
    :confirmation="formConfirmation(editId ? 'edit' : 'create')"
    confirm-function="submit"
    :confirm-btn="{ loading: saving, disabled: uploading }"
    @confirm="save"
  >
    <t-form-item label="服务主图">
      <AdminMediaUpload
        :key="dialogKey"
        v-model="mainImage"
        title="服务主图"
        :upload="upload"
        :disabled="saving || uploading"
        :error-message="uploadError"
        @removed="removed"
        @preview="(img) => (preview = img?.url || '')"
      />
      <t-link v-if="uploadError" @click="uploadError = ''">取消本次上传</t-link>
    </t-form-item>
    <t-form-item label="服务名称" required><t-input v-model="form.name" placeholder="请输入服务名称" /></t-form-item>
    <t-form-item label="价格" required
      ><t-input v-model="form.price" placeholder="请输入价格" suffix="元" @blur="formatPrice"
    /></t-form-item>
  </AdminFormDialog>
  <AdminConfirmDialog
    v-if="confirmation"
    :visible="true"
    :action="confirmation.action"
    :object-name="confirmation.row.name"
    object-type="服务"
    :function="confirmation.action === '删除' ? 'delete' : confirmation.action === '启用' ? 'enable' : 'disable'"
    :description="
      confirmation.action === '删除'
        ? '是否删除服务「' + confirmation.row.name + '」？已有搭配保留该项并标记为已删除。'
        : undefined
    "
    :loading="saving"
    @confirm="confirmAction"
    @update:visible="
      (v) => {
        if (!v) confirmation = null;
      }
    "
  />
  <AdminDialog
    :visible="!!preview"
    confirm-function="close"
    :confirmation="{ kind: 'none' }"
    close-on-overlay-click
    @close="preview = ''"
    header="图片预览"
    :footer="false"
    width="min(960px, 94vw)"
    @update:visible="
      (v) => {
        if (!v) preview = '';
      }
    "
  >
    <img v-if="preview" :src="preview" alt="服务主图" style="max-width: 100%" />
  </AdminDialog>
</template>
<script setup lang="ts">
import { computed, onScopeDispose, reactive, ref, watch } from 'vue';
import AdminTopNav from '@/components/AdminTopNav.vue';
import AdminSideMenu from '@/components/AdminSideMenu.vue';
import {
  AdminListPage,
  AdminFormDialog,
  AdminConfirmDialog,
  AdminDialog,
  adminFeedback,
} from '@/components/foundation';
import AdminMediaUpload, { type AdminMediaValue } from '@/components/foundation/AdminMediaUpload.vue';
import { buttonTheme } from '@/components/foundation/actions/buttonFunctions';
import { formConfirmation } from '@/components/foundation/actions/confirmation';
import { useOperationPreflight } from '@/composables/useOperationPreflight';
import { getLoginUser } from '@/services/auth';
import { hasPermission } from '@/services/adminPermissions';
import { request } from '@/services/http';
import {
  formatServicePrice,
  listServices,
  loadServiceImage,
  readService,
  servicePath,
  type StoreService,
} from '@/services/storeServices';
import ServiceImage from './ServiceImage.vue';

const rows = ref<StoreService[]>([]);
const loading = ref(false),
  saving = ref(false),
  uploading = ref(false),
  visible = ref(false);
const page = ref(1),
  pageSize = ref(10);
const pagination = computed(() => ({ current: page.value, pageSize: pageSize.value, total: rows.value.length }));
const columns = [
  ['image', '服务主图'],
  ['name', '服务名称'],
  ['price', '价格'],
  ['status', '状态'],
  ['creatorName', '创建人'],
  ['createdAt', '创建时间'],
  ['operation', '操作'],
].map(([colKey, title]) => ({ colKey, title }));
const can = (action: string) => hasPermission(getLoginUser(), 'store.service-management.' + action);
const editId = ref<number | null>(null);
const form = reactive({ name: '', price: '' });
const mainImage = ref<AdminMediaValue>(),
  uploadError = ref(''),
  preview = ref('');
const confirmation = ref<{ row: StoreService; action: '删除' | '启用' | '停用' } | null>(null);
const operations = useOperationPreflight();
const temporary = new Set<number>(),
  urls = new Set<string>();
let generation = 0,
  dialogGeneration = 0,
  listGeneration = 0;
const dialogKey = ref(0);
function failure(error: unknown) {
  adminFeedback.error(error instanceof Error ? error.message : '操作失败');
}
async function refresh() {
  const token = ++listGeneration;
  loading.value = true;
  try {
    const data = await listServices();
    if (token === listGeneration) rows.value = data;
  } catch (e) {
    if (token === listGeneration) failure(e);
  } finally {
    if (token === listGeneration) loading.value = false;
  }
}
function release(id: number) {
  temporary.delete(id);
  void request(servicePath + '/images/' + id, { method: 'DELETE' }).catch(() => {});
}
function removed(image: AdminMediaValue) {
  if (image.mediaId && temporary.has(image.mediaId)) release(image.mediaId);
}
function resetForm() {
  dialogGeneration++;
  dialogKey.value++;
  for (const id of temporary) release(id);
  for (const url of urls) URL.revokeObjectURL(url);
  urls.clear();
  mainImage.value = undefined;
  uploadError.value = '';
  uploading.value = false;
}
watch(
  visible,
  (v) => {
    if (!v) resetForm();
  },
  { flush: 'sync' },
);
watch(
  getLoginUser,
  () => {
    generation++;
    listGeneration++;
    temporary.clear();
    resetForm();
    visible.value = false;
    confirmation.value = null;
    preview.value = '';
    saving.value = false;
    rows.value = [];
    page.value = 1;
    if (can('view')) void refresh();
  },
  { immediate: true, flush: 'sync' },
);
onScopeDispose(() => {
  generation++;
  listGeneration++;
  resetForm();
});
function openCreate() {
  resetForm();
  editId.value = null;
  form.name = '';
  form.price = '';
  visible.value = true;
}
async function openEdit(row: StoreService) {
  await operations.check(
    'edit:' + row.id,
    () => readService(row.id),
    async (fresh) => {
      resetForm();
      const token = dialogGeneration;
      editId.value = fresh.id;
      form.name = fresh.name;
      form.price = fresh.price;
      if (fresh.imageId) {
        try {
          const image = await loadServiceImage(fresh);
          if (token !== dialogGeneration) {
            URL.revokeObjectURL(image);
            return;
          }
          urls.add(image);
          mainImage.value = { name: '服务主图', mediaId: fresh.imageId, url: image };
        } catch (e) {
          if (token === dialogGeneration) failure(e);
          return;
        }
      }
      visible.value = true;
    },
  );
}
function formatPrice() {
  const price = formatServicePrice(form.price);
  if (price !== null) form.price = price;
}
async function upload(file: File) {
  const token = dialogGeneration,
    identity = generation;
  uploading.value = true;
  uploadError.value = '';
  try {
    const data = new FormData();
    data.append('file', file);
    const id = await request<number>(servicePath + '/images', { method: 'POST', body: data });
    if (token !== dialogGeneration) {
      if (identity === generation) release(id);
      throw new Error('表单已关闭');
    }
    temporary.add(id);
    const url = URL.createObjectURL(file);
    urls.add(url);
    return { name: file.name, mediaId: id, url };
  } catch (e) {
    if (token === dialogGeneration) uploadError.value = '上传失败，请重新选择图片';
    throw e;
  } finally {
    if (token === dialogGeneration) uploading.value = false;
  }
}
async function save() {
  if (saving.value || uploading.value) return;
  const price = formatServicePrice(form.price),
    name = form.name.trim();
  if (!name || Array.from(name).length > 10) {
    adminFeedback.warning('服务名称须为 1 至 10 个字符');
    return;
  }
  if (price === null) {
    adminFeedback.warning('请填写非负价格，最多两位小数');
    return;
  }
  if (uploadError.value) {
    adminFeedback.warning(uploadError.value);
    return;
  }
  const imageId = mainImage.value?.mediaId ?? null;
  const token = generation;
  saving.value = true;
  try {
    await request(servicePath + (editId.value ? '/' + editId.value : ''), {
      method: editId.value ? 'PUT' : 'POST',
      body: JSON.stringify({ name, price, imageId }),
    });
    if (token !== generation) return;
    if (imageId) temporary.delete(imageId);
    visible.value = false;
    adminFeedback.success('服务已保存');
    await refresh();
  } catch (e) {
    if (token === generation) failure(e);
  } finally {
    if (token === generation) saving.value = false;
  }
}
function check(row: StoreService, action: '删除' | '启用' | '停用') {
  void operations.check(
    action + row.id,
    () => readService(row.id),
    (fresh) => {
      if (fresh.status !== row.status) {
        adminFeedback.warning('服务状态已变化，请重新操作');
        void refresh();
        return;
      }
      confirmation.value = { row: fresh, action };
    },
  );
}
async function confirmAction() {
  const target = confirmation.value;
  if (!target || saving.value) return;
  const token = generation;
  saving.value = true;
  try {
    const path = servicePath + '/' + target.row.id;
    if (target.action === '删除') await request(path, { method: 'DELETE' });
    else
      await request(path + '/status', { method: 'PUT', body: JSON.stringify({ enabled: target.action === '启用' }) });
    if (token !== generation) return;
    confirmation.value = null;
    adminFeedback.success('服务已' + target.action);
    await refresh();
  } catch (e) {
    if (token === generation) failure(e);
  } finally {
    if (token === generation) saving.value = false;
  }
}
</script>
