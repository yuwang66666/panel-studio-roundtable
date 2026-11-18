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
const stateTopic = '专家状态小窗如何准确反映当前公开讨论？';
const statePauses = ['intent', 'beforeText', 'partialText'].map((name) => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { name, entered: false, promise, release };
});
test.beforeAll(async () => {
  mkdirSync(resolve('.tmp'), { recursive: true });
  dir = mkdtempSync(resolve('.tmp/e2e-'));
  provider = await startProvider(
    async (task) => {
      if (task.input?.context?.topic === stateTopic) {
        if (task.purpose === 'intent') {
          statePauses[0].entered = true;
          await statePauses[0].promise;
          const context = task.input.context;
          return context.participant.name === '嘉宾1'
            ? {
                action: 'rebut',
                targetMessageId: context.messages[0].id,
                proposedFocus: 'PRIVATE_INTENT_NOT_PUBLIC',
              }
            : { action: 'pass', targetMessageId: null, proposedFocus: 'PRIVATE_INTENT_NOT_PUBLIC' };
        }
        if (task.purpose === 'utterance') {
          statePauses[1].entered = true;
          await statePauses[1].promise;
        }
        return defaultResponse(task);
      }
      await new Promise((r) => setTimeout(r, task.purpose === 'utterance' ? 100 : 50));
      return defaultResponse(task);
    },
    {
      streamChunkSize: 6,
      streamDelayMs: 15,
      afterStreamChunk: async ({ task, textSoFar }) => {
        if (task.input?.context?.topic === stateTopic) {
          if (task.purpose === 'utterance' && textSoFar.length >= 36 && !statePauses[2].entered) {
            statePauses[2].entered = true;
            await statePauses[2].promise;
          }
          return;
        }
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
  statePauses.forEach((p) => p.release());
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

test('历史总结仅展示自然语言，异常格式明确转为本地整理且保留证据', async ({ page }) => {
  const stored = backend.repo.snapshot('sample-1');
  const s = makeSample(0);
  const summary = s.messages.find((m) => m.kind === 'summary')!;
  summary.content = JSON.stringify({
    content: JSON.stringify({ summary: '本场讨论认可先明确适用条件。\n\n各方仍需验证实施成本。' }),
  });
  await page.route('**/api/discussions/sample-1/snapshot', (route) => route.fulfill({ json: s }));
  await page.goto('/discussions/sample-1');
  await expect(page.locator('.summary-message .message-content')).toHaveText(
    '本场讨论认可先明确适用条件。各方仍需验证实施成本。',
  );
  await expect(page.locator('.summary-format-note')).toHaveCount(0);
  await expect(page.locator('.summary-title')).toHaveText('本场圆桌总结');

  summary.content = JSON.stringify({
    reasoning: 'PRIVATE_SUMMARY_REASONING',
    result: { conclusion: 'UNKNOWN_SUMMARY_STRUCTURE' },
  });
  summary.summaryMeta = {
    source: 'model',
    throughMessageSeq: 5,
    insightsThroughMessageSeq: 5,
    model: '历史模型',
    provider: 'gpt',
    connectionId: 'env:GPT',
    connectionVersion: 1,
    fallbackUsed: false,
    reason: null,
  };
  s.messages.push({
    ...s.messages[1],
    id: 'sample-1-later',
    turnId: 'sample-1-later-turn',
    messageSeq: 7,
    content: '旧总结之后的发言不应进入旧摘要整理。',
  });
  s.discussion.insightsThrough = 7;
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/discussions/sample-1');
    await expect(page.locator('.summary-title')).toHaveText('本地整理摘要');
    await expect(page.locator('.summary-format-note')).toContainText('原总结格式异常');
    await expect(page.locator('.summary-format-note')).toContainText('原记录未修改');
    await expect(page.locator('.local-summary-message .message-meta strong')).toHaveText(
      '本地整理',
    );
    const rendered = await page.locator('.summary-message').innerText();
    for (const raw of [
      'PRIVATE_SUMMARY_REASONING',
      'UNKNOWN_SUMMARY_STRUCTURE',
      'reasoning',
      '历史模型',
      '旧总结之后的发言不应进入旧摘要整理',
    ])
      expect(rendered).not.toContain(raw);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.locator('.summary-title').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/live/summary-prose-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 375, height: 900 });
  await page.getByRole('button', { name: '查看整理来源发言 2', exact: true }).first().click();
  await expect(page.locator('#sample-1-m2')).toBeInViewport();
  delete summary.summaryMeta;
  await page.reload();
  await expect(page.locator('.summary-title')).toHaveText('本地整理摘要');
  await expect(page.locator('.summary-format-note')).toBeVisible();
  await expect(
    page.getByRole('button', { name: '查看整理来源发言 2', exact: true }).first(),
  ).toBeAttached();
  expect(backend.repo.snapshot('sample-1')).toEqual(stored);
});

test('总结草稿阻止结构化原文，刷新后仍展示安全正文', async ({ page }) => {
  const s = makeSample(1);
  s.messages = s.messages.filter((m) => m.kind !== 'summary');
  s.discussion.status = 'summarizing';
  s.draft = {
    turnId: 'safe-summary-draft',
    discussionId: s.discussion.id,
    participantId: s.participants[0].id,
    generation: s.discussion.generation,
    kind: 'summary',
    content: '{"reasoning":"PRIVATE_STREAM_REASONING',
    replyToMessageId: null,
    startedAt: s.discussion.updatedAt,
  };
  await page.route('**/api/discussions/sample-2/snapshot', (route) => route.fulfill({ json: s }));
  await page.setViewportSize({ width: 375, height: 900 });
  await page.goto('/discussions/sample-2');
  await expect(page.locator('.streaming-summary-title')).toHaveText('本场圆桌总结');
  await expect(page.locator('.streaming-placeholder')).toBeVisible();
  expect(await page.locator('body').innerText()).not.toContain('PRIVATE_STREAM_REASONING');
  s.draft.content = '{"content":"本场讨论需要先明确边界';
  await page.reload();
  await expect(page.locator('.streaming-placeholder')).toBeVisible();
  s.draft.content = JSON.stringify({ content: '本场讨论需要先明确边界，再验证成本。' });
  await page.reload();
  await expect(page.locator('.streaming-message .message-content')).toHaveText(
    '本场讨论需要先明确边界，再验证成本。',
  );
  s.draft.content = '本场讨论已形成有条件的共识。';
  await page.reload();
  await expect(page.locator('.streaming-message .message-content')).toHaveText(
    '本场讨论已形成有条件的共识。',
  );
  s.draft.content += '\n\n{"reasoning":"PRIVATE_STREAM_REASONING"}';
  await page.reload();
  const rendered = await page.locator('.streaming-message .message-content').innerText();
  expect(rendered).toContain('本场讨论已形成有条件的共识。');
  expect(rendered).not.toMatch(/reasoning|PRIVATE_STREAM_REASONING|[{}]/);
});

test('历史讨论确认删除、失败重试、刷新和跨页清理可用', async ({ page, context }) => {
  const sample = backend.repo.snapshot('sample-5');
  const preserved = backend.repo.snapshot('sample-1');
  const casting = backend.repo.createDiscussion('正在准备中的讨论不可删除', 4, 'env:CHAT');
  const watcher = await context.newPage();
  await watcher.goto('/discussions/sample-5');
  await expect(watcher.locator('.summary-title')).toBeVisible();
  await page.goto('/discussions/sample-5');
  await expect(page.locator('.summary-title')).toBeVisible();
  await page.getByRole('link', { name: '讨论空间', exact: true }).click();
  const card = page.locator('.discussion-card').filter({
    has: page.getByRole('heading', { name: sample.discussion.topic, exact: true }),
  });
  const activeCard = page.locator('.discussion-card').filter({
    has: page.getByRole('heading', { name: casting.discussion.topic, exact: true }),
  });
  await expect(activeCard).toBeVisible();
  await expect(activeCard.getByRole('button', { name: '删除会话' })).toHaveCount(0);
  const dialog = page.getByRole('dialog', { name: '删除这场讨论？', exact: true });
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await card.getByRole('button', { name: '删除会话' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(dialog).toContainText(sample.discussion.topic);
    await expect(dialog).toContainText('无法恢复');
    await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `test-results/live/delete-confirm-${width}.png`,
      fullPage: true,
    });
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(card.getByRole('button', { name: '删除会话' })).toBeFocused();
    expect(backend.repo.snapshot('sample-5')).toEqual(sample);
  }
  let deletes = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/discussions/sample-5', async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue();
    deletes++;
    if (deletes === 1)
      return route.fulfill({ status: 503, json: { error: { message: '模拟删除失败，请重试' } } });
    await gate;
    return route.continue();
  });
  try {
    await card.getByRole('button', { name: '删除会话' }).click();
    await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('模拟删除失败');
    await expect(card).toBeVisible();
    expect(backend.repo.snapshot('sample-5')).toEqual(sample);
    await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '删除中' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    release();
    await expect(dialog).not.toBeVisible();
    await expect(card).toHaveCount(0);
    await expect(page.getByRole('status')).toContainText('已删除');
    expect(deletes).toBe(2);
    await expect(watcher.getByText(/讨论不存在|已被删除/)).toBeVisible();
    expect((await page.request.get('/api/discussions/sample-5/snapshot')).status()).toBe(404);
    expect(backend.repo.snapshot('sample-1')).toEqual(preserved);
    await page.reload();
    await expect(page.locator('.discussion-card').first()).toBeVisible();
    await expect(card).toHaveCount(0);
    await page.goto('/discussions/sample-5');
    await expect(page.getByRole('alert')).toContainText(/讨论不存在|已被删除/);
  } finally {
    release();
    await watcher.close();
  }
});

test('专家状态准确随任务推进，刷新重连恢复且不泄露内部意愿', async ({ page, context }) => {
  const created = backend.repo.createDiscussion(stateTopic, 4, 'env:CHAT', 1);
  const id = created.discussion.id;
  backend.discussions.cast(id);
  await backend.discussions.idle(id);
  const ready = backend.repo.snapshot(id);
  const experts = ready.participants.filter((p) => p.role === 'expert');
  const speaker = experts.find((p) => p.name === '嘉宾1')!;
  const card = (participantId: string) =>
    page.locator(`.expert-item[data-participant-id="${participantId}"]`);
  try {
    await page.goto(`/discussions/${id}`);
    await page.getByRole('button', { name: '确认阵容，开始讨论' }).click();
    await expect.poll(() => statePauses[0].entered).toBe(true);
    for (const p of experts) {
      await expect(card(p.id)).toHaveAttribute('data-state', 'preparing');
      await expect(card(p.id).locator('.focus')).toContainText('公开关注点');
      await expect(card(p.id).locator('.focus')).toContainText('第 1 条发言');
    }
    await expect(page.locator('.experts-panel [role="status"]')).toHaveCount(1);
    await page.setViewportSize({ width: 375, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('tab', { name: '专家' }).click();
    await expect(page.getByRole('tab', { name: '专家' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.experts-panel')).toBeVisible();
    await expect(card(speaker.id).locator('.spin')).toHaveCSS('animation-name', 'none');
    await page.screenshot({ path: 'test-results/live/expert-preparing-375.png', fullPage: true });
    await page.reload();
    await page.getByRole('tab', { name: '专家' }).click();
    for (const p of experts) await expect(card(p.id)).toHaveAttribute('data-state', 'preparing');
    await context.setOffline(true);
    statePauses[0].release();
    await expect.poll(() => statePauses[1].entered).toBe(true);
    expect(backend.repo.snapshot(id).draft?.content).toBe('');
    await context.setOffline(false);
    await expect(card(speaker.id)).toHaveAttribute('data-state', 'preparing');
    for (const p of experts.filter((p) => p.id !== speaker.id))
      await expect(card(p.id)).toHaveAttribute('data-state', 'idle');
    await expect(card(speaker.id).locator('.focus')).toContainText('准备回应第 1 条发言');
    statePauses[1].release();
    await expect.poll(() => statePauses[2].entered).toBe(true);
    await expect(card(speaker.id)).toHaveAttribute('data-state', 'speaking');
    await expect(card(speaker.id).locator('.expert-status-label')).toHaveText('发言中');
    await expect(card(speaker.id).locator('.focus')).toContainText('正在回应第 1 条发言');
    await page.screenshot({ path: 'test-results/live/expert-speaking-375.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.reload();
    await expect(card(speaker.id)).toHaveAttribute('data-state', 'speaking');
    await page.screenshot({ path: 'test-results/live/expert-speaking-1440.png', fullPage: true });
    for (const width of [375, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      if (width <= 1100) await page.getByRole('tab', { name: '专家' }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    const publicState = JSON.stringify(backend.repo.snapshot(id));
    const publicEvents = JSON.stringify(backend.repo.eventsAfter(id, 0, 1000));
    for (const secret of ['PRIVATE_INTENT_NOT_PUBLIC', 'HIDDEN_REASONING']) {
      expect(publicState).not.toContain(secret);
      expect(publicEvents).not.toContain(secret);
      expect(await page.locator('body').innerText()).not.toContain(secret);
    }
    statePauses[2].release();
    await expect(page.locator('.summary-title')).toBeVisible();
    for (const p of ready.participants) {
      await expect(card(p.id)).toHaveAttribute('data-state', 'idle');
      expect(
        backend.repo.snapshot(id).participants.find((actor) => actor.id === p.id)?.publicFocus,
      ).toBeNull();
    }
    await expect(page.locator('.expert-status-summary')).toHaveText('全部待机');
    expect(backend.repo.snapshot(id).messages.filter((m) => m.kind === 'expert')).toHaveLength(1);
  } finally {
    statePauses.forEach((p) => p.release());
    await context.setOffline(false);
  }
});
