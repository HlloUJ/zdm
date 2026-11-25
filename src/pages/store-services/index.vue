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
            ><t-tag :theme="row.status === 'enabled' ? 'success' : 'danger'" variant="light">
              {{ row.status === 'enabled' ? '启用' : '停用' }}</t-tag
            ></template
          >
          <template #createdAt="{ row }">{{ formatProductDateTime(row.createdAt) }}</template>
          <template #operation="{ row }">
            <t-space size="small" align="center">
              <t-link
                hover="color"
                :disabled="operations.pending('edit:' + row.id)"
                v-if="can('edit')"
                :theme="buttonTheme('edit')"
                @click="openEdit(row)"
                ><t-loading v-if="operations.checkingIndicator('edit:' + row.id)" size="small" />编辑</t-link
              >
              <t-link
                v-if="can('toggle-status')"
                hover="color"
                :disabled="operations.pending((row.status === 'enabled' ? '停用' : '启用') + row.id)"
                :theme="buttonTheme(row.status === 'enabled' ? 'disable' : 'enable')"
                @click="check(row, row.status === 'enabled' ? '停用' : '启用')"
              >
                <t-loading
                  v-if="operations.checkingIndicator((row.status === 'enabled' ? '停用' : '启用') + row.id)"
                  size="small"
                />
                {{ row.status === 'enabled' ? '停用' : '启用' }}</t-link
              >
              <t-link
                hover="color"
                :disabled="operations.pending('删除' + row.id)"
                v-if="can('delete')"
                :theme="buttonTheme('delete')"
                @click="check(row, '删除')"
                ><t-loading v-if="operations.checkingIndicator('删除' + row.id)" size="small" />删除</t-link
              >
            </t-space>
          </template>
        </AdminListPage>
      </main>
    </div>
  </div>
  <AdminFormDialog
    ref="editor"
    :visible="visible"
    @update:visible="
      (v) => {
        if (!saving && !preview) visible = v;
      }
    "
    :close-on-esc-keydown="!preview"
    :data="form"
    :header="editId ? '编辑服务' : '新增服务'"
    :confirmation="formConfirmation(editId ? 'edit' : 'create')"
    confirm-function="submit"
    :confirm-btn="{ loading: saving, disabled: uploading }"
    @confirm="save"
  >
    <t-form-item label="服务主图">
      <t-space size="small" break-line align="start">
        <AdminMediaUpload
          :key="dialogKey"
          v-model="mainImage"
          title="封面图"
          accept="image/*"
          :upload="upload"
          :disabled="saving || uploading"
          :error-message="uploadError"
          @removed="removed"
          @preview="(img) => (preview = img?.url || '')"
        />
      </t-space>
      <t-link v-if="uploadError" @click="uploadError = ''">取消本次上传</t-link>
    </t-form-item>
    <t-form-item label="服务名称" name="name" required-mark>
      <t-input
        v-model="form.name"
        :maxlength="10"
        :disabled="saving"
        aria-required="true"
        placeholder="请输入服务名称"
        v-bind="fieldFeedback(nameError, nameError)"
      />
    </t-form-item>
    <t-form-item label="价格" name="price" required-mark>
      <DecimalInput
        v-model="form.price"
        :disabled="saving"
        plain
        large-number
        aria-required="true"
        inputmode="decimal"
        placeholder="请输入价格"
        suffix="元"
        v-bind="fieldFeedback(priceError, priceError)"
        @blur="priceTouched = true"
      />
    </t-form-item>
  </AdminFormDialog>
  <AdminConfirmDialog
    v-if="confirmation"
    :visible="true"
    :action="confirmation.action"
    :object-name="confirmation.row.name"
    object-type="服务"
    :function="confirmation.action === '删除' ? 'delete' : confirmation.action === '启用' ? 'enable' : 'disable'"
    :description="confirmation.action === '删除' ? '是否删除服务「' + confirmation.row.name + '」？' : undefined"
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
    mode="modal"
    show-overlay
    close-on-overlay-click
    @close="preview = ''"
    header="服务主图"
    :footer="false"
    width="min(960px, 94vw)"
    @update:visible="
      (v) => {
        if (!v) preview = '';
      }
    "
  >
    <img v-if="preview" :src="preview" alt="服务主图" class="service-preview-image" />
  </AdminDialog>
</template>
<script setup lang="ts">
import { computed, onScopeDispose, reactive, ref, watch } from 'vue';
import AdminTopNav from '@/components/AdminTopNav.vue';
import AdminSideMenu from '@/components/AdminSideMenu.vue';
import {
  AdminMediaUpload,
  type AdminMediaValue,
  AdminListPage,
  AdminFormDialog,
  AdminConfirmDialog,
  AdminDialog,
  adminFeedback,
} from '@/components/foundation';
import { buttonTheme } from '@/components/foundation/actions/buttonFunctions';
import { formConfirmation } from '@/components/foundation/actions/confirmation';
import { useOperationPreflight } from '@/composables/useOperationPreflight';
import { getLoginUser } from '@/services/auth';
import { hasPermission } from '@/services/adminPermissions';
import { useServerFields } from '@/utils/serverFieldValidation';
import { request } from '@/services/http';
import DecimalInput from '@/components/DecimalInput.vue';
import { fieldFeedback, useFormFeedback } from '@/utils/formValidation';
import { rejectFormSubmission } from '@/utils/submitValidation';
import { numericError } from '@/utils/numericInput';
import { getSafeErrorMessage } from '@/components/foundation/feedback/adminFeedback';
import {
  formatServicePrice,
  listServices,
  loadServiceImage,
  readService,
  servicePath,
  type StoreService,
} from '@/services/storeServices';
import ServiceImage from './ServiceImage.vue';
import type { PrimaryTableCol } from 'tdesign-vue-next';
import { formatProductDateTime } from '@/utils/formatProductDateTime';

const rows = ref<StoreService[]>([]);
const loading = ref(false),
  saving = ref(false),
  uploading = ref(false),
  visible = ref(false);
const page = ref(1),
  pageSize = ref(10);
const pagination = computed(() => ({ current: page.value, pageSize: pageSize.value, total: rows.value.length }));
const columns: PrimaryTableCol[] = [
  { colKey: 'image', title: '服务主图', width: 96 },
  { colKey: 'name', title: '服务名称', minWidth: 140 },
  { colKey: 'price', title: '价格', minWidth: 100 },
  { colKey: 'status', title: '状态', width: 90 },
  { colKey: 'creatorName', title: '创建人', minWidth: 110 },
  { colKey: 'createdAt', title: '创建时间', width: 180 },
  { colKey: 'operation', title: '操作', width: 168, align: 'left', fixed: 'right' },
];
const can = (action: string) => hasPermission(getLoginUser(), 'store.service-management.' + action);
const editId = ref<number | null>(null);
const form = reactive({ name: '', price: '' });
const editor = ref<InstanceType<typeof AdminFormDialog>>();
const submitted = ref(false);
const priceTouched = ref(false);
const serverFeedback = useFormFeedback(visible);
const nameError = computed(() => {
  const name = form.name.trim();
  if (submitted.value && !name) return '请输入服务名称';
  if (submitted.value && Array.from(name).length > 10) return '服务名称最多输入10个字符';
  return serverFeedback.field('name', name).tips || '';
});
const priceError = computed(() => {
  if (!priceTouched.value && !submitted.value) return '';
  if (!form.price) return '请输入价格';
  return numericError(form.price) || serverFeedback.field('price', form.price).tips || '';
});
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
  adminFeedback.error(getSafeErrorMessage(error, '操作失败，请稍后重试'));
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
  uploadError.value = '';
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
  submitted.value = false;
  priceTouched.value = false;
  serverFeedback.clear();
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
    if (token === dialogGeneration) {
      uploadError.value = getSafeErrorMessage(e, '上传失败，请重新选择图片');
      dialogKey.value++;
    }
    throw e;
  } finally {
    if (token === dialogGeneration) uploading.value = false;
  }
}
const storeServiceFields = () => ({
  name: form.name.trim(), price: form.price, imageId: mainImage.value?.mediaId ?? null,
});
const beginStoreServiceFeedback = useServerFields(
  () => visible.value, editor, storeServiceFields, (key, message) => {
    if (key === 'imageId') uploadError.value = message;
    else serverFeedback.reject(key, key === 'name' ? form.name.trim() : form.price, message);
  }, undefined, key => {
    if (key === 'imageId') uploadError.value = '';
    else serverFeedback.clearField(key);
  },
);
async function save() {
  if (saving.value || uploading.value) return;
  submitted.value = true;
  const name = form.name.trim();
  const price = formatServicePrice(form.price);
  if (nameError.value || price === null || priceError.value || uploadError.value) {
    await rejectFormSubmission(editor.value);
    return;
  }
  const imageId = mainImage.value?.mediaId ?? null;
  const token = generation;
  const reportFieldError = beginStoreServiceFeedback();
  saving.value = true;
  try {
    await request(servicePath + (editId.value ? '/' + editId.value : ''), {
      method: editId.value ? 'PUT' : 'POST',
      body: JSON.stringify({ name, price, imageId }),
    });
    if (token !== generation) return;
    if (imageId) temporary.delete(imageId);
    visible.value = false;
    adminFeedback.actionSuccess({ action: editId.value ? '编辑' : '新增', target: name });
    await refresh();
  } catch (e) {
    if (token !== generation) return;
    if (!(await reportFieldError(e))) failure(e);
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
    adminFeedback.actionSuccess({ action: target.action, target: target.row.name });
    await refresh();
  } catch (e) {
    if (token === generation) failure(e);
  } finally {
    if (token === generation) saving.value = false;
  }
}
</script>

<style scoped>
.service-preview-image {
  /* TDesign reserves 48px above and below its centered dialog, plus a 1px border. */
  --dialog-spacing: calc(49px + var(--td-comp-paddingTB-xxl) + var(--td-comp-paddingTB-l));
  display: block;
  margin-inline: auto;
  max-width: 100%;
  max-height: max(1px, calc(100dvh - 2 * var(--dialog-spacing) - var(--td-line-height-title-medium)));
}
</style>
