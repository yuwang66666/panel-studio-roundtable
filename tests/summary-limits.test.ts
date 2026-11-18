import { describe, expect, it } from 'vitest';
import { ProseOutputSchema } from '../packages/contracts/src/index';
import { ModelGateway, type Purpose } from '../apps/api/src/gateway';
import { readGatewayOptions, type GatewayOptions } from '../apps/api/src/gateway-options';
import type { PrivateConnection, Repository } from '../apps/api/src/repository';
import {
  defaultResponse,
  startProvider,
  type ProviderOptions,
  type Responder,
} from './fixtures/provider';
import { harness } from './fixtures/harness';

const protocols = ['openai-chat', 'openai-responses', 'anthropic'] as const;
const prose = '主持人总结需要完整保留已核验的共识、分歧和待验证问题。';
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function setup(
  protocol: PrivateConnection['protocol'] = 'openai-chat',
  options: Partial<GatewayOptions> = {},
  responder: Responder = () => ({ content: prose }),
  providerOptions: ProviderOptions = {},
) {
  const provider = await startProvider(responder, providerOptions);
  const runs: { purpose: string; errorCode: string | null }[] = [];
  const repo = {
    recordRun: (run: { purpose: string; errorCode: string | null }) => runs.push(run),
  } as unknown as Repository;
  const connection = {
    id: 'summary-limits-test',
    version: 1,
    protocol,
    provider: 'custom',
    model: 'fixture-only',
    baseUrl: provider.baseUrl,
    apiKey: 'fixture-only',
    structuredOutput: false,
  } as PrivateConnection;
  const gateway = new ModelGateway(repo, { retryDelay: 1, ...options });
  return {
    provider,
    runs,
    request: (
      purpose: Purpose = 'summary',
      onText?: (text: string) => void,
      signal?: AbortSignal,
    ) =>
      gateway.generate({
        connection,
        purpose,
        input: {},
        schema: ProseOutputSchema,
        onText,
        signal,
      }),
    close: provider.close,
  };
}

describe('主持人总结独立超时与输出额度', () => {
  it('defaults summaries to 240 seconds and 8192 tokens and loads separate overrides', () => {
    expect(readGatewayOptions({})).toMatchObject({
      timeout: 60000,
      insightsTimeout: 180000,
      insightsMaxTokens: 8192,
      summaryTimeout: 240000,
      summaryMaxTokens: 8192,
    });
    expect(
      readGatewayOptions({ SUMMARY_TIMEOUT_MS: '300000', SUMMARY_MAX_TOKENS: '12288' }),
    ).toMatchObject({
      timeout: 60000,
      insightsTimeout: 180000,
      insightsMaxTokens: 8192,
      summaryTimeout: 300000,
      summaryMaxTokens: 12288,
    });
  });

  it.each(
    ['SUMMARY_TIMEOUT_MS', 'SUMMARY_MAX_TOKENS'].flatMap((name) =>
      ['0', '-1', 'private-invalid-value'].map((value) => ({ name, value })),
    ),
  )('rejects invalid $name without echoing its value', ({ name, value }) => {
    let error: unknown;
    try {
      readGatewayOptions({ [name]: value });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(name);
    expect((error as Error).message).not.toContain(value);
  });

  it.each(protocols)(
    'sends default and custom summary token limits through %s',
    async (protocol) => {
      const standard = await setup(protocol),
        custom = await setup(protocol, { summaryMaxTokens: 12288 });
      const field = protocol === 'openai-responses' ? 'max_output_tokens' : 'max_tokens';
      try {
        await standard.request();
        expect(standard.provider.calls[0].body[field]).toBe(8192);
        for (const purpose of ['summary', 'insights', 'cast', 'opening'] as const)
          await custom.request(purpose);
        expect(custom.provider.calls.map((call) => call.body[field])).toEqual([
          12288, 8192, 4096, 1200,
        ]);
      } finally {
        await standard.close();
        await custom.close();
      }
    },
  );

  it('lets summaries exceed the ordinary deadline while respecting their own deadline', async () => {
    const s = await setup(
      'openai-chat',
      { timeout: 70, summaryTimeout: 1500, insightsTimeout: 70 },
      async () => {
        await delay(220);
        return { content: prose };
      },
    );
    try {
      await expect(s.request('opening')).rejects.toMatchObject({ code: 'TIMEOUT' });
      await expect(s.request('insights')).rejects.toMatchObject({ code: 'TIMEOUT' });
      await expect(s.request()).resolves.toEqual({ content: prose });
      expect(s.runs.map((run) => [run.purpose, run.errorCode])).toEqual([
        ['opening', 'TIMEOUT'],
        ['insights', 'TIMEOUT'],
        ['summary', null],
      ]);
    } finally {
      await s.close();
    }
  });

  it('reports the summary phase and configured seconds when its deadline expires', async () => {
    const s = await setup('openai-chat', { timeout: 1500, summaryTimeout: 200 }, async () => {
      await delay(400);
      return { content: prose };
    });
    try {
      await expect(s.request()).rejects.toMatchObject({
        code: 'TIMEOUT',
        message: expect.stringMatching(/主持人总结.*0\.2\s*秒/),
      });
      expect(s.provider.calls).toHaveLength(1);
      expect(s.runs[0].errorCode).toBe('TIMEOUT');
    } finally {
      await s.close();
    }
  });

  it.each(protocols)(
    'completes a slow %s summary stream beyond the ordinary deadline',
    async (protocol) => {
      const ordinaryDeadline = 70;
      const s = await setup(
        protocol,
        { timeout: ordinaryDeadline, summaryTimeout: 2000 },
        undefined,
        { streamChunkSize: 3, streamDelayMs: 25 },
      );
      const updates: { text: string; elapsed: number }[] = [],
        started = Date.now();
      try {
        await expect(
          s.request('summary', (text) => updates.push({ text, elapsed: Date.now() - started })),
        ).resolves.toEqual({ content: prose });
        expect(
          updates.filter((u) => u.text && u.elapsed > ordinaryDeadline).length,
        ).toBeGreaterThan(1);
        expect(updates.at(-1)?.text).toBe(prose);
        expect(s.provider.calls).toHaveLength(1);
        expect(s.provider.calls[0].body.stream).toBe(true);
        expect(s.runs[0].errorCode).toBeNull();
      } finally {
        await s.close();
      }
    },
  );

  it('can cancel a summary after public text begins even with the longer deadline', async () => {
    const s = await setup('openai-chat', {}, undefined, { streamChunkSize: 3, streamDelayMs: 20 });
    const controller = new AbortController();
    try {
      await expect(
        s.request(
          'summary',
          (text) => {
            if (text) controller.abort();
          },
          controller.signal,
        ),
      ).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(s.provider.calls).toHaveLength(1);
      expect(s.runs[0].errorCode).toBe('CANCELLED');
    } finally {
      await s.close();
    }
  });

  it('keeps the summary deadline and token budget during output repair', async () => {
    let attempts = 0;
    const s = await setup(
      'openai-chat',
      { timeout: 50, summaryTimeout: 1500, summaryMaxTokens: 12288 },
      async () => {
        await delay(150);
        return ++attempts === 1 ? '{"content":"未完成的初稿' : { content: prose };
      },
    );
    const updates: string[] = [];
    try {
      await expect(s.request('summary', (text) => updates.push(text))).resolves.toEqual({
        content: prose,
      });
      expect(s.provider.calls).toHaveLength(2);
      expect(s.provider.calls.map((call) => call.body.max_tokens)).toEqual([12288, 12288]);
      expect(s.runs.map((run) => run.errorCode)).toEqual(['INVALID_OUTPUT', null]);
      expect(updates.filter((text) => text === '')).toHaveLength(2);
      expect(updates.at(-1)).toBe(prose);
    } finally {
      await s.close();
    }
  });

  it('retries a timed-out summary without repeating already completed insights or expert messages', async () => {
    let slowSummary = true;
    const purposes: string[] = [];
    const h = await harness(async (task) => {
      purposes.push(task.purpose);
      if (task.purpose === 'summary' && slowSummary) await delay(1700);
      return defaultResponse(task);
    });
    try {
      const created = h.repo.createDiscussion(
        '如何确保洞察完成后仅重试总结？',
        4,
        h.connection.id,
        3,
      );
      const id = created.discussion.id;
      h.discussions.cast(id);
      await h.discussions.idle(id);
      let s = h.repo.snapshot(id);
      h.repo.start(id, s.discussion.version, s.discussion.castVersion, 3);
      h.discussions.run(id);
      await h.discussions.idle(id);
      s = h.repo.snapshot(id);
      expect(s.discussion.status).toBe('failed');
      expect(s.discussion.failureStage).toBe('summary');
      expect(s.discussion.error).toMatch(/主持人总结.*1\.5\s*秒/);
      expect(s.draft).toBeNull();
      expect(s.discussion.insightsThrough).toBe(s.messages.at(-1)?.messageSeq);
      expect(s.insights.length).toBeGreaterThan(0);
      const before = s;
      const insightCalls = purposes.filter((purpose) => purpose === 'insights').length;
      slowSummary = false;
      const retry = await h.command('POST', `/api/discussions/${id}/retry`, {
        expectedVersion: s.discussion.version,
      });
      expect(retry.statusCode).toBe(202);
      await h.discussions.idle(id);
      s = h.repo.snapshot(id);
      expect(s.discussion.status).toBe('completed');
      expect(s.messages.slice(0, before.messages.length)).toEqual(before.messages);
      expect(s.messages.filter((message) => message.kind === 'summary')).toHaveLength(1);
      expect(s.draft).toBeNull();
      expect(s.insights).toEqual(before.insights);
      expect(purposes.filter((purpose) => purpose === 'insights')).toHaveLength(insightCalls);
      expect(purposes.filter((purpose) => purpose === 'summary')).toHaveLength(2);
    } finally {
      await h.close();
    }
  });
});
