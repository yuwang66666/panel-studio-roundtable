import { test, expect, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve, sep } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createApp } from '../../apps/api/src/app';
import { startProvider } from '../fixtures/provider';
import { makeSample } from '../../packages/domain/src/samples';
import type { DiscussionSnapshot } from '../../packages/contracts/src/index';

let provider: Awaited<ReturnType<typeof startProvider>>;
let backend: Awaited<ReturnType<typeof createApp>>;
let vite: { close(): Promise<void> } | undefined;
let dir: string;
let castId: string;
const studioId = 'layout-studio';
const widths = [375, 768, 1024, 1440, 2560];
const paneScrollers = ['.experts-list', '.transcript-scroll', '.insights-list'];

function sampleCopy(id: string, index = 0): DiscussionSnapshot {
  const original = makeSample(index);
  return JSON.parse(JSON.stringify(original).replaceAll(original.discussion.id, id));
}

test.beforeAll(async () => {
  mkdirSync(resolve('.tmp'), { recursive: true });
  dir = mkdtempSync(resolve('.tmp/layout-e2e-'));
  provider = await startProvider();
  const modelIds = Array.from({ length: 20 }, (_, i) => `M${String(i + 1).padStart(2, '0')}`);
  const modelEnv: NodeJS.ProcessEnv = {
    PANEL_MODELS: modelIds.join(','),
    PANEL_DEFAULT_MODERATOR: modelIds[0],
  };
  for (const id of modelIds) {
    modelEnv[`MODEL_${id}_NAME`] = `布局验收模型 ${id}`;
    modelEnv[`MODEL_${id}_PROVIDER`] = 'custom';
    modelEnv[`MODEL_${id}_PROTOCOL`] = 'openai-chat';
    modelEnv[`MODEL_${id}_BASE_URL`] = provider.baseUrl;
    modelEnv[`MODEL_${id}_MODEL`] = `layout-fixture-${id}`;
    modelEnv[`MODEL_${id}_API_KEY`] = `layout-fake-key-${id}`;
  }
  backend = await createApp({
    dataDir: dir,
    origins: ['http://127.0.0.1:5176'],
    modelEnv,
  });
  for (let i = 0; i < 24; i++) {
    const sample = sampleCopy(`layout-history-${i}`, i % 5);
    sample.discussion.topic = `布局验收 ${i + 1}：${sample.discussion.topic}`;
    backend.repo.importSample(sample);
  }
  const studio = sampleCopy(studioId);
  studio.messages = [
    { ...studio.messages[0], id: `${studioId}-m1`, messageSeq: 1 },
    ...Array.from({ length: 16 }, (_, index) => ({
      ...studio.messages[(index % 4) + 1],
      id: `${studioId}-m${index + 2}`,
      turnId: `${studioId}-t${index + 2}`,
      messageSeq: index + 2,
      content: `${studio.messages[(index % 4) + 1].content} 本条是独立滚动验收的已保存发言，检查较长正文在各屏幕宽度下仍保持清晰的阅读行宽。`,
      replyToMessageId: index > 0 ? `${studioId}-m${index + 1}` : null,
    })),
    {
      ...studio.messages.at(-1)!,
      id: `${studioId}-m18`,
      turnId: `${studioId}-t18`,
      messageSeq: 18,
    },
  ];
  studio.discussion.insightsThrough = 17;
  studio.insights = Array.from({ length: 20 }, (_, index) => {
    const base = studio.insights[index % 3];
    return {
      ...base,
      id: `${studioId}-insight-${index}`,
      text: `第 ${index + 1} 条已核验洞察：${base.text} 需要结合已保存发言核对适用范围与实施条件。`,
      throughMessageSeq: 17,
      participantIds: [studio.participants[1].id, studio.participants[2].id],
      evidence: [
        { messageId: studio.messages[1].id, relation: 'supports' as const },
        { messageId: studio.messages[2].id, relation: 'supports' as const },
      ],
    };
  });
  backend.repo.importSample(studio);
  const initial = backend.repo.createDiscussion(
    '六位专家的阵容分配应如何在窄屏完整操作？',
    6,
    'env:M01',
  );
  castId = initial.discussion.id;
  backend.discussions.cast(castId);
  await backend.discussions.idle(castId);
  expect(backend.repo.snapshot(castId).participants).toHaveLength(7);
  const target = await backend.app.listen({ port: 0, host: '127.0.0.1' });
  const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
  const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
  const server = await createServer({
    root: resolve('apps/web'),
    server: { port: 5176, host: '127.0.0.1', strictPort: true, proxy: { '/api': target } },
  });
  vite = server;
  await server.listen();
});

test.afterAll(async () => {
  await vite?.close();
  await backend?.app.close();
  await provider?.close();
  if (dir?.startsWith(resolve('.tmp') + sep)) rmSync(dir, { recursive: true, force: true });
});

async function expectFixedDocument(page: Page) {
  const result = await page.evaluate(() => {
    const doc = document.scrollingElement!;
    window.scrollTo(200, 200);
    return {
      width: doc.scrollWidth,
      height: doc.scrollHeight,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      x: scrollX,
      y: scrollY,
    };
  });
  expect(result.width).toBeLessThanOrEqual(result.viewportWidth + 1);
  expect(result.height).toBeLessThanOrEqual(result.viewportHeight + 1);
  expect(result.x).toBe(0);
  expect(result.y).toBe(0);
}

async function scrollIndependently(page: Page, selector: string, peers: string[] = []) {
  await expect(page.locator(selector)).toBeVisible();
  const result = await page.locator(selector).evaluate((element, peerSelectors) => {
    const scroller = element as HTMLElement;
    const before = peerSelectors.map((s) => document.querySelector<HTMLElement>(s)?.scrollTop ?? 0);
    const ownBefore = scroller.scrollTop;
    scroller.scrollTop = ownBefore > 0 ? 0 : scroller.scrollHeight;
    return {
      overflow: scroller.scrollHeight > scroller.clientHeight + 1,
      moved: scroller.scrollTop !== ownBefore,
      otherPositions: peerSelectors.map(
        (s) => document.querySelector<HTMLElement>(s)?.scrollTop ?? 0,
      ),
      before,
      documentY: scrollY,
      height: scroller.clientHeight,
      bottom: scroller.getBoundingClientRect().bottom,
      viewportHeight: innerHeight,
    };
  }, peers);
  expect(result.overflow, `${selector} should have real overflowing content`).toBe(true);
  expect(result.moved, `${selector} should scroll`).toBe(true);
  expect(result.otherPositions).toEqual(result.before);
  expect(result.documentY).toBe(0);
  expect(result.height).toBeGreaterThan(60);
  expect(result.bottom).toBeLessThanOrEqual(result.viewportHeight + 1);
}

for (const width of widths) {
  test(`${width}px首页、模型设置和阵容均在容器内完整操作`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.locator('.discussion-card')).toHaveCount(26);
    await expectFixedDocument(page);
    await scrollIndependently(page, '.discussion-library', ['.home-overview']);
    await page.locator('.discussion-card-link').last().scrollIntoViewIfNeeded();
    await expect(page.locator('.discussion-card-link').last()).toBeInViewport();
    await expectFixedDocument(page);
    await expect(page.getByRole('button', { name: '开启一场圆桌' })).toHaveCSS(
      'transition-duration',
      '0s',
    );
    await page.getByRole('button', { name: '开启一场圆桌' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await page.screenshot({ path: `test-results/layout/home-${width}.png` });

    await page.goto('/settings');
    await expect(page.locator('.connection-card')).toHaveCount(20);
    await expectFixedDocument(page);
    await scrollIndependently(page, '.models-scroll', ['.model-preferences']);
    await page.locator('.connection-card').last().getByRole('button', { name: '测试连接' }).click();
    await expect(
      page.locator('.connection-card').last().getByText('连接验证通过', { exact: true }),
    ).toBeVisible();
    await page.getByLabel('默认主持人模型').selectOption('env:M20');
    await expect(page.getByLabel('默认主持人模型')).toHaveValue('env:M20');
    if (
      await page
        .locator('.model-preferences')
        .evaluate((element) => element.scrollHeight > element.clientHeight + 1)
    )
      await scrollIndependently(page, '.model-preferences', ['.models-scroll']);
    await page.getByRole('link', { name: '前往讨论空间' }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('link', { name: '前往讨论空间' })).toBeInViewport();
    await expectFixedDocument(page);
    await page.screenshot({ path: `test-results/layout/settings-${width}.png` });

    await page.goto(`/discussions/${castId}`);
    await expect(page.locator('.cast-card')).toHaveCount(7);
    await expectFixedDocument(page);
    await scrollIndependently(page, '.cast-content');
    await page.getByLabel('嘉宾6的模型').selectOption('env:M20');
    await page.getByRole('button', { name: '保存分配', exact: true }).click();
    await expect(page.getByRole('button', { name: '保存分配', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: '确认阵容，开始讨论' })).toBeInViewport();
    await page.reload();
    await expect(page.getByLabel('嘉宾6的模型')).toHaveValue('env:M20');
    await page.getByLabel('嘉宾6的模型').scrollIntoViewIfNeeded();
    await expect(page.getByLabel('嘉宾6的模型')).toBeInViewport();
    await expectFixedDocument(page);
    await page.screenshot({ path: `test-results/layout/cast-${width}.png` });
  });

  test(`${width}px演播厅区域独立滚动、页签和阅读行宽正确`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/discussions/${studioId}`);
    await expect(page.locator('.summary-title')).toBeVisible();
    await expectFixedDocument(page);
    if (width <= 1100) {
      for (const [name, panel, scroller] of [
        ['现场', '.transcript-panel', '.transcript-scroll'],
        ['专家', '.experts-panel', '.experts-list'],
        ['洞察', '.insights-panel', '.insights-list'],
      ]) {
        const tab = page.getByRole('tab', { name, exact: true });
        await tab.click();
        await expect(tab).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator(panel)).toBeVisible();
        for (const other of ['.transcript-panel', '.experts-panel', '.insights-panel'].filter(
          (p) => p !== panel,
        ))
          await expect(page.locator(other)).toBeHidden();
        const controlId = await tab.getAttribute('aria-controls');
        expect(controlId).toBeTruthy();
        await expect(page.locator(panel)).toHaveAttribute('id', controlId!);
        await scrollIndependently(
          page,
          scroller,
          paneScrollers.filter((s) => s !== scroller),
        );
        await expectFixedDocument(page);
      }
      const first = page.getByRole('tab', { name: '现场', exact: true });
      await first.focus();
      await page.keyboard.press('ArrowRight');
      await expect(page.getByRole('tab', { name: '专家', exact: true })).toBeFocused();
      await expect(page.locator('.experts-panel')).toBeVisible();
      await page.keyboard.press('End');
      await expect(page.getByRole('tab', { name: '洞察', exact: true })).toBeFocused();
      await page.keyboard.press('Home');
      await expect(first).toBeFocused();
      await expect(page.locator('.transcript-panel')).toBeVisible();
    } else {
      for (const scroller of paneScrollers)
        await scrollIndependently(
          page,
          scroller,
          paneScrollers.filter((s) => s !== scroller),
        );
      await expectFixedDocument(page);
    }
    const visibleContent = page.locator('.transcript-panel .message-content').first();
    const contentBox = await visibleContent.boundingBox();
    expect(contentBox!.width).toBeLessThanOrEqual(900);
    if (width >= 1440) {
      const expertsBox = await page.locator('.experts-panel').boundingBox();
      const insightsBox = await page.locator('.insights-panel').boundingBox();
      expect(expertsBox!.width).toBeGreaterThanOrEqual(240);
      expect(insightsBox!.width).toBeGreaterThanOrEqual(300);
    }
    await page.screenshot({ path: `test-results/layout/studio-${width}.png` });
  });
}

test('375×568短视口的创建、设置及阵容操作不被裁切', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 568 });
  await page.goto('/');
  await expect(page.locator('.discussion-card')).toHaveCount(26);
  await expectFixedDocument(page);
  await page.getByRole('button', { name: '开启一场圆桌' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.getByLabel('想讨论什么？').fill('短视口下如何访问所有操作？');
  await page.getByRole('button', { name: '生成讨论阵容' }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: '生成讨论阵容' })).toBeInViewport();
  await expectFixedDocument(page);
  await page.keyboard.press('Escape');
  await page.goto('/settings');
  await expect(page.locator('.connection-card')).toHaveCount(20);
  const finalConnectionTest = page
    .locator('.connection-card')
    .last()
    .getByRole('button', { name: '测试连接' });
  await finalConnectionTest.scrollIntoViewIfNeeded();
  await expect(finalConnectionTest).toBeInViewport();
  await page.getByLabel('默认主持人模型').scrollIntoViewIfNeeded();
  await expect(page.getByLabel('默认主持人模型')).toBeInViewport();
  await expectFixedDocument(page);
  await page.goto(`/discussions/${castId}`);
  await expect(page.locator('.cast-card')).toHaveCount(7);
  await page.locator('.cast-topic').scrollIntoViewIfNeeded();
  await expect(page.locator('.cast-topic')).toBeInViewport();
  await page.getByLabel('嘉宾6的模型').scrollIntoViewIfNeeded();
  await expect(page.getByLabel('嘉宾6的模型')).toBeInViewport();
  await page.getByRole('button', { name: '保存分配', exact: true }).click();
  await expect(page.getByRole('button', { name: '确认阵容，开始讨论' })).toBeInViewport();
  await expectFixedDocument(page);
  await page.screenshot({ path: 'test-results/layout/cast-short-375.png' });
});
