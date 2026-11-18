import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { createApp } from '../apps/api/src/app';
import { InsightsService } from '../apps/api/src/insights';
import { makeSample } from '../packages/domain/src/samples';
import { defaultResponse, startProvider, type Responder } from './fixtures/provider';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const gatewayOptions = {
  timeout: 2000,
  insightsTimeout: 2000,
  summaryTimeout: 2000,
  retryDelay: 1,
};

async function setup(
  responder: Responder = defaultResponse,
  options: {
    summaryTimeout?: number;
    closingTimeout?: number;
    attempts?: number;
    connectionConcurrency?: number;
  } = {},
) {
  mkdirSync(resolve('.tmp'), { recursive: true });
  const dir = mkdtempSync(resolve('.tmp/summary-resilience-'));
  const provider = await startProvider(responder);
  const appOptions = {
    dataDir: dir,
    gatewayOptions: {
      ...gatewayOptions,
      summaryTimeout: options.summaryTimeout || 2000,
      connectionConcurrency: options.connectionConcurrency || 2,
    },
    closingOptions: {
      timeoutMs: options.closingTimeout || 5000,
      maxModelAttempts: options.attempts || 4,
    },
  };
  let instance = await createApp(appOptions);
  const host = instance.repo.saveConnection({
    name: '主模型',
    provider: 'custom',
    protocol: 'openai-chat',
    baseUrl: provider.baseUrl,
    model: 'host-v1',
    apiKey: 'fixture-host',
    active: true,
    structuredOutput: false,
  });
  const backup = instance.repo.saveConnection({
    name: '备用模型',
    provider: 'gpt',
    protocol: 'openai-responses',
    baseUrl: provider.baseUrl,
    model: 'backup-v1',
    apiKey: 'fixture-backup',
    active: true,
    structuredOutput: false,
  });
  function prepare(
    topic = '模型故障后如何保证总结可以交付？',
    insightsCovered = true,
    closing = true,
  ) {
    const initial = instance.repo.createDiscussion(topic, 4, host.id, 3);
    const id = initial.discussion.id;
    let ready = instance.repo.saveCast(
      id,
      initial.discussion.generation,
      makeSample(0).participants.map((p, index) => ({
        ...p,
        id: `${id}-p${index}`,
        discussionId: id,
      })),
    );
    ready = instance.repo.bind(
      id,
      ready.discussion.version,
      ready.discussion.castVersion,
      ready.participants.map((p, index) => ({
        participantId: p.id,
        connectionId: index === 1 ? backup.id : host.id,
      })),
    );
    const running = instance.repo.start(
      id,
      ready.discussion.version,
      ready.discussion.castVersion,
      3,
    );
    for (const index of [1, 2])
      instance.repo.appendMessage(id, running.discussion.generation, {
        turnId: `${id}-turn-${index}`,
        participantId: running.participants[index].id,
        kind: 'expert',
        content: `${topic}第${index}条已保存观点。`,
        replyToMessageId: null,
      });
    if (insightsCovered) instance.repo.saveInsights(id, running.discussion.generation, 2, []);
    if (closing) instance.repo.transition(id, 'summarizing');
    return instance.repo.snapshot(id);
  }
  return {
    get app() {
      return instance.app;
    },
    get repo() {
      return instance.repo;
    },
    get gateway() {
      return instance.gateway;
    },
    get discussions() {
      return instance.discussions;
    },
    provider,
    host,
    backup,
    prepare,
    async reopen() {
      await instance.app.close();
      instance = await createApp(appOptions);
    },
    async close() {
      await instance.app.close();
      await provider.close();
      if (!dir.startsWith(resolve('.tmp') + sep)) throw new Error('unsafe cleanup');
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('所有讨论共用的总结容错流程', () => {
  it.each(['auth', 'timeout', 'invalid'] as const)(
    'switches to a frozen backup after host %s failure',
    async (failure) => {
      const h = await setup(
        async (task, call) => {
          if (task.purpose === 'summary' && call.body.model === 'host-v1') {
            if (failure === 'timeout') await delay(300);
            if (failure === 'invalid') return 'not-json';
          }
          return defaultResponse(task);
        },
        { summaryTimeout: 100 },
      );
      try {
        const before = h.prepare();
        if (failure === 'auth') h.provider.fail(401);
        h.discussions.summarize(before.discussion.id);
        await h.discussions.idle(before.discussion.id);
        const result = h.repo.snapshot(before.discussion.id);
        expect(result.discussion.status).toBe('completed');
        expect(result.messages.slice(0, 2)).toEqual(before.messages);
        const summary = result.messages.at(-1)!;
        expect(summary.summaryMeta).toMatchObject({
          source: 'model',
          connectionId: h.backup.id,
          connectionVersion: 1,
          model: 'backup-v1',
          fallbackUsed: true,
          throughMessageSeq: 2,
          insightsThroughMessageSeq: 2,
        });
        expect(h.provider.calls).toHaveLength(2);
        expect(result.draft).toBeNull();
      } finally {
        await h.close();
      }
    },
  );

  it('finishes with a labeled local summary when every model returns invalid output', async () => {
    const h = await setup((task) =>
      task.purpose === 'summary' ? 'invalid-json' : defaultResponse(task),
    );
    try {
      const before = h.prepare();
      h.discussions.summarize(before.discussion.id);
      await h.discussions.idle(before.discussion.id);
      const result = h.repo.snapshot(before.discussion.id);
      expect(result.discussion.status).toBe('completed');
      expect(result.discussion.error).toBeNull();
      expect(result.messages.filter((m) => m.kind === 'summary')).toHaveLength(1);
      expect(result.messages.at(-1)?.summaryMeta).toMatchObject({
        source: 'local',
        model: null,
        provider: null,
        connectionId: null,
        fallbackUsed: true,
        reason: 'models_unavailable',
        throughMessageSeq: 2,
      });
      expect(result.messages.at(-1)?.content).toContain('本地整理摘要');
      expect(result.messages.slice(0, 2)).toEqual(before.messages);
      expect(h.provider.calls).toHaveLength(4);
      expect(h.repo.closingJob(before.discussion.id, before.discussion.generation)).toBeNull();
      expect(result.draft).toBeNull();
    } finally {
      await h.close();
    }
  });

  it('does not repeatedly call connections whose authentication already failed', async () => {
    const h = await setup();
    try {
      const s = h.prepare();
      h.provider.fail(401, 10);
      h.discussions.summarize(s.discussion.id);
      await h.discussions.idle(s.discussion.id);
      const result = h.repo.snapshot(s.discussion.id);
      expect(result.discussion.status).toBe('completed');
      expect(result.messages.at(-1)?.summaryMeta?.source).toBe('local');
      expect(h.provider.calls).toHaveLength(2);
      expect(new Set(h.provider.calls.map((call) => call.body.model)).size).toBe(2);
    } finally {
      await h.close();
    }
  });

  it('closes locally after persistent expert model failures instead of leaving the discussion failed', async () => {
    const h = await setup((task) =>
      task.purpose === 'utterance' || task.purpose === 'summary'
        ? 'invalid-json'
        : defaultResponse(task),
    );
    try {
      const before = h.prepare('专家连续调用失败也必须保留可读的总结。', true, false);
      h.discussions.run(before.discussion.id);
      await h.discussions.idle(before.discussion.id);
      const result = h.repo.snapshot(before.discussion.id);
      expect(result.discussion.status).toBe('completed');
      expect(result.messages.filter((m) => m.kind === 'expert')).toEqual(before.messages);
      expect(result.messages.filter((m) => m.kind === 'summary')).toHaveLength(1);
      expect(result.messages.at(-1)?.summaryMeta).toMatchObject({
        source: 'local',
        reason: 'models_unavailable',
      });
      expect(result.discussion.failureStage).toBeNull();
      expect(result.discussion.error).toBeNull();
    } finally {
      await h.close();
    }
  });

  it('summarizes the entire transcript after final insight failure without inventing insight coverage', async () => {
    let suppliedMessages = 0;
    const h = await setup((task) => {
      if (task.purpose === 'insights') return 'invalid-json';
      if (task.purpose === 'summary') suppliedMessages = task.input.context.messages.length;
      return defaultResponse(task);
    });
    try {
      const before = h.prepare('洞察服务失效后还能否整理全部发言？', false);
      h.discussions.summarize(before.discussion.id);
      await h.discussions.idle(before.discussion.id);
      const result = h.repo.snapshot(before.discussion.id);
      expect(result.discussion.status).toBe('completed');
      expect(result.discussion.insightsThrough).toBe(0);
      expect(result.insights).toEqual([]);
      expect(suppliedMessages).toBe(2);
      expect(result.messages.at(-1)?.summaryMeta).toMatchObject({
        source: 'model',
        throughMessageSeq: 2,
        insightsThroughMessageSeq: 0,
      });
      expect(result.messages.slice(0, 2)).toEqual(before.messages);
    } finally {
      await h.close();
    }
  });

  it('uses local content without another network request when the call budget is exhausted', async () => {
    const h = await setup();
    try {
      const before = h.prepare('模型调用预算耗尽后仍需交付总结。', false);
      const d = h.repo.discussion(before.discussion.id);
      d.callCount = d.maxCalls;
      h.repo.db
        .prepare('UPDATE discussions SET data_json=? WHERE id=?')
        .run(JSON.stringify(d), d.id);
      h.discussions.summarize(d.id);
      await h.discussions.idle(d.id);
      const result = h.repo.snapshot(d.id);
      expect(result.discussion.status).toBe('completed');
      expect(result.discussion.callCount).toBe(d.maxCalls);
      expect(result.messages.at(-1)?.summaryMeta).toMatchObject({
        source: 'local',
        reason: 'budget_exhausted',
      });
      expect(h.provider.calls).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('ends the entire closing process at its deadline and still persists a local summary', async () => {
    const h = await setup(
      async (task) => {
        await delay(500);
        return defaultResponse(task);
      },
      { closingTimeout: 120 },
    );
    try {
      const before = h.prepare();
      const started = Date.now();
      h.discussions.summarize(before.discussion.id);
      await h.discussions.idle(before.discussion.id);
      const result = h.repo.snapshot(before.discussion.id);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(result.discussion.status).toBe('completed');
      expect(result.messages.at(-1)?.summaryMeta).toMatchObject({
        source: 'local',
        reason: 'deadline_exceeded',
      });
      expect(result.draft).toBeNull();
      expect(h.provider.calls).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it('does not convert an explicit cancellation into a local summary', async () => {
    const entered = gate(),
      response = gate();
    const h = await setup(async (task) => {
      entered.release();
      await response.promise;
      return defaultResponse(task);
    });
    const controller = new AbortController();
    try {
      const s = h.prepare();
      const service = new InsightsService(h.repo, h.gateway, {
        timeoutMs: 2000,
        maxModelAttempts: 4,
      });
      const pending = service.finish(s.discussion.id, s.discussion.generation, controller.signal);
      const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
      await entered.promise;
      controller.abort();
      await rejected;
      expect(h.repo.snapshot(s.discussion.id).messages).toEqual(s.messages);
      expect(h.repo.snapshot(s.discussion.id).draft).toBeNull();
      expect(h.provider.calls).toHaveLength(1);
    } finally {
      response.release();
      await h.close();
    }
  });

  it('rejects late model output after the generation changes', async () => {
    const entered = gate(),
      response = gate();
    const h = await setup(async (task) => {
      entered.release();
      await response.promise;
      return defaultResponse(task);
    });
    try {
      const s = h.prepare();
      const service = new InsightsService(h.repo, h.gateway);
      const pending = service.finish(
        s.discussion.id,
        s.discussion.generation,
        new AbortController().signal,
      );
      const rejected = expect(pending).rejects.toMatchObject({ code: 'STALE_RESULT' });
      await entered.promise;
      h.repo.transition(s.discussion.id, 'interrupted', { bumpGeneration: true });
      response.release();
      await rejected;
      expect(h.repo.snapshot(s.discussion.id).messages).toEqual(s.messages);
      expect(h.repo.discussion(s.discussion.id).status).toBe('interrupted');
    } finally {
      response.release();
      await h.close();
    }
  });

  it('propagates storage errors without disguising them as model fallback', async () => {
    const h = await setup();
    try {
      const s = h.prepare();
      const commit = vi.spyOn(h.repo, 'appendMessage').mockImplementation(() => {
        throw new Error('storage-unavailable');
      });
      const service = new InsightsService(h.repo, h.gateway);
      await expect(
        service.finish(s.discussion.id, s.discussion.generation, new AbortController().signal),
      ).rejects.toThrow('storage-unavailable');
      expect(h.repo.snapshot(s.discussion.id).messages).toEqual(s.messages);
      expect(commit).toHaveBeenCalledTimes(1);
      expect(h.provider.calls).toHaveLength(1);
      commit.mockRestore();
    } finally {
      await h.close();
    }
  });

  it('keeps backup credentials and model versions frozen after settings change', async () => {
    const h = await setup((task, call) =>
      call.body.model === 'host-v1' ? 'invalid-json' : defaultResponse(task),
    );
    try {
      const s = h.prepare();
      h.repo.saveConnection(
        {
          name: '备用已更新',
          provider: 'gpt',
          protocol: 'openai-responses',
          baseUrl: h.provider.baseUrl,
          model: 'backup-v2',
          apiKey: 'fixture-new-key',
          active: true,
          structuredOutput: false,
        },
        h.backup.id,
      );
      h.discussions.summarize(s.discussion.id);
      await h.discussions.idle(s.discussion.id);
      const result = h.repo.snapshot(s.discussion.id);
      expect(result.messages.at(-1)?.summaryMeta).toMatchObject({
        model: 'backup-v1',
        connectionVersion: 1,
      });
      expect(h.provider.calls[1].body.model).toBe('backup-v1');
      expect(h.provider.calls[1].authorization).toBe('Bearer fixture-backup');
    } finally {
      await h.close();
    }
  });

  it('isolates simultaneous summaries and ignores duplicate launches', async () => {
    const h = await setup(async (task, call) => {
      if (call.body.model === 'host-v1') return 'invalid-json';
      await delay(10);
      return { content: `${task.input.context.topic} 已根据本场记录整理。` };
    });
    try {
      const a = h.prepare('甲场：城市公共交通应该怎样改进？'),
        b = h.prepare('乙场：大学课程评价应该怎样改进？');
      for (const s of [a, b]) {
        h.discussions.summarize(s.discussion.id);
        h.discussions.summarize(s.discussion.id);
      }
      await Promise.all([h.discussions.idle(a.discussion.id), h.discussions.idle(b.discussion.id)]);
      for (const [own, other] of [
        [a, b],
        [b, a],
      ]) {
        const result = h.repo.snapshot(own.discussion.id);
        const summaries = result.messages.filter((m) => m.kind === 'summary');
        expect(result.discussion.status).toBe('completed');
        expect(summaries).toHaveLength(1);
        expect(summaries[0].content).toContain(own.discussion.topic);
        expect(summaries[0].content).not.toContain(other.discussion.topic);
        expect(result.messages.slice(0, 2)).toEqual(own.messages);
      }
      expect(h.provider.calls).toHaveLength(4);
    } finally {
      await h.close();
    }
  });

  it('resumes only unfinished closing work after restart without resetting its attempt allowance', async () => {
    const h = await setup();
    try {
      const closing = h.prepare('重启后只恢复尚未完成的总结。');
      h.repo.ensureClosingJob(closing.discussion.id, closing.discussion.generation, {
        timeoutMs: 30000,
        maxAttempts: 1,
      });
      h.repo.claimClosingAttempt(closing.discussion.id, closing.discussion.generation);
      const runningInitial = h.repo.createDiscussion(
        '仍在讨论中的场次重启后不得自动续跑。',
        4,
        h.host.id,
      );
      const runningReady = h.repo.saveCast(
        runningInitial.discussion.id,
        runningInitial.discussion.generation,
        makeSample(0).participants.map((p, i) => ({
          ...p,
          id: `${runningInitial.discussion.id}-p${i}`,
          discussionId: runningInitial.discussion.id,
        })),
      );
      h.repo.start(
        runningReady.discussion.id,
        runningReady.discussion.version,
        runningReady.discussion.castVersion,
        3,
      );
      await h.reopen();
      await expect.poll(() => h.repo.discussion(closing.discussion.id).status).toBe('completed');
      const resumed = h.repo.snapshot(closing.discussion.id);
      expect(resumed.messages.slice(0, 2)).toEqual(closing.messages);
      expect(resumed.messages.at(-1)?.summaryMeta?.source).toBe('local');
      expect(h.repo.discussion(runningReady.discussion.id).status).toBe('interrupted');
      expect(h.provider.calls).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('queues recovered summaries at three discussions and completes every queued item', async () => {
    const release = gate();
    let active = 0,
      peak = 0,
      entered = 0;
    const purposes: string[] = [];
    const h = await setup(
      async (task) => {
        purposes.push(task.purpose);
        active++;
        entered++;
        peak = Math.max(peak, active);
        try {
          await release.promise;
          return defaultResponse(task);
        } finally {
          active--;
        }
      },
      { connectionConcurrency: 4 },
    );
    try {
      const pending = [];
      for (let index = 0; index < 4; index++) {
        const s = h.prepare(`第${index}场待恢复总结应该遵守并发限制。`);
        h.repo.ensureClosingJob(s.discussion.id, s.discussion.generation, {
          timeoutMs: 30000,
          maxAttempts: 1,
        });
        pending.push(s);
        h.repo.transition(s.discussion.id, 'interrupted');
      }
      const running = h.prepare('重启前仍在讨论的场次保留中断状态。', true, false);
      // Simulate persisted pre-crash work without launching requests in this process.
      for (const s of pending) {
        const d = h.repo.discussion(s.discussion.id);
        d.status = 'summarizing';
        h.repo.db
          .prepare('UPDATE discussions SET status=?,data_json=? WHERE id=?')
          .run(d.status, JSON.stringify(d), d.id);
      }
      await h.reopen();
      await expect.poll(() => entered).toBe(3);
      expect(
        pending.filter((s) => h.repo.discussion(s.discussion.id).status === 'summarizing'),
      ).toHaveLength(3);
      expect(
        pending.filter((s) => h.repo.discussion(s.discussion.id).status === 'interrupted'),
      ).toHaveLength(1);
      expect(h.repo.discussion(running.discussion.id).status).toBe('interrupted');
      release.release();
      await Promise.all(pending.map((s) => h.discussions.idle(s.discussion.id)));
      expect(peak).toBe(3);
      expect(entered).toBe(4);
      expect(purposes).toEqual(['summary', 'summary', 'summary', 'summary']);
      for (const s of pending) {
        const result = h.repo.snapshot(s.discussion.id);
        expect(result.discussion.status).toBe('completed');
        expect(result.messages.slice(0, s.messages.length)).toEqual(s.messages);
        expect(result.messages.filter((m) => m.kind === 'summary')).toHaveLength(1);
        expect(result.messages.at(-1)?.summaryMeta?.source).toBe('model');
      }
      expect(h.repo.snapshot(running.discussion.id).messages).toEqual(running.messages);
      expect(h.repo.discussion(running.discussion.id).status).toBe('interrupted');
    } finally {
      release.release();
      await h.close();
    }
  });

  it.each([true, false])(
    'does not hide a storage error behind an expired closing deadline (insights covered: %s)',
    async (covered) => {
      const h = await setup();
      const generate = vi.spyOn(h.gateway, 'generate').mockImplementation(async () => {
        await delay(70);
        throw new Error('storage-after-deadline');
      });
      try {
        const s = h.prepare('本地存储故障不能被模型兜底掩盖。', covered);
        const service = new InsightsService(h.repo, h.gateway, {
          timeoutMs: 20,
          maxModelAttempts: 4,
        });
        await expect(
          service.finish(s.discussion.id, s.discussion.generation, new AbortController().signal),
        ).rejects.toThrow('storage-after-deadline');
        expect(h.repo.snapshot(s.discussion.id).messages).toEqual(s.messages);
        expect(h.repo.snapshot(s.discussion.id).draft).toBeNull();
        expect(h.repo.discussion(s.discussion.id).status).toBe('summarizing');
        expect(generate).toHaveBeenCalledTimes(1);
      } finally {
        generate.mockRestore();
        await h.close();
      }
    },
  );
});
