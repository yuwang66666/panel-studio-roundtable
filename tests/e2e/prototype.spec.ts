import { test, expect } from '@playwright/test';
test('原型四种宽度无横向溢出，样例和证据可以阅读', async ({ page }) => {
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/preview');
    await expect(page.getByRole('heading', { name: '让观点交锋， 让答案浮现。' })).toBeVisible();
    await expect(page.locator('.discussion-card')).toHaveCount(5);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.locator('.discussion-card').first().click();
    await expect(page.locator('.summary-title')).toHaveText('本场圆桌总结');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    if (width <= 1100) await page.getByRole('tab', { name: '洞察' }).click();
    await page.getByRole('button', { name: '查看证据发言 2' }).first().click();
    await expect(page.locator('#sample-1-m2')).toBeInViewport();
    await page.screenshot({ path: `test-results/studio-${width}.png`, fullPage: true });
  }
});
test('原型连接配置和创建阵容流程', async ({ page }) => {
  await page.goto('/preview/settings');
  await page.getByLabel('连接名称').fill('测试连接');
  await page.getByLabel('模型名称').fill('demo-model');
  await page.getByLabel('API Key', { exact: true }).fill('preview-only-key');
  await page.getByRole('button', { name: '保存连接', exact: true }).click();
  await expect(page.getByRole('heading', { name: '测试连接' })).toBeVisible();
  await page.getByLabel('默认主持人模型').selectOption({ label: '测试连接' });
  await page.getByRole('link', { name: '讨论空间', exact: true }).click();
  await page.getByRole('button', { name: '开启一场圆桌' }).click();
  await page.getByLabel('想讨论什么？').fill('如何评估不同模型的讨论表现？');
  await page.getByRole('button', { name: '生成讨论阵容' }).click();
  await expect(page.getByRole('heading', { name: '本场讨论阵容' })).toBeVisible();
  await expect(page.locator('.cast-card')).toHaveCount(5);
  await expect(page.getByRole('button', { name: '确认阵容，开始讨论' })).toBeEnabled();
});
