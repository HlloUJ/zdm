import { expect, test, type Page } from '@playwright/test';
import { productWarehouseUrl } from './product-test-navigation';

const categories = [
  { id: 7, parentId: null, name: '休闲椅', status: 'enabled', coefficient: null },
  { id: 8, parentId: 7, name: '单人椅', status: 'enabled', coefficient: null },
  { id: 9, parentId: 8, name: '木质单人椅', status: 'enabled', coefficient: null },
];

export function registerStoreCategoryAdjustmentTests(
  module: 'finished-stock-management' | 'accessory-management',
  login: (page: Page) => Promise<void>,
  product: (overrides: Record<string, unknown>) => Record<string, unknown>,
) {
  const resource = module === 'finished-stock-management' ? 'store-finished-products' : 'store-accessory-products';
  const api = `**/api/admin/${resource}`;
  const ok = (data: unknown) => ({ code: 0, message: 'ok', data });

  test('store category adjustment filters direct parent bindings and searches any level', async ({ page }) => {
    await login(page);
    const records = [
      product({ name: '一级待调整', storeCategoryId: 7 }),
      product({ id: 42, productId: 92, name: '二级待调整', storeCategoryId: 8 }),
      product({ id: 43, productId: 93, name: '三级已归类', storeCategoryId: 9 }),
      product({ id: 44, productId: 94, name: '未归类商品', storeCategoryId: null }),
      product({ id: 45, productId: 95, name: '在售待调整', storeCategoryId: 7, effectiveStatus: 'selling' }),
      product({ id: 46, productId: 96, name: '回收站商品', storeCategoryId: 7, effectiveStatus: 'recycle' }),
    ];
    await page.route(api, (route) => route.fulfill({ json: ok(records) }));
    await page.route(`${api}/list/categories`, (route) => route.fulfill({ json: ok(categories) }));
    await page.goto(productWarehouseUrl(`/store/${module}`));

    const main = page.getByRole('main');
    const rows = main.locator('tbody tr');
    const flag = main.getByRole('checkbox', { name: '待调整分类' });
    const flagLabel = main.getByText('待调整分类', { exact: true });
    const query = main.getByRole('button', { name: '查询', exact: true });
    const reset = main.getByRole('button', { name: '重置', exact: true });
    const tags = rows.getByText('请调整分类', { exact: true });
    const picker = main.locator('.filter-row .t-select-input');
    const panel = page.locator('.t-cascader__panel:visible');

    await expect(flag).not.toBeChecked();
    await expect(rows).toHaveCount(4);
    await expect(tags).toHaveCount(2);
    await rows.filter({ hasText: '一级待调整' }).getByText('请调整分类').hover();
    await expect(page.getByText('该分类层级有变动，请重新设置该商品分类', { exact: true })).toBeVisible();
    await flagLabel.click();
    await expect(flag).toBeChecked();
    await expect(rows).toHaveCount(4);
    await query.click();
    await expect(rows).toHaveCount(2);
    await main.getByPlaceholder('请输入商品名称/ID/编号').fill('92');
    await query.click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('二级待调整');

    await reset.click();
    await expect(flag).not.toBeChecked();
    await expect(rows).toHaveCount(4);
    await picker.click();
    await panel.getByText('休闲椅', { exact: true }).click();
    await query.click();
    await expect(rows).toHaveCount(3);
    await expect(tags).toHaveCount(2);
    await picker.click();
    await panel.getByText('休闲椅', { exact: true }).hover();
    await panel.getByText('单人椅', { exact: true }).click();
    await flagLabel.click();
    await query.click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('二级待调整');
    await flagLabel.click();
    await expect(flag).not.toBeChecked();
    await query.click();
    await expect(rows).toHaveCount(2);
    await expect(tags).toHaveCount(1);

    records.push(...Array.from({ length: 10 }, (_, index) =>
      product({ id: 50 + index, productId: 100 + index, name: `待调整商品 ${index}`, storeCategoryId: 7 }),
    ));
    await page.reload();
    await flagLabel.click();
    await query.click();
    await expect(tags).toHaveCount(10);
    await main.locator('.t-pagination__btn-next').click();
    await expect(tags).toHaveCount(2);
  });

  test('store category adjustment prevents saving an existing parent binding', async ({ page }) => {
    await login(page);
    const record = product({ storeCategoryId: 7, storeCategoryName: '休闲椅' });
    await page.route(api, (route) => route.fulfill({ json: ok([record]) }));
    await page.route(`${api}/41`, (route) => route.fulfill({ json: ok(record) }));
    await page.route(`${api}/41/edit-categories`, (route) => route.fulfill({ json: ok(categories) }));
    await page.goto(productWarehouseUrl(`/store/${module}/41/edit`));
    const main = page.getByRole('main');
    const save = main.locator('.form-submit-bar').getByRole('button', { name: '确认保存', exact: true });
    await expect(save).toBeDisabled();
    await main.locator('.t-cascader input').click();
    const panel = page.locator('.t-cascader__panel:visible');
    await panel.getByText('休闲椅', { exact: true }).hover();
    await panel.getByText('单人椅', { exact: true }).hover();
    await expect(save).toBeDisabled();
    await panel.getByText('木质单人椅', { exact: true }).click();
    await expect(save).toBeEnabled();
  });
}
