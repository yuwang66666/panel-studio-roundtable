import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve, sep } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createApp } from '../../apps/api/src/app';
import { startProvider, defaultResponse } from '../fixtures/provider';
import { makeSample } from '../../packages/domain/src/samples';
let provider: Awaited<ReturnType<typeof startProvider>>,
  backend: Awaited<ReturnType<typeof createApp>>,
  vite: any,
  dir: string;
test.beforeAll(async () => {
  mkdirSync(resolve('.tmp'), { recursive: true });
  dir = mkdtempSync(resolve('.tmp/e2e-'));
  provider = await startProvider(async (task) => {
    await new Promise((r) => setTimeout(r, task.purpose === 'utterance' ? 180 : 70));
    return defaultResponse(task);
  });
  backend = await createApp({ dataDir: dir, origins: ['http://127.0.0.1:5174'] });
  for (let i = 0; i < 5; i++) backend.repo.importSample(makeSample(i));
  const target = await backend.app.listen({ port: 0, host: '127.0.0.1' });
  const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
  const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
  vite = await createServer({
    root: resolve('apps/web'),
    server: { port: 5174, host: '127.0.0.1', strictPort: true, proxy: { '/api': target } },
  });
  await vite.listen();
});
test.afterAll(async () => {
  await vite?.close();
  await backend?.app.close();
  await provider?.close();
  if (dir?.startsWith(resolve('.tmp') + sep)) rmSync(dir, { recursive: true, force: true });
});
test('实际页面完成配置、阵容、实时讨论、断线恢复与总结', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/settings');
  await page.getByLabel('连接名称').fill('本地协议验收');
  await page.getByRole('combobox', { name: '服务商', exact: true }).selectOption('custom');
  await page.getByLabel('API 地址').fill(provider.baseUrl);
  await page.getByLabel('模型名称').fill('fixture-model');
  await page.getByLabel('API Key', { exact: true }).fill('e2e-test-only');
  await page.getByRole('button', { name: '保存连接', exact: true }).click();
  await expect(page.getByRole('heading', { name: '本地协议验收' })).toBeVisible();
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(page.locator('.test-tag')).toHaveText('连接验证通过');
  await page.getByLabel('默认主持人模型').selectOption({ label: '本地协议验收' });
  await page.getByRole('link', { name: '讨论空间', exact: true }).click();
  await page.getByRole('button', { name: '开启一场圆桌' }).click();
  await page.getByLabel('想讨论什么？').fill('如何评估多智能体对企业决策的帮助？');
  await page.getByRole('button', { name: '生成讨论阵容' }).click();
  await expect(page.locator('.cast-card')).toHaveCount(5);
  const extra = [
    { name: 'Claude 协议专家', provider: 'claude', protocol: 'anthropic', model: 'fixture-claude' },
    { name: 'GPT 协议专家', provider: 'gpt', protocol: 'openai-responses', model: 'fixture-gpt' },
  ];
  for (const c of extra)
    backend.repo.saveConnection({
      ...c,
      provider: c.provider as 'claude' | 'gpt',
      protocol: c.protocol as 'anthropic' | 'openai-responses',
      baseUrl: provider.baseUrl,
      apiKey: 'fixture-extra',
      active: true,
      structuredOutput: false,
    });
  await page.reload();
  await expect(page.locator('.cast-card')).toHaveCount(5);
  await page.getByLabel('嘉宾1的模型').selectOption({ label: 'Claude 协议专家 · fixture-claude' });
  await page.getByLabel('嘉宾2的模型').selectOption({ label: 'GPT 协议专家 · fixture-gpt' });
  await page.getByRole('button', { name: '确认阵容，开始讨论' }).click();
  await expect(page.getByRole('heading', { name: '现场讨论' })).toBeVisible();
  await expect.poll(() => page.locator('.message').count()).toBeGreaterThanOrEqual(7);
  await page.locator('.transcript-scroll').evaluate((el) => {
    el.scrollTo({ top: 0, behavior: 'instant' });
    el.dispatchEvent(new Event('scroll'));
  });
  await expect(page.locator('.new-messages')).toBeVisible();
  expect(await page.locator('.transcript-scroll').evaluate((el) => el.scrollTop)).toBeLessThan(50);
  await context.setOffline(true);
  await page.waitForTimeout(700);
  await context.setOffline(false);
  await expect(page.locator('.summary-title')).toHaveText('本场圆桌总结', { timeout: 30000 });
  await expect(page.locator('.message')).toHaveCount(18);
  const ids = await page.locator('.message').evaluateAll((nodes) => nodes.map((n) => n.id));
  expect(new Set(ids).size).toBe(ids.length);
  await page.reload();
  await expect(page.locator('.message')).toHaveCount(18);
  await expect(page.locator('.insight-card')).not.toHaveCount(0);
  await page.screenshot({ path: 'test-results/live-studio.png', fullPage: true });
  expect(errors).toEqual([]);
});
test('手机页面、独立滚动与键盘焦点可用', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await page.screenshot({ path: 'test-results/home-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '开启一场圆桌' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.goto('/discussions/sample-1');
  await expect(page.getByRole('tab', { name: '现场' })).toBeVisible();
  await page.getByRole('tab', { name: '专家' }).click();
  await expect(page.locator('.experts-panel')).toBeVisible();
  await page.getByRole('tab', { name: '洞察' }).click();
  await expect(page.locator('.insights-panel')).toBeVisible();
  await page.getByRole('button', { name: '查看证据发言 2' }).first().click();
  await expect(page.locator('#sample-1-m2')).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/studio-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.screenshot({ path: 'test-results/home-desktop.png', fullPage: true });
  await page.getByRole('link', { name: '模型设置', exact: true }).click();
  await page.getByLabel('连接名称').focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('combobox', { name: '服务商', exact: true })).toBeFocused();
  await page.screenshot({ path: 'test-results/settings-desktop.png', fullPage: true });
});
