import { expect, test } from '@playwright/test';
import { installAdminApiMocks } from './admin-api-mocks';

for (const failure of ['server', 'network'] as const) {
  test(`valid submit retains the ${failure} failure Toast and never replaces it with validation feedback`, async ({
    page,
  }) => {
    await installAdminApiMocks(page);
    let requests = 0;
    await page.route('**/api/admin/auth/login', async (route) => {
      requests++;
      if (failure === 'network') await route.abort('failed');
      else await route.fulfill({ status: 500, json: { code: 500, message: '服务暂不可用，请稍后重试' } });
    });
    await page.goto('/login');
    await page.getByPlaceholder('请输入手机号').fill('15900000001');
    await page.getByPlaceholder('请输入验证码').fill('888888');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const feedback = page.locator('.zdm-admin-feedback');
    await expect(feedback).toHaveCount(1);
    await expect(feedback).not.toHaveText('');
    await expect(feedback.filter({ hasText: '表单校验未通过，请检查标红字段' })).toHaveCount(0);
    if (failure === 'server') await expect(feedback).toContainText('服务暂不可用，请稍后重试');
    await expect(page.locator('.t-form__controls.t-is-error')).toHaveCount(0);
    await expect(page.getByPlaceholder('请输入手机号')).toHaveValue('15900000001');
    await expect(page.getByPlaceholder('请输入验证码')).toHaveValue('888888');
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeEnabled();
    await expect(page).toHaveURL(/\/login$/);
    expect(requests).toBe(1);
  });
}

test('duplicate variety and missing name share a summary, and editing clears the rejected value', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('zdm-admin-token', 'dev-token');
    localStorage.setItem('zdm-admin-user', JSON.stringify({
      id: 1, name: '韩健', phone: '19900009901', roles: ['SUPER_ADMIN'], permissions: ['all'], dataPermission: 'all',
    }));
  });
  await installAdminApiMocks(page);
  let submissions = 0;
  await page.route('**/api/admin/slab-varieties', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    submissions++;
    const data = route.request().postDataJSON();
    if (data.name === '芬迪白') {
      return route.fulfill({ status: 400, headers: { 'X-Zdm-Invalid-Field': 'name' },
        json: { code: 400, message: '品种名称已存在', data: null } });
    }
    return route.fulfill({ json: { code: 0, message: 'ok', data: { ...data, id: 8001 } } });
  });
  await page.goto('/slab-variety');
  await page.getByRole('button', { name: '新增', exact: true }).click();
  const dialog = page.locator('.t-dialog:visible');
  const name = dialog.getByPlaceholder('请输入品种');
  const item = dialog.locator('.t-form__item').filter({ has: page.getByPlaceholder('请输入品种') });
  const confirm = dialog.getByRole('button', { name: '确认新增', exact: true });
  const summary = page.locator('.zdm-admin-feedback').filter({ hasText: '表单校验未通过，请检查标红字段' });
  await confirm.click();
  await expect(item.locator('.t-is-error')).toBeVisible();
  await expect(summary).toHaveCount(1);
  expect(submissions).toBe(0);
  await name.fill('芬迪白');
  await confirm.click();
  await expect(item.locator('.t-is-error')).toContainText('品种名称已存在');
  await expect(summary).toHaveCount(1);
  await expect(name).toHaveValue('芬迪白');
  await name.fill('芬迪白新品');
  await expect(item.locator('.t-is-error')).toHaveCount(0);
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  expect(submissions).toBe(2);
});
