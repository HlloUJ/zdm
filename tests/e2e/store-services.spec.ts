import { expect, test } from '@playwright/test';

test('门店可新增无图的零元服务，并查看和停用它', async ({ page }) => {
  const user = {
    id: 7,
    identityId: 8,
    tenantId: 1,
    storeId: 2,
    storeType: 'cityPartner',
    clientCode: 'admin',
    name: '测试店员',
    roles: ['STORE_ADMIN'],
    dataPermission: 'all',
    permissions: ['view', 'create', 'edit', 'toggle-status', 'delete'].map((a) => 'store.service-management.' + a),
  };
  await page.addInitScript((user) => {
    localStorage.setItem('zdm-admin-token', 'test-token');
    localStorage.setItem('zdm-admin-user', JSON.stringify(user));
  }, user);
  const items: Record<string, unknown>[] = [];
  await page.route('**/api/admin/**', async (route) => {
    const path = new URL(route.request().url()).pathname,
      method = route.request().method();
    let data: unknown = [];
    if (path.endsWith('/contexts')) data = [user];
    if (path.endsWith('/store-services')) {
      if (method === 'POST') {
        const input = route.request().postDataJSON();
        expect(input).toEqual({ name: '上门安装', price: '0.00', imageId: null });
        items.push({ ...input, id: 1, creatorName: user.name, status: 'enabled', createdAt: '2026-11-24T09:00:00' });
      }
      data = method === 'POST' ? items[0] : items;
    }
    if (path.endsWith('/store-services/1')) data = items[0];
    if (path.endsWith('/1/status')) {
      items[0].status = 'disabled';
      data = true;
    }
    await route.fulfill({ json: { code: 0, message: 'ok', data } });
  });
  await page.goto('/store/service-management');
  await page.getByRole('button', { name: '新增', exact: true }).click();
  await page.getByPlaceholder('请输入服务名称').fill(' 上门安装 ');
  await page.getByPlaceholder('请输入价格').fill('0');
  await page.getByRole('button', { name: '确认新增' }).click();
  const row = page.getByRole('row').filter({ hasText: '上门安装' });
  await expect(row).toContainText('0.00');
  await expect(row.getByAltText('默认图片')).toBeVisible();
  await row.getByText('停用', { exact: true }).click();
  await page.getByRole('button', { name: '确认停用' }).click();
  await expect(row.locator('.t-tag')).toHaveText('停用');
});
