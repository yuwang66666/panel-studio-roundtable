import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { ProseOutputSchema } from '../packages/contracts/src/index';
import { ModelGateway } from '../apps/api/src/gateway';
import type { PrivateConnection, Repository } from '../apps/api/src/repository';
import { createApp } from '../apps/api/src/app';
import { makeSample } from '../packages/domain/src/samples';
import { extractSummaryProse } from '../packages/domain/src/summary-prose';
import {
  defaultResponse,
  startProvider,
  type ProviderOptions,
  type RecordedCall,
  type Responder,
} from './fixtures/provider';

const protocols = ['openai-chat', 'openai-responses', 'anthropic'] as const;
const prose =
  '本场讨论围绕小范围试点展开，两位专家支持先明确条件，再依据结果调整。\n\n具体的评估周期仍未达成一致，需要通过试点数据继续验证。';
const badStructure = JSON.stringify({ unexpected: { notes: 'PRIVATE_BAD_SUMMARY' } });

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}

/** Exercise a provider that ignores stream:true and returns an ordinary JSON response. */
async function jsonProvider(responder: Responder) {
  const calls: RecordedCall[] = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const call = { path: req.url!, body };
      calls.push(call);
      const input = body.input?.at(-1)?.content || body.messages?.at(-1)?.content;
      const result = await responder(JSON.parse(input), call);
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      const value = req.url?.endsWith('/responses')
        ? {
            output: [
              { type: 'reasoning', summary: [{ type: 'summary_text', text: 'HIDDEN_REASONING' }] },
              { type: 'message', content: [{ type: 'output_text', text }] },
            ],
          }
        : req.url?.endsWith('/messages')
          ? {
              content: [
                { type: 'thinking', thinking: 'HIDDEN_REASONING' },
                { type: 'text', text },
              ],
            }
          : { choices: [{ message: { content: text, reasoning_content: 'HIDDEN_REASONING' } }] };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    calls,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

async function gatewayFixture(
  protocol: PrivateConnection['protocol'],
  responder: Responder,
  transport: 'stream' | 'json' = 'stream',
  options: ProviderOptions = {},
) {
  const provider =
    transport === 'stream'
      ? await startProvider(responder, options)
      : await jsonProvider(responder);
  const runs: { errorCode: string | null }[] = [];
  const repo = {
    recordRun: (run: { errorCode: string | null }) => runs.push(run),
  } as unknown as Repository;
  const connection = {
    id: 'prose-fixture',
    version: 1,
    protocol,
    provider: 'custom',
    model: 'prose-fixture',
    baseUrl: provider.baseUrl,
    apiKey: 'fixture-only',
    structuredOutput: false,
  } as PrivateConnection;
  const gateway = new ModelGateway(repo, { summaryTimeout: 2000, retryDelay: 1 });
  return {
    provider,
    runs,
    generate: (onText: (text: string) => void, maxRepairs: 0 | 1 = 0) =>
      gateway.generate({
        connection,
        purpose: 'summary',
        input: {},
        schema: ProseOutputSchema,
        onText,
        maxRepairs,
        maxRetries: 0,
      }),
    close: provider.close,
  };
}

function expectPublicProse(updates: string[]) {
  for (const text of updates) {
    expect(text).not.toMatch(/[{}\[\]`]/u);
    expect(text).not.toContain('HIDDEN_REASONING');
    expect(text).not.toContain('PRIVATE_BAD_SUMMARY');
    expect(text).not.toContain('"content"');
    expect(text).not.toContain('"summary"');
  }
}

async function discussionFixture(responder: Responder = defaultResponse) {
  mkdirSync(resolve('.tmp'), { recursive: true });
  const dir = mkdtempSync(resolve('.tmp/summary-prose-'));
  const provider = await startProvider(responder, { streamChunkSize: 4 });
  const app = await createApp({
    dataDir: dir,
    gatewayOptions: { summaryTimeout: 2000, insightsTimeout: 2000, retryDelay: 1 },
    closingOptions: { timeoutMs: 5000, maxModelAttempts: 4 },
  });
  const host = app.repo.saveConnection({
    name: '主总结模型',
    provider: 'custom',
    protocol: 'openai-chat',
    baseUrl: provider.baseUrl,
    model: 'host-prose',
    apiKey: 'fixture-host',
    active: true,
    structuredOutput: false,
  });
  const backup = app.repo.saveConnection({
    name: '备用总结模型',
    provider: 'gpt',
    protocol: 'openai-responses',
    baseUrl: provider.baseUrl,
    model: 'backup-prose',
    apiKey: 'fixture-backup',
    active: true,
    structuredOutput: false,
  });
  const created = app.repo.createDiscussion('如何以自然语言整理试点讨论？', 4, host.id);
  const id = created.discussion.id;
  let s = app.repo.saveCast(
    id,
    created.discussion.generation,
    makeSample(0).participants.map((p, i) => ({ ...p, id: `${id}-p${i}`, discussionId: id })),
  );
  s = app.repo.bind(
    id,
    s.discussion.version,
    s.discussion.castVersion,
    s.participants.map((p, i) => ({
      participantId: p.id,
      connectionId: i === 1 ? backup.id : host.id,
    })),
  );
  s = app.repo.start(id, s.discussion.version, s.discussion.castVersion, 3);
  for (const index of [1, 2])
    app.repo.appendMessage(id, s.discussion.generation, {
      turnId: `${id}-turn-${index}`,
      participantId: s.participants[index].id,
      kind: 'expert',
      content: index === 1 ? '建议先明确试点范围。' : '试点评估周期需要进一步讨论。',
      replyToMessageId: null,
    });
  app.repo.saveInsights(id, s.discussion.generation, 2, []);
  app.repo.transition(id, 'summarizing');
  const initial = app.repo.snapshot(id);
  return {
    ...app,
    provider,
    host,
    backup,
    initial,
    async finish() {
      app.discussions.summarize(id);
      await app.discussions.idle(id);
      return app.repo.snapshot(id);
    },
    async close() {
      await app.app.close();
      await provider.close();
      if (!dir.startsWith(resolve('.tmp') + sep)) throw Error('Invalid cleanup path');
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('总结自然语言在模型、草稿和保存之间保持一致', () => {
  it.each(
    protocols.flatMap((protocol) =>
      ['stream', 'json'].map((transport) => ({ protocol, transport })),
    ),
  )(
    '$protocol over $transport unwraps known nested prose without exposing JSON or vendor reasoning',
    async ({ protocol, transport }) => {
      const h = await gatewayFixture(
        protocol,
        () => ({ content: JSON.stringify({ content: JSON.stringify({ summary: prose }) }) }),
        transport as 'stream' | 'json',
        { streamChunkSize: 1 },
      );
      const updates: string[] = [];
      try {
        await expect(h.generate((text) => updates.push(text))).resolves.toEqual({ content: prose });
        expect(updates.at(-1)).toBe(prose);
        expectPublicProse(updates);
        expect(h.provider.calls).toHaveLength(1);
        expect(h.runs).toEqual([expect.objectContaining({ errorCode: null })]);
      } finally {
        await h.close();
      }
    },
  );

  it.each(protocols)(
    '%s still publishes ordinary prose before the provider finishes',
    async (protocol) => {
      const seen = gate(),
        release = gate();
      let paused = false,
        completed = false;
      const h = await gatewayFixture(protocol, () => ({ content: prose }), 'stream', {
        streamChunkSize: 4,
        afterStreamChunk: async ({ textSoFar }) => {
          if (!paused && textSoFar.includes(prose.slice(0, 12))) {
            paused = true;
            await release.promise;
          }
        },
      });
      const updates: string[] = [];
      const pending = h
        .generate((text) => {
          updates.push(text);
          if (text) seen.release();
        })
        .then((value) => {
          completed = true;
          return value;
        });
      try {
        await Promise.race([
          seen.promise,
          pending.then(() => {
            throw Error('Summary finished without a public partial update');
          }),
        ]);
        expect(completed).toBe(false);
        expect(
          updates.some((text) => text && prose.startsWith(text) && text.length < prose.length),
        ).toBe(true);
        release.release();
        await expect(pending).resolves.toEqual({ content: prose });
        expectPublicProse(updates);
      } finally {
        release.release();
        await pending.catch(() => {});
        await h.close();
      }
    },
  );

  it.each(protocols)(
    '%s rejects embedded object JSON and repairs once without publishing it',
    async (protocol) => {
      let attempt = 0;
      const h = await gatewayFixture(
        protocol,
        () => ({ content: ++attempt === 1 ? `本场讨论如下：${badStructure}` : prose }),
        'stream',
        { streamChunkSize: 1 },
      );
      const updates: string[] = [];
      try {
        await expect(h.generate((text) => updates.push(text), 1)).resolves.toEqual({
          content: prose,
        });
        expect(h.provider.calls).toHaveLength(2);
        expect(h.runs.map((run) => run.errorCode)).toEqual(['INVALID_OUTPUT', null]);
        expectPublicProse(updates);
        expect(updates.at(-1)).toBe(prose);
      } finally {
        await h.close();
      }
    },
  );

  it('rejects a structured ordinary JSON response without returning private detail', async () => {
    const h = await gatewayFixture('openai-chat', () => ({ content: badStructure }), 'json');
    const updates: string[] = [];
    try {
      const error = await h.generate((text) => updates.push(text)).catch((reason) => reason);
      expect(error).toMatchObject({ code: 'INVALID_OUTPUT' });
      expect(error.message).not.toContain('PRIVATE_BAD_SUMMARY');
      expectPublicProse(updates);
      expect(h.provider.calls).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it('saves normalized nested prose once with the original model source', async () => {
    const h = await discussionFixture((task) =>
      task.purpose === 'summary'
        ? { content: JSON.stringify({ summary: prose }) }
        : defaultResponse(task),
    );
    try {
      const result = await h.finish();
      expect(result.discussion.status).toBe('completed');
      expect(result.messages.slice(0, 2)).toEqual(h.initial.messages);
      expect(result.messages.filter((m) => m.kind === 'summary')).toHaveLength(1);
      expect(result.messages.at(-1)).toMatchObject({
        content: prose,
        summaryMeta: { source: 'model', connectionId: h.host.id, fallbackUsed: false },
      });
      const updates = h.repo
        .eventsAfter(result.discussion.id, 0, 1000)
        .filter((event) => event.type === 'speech.updated')
        .map((event) => event.payload.draft.content);
      expectPublicProse(updates);
      expect(result.draft).toBeNull();
      expect(h.provider.calls).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it('tries a frozen backup after unusable nested JSON and records the actual summary model', async () => {
    const h = await discussionFixture((task, call) =>
      task.purpose === 'summary'
        ? { content: call.body.model === 'host-prose' ? badStructure : prose }
        : defaultResponse(task),
    );
    try {
      const result = await h.finish();
      expect(result.discussion.status).toBe('completed');
      expect(result.messages.filter((m) => m.kind === 'summary')).toHaveLength(1);
      expect(result.messages.at(-1)).toMatchObject({
        content: prose,
        summaryMeta: {
          source: 'model',
          connectionId: h.backup.id,
          model: 'backup-prose',
          fallbackUsed: true,
        },
      });
      expect(h.provider.calls.map((call) => call.body.model)).toEqual([
        'host-prose',
        'backup-prose',
      ]);
      expect(JSON.stringify(h.repo.eventsAfter(result.discussion.id, 0, 1000))).not.toContain(
        'PRIVATE_BAD_SUMMARY',
      );
      expect(result.draft).toBeNull();
    } finally {
      await h.close();
    }
  });

  it('finishes with labeled local prose after four unusable model summaries', async () => {
    const h = await discussionFixture((task) =>
      task.purpose === 'summary' ? { content: badStructure } : defaultResponse(task),
    );
    try {
      const result = await h.finish();
      expect(result.discussion.status).toBe('completed');
      expect(result.discussion.error).toBeNull();
      expect(result.messages.slice(0, 2)).toEqual(h.initial.messages);
      expect(result.messages.filter((m) => m.kind === 'summary')).toHaveLength(1);
      expect(result.messages.at(-1)?.summaryMeta).toMatchObject({
        source: 'local',
        model: null,
        connectionId: null,
        reason: 'models_unavailable',
      });
      expect(result.messages.at(-1)?.content).toContain('本地整理摘要');
      expect(result.messages.at(-1)?.content).toContain('建议先明确试点范围');
      expectPublicProse([result.messages.at(-1)!.content]);
      expect(JSON.stringify(h.repo.eventsAfter(result.discussion.id, 0, 1000))).not.toContain(
        'PRIVATE_BAD_SUMMARY',
      );
      expect(h.provider.calls).toHaveLength(4);
      expect(h.repo.closingJob(result.discussion.id, result.discussion.generation)).toBeNull();
      expect(result.draft).toBeNull();
    } finally {
      await h.close();
    }
  });

  it('rejects raw structured summary writes before committing a message or completion event', async () => {
    const h = await discussionFixture();
    try {
      const before = h.repo.snapshot(h.initial.discussion.id);
      expect(() =>
        h.repo.appendMessage(before.discussion.id, before.discussion.generation, {
          turnId: 'bypass-gateway',
          participantId: before.participants[0].id,
          kind: 'summary',
          content: badStructure,
          replyToMessageId: null,
          summaryMeta: {
            source: 'model',
            throughMessageSeq: 2,
            insightsThroughMessageSeq: 2,
            model: h.host.model,
            provider: h.host.provider,
            connectionId: h.host.id,
            connectionVersion: h.host.version,
            fallbackUsed: false,
            reason: null,
          },
        }),
      ).toThrow();
      expect(h.repo.snapshot(before.discussion.id)).toEqual(before);
      expect(h.provider.calls).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('keeps local fallback readable when legacy topic, speaker labels, messages and insights contain JSON', async () => {
    const h = await discussionFixture((task) =>
      task.purpose === 'summary' ? { content: badStructure } : defaultResponse(task),
    );
    try {
      const s = h.repo.snapshot(h.initial.discussion.id);
      const structuredMessage = { ...s.messages[0], content: badStructure };
      h.repo.db
        .prepare('UPDATE messages SET data_json=? WHERE id=?')
        .run(JSON.stringify(structuredMessage), structuredMessage.id);
      const structuredSpeaker = { ...s.participants[1], name: badStructure, title: badStructure };
      h.repo.db
        .prepare('UPDATE participants SET data_json=? WHERE id=?')
        .run(JSON.stringify(structuredSpeaker), structuredSpeaker.id);
      h.repo.db
        .prepare('UPDATE discussions SET data_json=? WHERE id=?')
        .run(JSON.stringify({ ...s.discussion, topic: badStructure }), s.discussion.id);
      h.repo.saveInsights(s.discussion.id, s.discussion.generation, 2, [
        {
          id: 'legacy-json-insight',
          kind: 'consensus',
          status: 'stable',
          scope: 'local',
          text: badStructure,
          participantIds: [s.participants[1].id, s.participants[2].id],
          evidence: s.messages.map((m) => ({ messageId: m.id, relation: 'supports' as const })),
          revision: 1,
          throughMessageSeq: 2,
        },
      ]);
      const before = h.repo.snapshot(s.discussion.id);
      const result = await h.finish();
      const summary = result.messages.at(-1)!;
      expect(result.discussion.status).toBe('completed');
      expect(summary.summaryMeta?.source).toBe('local');
      expect(summary.content).toContain('该记录包含结构化内容，请查看原始记录');
      expect(summary.content).toContain('发言 #1');
      expect(summary.content).toContain('试点评估周期需要进一步讨论');
      expectPublicProse([summary.content]);
      expect(extractSummaryProse(summary.content)).toBe(summary.content);
      expect(result.messages.slice(0, 2)).toEqual(before.messages);
      expect(result.insights).toEqual(before.insights);
    } finally {
      await h.close();
    }
  });
});
