import { checkCategoryHelpFeedback } from './category-help-feedback';
import { expect, test, type Page } from '@playwright/test';
import { installAdminApiMocks } from './admin-api-mocks';

const prefix = 'admin.tenant.store-category-management';
async function setup(page: Page, permissions: string[]) {
  await page.addInitScript((permissions) => {
    localStorage.setItem('zdm-admin-token', 'dev-token');
    localStorage.setItem(
      'zdm-admin-user',
      JSON.stringify({
        id: 1,
        clientCode: 'admin',
        name: '测试员工',
        phone: '15900000001',
        roles: ['EMPLOYEE'],
        tenantId: 1,
        storeId: 1,
        storeType: 'cityPartner',
        dataPermission: 'self',
        permissions,
      }),
    );
  }, permissions);
  await installAdminApiMocks(page);
  const rows = [
    {
      id: 1,
      scope: 'finished',
      parentId: null,
      name: '成品一级',
      sortOrder: 1,
      productCount: 0,
      status: 'enabled',
      createdByName: '其他员工',
      createdAt: '2026-10-09T14:28:00',
    },
    { id: 2, scope: 'finished', parentId: 1, name: '成品二级', sortOrder: 1, productCount: 0, status: 'enabled' },
    { id: 3, scope: 'finished', parentId: 2, name: '成品三级', sortOrder: 1, productCount: 0, status: 'enabled' },
    { id: 4, scope: 'accessory', parentId: null, name: '配件一级', sortOrder: 1, productCount: 0, status: 'enabled' },
    { id: 5, scope: 'finished', parentId: null, name: '成品另一级', sortOrder: 2, productCount: 0, status: 'enabled' },
  ];
  const requests: { method: string; scope: string | null; payload?: Record<string, unknown> }[] = [];
  await page.route(/\/api\/admin\/store-categories(?:\/[^?]*)?(?:\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const payload = method === 'PUT' || method === 'POST' ? route.request().postDataJSON() : undefined;
    requests.push({ method, scope: url.searchParams.get('scope'), payload });
    const data = url.pathname.endsWith('/child-creation-check')
      ? false
      : method === 'GET'
        ? rows.filter((row) => row.scope === url.searchParams.get('scope'))
        : rows[0];
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ code: 0, message: 'ok', data }) });
  });
  return requests;
}

test('switches isolated category types and limits maintenance to three levels', async ({ page }) => {
  const actions = ['view', 'create-root', 'create-child', 'edit', 'sort', 'toggle-status', 'delete'];
  const requests = await setup(
    page,
    ['finished', 'accessory'].flatMap((scope) => actions.map((action) => `${prefix}.${scope}.${action}`)),
  );
  await page.goto('/store-category-management');
  await expect(page.locator('.t-tabs__nav-item').filter({ hasText: '成品现货分类' })).toBeVisible();
  await expect(page.locator('.t-tabs__nav-item').filter({ hasText: '配件分类' })).toBeVisible();
  await expect(page.getByText('其他员工', { exact: true })).toBeVisible();
  const dragIcon = page.locator('tbody [data-category-id]').first();
  await expect(dragIcon).toBeVisible();
  const dragSpace = await dragIcon.evaluate((icon) => {
    const cell = icon.closest('td')!;
    const style = getComputedStyle(cell);
    return {
      available: cell.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      required: icon.getBoundingClientRect().width,
      inset: icon.getBoundingClientRect().left - cell.getBoundingClientRect().left,
      nameInset: parseFloat(getComputedStyle(cell.nextElementSibling!).paddingLeft),
    };
  });
  expect(dragSpace.required).toBeGreaterThan(0);
  expect(dragSpace.available).toBeGreaterThanOrEqual(dragSpace.required);
  expect(dragSpace.inset).toBeCloseTo((dragSpace.available - dragSpace.required) / 2, 0);
  expect(dragSpace.nameInset).toBe(0);
  await expect(page.getByText('2026/10/09 14:28', { exact: true })).toBeVisible();
  await page.getByRole('row').filter({ hasText: '成品一级' }).getByRole('button', { name: '展开下级分类' }).click();
  await page.getByRole('row').filter({ hasText: '成品二级' }).getByRole('button', { name: '展开下级分类' }).click();
  const third = page.getByRole('row').filter({ hasText: '成品三级' });
  await expect(third).toBeVisible();
  await expect(third.getByText('新增下级', { exact: true })).toHaveCount(0);
  await page.locator('.t-tabs__nav-item').filter({ hasText: '配件分类' }).click();
  await expect(page.getByText('配件一级', { exact: true })).toBeVisible();
  await expect(page.getByText('成品一级', { exact: true })).toHaveCount(0);
  expect(requests.filter((item) => item.method === 'GET').map((item) => item.scope)).toContain('accessory');
  await page.getByRole('button', { name: '新增一级分类', exact: true }).click();
  const dialog = page.locator('.t-dialog:visible');
  const name = dialog.getByPlaceholder('请输入分类名称');
  await name.fill('一二三四五六七');
  await expect(name).toHaveValue('一二三四五六');
  await name.press('End');
  await name.pressSequentially('七');
  await expect(name).toHaveValue('一二三四五六');
  await expect(dialog.getByText('最多输入6个字符', { exact: true })).toBeVisible();
  await checkCategoryHelpFeedback(dialog);
  await expect(dialog.getByText('停用分类不可用于新商品上架。', { exact: true })).toHaveCount(0);
  const statusTops = await dialog
    .locator('.t-radio')
    .evaluateAll((radios) => radios.map((radio) => radio.getBoundingClientRect().top));
  expect(statusTops).toHaveLength(2);
  expect(Math.max(...statusTops) - Math.min(...statusTops)).toBeLessThanOrEqual(1);
  await name.fill('新增配件分类');
  await dialog.getByRole('button', { name: /^确认(?:新增|保存|配置权限)$/, exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(requests.find((item) => item.method === 'POST')?.payload).toMatchObject({
    scope: 'accessory',
    name: '新增配件分类',
  });
});

test('accessory-only permission hides the tab rail and falls back without requesting finished data', async ({
  page,
}) => {
  const requests = await setup(page, [`${prefix}.accessory.view`]);
  await page.goto('/store-category-management');
  await expect(page.getByText('配件一级', { exact: true })).toBeVisible();
  await expect(page.locator('.t-tabs__nav')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '新增一级分类' })).toHaveCount(0);
  await expect(page.getByText('编辑', { exact: true })).toHaveCount(0);
  expect(requests.filter((item) => item.method === 'GET').every((item) => item.scope === 'accessory')).toBe(true);
});

test('unscoped historical grants do not expose the module or request private categories', async ({ page }) => {
  const requests = await setup(page, [`${prefix}.view`, `${prefix}.move-up`]);
  await page.goto('/store-category-management');
  await expect(page).not.toHaveURL(/store-category-management$/);
  await expect(page.locator('.side-nav').getByText('门店分类管理', { exact: true })).toHaveCount(0);
  expect(requests).toHaveLength(0);
});

test('edit without status permission preserves status and never grants sorting', async ({ page }) => {
  const requests = await setup(page, [`${prefix}.finished.edit`]);
  await page.goto('/store-category-management');
  await page.getByRole('row').filter({ hasText: '成品一级' }).getByText('编辑', { exact: true }).click();
  const dialog = page.locator('.t-dialog:visible');
  await expect(dialog.getByRole('radio', { name: '启用', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('radio', { name: '停用', exact: true })).toBeDisabled();
  await dialog.getByPlaceholder('请输入分类名称').fill('修改名称');
  await dialog.getByRole('button', { name: /^确认(?:新增|保存|配置权限)$/, exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(requests.find((item) => item.method === 'PUT')?.payload).toEqual({ name: '修改名称' });
  await expect(page.locator('[data-category-id]')).toHaveCount(0);
});

test('adding a child to a priced category requires confirmation; cancel preserves the form and posts nothing', async ({
  page,
}) => {
  const requests = await setup(
    page,
    ['view', 'create-child'].map((action) => `${prefix}.finished.${action}`),
  );
  await page.route('**/api/admin/store-categories/5/child-creation-check?scope=finished', (route) =>
    route.fulfill({ json: { code: 0, message: 'ok', data: true } }),
  );
  await page.goto('/store-category-management');
  await page.getByRole('row').filter({ hasText: '成品另一级' }).getByText('新增下级', { exact: true }).click();
  const form = page.locator('.t-dialog:visible').filter({ hasText: '分类名称' });
  await form.getByPlaceholder('请输入分类名称').fill('新增二级');
  await form.getByRole('button', { name: /^确认(?:新增|保存|配置权限)$/, exact: true }).click();
  const confirmation = page.locator('.t-dialog:visible').filter({ hasText: '已有商品价格不受影响' });
  await expect(confirmation).toBeVisible();
  expect(requests.filter((item) => item.method === 'POST')).toHaveLength(0);
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await expect(confirmation).toBeHidden();
  await expect(form.getByPlaceholder('请输入分类名称')).toHaveValue('新增二级');
  await form.getByRole('button', { name: /^确认(?:新增|保存|配置权限)$/, exact: true }).click();
  await confirmation.getByRole('button', { name: '确认新增', exact: true }).click();
  await expect(form).toBeHidden();
  await expect(confirmation).toBeHidden();
  expect(requests.filter((item) => item.method === 'POST')).toHaveLength(1);
  expect(requests.find((item) => item.method === 'POST')?.payload).toMatchObject({
    parentId: 5,
    scope: 'finished',
    name: '新增二级',
    confirmPriceRemoval: true,
  });
});

test('duplicate category names keep the original rejection and show its native field message', async ({ page }) => {
  const requests = await setup(page, [`${prefix}.finished.create-root`]);
  await page.goto('/store-category-management');
  await page.getByRole('button', { name: '新增一级分类', exact: true }).click();
  const dialog = page.locator('.t-dialog:visible');
  await dialog.getByPlaceholder('请输入分类名称').fill('成品一级');
  await dialog.getByRole('button', { name: /^确认(?:新增|保存|配置权限)$/, exact: true }).click();
  const field = dialog
    .locator('.t-form__item')
    .filter({ has: page.locator('.t-form__label').filter({ hasText: '分类名称' }) });
  await expect(field.getByText('同级分类名称不能重复', { exact: true })).toBeVisible();
  await expect(page.locator('.zdm-admin-feedback').filter({ hasText: '同级分类名称不能重复' })).toHaveCount(0);
  expect(requests.some((item) => item.method === 'POST')).toBe(false);
  await dialog.getByPlaceholder('请输入分类名称').fill('合法的新分类');
  await dialog.getByRole('button', { name: /^确认(?:新增|保存|配置权限)$/, exact: true }).click();
  await expect(dialog).toBeHidden();
});

test('expands the confirm button for its spinner and moves feedback to the list after a status write', async ({ page }) => {
  await setup(page, [prefix + '.finished.view', prefix + '.finished.toggle-status']);
  await page.goto('/store-category-management');
  const row = page.getByRole('row').filter({ hasText: '成品另一级' });
  await row.getByText('停用', { exact: true }).click();
  const confirm = page.getByRole('button', { name: '确认停用', exact: true });
  const dialog = page.locator('.t-dialog:visible').filter({ has: confirm });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('..')).not.toHaveClass(/enter-active/);
  const width = await confirm.evaluate((button) => (button as HTMLButtonElement).offsetWidth);
  let finishWrite!: () => void;
  let finishRead!: () => void;
  const writeGate = new Promise<void>((resolve) => { finishWrite = resolve; });
  const readGate = new Promise<void>((resolve) => { finishRead = resolve; });
  let writes = 0;
  await page.route('**/api/admin/store-categories/**/status?*', async (route) => {
    writes++;
    await writeGate;
    await route.fallback();
  });
  await page.route('**/api/admin/store-categories?*', async (route) => {
    await readGate;
    await route.fallback();
  });
  try {
    await confirm.evaluate((button) => { const target = button as HTMLButtonElement; target.click(); target.click(); });
    await expect(confirm).toBeDisabled();
    await expect(confirm.locator('.t-loading')).toBeVisible();
    expect(await confirm.evaluate((button) => (button as HTMLButtonElement).offsetWidth)).toBeGreaterThan(width);
    expect(writes).toBe(1);
    finishWrite();
    await expect(dialog).toBeHidden();
    await expect(page.locator('.t-table .t-loading').first()).toBeVisible();
  } finally {
    finishWrite();
    finishRead();
  }
  await expect(page.locator('.t-table .t-loading')).toHaveCount(0);
});

test('a fast category deletion never mounts a spinner in the closing button', async ({ page }) => {
  await setup(page, [prefix + '.finished.view', prefix + '.finished.delete']);
  await page.route('**/api/admin/store-categories/5/delete-check?*', route =>
    route.fulfill({ json: { code: 0, data: true } }));
  let writes = 0;
  await page.route('**/api/admin/store-categories/5?*', route => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    writes++;
    return route.fulfill({ json: { code: 0, data: true } });
  });
  await page.goto('/store-category-management');
  await page.getByRole('row').filter({ hasText: '成品另一级' }).getByText('删除', { exact: true }).click();
  const button = page.getByRole('button', { name: '确认删除', exact: true });
  await expect(button).toBeVisible();
  // Hold page timers still while the mocked HTTP response and Vue updates complete.
  const now = new Date();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(new Date(now.getTime() + 1000));
  await button.evaluate(element => {
    const observed = new MutationObserver(records => {
      if (records.some(record => [...record.addedNodes].some(node =>
        node instanceof Element && (node.matches('.t-loading') || node.querySelector('.t-loading'))))) {
        document.body.dataset.deleteSpinner = 'seen';
      }
    });
    observed.observe(element, { childList: true, subtree: true });
    (element as HTMLButtonElement).click();
    (element as HTMLButtonElement).click();
  });
  await expect(page.getByText('已删除“成品另一级”', { exact: true })).toBeVisible();
  await page.clock.runFor(500);
  expect(writes).toBe(1);
  await expect(button).toBeHidden();
  expect(await page.locator('body').getAttribute('data-delete-spinner')).toBeNull();
});

test('delete link and confirm button reclaim their icon space when idle', async ({ page }) => {
  await setup(page, [prefix + '.finished.view', prefix + '.finished.delete']);
  let finishCheck!: () => void;
  let finishDelete!: () => void;
  const checkGate = new Promise<void>(resolve => { finishCheck = resolve; });
  const deleteGate = new Promise<void>(resolve => { finishDelete = resolve; });
  await page.route('**/api/admin/store-categories/5/delete-check?*', async route => {
    await checkGate;
    await route.fulfill({ json: { code: 0, data: true } });
  });
  await page.route('**/api/admin/store-categories/5?*', async route => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    await deleteGate;
    await route.fulfill({ json: { code: 0, data: false } });
  });
  await page.goto('/store-category-management');
  const link = page.getByRole('row').filter({ hasText: '成品另一级' }).locator('.t-link').filter({ hasText: '删除' });
  const prefixIcon = link.locator('.t-link__prefix-icon');
  const width = (element: Element) => (element as HTMLElement).offsetWidth;
  await expect(link).toBeVisible();
  await expect(prefixIcon).toBeHidden();
  const idleLink = await link.evaluate(width);
  try {
    await link.click();
    await expect(prefixIcon.locator('.t-loading')).toBeVisible();
    expect(await link.evaluate(width)).toBeGreaterThan(idleLink);
    finishCheck();
    const button = page.getByRole('button', { name: '确认删除', exact: true });
    await expect(button).toBeVisible();
    await expect(prefixIcon).toBeHidden();
    expect(await link.evaluate(width)).toBe(idleLink);
    const idleButton = await button.evaluate(width);
    await button.click();
    await expect(button.locator('.t-loading')).toBeVisible();
    expect(await button.evaluate(width)).toBeGreaterThan(idleButton);
    finishDelete();
    await expect(button).toBeEnabled();
    await expect(button.locator('.t-loading')).toHaveCount(0);
    expect(await button.evaluate(width)).toBe(idleButton);
  } finally {
    finishCheck();
    finishDelete();
  }
});
