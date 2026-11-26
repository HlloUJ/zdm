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
  await expect(row.locator('.t-tag')).toHaveClass(/t-tag--success/);
  await expect(row.getByAltText('默认图片')).toBeVisible();
  await expect(row.getByAltText('默认图片')).toHaveCSS('width', '64px');
  await expect(row.getByAltText('默认图片')).toHaveCSS('height', '64px');
  await expect(row.getByRole('cell', { name: '2026/11/24 17:00', exact: true })).toBeVisible();
  const actions = row.getByRole('cell').last();
  await expect(actions).toHaveClass(/t-table__cell--fixed-right/);
  const edit = await actions.getByText('编辑', { exact: true }).boundingBox();
  const disable = await actions.getByText('停用', { exact: true }).boundingBox();
  expect(disable!.x).toBeGreaterThan(edit!.x + edit!.width);
  await actions.getByText('删除', { exact: true }).click();
  const deletion = page.locator('.zdm-admin-confirm-dialog');
  await expect(deletion.locator('.zdm-admin-confirm-dialog__content')).toHaveText('是否删除服务「上门安装」？');
  await deletion.getByRole('button', { name: '取消' }).click();
  await row.getByText('停用', { exact: true }).click();
  await page.getByRole('button', { name: '确认停用' }).click();
  await expect(row.locator('.t-tag')).toHaveText('停用');
  await expect(row.locator('.t-tag')).toHaveClass(/t-tag--danger/);
});

for (const [width, height] of [[1600, 900], [1536, 1536], [900, 1800]]) {
  test(`服务主图完整显示并保持原比例 ${width}×${height}`, async ({ page }) => {
    await page.setViewportSize({ width: 1694, height: 860 });
    const service = {
      id: 1, name: '上门量尺', price: '10.00', imageId: 7,
      status: 'enabled', creatorName: '店员', createdAt: '2026-11-25T06:00:00Z',
    };
    await page.route('**/api/admin/**', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/1/images/7')) {
        return route.fulfill({
          contentType: 'image/svg+xml',
          body: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="teal"/></svg>`,
        });
      }
      return route.fulfill({ json: { code: 0, data: path.endsWith('/store-services') ? [service] : [] } });
    });
    await page.goto('/store/service-management');
    await page.getByRole('button', { name: '预览上门量尺主图' }).click();
    const preview = page.locator('.t-dialog').filter({ has: page.getByAltText('服务主图', { exact: true }) });
    const image = preview.locator('img');
    await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(width);
    const box = (await image.boundingBox())!;
    expect(box.width / box.height).toBeCloseTo(width / height, 2);
    await expectStandardImagePreviewAndDismiss(page, preview);
  });
}

test('新增与编辑使用必填标记、字段错误及精确金额输入', async ({ page }) => {
  const item = {
    id: 1,
    name: '量尺',
    price: '0.50',
    imageId: 17,
    status: 'enabled',
    creatorName: '店员',
    createdAt: '2026-11-24T09:00:00',
  };
  const writes: string[] = [];
  await page.route('**/api/admin/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/1/images/17')) {
      expect(route.request().headers().authorization).toBe('Bearer test-token');
      return route.fulfill({ path: 'src/pages/store-services/default-image.png', contentType: 'image/png' });
    }
    if (route.request().method() === 'POST' || route.request().method() === 'PUT') {
      writes.push(route.request().postDataJSON().price);
      return route.fulfill({ status: 400, headers: { 'X-Zdm-Invalid-Field': 'name' }, json: {
        code: 400, message: '本店已有同名服务',
        fieldErrors: [{ field: 'name', message: '服务名称已存在，请更换名称' }],
      } });
    }
    await route.fulfill({
      json: {
        code: 0,
        data: path.endsWith('/store-services') ? [item] : path.endsWith('/store-services/1') ? item : [],
      },
    });
  });
  await page.goto('/store/service-management');
  const thumbnail = page.getByRole('button', { name: '预览量尺主图' });
  await expect(thumbnail).toHaveCSS('width', '64px');
  await expect(thumbnail).toHaveCSS('height', '64px');
  await thumbnail.press('Enter');
  const preview = page
    .locator('.t-dialog')
    .filter({ has: page.locator('.t-dialog__header').filter({ hasText: '服务主图' }) });
  await expectStandardImagePreviewAndDismiss(page, preview);
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
  const fullName = '岩板餐桌安装费🪨AB';
  await name.fill(fullName + '超长');
  await expect(name).toHaveValue(fullName);
  await name.press('End');
  await name.pressSequentially('C');
  await expect(name).toHaveValue(fullName);
  await name.press('Backspace');
  await name.pressSequentially('C');
  await expect(name).toHaveValue('岩板餐桌安装费🪨AC');
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
  await expect(dialog.getByText('服务名称已存在，请更换名称')).toBeVisible();
  expect(writes).toEqual(['0.50']);
  await name.fill('配送');
  await expect(dialog.getByText('服务名称已存在，请更换名称')).toHaveCount(0);
  await dialog.getByRole('button', { name: '取消' }).click();
  await page.getByText('编辑', { exact: true }).click();
  await expect(page.getByPlaceholder('请输入服务名称')).toHaveValue('量尺');
  await expect(page.getByPlaceholder('请输入价格')).toHaveValue('0.50');
  await page.getByPlaceholder('请输入服务名称').fill(fullName + '超长');
  await expect(page.getByPlaceholder('请输入服务名称')).toHaveValue(fullName);
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
  await expect(editor.getByRole('button', { name: '封面图', exact: true })).toBeVisible();
  const original = await card.locator('img').getAttribute('src');
  await card.click();
  const preview = page
    .locator('.t-dialog')
    .filter({ has: page.locator('.t-dialog__header').filter({ hasText: '服务主图' }) });
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
  await expect(editor.getByText('更换主图')).toHaveCount(0);
  await card.hover();
  await card.locator('.t-icon-delete').click();
  await expect.poll(() => released).toEqual([1]);
  await expect(card).toHaveCount(0);
  const selecting = page.waitForEvent('filechooser');
  await editor.getByText('封面图', { exact: true }).click();
  await (await selecting).setFiles({ ...file, name: '安装.png' });
  await expect(card.locator('img')).toBeVisible();
  await expect(card.locator('img')).not.toHaveAttribute('src', original!);
  await card.hover();
  await card.locator('.t-icon-delete').click();
  await expect.poll(() => released).toEqual([1, 2]);
  await expect(preview).not.toBeVisible();
  await expect(editor.getByText('更换主图')).toHaveCount(0);
});
