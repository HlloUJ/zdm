import { expectStandardImagePreviewAndDismiss } from './image-preview-assertions';
import { expect, test } from '@playwright/test';

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
test.beforeEach(async ({ page }) => {
  await page.route('**/api/open/store-cache-exits', (route) => route.fulfill({ json: { code: 0, data: [] } }));
  await page.addInitScript((user) => {
    localStorage.setItem('zdm-admin-token', 'test-token');
    localStorage.setItem('zdm-admin-user', JSON.stringify(user));
  }, user);
});

test('门店可新增无图的零元服务，并查看和停用它', async ({ page }) => {
  const items: Record<string, unknown>[] = [];
  await page.route('**/api/admin/**', async (route) => {
    const path = new URL(route.request().url()).pathname,
      method = route.request().method();
    let data: unknown = path.endsWith('/contexts') ? [user] : [];

    if (path.endsWith('/store-services')) {
      if (method === 'POST') {
        const input = route.request().postDataJSON();
        expect(input).toEqual({ name: '上门安装', price: '0.00', imageId: null });
        items.push({ ...input, id: 1, creatorName: '测试店员', status: 'enabled', createdAt: '2026-11-24T09:00:00' });
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

test('新增与编辑使用必填标记、字段错误及精确金额输入', async ({ page }) => {
  const item = {
    id: 1,
    name: '量尺',
    price: '0.50',
    imageId: null,
    status: 'enabled',
    creatorName: '店员',
    createdAt: '2026-11-24T09:00:00',
  };
  const writes: string[] = [];
  await page.route('**/api/admin/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'POST' || route.request().method() === 'PUT') {
      writes.push(route.request().postDataJSON().price);
      return route.fulfill({ status: 400, json: { code: 400, message: '本店已有同名服务' } });
    }
    await route.fulfill({
      json: {
        code: 0,
        data: path.endsWith('/store-services') ? [item] : path.endsWith('/store-services/1') ? item : [],
      },
    });
  });
  await page.goto('/store/service-management');
  await page.getByRole('button', { name: '新增', exact: true }).click();
  const dialog = page.locator('.t-dialog').filter({ hasText: '新增服务' });
  await expect(dialog.locator('.t-form__label--required')).toHaveCount(2);
  await expect(dialog.locator('.t-is-error')).toHaveCount(0);
  await dialog.getByRole('button', { name: '确认新增' }).click();
  await expect(page.getByText('表单校验未通过，请检查标红字段')).toHaveCount(1);
  const name = dialog.getByPlaceholder('请输入服务名称'),
    price = dialog.getByPlaceholder('请输入价格');
  await expect(dialog.getByText('请输入服务名称', { exact: true })).toBeVisible();
  await expect(dialog.getByText('请输入价格', { exact: true })).toBeVisible();
  expect(writes).toEqual([]);
  await name.fill('这是一条超过十个字符的服务名称');
  await expect(dialog.getByText('服务名称最多输入10个字符')).toBeVisible();
  await name.fill('量尺');
  await price.pressSequentially('00.509');
  await expect(price).toHaveValue('0.50');
  await price.selectText();
  await price.fill('000.02.2223222');
  await expect(price).toHaveValue('0.50');
  await price.fill('.');
  await name.focus();
  await expect(dialog.getByText('请输入数字', { exact: true })).toBeVisible();
  await price.fill('.5');
  await name.focus();
  await expect(price).toHaveValue('0.50');
  await dialog.getByRole('button', { name: '确认新增' }).click();
  await expect(dialog.getByText('本店已有同名服务')).toBeVisible();
  expect(writes).toEqual(['0.50']);
  await name.fill('配送');
  await expect(dialog.getByText('本店已有同名服务')).toHaveCount(0);
  await dialog.getByRole('button', { name: '取消' }).click();
  await page.getByText('编辑', { exact: true }).click();
  await expect(page.getByPlaceholder('请输入服务名称')).toHaveValue('量尺');
  await expect(page.getByPlaceholder('请输入价格')).toHaveValue('0.50');
});

test('主图上传、原生卡片预览、替换与删除保留表单草稿', async ({ page }) => {
  let uploads = 0;
  let refuseReplacement = false;
  const released: number[] = [];
  await page.route('**/api/admin/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (refuseReplacement && path.endsWith('/images')) {
      return route.fulfill({ status: 400, json: { code: 400, message: '请选择有效的图片文件' } });
    }
    if (route.request().method() === 'DELETE') released.push(Number(path.split('/').at(-1)));
    await route.fulfill({ json: { code: 0, data: path.endsWith('/images') ? ++uploads : [] } });
  });
  await page.goto('/store/service-management');
  await page.getByRole('button', { name: '新增', exact: true }).click();
  const editor = page.locator('.t-dialog').filter({ hasText: '新增服务' });
  const file = {
    name: '量尺.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/oioAAAAASUVORK5CYII=',
      'base64',
    ),
  };
  await editor.getByPlaceholder('请输入服务名称').fill('上门量尺');
  await editor.locator('input[type=file]').setInputFiles(file);
  const card = editor.locator('.t-upload__card-content');
  await expect(card.locator('img')).toBeVisible();
  await expect(editor.locator('.t-upload__card-item')).toHaveCount(1);
  await expect(card).toHaveCSS('width', '110px');
  await expect(card).toHaveCSS('height', '110px');
  const original = await card.locator('img').getAttribute('src');
  await card.click();
  const preview = page.locator('.t-dialog').filter({ hasText: '图片预览' });
  await expectStandardImagePreviewAndDismiss(page, preview);
  await editor.locator('.admin-media-upload').press('Enter');
  await expect(preview).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(preview).not.toBeVisible();
  await expect(editor.getByPlaceholder('请输入服务名称')).toHaveValue('上门量尺');
  refuseReplacement = true;
  await editor.locator('input[type=file]').setInputFiles({ ...file, name: '无效.png' });
  await expect(editor.getByText('请选择有效的图片文件')).toBeVisible();
  await expect(card.locator('img')).toHaveAttribute('src', original!);
  expect(released).toEqual([]);
  refuseReplacement = false;
  const selecting = page.waitForEvent('filechooser');
  await editor.getByText('更换主图').click();
  await (await selecting).setFiles({ ...file, name: '安装.png' });
  await expect.poll(() => released).toEqual([1]);
  await card.hover();
  await card.locator('.t-icon-delete').click();
  await expect.poll(() => released).toEqual([1, 2]);
  await expect(preview).not.toBeVisible();
  await expect(editor.getByText('更换主图')).toHaveCount(0);
});
