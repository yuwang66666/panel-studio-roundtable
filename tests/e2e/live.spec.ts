import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve, sep } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { createApp } from '../../apps/api/src/app';
import { startProvider, defaultResponse } from '../fixtures/provider';
import { makeSample } from '../../packages/domain/src/samples';
import { buildLocalSummary } from '../../packages/domain/src/local-summary';
let provider: Awaited<ReturnType<typeof startProvider>>,
  backend: Awaited<ReturnType<typeof createApp>>,
  vite: any,
  dir: string;
const openingPauses = [24, 36].map((at) => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { at, entered: false, promise, release };
});
test.beforeAll(async () => {
  mkdirSync(resolve('.tmp'), { recursive: true });
  dir = mkdtempSync(resolve('.tmp/e2e-'));
  provider = await startProvider(
    async (task) => {
      await new Promise((r) => setTimeout(r, task.purpose === 'utterance' ? 100 : 50));
      return defaultResponse(task);
    },
    {
      streamChunkSize: 6,
      streamDelayMs: 15,
      afterStreamChunk: async ({ task, textSoFar }) => {
        if (task.purpose !== 'opening') return;
        const pause = openingPauses.find((p) => !p.entered && textSoFar.length >= p.at);
        if (pause) {
          pause.entered = true;
          await pause.promise;
        }
      },
    },
  );
  const fixtureEnv = [
    'PANEL_MODELS=CHAT,CLAUDE,GPT',
    'PANEL_DEFAULT_MODERATOR=CHAT',
    ...[
      {
        id: 'CHAT',
        name: '本地协议验收',
        provider: 'custom',
        protocol: 'openai-chat',
        model: 'fixture-model',
      },
      {
        id: 'CLAUDE',
        name: 'Claude 协议专家',
        provider: 'claude',
        protocol: 'anthropic',
        model: 'fixture-claude',
      },
      {
        id: 'GPT',
        name: 'GPT 协议专家',
        provider: 'gpt',
        protocol: 'openai-responses',
        model: 'fixture-gpt',
      },
    ].flatMap((c) => [
      `MODEL_${c.id}_NAME=${c.name}`,
      `MODEL_${c.id}_PROVIDER=${c.provider}`,
      `MODEL_${c.id}_PROTOCOL=${c.protocol}`,
      `MODEL_${c.id}_BASE_URL=${provider.baseUrl}`,
      `MODEL_${c.id}_MODEL=${c.model}`,
      `MODEL_${c.id}_API_KEY=e2e-env-${c.id}-only`,
    ]),
  ].join('\n');
  writeFileSync(resolve(dir, '.env'), fixtureEnv);
  backend = await createApp({
    dataDir: dir,
    origins: ['http://127.0.0.1:5174'],
    modelEnv: parseEnv(readFileSync(resolve(dir, '.env'), 'utf8')),
  });
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
  openingPauses.forEach((p) => p.release());
  await vite?.close();
  await backend?.app.close();
  await provider?.close();
  if (dir?.startsWith(resolve('.tmp') + sep)) rmSync(dir, { recursive: true, force: true });
});
test('三协议发言逐段显示，刷新和断线恢复草稿并完成讨论', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/settings');
  await expect(page.locator('.connection-card')).toHaveCount(3);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.getByLabel('API Key', { exact: true })).toHaveCount(0);
  const publicModels = await (await page.request.get('/api/model-connections')).text();
  expect(publicModels).not.toContain('e2e-env-');
  expect(publicModels).not.toContain('"apiKey"');
  await expect(page.getByLabel('默认主持人模型')).toHaveValue('env:CHAT');
  const chatCard = page
    .locator('.connection-card')
    .filter({ has: page.getByRole('heading', { name: '本地协议验收', exact: true }) });
  await chatCard.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(chatCard.locator('.test-tag')).toHaveText('连接验证通过');
  await page.getByLabel('默认主持人模型').selectOption('env:GPT');
  await expect(page.getByLabel('默认主持人模型')).toHaveValue('env:GPT');
  await page.reload();
  await expect(page.getByLabel('默认主持人模型')).toHaveValue('env:GPT');
  await page.getByLabel('默认主持人模型').selectOption('env:CHAT');
  await expect(page.getByLabel('默认主持人模型')).toHaveValue('env:CHAT');
  await page.getByRole('link', { name: '讨论空间', exact: true }).click();
  await page.getByRole('button', { name: '开启一场圆桌' }).click();
  await page.getByLabel('想讨论什么？').fill('如何评估多智能体对企业决策的帮助？');
  await page.getByRole('button', { name: '生成讨论阵容' }).click();
  await expect(page.locator('.cast-card')).toHaveCount(5);
  await page.reload();
  await expect(page.locator('.cast-card')).toHaveCount(5);
  await page.getByLabel('嘉宾1的模型').selectOption({ label: 'Claude 协议专家 · fixture-claude' });
  await page.getByLabel('嘉宾2的模型').selectOption({ label: 'GPT 协议专家 · fixture-gpt' });
  await page.getByRole('button', { name: '确认阵容，开始讨论' }).click();
  await expect(page.getByRole('heading', { name: '现场讨论' })).toBeVisible();
  const discussionId = page.url().split('/').at(-1)!;
  const draft = page.locator('.streaming-message');
  await expect.poll(() => openingPauses[0].entered).toBe(true);
  await expect(draft.locator('.message-content')).toContainText('欢迎');
  await expect(page.locator('.message')).toHaveCount(0);
  const firstDraft = backend.repo.snapshot(discussionId).draft!;
  expect(firstDraft.content.length).toBeGreaterThan(0);
  expect(firstDraft.content.length).toBeLessThan(
    '欢迎来到圆桌，请各位结合专业背景，讨论这个问题成立的条件。'.length,
  );
  for (const hidden of ['HIDDEN_REASONING', '"content"', '"sentences"', '{'])
    expect(await draft.innerText()).not.toContain(hidden);
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(draft).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/live/streaming-mobile.png', fullPage: true });
  await page.reload();
  await expect(draft).toHaveAttribute('data-turn-id', firstDraft.turnId);
  await expect(draft.locator('.message-content')).toContainText(firstDraft.content);
  await expect(page.locator('.message')).toHaveCount(0);
  await context.setOffline(true);
  openingPauses[0].release();
  await expect.poll(() => openingPauses[1].entered).toBe(true);
  await expect
    .poll(() => backend.repo.snapshot(discussionId).draft?.content.length || 0)
    .toBeGreaterThan(firstDraft.content.length);
  const offlineDraft = backend.repo.snapshot(discussionId).draft!;
  await context.setOffline(false);
  await expect(draft).toHaveAttribute('data-turn-id', firstDraft.turnId);
  await expect(draft.locator('.message-content')).toContainText(offlineDraft.content);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: 'test-results/live/streaming-desktop.png', fullPage: true });
  openingPauses[1].release();
  await expect(page.locator('.message').first()).toContainText(
    '欢迎来到圆桌，请各位结合专业背景，讨论这个问题成立的条件。',
  );
  await expect(page.locator(`.streaming-message[data-turn-id="${firstDraft.turnId}"]`)).toHaveCount(
    0,
  );
  await expect.poll(() => page.locator('.message').count()).toBeGreaterThanOrEqual(7);
  await page.locator('.transcript-scroll').evaluate((el) => {
    el.scrollTo({ top: 0, behavior: 'instant' });
    el.dispatchEvent(new Event('scroll'));
  });
  await expect(page.locator('.streaming-message .message-content')).toBeVisible();
  const beforeGrowth = await page.locator('.transcript-scroll').innerText();
  await expect.poll(() => page.locator('.transcript-scroll').innerText()).not.toBe(beforeGrowth);
  expect(await page.locator('.transcript-scroll').evaluate((el) => el.scrollTop)).toBeLessThan(50);
  await expect(page.locator('.new-messages')).toBeVisible();
  expect(await page.locator('.transcript-scroll').evaluate((el) => el.scrollTop)).toBeLessThan(50);
  await context.setOffline(true);
  await page.waitForTimeout(700);
  await context.setOffline(false);
  try {
    await expect(page.locator('.summary-title')).toHaveText('本场圆桌总结', { timeout: 30000 });
  } catch (error) {
    const current = backend.repo.snapshot(discussionId);
    console.info('Isolated discussion diagnostics', {
      status: current.discussion.status,
      messageCount: current.messages.length,
      eventSeq: current.lastEventSeq,
      draft: current.draft && { kind: current.draft.kind, length: current.draft.content.length },
      calls: provider.calls.length,
    });
    throw error;
  }
  await expect(page.locator('.message')).toHaveCount(18);
  await expect(page.locator('.streaming-message')).toHaveCount(0);
  expect(backend.repo.snapshot(discussionId).draft).toBeNull();
  for (const path of ['/v1/chat/completions', '/v1/messages', '/v1/responses'])
    expect(provider.calls.some((c) => c.path === path && c.body.stream === true)).toBe(true);
  expect(await page.locator('.transcript-scroll').innerText()).not.toContain('HIDDEN_REASONING');
  const ids = await page.locator('.message').evaluateAll((nodes) => nodes.map((n) => n.id));
  expect(new Set(ids).size).toBe(ids.length);
  await page.reload();
  await expect(page.locator('.message')).toHaveCount(18);
  await expect(page.locator('.insight-card')).not.toHaveCount(0);
  await page.screenshot({ path: 'test-results/live/live-studio.png', fullPage: true });
  expect(errors).toEqual([]);
});
test('手机页面、独立滚动与键盘焦点可用', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await page.screenshot({ path: 'test-results/live/home-mobile.png', fullPage: true });
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
  await page.screenshot({ path: 'test-results/live/studio-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.screenshot({ path: 'test-results/live/home-desktop.png', fullPage: true });
  await page.getByRole('link', { name: '模型设置', exact: true }).click();
  await page.getByLabel('搜索模型').focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '测试连接', exact: true }).first()).toBeFocused();
  await page.getByLabel('搜索模型').fill('fixture-gpt');
  await expect(page.locator('.connection-card')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'GPT 协议专家' })).toBeVisible();
  await page.getByLabel('搜索模型').fill('不存在的模型');
  await expect(page.getByRole('heading', { name: '没有匹配的模型' })).toBeVisible();
  await page.getByRole('button', { name: '清空搜索' }).click();
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator('.connection-card')).toHaveCount(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await expect(page.getByLabel('默认主持人模型')).toBeVisible();
    await page.screenshot({ path: `test-results/live/settings-${width}.png`, fullPage: true });
  }
});

test('没有环境模型时显示配置提示且不能创建讨论', async ({ page }) => {
  await page.route('**/api/model-connections', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/settings', (route) =>
    route.fulfill({ json: { defaultModeratorConnectionId: null } }),
  );
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: '尚未配置可用模型' })).toBeVisible();
  await expect(page.getByLabel('默认主持人模型')).toBeDisabled();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await page.getByRole('link', { name: '讨论空间', exact: true }).click();
  await page.getByRole('button', { name: '开启一场圆桌' }).click();
  await page.getByLabel('想讨论什么？').fill('未配置模型时应该如何提示？');
  await expect(page.getByRole('button', { name: '生成讨论阵容' })).toBeDisabled();
});

test('本地整理与备用模型来源明确，手机可定位原始发言', async ({ page }) => {
  const s = makeSample(0);
  s.discussion.insightsThrough = 3;
  s.insights = [];
  const summary = s.messages.find((m) => m.kind === 'summary')!;
  summary.content = buildLocalSummary(s);
  summary.summaryMeta = {
    source: 'local',
    throughMessageSeq: 5,
    insightsThroughMessageSeq: 3,
    model: null,
    provider: null,
    connectionId: null,
    connectionVersion: null,
    fallbackUsed: true,
    reason: 'models_unavailable',
  };
  await page.route('**/api/discussions/sample-1/snapshot', (route) => route.fulfill({ json: s }));
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/discussions/sample-1');
    await expect(page.locator('.summary-title')).toHaveText('本地整理摘要');
    await expect(page.locator('.local-summary-message .message-meta strong')).toHaveText(
      '本地整理',
    );
    await expect(page.locator('.summary-provenance')).toContainText(
      '根据已保存发言与已核验洞察整理',
    );
    await expect(page.locator('.summary-coverage-note')).toContainText('洞察仅覆盖前 3 条发言');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.locator('.summary-title').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/live/local-summary-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 375, height: 900 });
  await page.getByRole('button', { name: '查看整理来源发言 2', exact: true }).first().click();
  await expect(page.locator('#sample-1-m2')).toBeInViewport();
  summary.summaryMeta = {
    ...summary.summaryMeta,
    source: 'model',
    model: '备用验证模型',
    provider: 'gpt',
    connectionId: 'env:GPT',
    connectionVersion: 1,
    reason: null,
  };
  summary.content = '这是本地HTTP测试数据中的备用模型总结。';
  await page.reload();
  await expect(page.locator('.summary-title')).toHaveText('本场圆桌总结');
  await expect(page.locator('.summary-provenance')).toContainText('备用模型完成：备用验证模型');
  await expect(page.locator('.local-summary-message')).toHaveCount(0);
});
