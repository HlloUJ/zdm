import { defineComponent, h, proxyRefs, type Component } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminFeedback } from '@/components/foundation/feedback/adminFeedback';
import { setLoginUser, getLoginUser } from '@/services/auth';

const components = import.meta.glob(['../pages/**/index.vue', '../pages/finished-stock/store/{StoreFinishedEditor,price-configuration}.vue', '../components/AdminTopNav.vue']);
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function response(data: unknown, status = 200, message = 'ok', blocked = false) {
  return new Response(JSON.stringify({ code: status === 200 ? 0 : status, data, message }), {
    status, headers: { 'Content-Type': 'application/json', ...(blocked ? { 'X-Zdm-Operation-Blocked': 'true' } : {}) },
  });
}
function mockApi(serve: (path: string, method: string) => Response | Promise<Response> | undefined) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://localhost').pathname;
    const supplied = serve(path, init?.method || 'GET');
    if (supplied) return supplied;
    if (path.endsWith('/delete-preview') && path.includes('product-attributes')) return response({deletionMode: 'physical', attributeValueCount: 0});
    if (path.endsWith('-check') || path.endsWith('-preview')) return response(true);
    return response([]);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
// Mount the real compiled page setup with router, lifecycle and reactive stores.
// The host omits the render tree so the same test can hold an HTTP response across two callbacks.
async function pageState(name: string, props: object = {}, client: 'admin' | 'store' = 'admin') {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const modulePath = name.startsWith('components/') ? name : 'pages/' + name;
  const load = components['../' + modulePath + (name.endsWith('.vue') ? '' : '/index.vue')];
  const component = (await load() as { default: Component }).default as {
    setup: (props: object, context: object) => Record<string, any>;
  };
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:rest(.*)', component: { render: () => null } }] });
  await router.push('/case');
  const user = getLoginUser();
  setLoginUser({ ...user, id: 13, name: '测试员工', clientCode: 'admin', storeType: client === 'store' ? 'cityPartner' : undefined, storeId: client === 'store' ? 18 : undefined, tenantId: client === 'store' ? 12 : undefined, roles: ['SUPER_ADMIN'], permissions: ['*'], dataPermission: 'all' });
  let state!: Record<string, any>;
  const Host = defineComponent({
    setup(_, ctx) {
      state = proxyRefs(component.setup(props, { ...ctx, expose: () => {} }));
      return () => h('div');
    },
  });
  const wrapper = mount(Host, { global: { plugins: [router] } });
  cleanups.push(() => wrapper.unmount());
  await flushPromises();
  return state;
}
function feedback() {
  const warning = vi.spyOn(adminFeedback, 'warning').mockImplementation(vi.fn());
  const error = vi.spyOn(adminFeedback, 'error').mockImplementation(vi.fn());
  const deleted = vi.spyOn(adminFeedback, 'deleted').mockImplementation(vi.fn());
  vi.spyOn(adminFeedback, 'actionSuccess').mockImplementation(vi.fn());
  vi.spyOn(adminFeedback, 'actionError').mockImplementation(vi.fn());
  return { warning, error, deleted };
}
const row = { id: 91, name: '记录91', code: 'code91', status: 'normal', children: [], productCount: 0,
  identityType: 'employee', roles: [], roleIds: [], tenantName: '测试租户', shopName: '测试门店' };
type Entry = [page: string, open: string, submit: string, collection: string, extra?: string];
const entries: Entry[] = [
  ['product/category', 'openDeleteDialog', 'handleDeleteConfirm', 'product-categories'],
  ['store-category/management', 'openDeleteDialog', 'handleDeleteConfirm', 'store-categories'],
  ['product/attribute', 'openDeleteConfirm', 'handleConfirm', 'product-attributes'],
  ['product/attribute-value', 'openDeleteConfirm', 'handleConfirm', 'product-attribute-values'],
  ['product/markup-configuration', 'openConfirm', 'submitConfirm', 'finished-markup-configurations'],
  ['craft/finished-stock', 'openDeleteConfirm', 'handleConfirm', 'crafts'],
  ['slab/variety', 'openDeleteConfirm', 'handleConfirm', 'slab-varieties'],
  ['slab/origin', 'openDeleteConfirm', 'handleConfirm', 'slab-origins'],
  ['slab/texture', 'openConfirm', 'submitConfirm', 'slab-textures', 'delete'],
  ['slab/color', 'openColorConfirm', 'submitColorConfirm', 'slab-colors', 'delete'],
  ['slab/grade', 'openConfirm', 'submitConfirm', 'slab-grades', 'delete'],
  ['permission/employee', 'openDeleteConfirm', 'handleConfirmSubmit', 'employees'],
  ['role/management', 'openDeleteConfirm', 'handleDeleteConfirm', 'roles'],
  ['supplier/management', 'openDeleteConfirm', 'handleConfirm', 'suppliers'],
  ['store-level/management', 'openConfirm', 'submitConfirm', 'store-levels', 'delete'],
  ['tenant/management', 'openStatusConfirm', 'handleConfirm', 'tenants'],
  ['tenant/store', 'openRestoreConfirm', 'handleConfirm', 'stores'],
  ['selection-center', '', 'remove', 'store-product-center'],
];
describe('registered page callbacks', () => {
  it.each(entries)('%s submits one mutation for two identical calls', async (name, open, submit, collection, arg) => {
    const pending = deferred<Response>();
    const writes: string[] = [];
    const messages = feedback();
    mockApi((path, method) => {
      if (method !== 'GET' && path.includes('/' + collection + '/')) {
        writes.push(method + ' ' + path);
        return pending.promise;
      }
    });
    const page = await pageState(name);
    if (open) await page[open](row, arg);
    else page.context = { key: 'store-1' };
    const first = page[submit](91);
    const second = page[submit](91);
    await flushPromises();
    expect(writes).toHaveLength(1);
    const falseResult = ['crafts', 'slab-varieties', 'slab-origins', 'slab-grades', 'store-levels'].includes(collection);
    pending.resolve(response(falseResult ? false : collection === 'product-attributes' ? { deletionMode: 'physical', attributeValueCount: 0 } : true));
    await Promise.all([first, second]);
    if (falseResult) {
      expect(messages.deleted).not.toHaveBeenCalled();
      expect(messages.error).toHaveBeenCalledWith(expect.stringContaining('未删除'));
    }
  });

  it.each([
    ['product/attribute', 'openDeleteConfirm', 'confirmTarget', 'delete-preview'],
    ['store-level/management', 'openConfirm', 'confirmRow', 'delete-preview'],
    ['tenant/management', 'openPurgeDialog', 'purgeTarget', 'purge-preview'],
  ])('%s keeps the latest confirmation target and preview after reverse replies', async (name, open, target, endpoint) => {
    feedback();
    const a = deferred<Response>(), b = deferred<Response>();
    mockApi((path) => path.endsWith('/' + endpoint) ? (path.includes('/91/') ? a.promise : b.promise) : undefined);
    const page = await pageState(name);
    const first = page[open](row, 'delete');
    const second = page[open]({ ...row, id: 92, tenantName: '租户B' }, 'delete');
    const value = (id: number) => name === 'tenant/management' ? { eligible:true, tenantName: '租户'+id, storePlans: { [id]: 'plan-' + id } }
      : name === 'product/attribute' ? { deletionMode:'physical', attributeValueCount:id } : true;
    b.resolve(response(value(92))); await second;
    a.resolve(response(value(91))); await first;
    expect(page[target]?.id).toBe(92);
    if (name === 'tenant/management') expect(page.purgePreview.storePlans).toEqual({92: 'plan-92'});
    if (name === 'product/attribute') expect(page.deletePreview.attributeValueCount).toBe(92);
  });

  it.each([
    ['employee-invite', 'phoneFormRef', 'sendCode', 'requestingCode'],
    ['finished-stock/store/StoreFinishedEditor.vue', 'formRef', 'save', 'saving'],
    ['finished-stock/store/price-configuration.vue', 'createFormRef', 'saveDiscount', 'saving'],
  ])('locks %s before the first asynchronous field check', async (name, form, action, lock) => {
    const messages = feedback();
    const fetch = mockApi(() => undefined);
    const page = await pageState(name, { product: { id: 91, skus: [] } }, 'store');
    if (action === 'saveDiscount') {
      page.activeKey = 'discount.finished';
      page.openCreateDiscount();
      await flushPromises();
    }
    const pending = deferred<boolean>();
    const validate = vi.fn(() => pending.promise);
    page[form] = { validate };
    const first = page[action]();
    const second = page[action]();
    expect(page[lock]).toBe(true);
    expect(validate).toHaveBeenCalledTimes(1);
    pending.resolve(false);
    await Promise.all([first, second]);
    expect(page[lock]).toBe(false);
    expect(messages.warning).toHaveBeenCalledExactlyOnceWith('表单校验未通过，请检查标红字段');
    expect(fetch.mock.calls.filter(([, init]) => init?.method && init.method !== 'GET')).toHaveLength(0);
  });

  it('sends one logout request from the shared top navigation', async () => {
    const pending = deferred<Response>();
    const fetch = mockApi((path) => path.endsWith('/logout') ? pending.promise : undefined);
    vi.spyOn(adminFeedback, 'success').mockImplementation(vi.fn());
    const page = await pageState('components/AdminTopNav.vue');
    const first = page.handleLogout();
    const second = page.handleLogout();
    expect(page.loggingOut).toBe(true);
    expect(fetch.mock.calls.filter(([path]) => path.endsWith('/logout'))).toHaveLength(1);
    pending.resolve(response(true));
    await Promise.all([first, second]);
    expect(page.loggingOut).toBe(false);
    expect(adminFeedback.success).toHaveBeenCalledExactlyOnceWith('已退出登录');
  });

  it('reports a completed follow-up deletion separately when reloading its details fails', async () => {
    feedback();
    const success = vi.spyOn(adminFeedback, 'success').mockImplementation(vi.fn());
    mockApi((path, method) => method === 'DELETE' ? response(true)
      : path.endsWith('/store-customers/91') ? response(null, 500, '详情暂不可用') : undefined);
    const page = await pageState('customer', {}, 'store');
    page.detail = {customer: row, followups: []};
    page.deletingFollowId = 14;
    page.confirmVisible = true;
    await page.confirmOperation();
    expect(page.confirmVisible).toBe(false);
    expect(success).toHaveBeenCalledExactlyOnceWith('已删除跟进记录');
    expect(adminFeedback.actionError).toHaveBeenCalledWith(expect.objectContaining({action: '刷新客户详情'}));
    expect(adminFeedback.actionError).not.toHaveBeenCalledWith(expect.objectContaining({action: '删除'}));
  });

  it('keeps a later terminal selection when an older save finishes', async () => {
    const messages = feedback();
    const a = deferred<Response>();
    mockApi((_path, method) => method === 'PUT' ? a.promise : undefined);
    const page = await pageState('permission/terminal-function');
    const original = page.activeTerminal;
    page.checkedValues = ['original.choice'];
    const save = page.saveAllocation();
    page.activeTerminal = original === 'store' ? 'supply-chain' : 'store';
    page.checkedValues = ['new.choice'];
    a.resolve(response({ terminalType: original, functionPermissions: 'original.choice' }));
    await save;
    expect(page.checkedValues).toEqual(['new.choice']);
    expect(adminFeedback.actionSuccess).not.toHaveBeenCalled();
    expect(messages.error).not.toHaveBeenCalled();
  });

  it('keeps the archived tenant out of a purge dialog when the preview rejects deletion', async () => {
    const messages = feedback();
    const fetch = mockApi((path) => path.endsWith('/purge-preview')
      ? response({eligible:false, blockers:['门店清理尚未就绪'], storePlans:{}}) : undefined);
    const page = await pageState('tenant/management');
    await page.openPurgeDialog(row);
    expect(messages.warning).toHaveBeenCalledExactlyOnceWith('门店清理尚未就绪');
    expect(page.purgeDialogVisible).toBe(false);
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('sends the reviewed tenant name and plans only for that tenant', async () => {
    feedback();
    const fetch = mockApi((path, method) => path.endsWith('/purge-preview')
      ? response({ eligible: true, tenantName: '最新租户名称', storePlans: { 7: 'plan7' } })
      : method === 'POST' ? response({ storeResults: [] }) : undefined);
    const page = await pageState('tenant/management');
    await page.openPurgeDialog(row);
    page.purgeConfirmationName = row.tenantName;
    await page.handlePurge();
    expect(fetch.mock.calls.some(([,init]) => init?.method === 'POST')).toBe(false);
    page.purgeConfirmationName = '最新租户名称';
    await page.handlePurge();
    const writes = fetch.mock.calls.filter(([,init]) => init?.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toMatch(/\/91\/purge$/);
    expect(JSON.parse(String(writes[0][1]?.body))).toEqual({ confirmationName: '最新租户名称', storePlans: { 7: 'plan7' } });
  });

  it('shows one warning on a category rule and an error on an unclassified HTTP failure', async () => {
    const messages = feedback();
    let known = true;
    const fetch = mockApi((path) => path.endsWith('/delete-check') ? response(null, 400, '该分类已配置发布属性模板', known) : undefined);
    const page = await pageState('product/category');
    await page.openDeleteDialog(row);
    expect(messages.warning).toHaveBeenCalledExactlyOnceWith('该分类已配置发布属性模板');
    expect(page.deleteVisible).toBe(false);
    known = false;
    await page.openDeleteDialog(row);
    expect(messages.error).toHaveBeenCalledWith('操作条件检查失败，请稍后重试');
    expect(page.deleteVisible).toBe(false);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(0);
  });
});
