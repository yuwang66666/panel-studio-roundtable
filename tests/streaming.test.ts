import { describe, expect, it } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { setImmediate as nextTick } from 'node:timers/promises';
import { z } from 'zod';
import { ModelGateway } from '../apps/api/src/gateway';
import type { PrivateConnection, Repository } from '../apps/api/src/repository';
import { AppError } from '../apps/api/src/errors';
import { projectSpeechText } from '../apps/api/src/streaming';

type Protocol = PrivateConnection['protocol'];
const protocols: Protocol[] = ['openai-chat', 'openai-responses', 'anthropic'];
const opts = {
  globalConcurrency: 4,
  connectionConcurrency: 2,
  timeout: 2000,
  summaryTimeout: 2000,
  retryDelay: 1,
};
const schema = z.object({ sentences: z.array(z.string()).min(1).max(2) }).strict();
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function setup(
  protocol: Protocol,
  respond: (res: ServerResponse, count: number) => Promise<void> | void,
) {
  const calls: any[] = [],
    runs: any[] = [];
  const server = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      calls.push(JSON.parse(raw));
      await respond(res, calls.length);
    } catch {
      res.destroy();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const repo = { recordRun: (run: unknown) => runs.push(run) } as unknown as Repository;
  const connection = {
    id: 'stream-test',
    version: 1,
    protocol,
    provider: 'custom',
    model: 'test',
    baseUrl: `http://127.0.0.1:${address.port}`,
    apiKey: 'local-test-only',
    structuredOutput: false,
  } as PrivateConnection;
  const gateway = new ModelGateway(repo, opts);
  return {
    calls,
    runs,
    gateway,
    repo,
    connection,
    request: { connection, purpose: 'utterance' as const, input: {}, schema },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}
const frame = (data: unknown, event?: string) =>
  `${event ? `event: ${event}\r\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\r\n\r\n`;
function start(res: ServerResponse, protocol: Protocol) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(': heartbeat\r\n\r\n');
  if (protocol === 'anthropic') {
    res.write(
      frame({ type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 0 } } }),
    );
    res.write(
      frame({
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'PRIVATE_THINKING' },
      }),
    );
  } else if (protocol === 'openai-chat') {
    res.write(frame({ choices: [{ delta: { reasoning_content: 'PRIVATE_THINKING' } }] }));
  } else {
    res.write(frame({ type: 'response.reasoning_text.delta', delta: 'PRIVATE_THINKING' }));
  }
}
function delta(protocol: Protocol, text: string) {
  if (protocol === 'openai-chat') return frame({ choices: [{ delta: { content: text } }] });
  if (protocol === 'openai-responses')
    return frame({ type: 'response.output_text.delta', delta: text });
  return frame({ type: 'content_block_delta', delta: { type: 'text_delta', text } });
}
function finish(res: ServerResponse, protocol: Protocol) {
  if (protocol === 'openai-chat') {
    res.write(frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
    res.write(frame({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 8 } }));
    res.end(frame('[DONE]'));
  } else if (protocol === 'openai-responses') {
    res.end(
      frame({
        type: 'response.completed',
        response: { status: 'completed', usage: { input_tokens: 12, output_tokens: 8 } },
      }),
    );
  } else {
    res.write(
      frame({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 8 },
      }),
    );
    res.end(frame({ type: 'message_stop' }));
  }
}
async function fragmented(res: ServerResponse, value: string) {
  const bytes = Buffer.from(value);
  for (let i = 0; i < bytes.length; i += 7) {
    res.write(bytes.subarray(i, i + 7));
    await nextTick();
  }
}

describe('公开 JSON 文本投影', () => {
  it('only projects top-level speech and keeps nested reasoning private', () => {
    expect(projectSpeechText('{"reasoning":{"content":"PRIVATE"},"content":"公开', 'opening')).toBe(
      '公开',
    );
    expect(projectSpeechText('{"reasoning":{"content":"PRIVATE"}', 'opening')).toBe('');
    expect(projectSpeechText('{"content":"PRIVATE"}', 'intent')).toBe('');
    expect(projectSpeechText('{"sentences":["第一句。","第二', 'utterance')).toBe('第一句。第二');
    expect(projectSpeechText('{"sentences":[{"content":"PRIVATE"}]}', 'utterance')).toBe('');
  });
  it('decodes split unicode, escapes and code fences without emitting incomplete surrogate pairs', () => {
    expect(projectSpeechText('```json\n{"content":"你好\\uD83D', 'summary')).toBe('你好');
    expect(
      projectSpeechText(
        '```json\n{"content":"你好\\uD83D\\uDE00\\n\\"引号\\"\\\\路径"}\n```',
        'summary',
      ),
    ).toBe('你好😀\n"引号"\\路径');
    expect(projectSpeechText('```js', 'summary')).toBe('');
    expect(projectSpeechText('{"content":"字\\u4', 'probe')).toBe('字');
  });
});

describe('供应商真实 HTTP 流式协议', () => {
  it.each(protocols)(
    '%s publishes partial speech before completion and records usage',
    async (protocol) => {
      const seen = deferred(),
        release = deferred();
      const s = await setup(protocol, async (res) => {
        start(res, protocol);
        await fragmented(res, delta(protocol, '```json\n{"sentences":["你好😀'));
        await release.promise;
        res.write(delta(protocol, '\\n\\"证据\\"。","第二句。"]}\n```'));
        finish(res, protocol);
      });
      const updates: string[] = [];
      let settled = false;
      const result = s.gateway.generate({
        ...s.request,
        onText: (text) => {
          updates.push(text);
          if (text === '你好😀') seen.resolve();
        },
      });
      result.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      try {
        await seen.promise;
        expect(settled).toBe(false);
        expect(updates).toEqual(['', '你好😀']);
        release.resolve();
        expect(await result).toEqual({ sentences: ['你好😀\n"证据"。', '第二句。'] });
        expect(updates.at(-1)).toBe('你好😀\n"证据"。第二句。');
        expect(updates.join('')).not.toMatch(/PRIVATE|sentences|```/);
        expect(s.calls[0].stream).toBe(true);
        expect(s.runs[0].usage).toEqual({ inputTokens: 12, outputTokens: 8 });
        expect(s.runs[0].errorCode).toBeNull();
      } finally {
        release.resolve();
        await s.close();
      }
    },
  );
  it.each(protocols)(
    '%s rejects a stream without its terminal marker even if JSON is complete',
    async (protocol) => {
      const s = await setup(protocol, (res) => {
        start(res, protocol);
        res.end(delta(protocol, '{"sentences":["有效内容。"]}'));
      });
      try {
        await expect(s.gateway.generate({ ...s.request, onText: () => {} })).rejects.toMatchObject({
          code: 'UPSTREAM_STREAM',
        });
        expect(s.calls).toHaveLength(1);
        expect(s.runs[0].errorCode).toBe('UPSTREAM_STREAM');
      } finally {
        await s.close();
      }
    },
  );
  it.each(protocols)(
    '%s rejects provider error events without exposing provider details',
    async (protocol) => {
      const s = await setup(protocol, (res) => {
        start(res, protocol);
        res.write(delta(protocol, '{"sentences":["部分'));
        res.end(frame({ type: 'error', error: { message: 'PRIVATE_PROVIDER_SECRET' } }));
      });
      try {
        const error = await s.gateway.generate({ ...s.request, onText: () => {} }).catch((e) => e);
        expect(error.code).toBe('UPSTREAM_STREAM');
        expect(error.message).not.toContain('PRIVATE_PROVIDER_SECRET');
        expect(s.calls).toHaveLength(1);
      } finally {
        await s.close();
      }
    },
  );
  it('resets the draft before the one allowed output repair', async () => {
    const updates: string[] = [];
    const s = await setup('openai-chat', (res, count) => {
      start(res, 'openai-chat');
      res.write(
        delta(
          'openai-chat',
          count === 1 ? '{"sentences":["失败。","二。","三。"]}' : '{"sentences":["修复。"]}',
        ),
      );
      finish(res, 'openai-chat');
    });
    try {
      expect(
        await s.gateway.generate({
          ...s.request,
          onText: (text) => {
            updates.push(text);
          },
        }),
      ).toEqual({ sentences: ['修复。'] });
      expect(updates).toEqual(['', '失败。二。三。', '', '修复。']);
      expect(s.calls).toHaveLength(2);
      expect(s.runs.map((run) => run.errorCode)).toEqual(['INVALID_OUTPUT', null]);
    } finally {
      await s.close();
    }
  });
  it('resets before a temporary HTTP retry and keeps streaming enabled', async () => {
    const updates: string[] = [];
    const s = await setup('openai-chat', (res, count) => {
      if (count === 1) {
        res.writeHead(429);
        res.end();
        return;
      }
      start(res, 'openai-chat');
      res.write(delta('openai-chat', '{"sentences":["成功。"]}'));
      finish(res, 'openai-chat');
    });
    try {
      await s.gateway.generate({
        ...s.request,
        onText: (text) => {
          updates.push(text);
        },
      });
      expect(updates).toEqual(['', '', '成功。']);
      expect(s.calls.map((call) => call.stream)).toEqual([true, true]);
      expect(s.runs.map((run) => run.errorCode)).toEqual(['UPSTREAM_RATE_LIMIT', null]);
    } finally {
      await s.close();
    }
  });
  it('resets partial speech when a broken network stream is retried', async () => {
    const received = deferred();
    const updates: string[] = [];
    const s = await setup('openai-chat', async (res, count) => {
      start(res, 'openai-chat');
      if (count === 1) {
        res.write(delta('openai-chat', '{"sentences":["旧草稿'));
        await received.promise;
        res.destroy();
      } else {
        res.write(delta('openai-chat', '{"sentences":["新结果。"]}'));
        finish(res, 'openai-chat');
      }
    });
    try {
      await s.gateway.generate({
        ...s.request,
        onText: (text) => {
          updates.push(text);
          if (text === '旧草稿') received.resolve();
        },
      });
      expect(updates).toEqual(['', '旧草稿', '', '新结果。']);
      expect(s.runs.map((run) => run.errorCode)).toEqual(['UPSTREAM_NETWORK', null]);
    } finally {
      received.resolve();
      await s.close();
    }
  });
  it('decodes JSON unicode escapes across separate SSE text deltas', async () => {
    const updates: string[] = [];
    const s = await setup('openai-chat', (res) => {
      start(res, 'openai-chat');
      res.write(delta('openai-chat', '{"sentences":["\\u4'));
      res.write(delta('openai-chat', 'f60\\u597d\\uD83D'));
      res.write(delta('openai-chat', '\\uDE00。"]}'));
      finish(res, 'openai-chat');
    });
    try {
      expect(
        await s.gateway.generate({
          ...s.request,
          onText: (text) => {
            updates.push(text);
          },
        }),
      ).toEqual({ sentences: ['你好😀。'] });
      expect(updates).toEqual(['', '你好', '你好😀。']);
    } finally {
      await s.close();
    }
  });
  it.each([
    {
      protocol: 'openai-chat' as const,
      ending: { choices: [{ delta: {}, finish_reason: 'length' }] },
    },
    {
      protocol: 'openai-responses' as const,
      ending: { type: 'response.incomplete', response: { status: 'incomplete' } },
    },
    {
      protocol: 'openai-responses' as const,
      ending: { type: 'response.failed', response: { status: 'failed' } },
    },
    {
      protocol: 'anthropic' as const,
      ending: { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
    },
  ])('rejects unsuccessful terminal conditions in $protocol', async ({ protocol, ending }) => {
    const s = await setup(protocol, (res) => {
      start(res, protocol);
      res.write(delta(protocol, '{"sentences":["内容完整但生成被截断。"]}'));
      res.end(frame(ending));
    });
    try {
      await expect(s.gateway.generate({ ...s.request, onText: () => {} })).rejects.toMatchObject({
        code: 'UPSTREAM_STREAM',
      });
      expect(s.calls).toHaveLength(1);
    } finally {
      await s.close();
    }
  });
  it.each(['STALE_RESULT', 'CONFLICT', 'UPSTREAM_NETWORK'])(
    'preserves %s callback errors and never retries or repairs them',
    async (code) => {
      const s = await setup('openai-chat', (res) => {
        start(res, 'openai-chat');
        res.write(delta('openai-chat', '{"sentences":["迟到。"]}'));
        finish(res, 'openai-chat');
      });
      try {
        await expect(
          s.gateway.generate({
            ...s.request,
            onText: (text) => {
              if (text) throw new AppError(code, '过期结果', 409);
            },
          }),
        ).rejects.toMatchObject({ code });
        expect(s.calls).toHaveLength(1);
      } finally {
        await s.close();
      }
    },
  );
  it('cancels an in-flight stream without completing or retrying it', async () => {
    const s = await setup('openai-chat', (res) => {
      start(res, 'openai-chat');
      res.write(delta('openai-chat', '{"sentences":["取消'));
    });
    const controller = new AbortController();
    try {
      await expect(
        s.gateway.generate({
          ...s.request,
          signal: controller.signal,
          onText: (text) => {
            if (text) controller.abort();
          },
        }),
      ).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(s.calls).toHaveLength(1);
      expect(s.runs[0].errorCode).toBe('CANCELLED');
    } finally {
      await s.close();
    }
  });
  it('times out while waiting for remaining deltas', async () => {
    const s = await setup('openai-chat', (res) => {
      start(res, 'openai-chat');
      res.write(delta('openai-chat', '{"sentences":["等待'));
    });
    try {
      const gateway = new ModelGateway(s.repo, { ...opts, timeout: 80 });
      await expect(gateway.generate({ ...s.request, onText: () => {} })).rejects.toMatchObject({
        code: 'TIMEOUT',
      });
      expect(s.calls).toHaveLength(1);
    } finally {
      await s.close();
    }
  });
  it('rejects cancellation even when final text and terminal marker arrive in the same chunk', async () => {
    const controller = new AbortController();
    const s = await setup('openai-chat', (res) => {
      start(res, 'openai-chat');
      res.write(delta('openai-chat', '{"sentences":["最后一段。"]}'));
      finish(res, 'openai-chat');
    });
    try {
      await expect(
        s.gateway.generate({
          ...s.request,
          signal: controller.signal,
          onText: (text) => {
            if (text) controller.abort();
          },
        }),
      ).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(s.calls).toHaveLength(1);
    } finally {
      await s.close();
    }
  });
  it('accepts a normal JSON response once without simulating incremental output', async () => {
    const s = await setup('openai-chat', (res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ choices: [{ message: { content: '{"sentences":["普通输出。"]}' } }] }),
      );
    });
    const updates: string[] = [];
    try {
      await s.gateway.generate({
        ...s.request,
        onText: (text) => {
          updates.push(text);
        },
      });
      expect(updates).toEqual(['', '普通输出。']);
      expect(s.calls).toHaveLength(1);
    } finally {
      await s.close();
    }
  });
  it('never retries a rejected streaming request as a non-streaming request', async () => {
    const s = await setup('openai-chat', (res) => {
      res.writeHead(400);
      res.end('unsupported stream');
    });
    try {
      await expect(s.gateway.generate({ ...s.request, onText: () => {} })).rejects.toMatchObject({
        code: 'UPSTREAM_REQUEST',
      });
      expect(s.calls).toHaveLength(1);
      expect(s.calls[0].stream).toBe(true);
    } finally {
      await s.close();
    }
  });
});
