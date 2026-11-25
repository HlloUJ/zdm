import { expect, type Locator, type Page } from '@playwright/test';

export async function expectMediaToFit(preview: Locator, media: Locator) {
  await expect(media).toBeVisible();
  await expect(media).toHaveCSS('object-fit', 'contain');
  await expect.poll(() => media.evaluate((element) => {
    const card = element.closest('.t-dialog')!;
    const body = element.closest('.t-dialog__body')!;
    return [card, card.querySelector('.t-dialog__close')!, element].every((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.top >= -1 && rect.left >= -1
        && rect.bottom <= window.innerHeight + 1 && rect.right <= window.innerWidth + 1;
    }) && body.scrollHeight <= body.clientHeight + 1 && body.scrollWidth <= body.clientWidth + 1;
  })).toBe(true);
  await expect(preview.locator('.t-dialog__header')).toBeVisible();
}

/** Check the shared image-only window contract, then dismiss via native outside click. */
export async function expectStandardImagePreviewAndDismiss(page: Page, preview: Locator) {
  await expect(preview).toBeVisible();
  const expectedWidth = Math.min(960, page.viewportSize()!.width * 0.94);
  await expect.poll(async () => Math.abs((await preview.boundingBox())!.width - expectedWidth)).toBeLessThanOrEqual(1);
  const image = preview.locator('img').first();
  await expect(image).toBeVisible();
  await expect(image).toHaveCSS('max-width', '100%');
  await expectMediaToFit(preview, image);
  await expect(image).toHaveCSS('border-top-width', '0px');
  const context = page.locator('.t-dialog__ctx').filter({ has: preview });
  await expect(context.locator('.t-dialog__mask')).toBeVisible();
  await image.click();
  await expect(preview).toBeVisible();
  await context.locator('.t-dialog__position').click({ position: { x: 5, y: 5 } });
  await expect(preview).not.toBeVisible();
}
