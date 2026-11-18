import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
let vite: { close(): Promise<void> } | undefined;
test.beforeAll(async () => {
  const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
  const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
  const server = await createServer({
    root: resolve('apps/web'),
    server: { port: 5175, host: '127.0.0.1', strictPort: true },
  });
  vite = server;
  await server.listen();
});
test.afterAll(async () => {
  await vite?.close();
});
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
    await page.screenshot({ path: `test-results/prototype/studio-${width}.png`, fullPage: true });
  }
});
test('原型预置模型选择和创建阵容流程', async ({ page }) => {
  await page.goto('/preview/settings');
  await expect(page.getByRole('heading', { name: '样例模型', exact: true })).toBeVisible();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.getByLabel('默认主持人模型')).toHaveValue('preview-model');
  await page.getByRole('link', { name: '讨论空间', exact: true }).click();
  await page.getByRole('button', { name: '开启一场圆桌' }).click();
  await page.getByLabel('想讨论什么？').fill('如何评估不同模型的讨论表现？');
  await page.getByRole('button', { name: '生成讨论阵容' }).click();
  await expect(page.getByRole('heading', { name: '本场讨论阵容' })).toBeVisible();
  await expect(page.locator('.cast-card')).toHaveCount(5);
  await expect(page.getByRole('button', { name: '确认阵容，开始讨论' })).toBeEnabled();
});
