import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
export interface RecordedCall {
  path: string;
  body: any;
  authorization?: string;
  apiKey?: string;
}
export type Responder = (
  task: { purpose: string; input: any },
  call: RecordedCall,
) => unknown | Promise<unknown>;
export interface ProviderOptions {
  streamChunkSize?: number;
  streamDelayMs?: number;
  afterStreamChunk?: (chunk: {
    task: { purpose: string; input: any };
    call: RecordedCall;
    index: number;
    textSoFar: string;
  }) => void | Promise<void>;
}
export function defaultResponse({ purpose, input }: { purpose: string; input: any }) {
  const context = input?.context || input;
  if (purpose === 'test') return { ok: true };
  if (purpose === 'cast') {
    const role = (i: number) => ({
      name: `嘉宾${i}`,
      occupation: [
        '主持人',
        '产业研究员',
        '政策研究员',
        '企业实践者',
        '社会学者',
        '工程师',
        '教育学者',
      ][i],
      title: `视角${i}`,
      stance: `从第${i}种专业视角讨论适用条件`,
      specialty: [`领域${i}`],
    });
    return {
      moderator: role(0),
      experts: Array.from({ length: input.expertCount }, (_, i) => role(i + 1)),
    };
  }
  const experts = context?.participants?.filter((p: any) => p.role === 'expert') || [];
  const messages = (context?.messages || []).filter((m: any) => m.kind === 'expert');
  if (purpose === 'intent') {
    const actor = context.participant;
    const last = messages.at(-1);
    return {
      action: last && last.participantId !== actor.id ? 'supplement' : 'raise',
      targetMessageId: last && last.participantId !== actor.id ? last.id : null,
      proposedFocus: `补充第${context.throughMessageSeq}条发言的适用条件和评估依据`,
    };
  }
  if (purpose === 'utterance')
    return {
      sentences: [
        `从${context.participant.occupation}的角度，需要先明确适用条件和评价指标。`,
        '我支持在限定范围试点，并根据实际结果调整。',
      ],
    };
  if (purpose === 'opening')
    return { content: '欢迎来到圆桌，请各位结合专业背景，讨论这个问题成立的条件。' };
  if (purpose === 'probe')
    return { content: '刚才的观点在什么条件下会失效？请补充可检验的判断依据。' };
  if (purpose === 'insights') {
    const distinct = [...new Map(messages.map((m: any) => [m.participantId, m])).values()] as any[];
    if (distinct.length < 2) return { insights: [] };
    return {
      insights: [
        {
          id: 'bounded-trial',
          kind: 'consensus',
          status: 'stable',
          scope: distinct.length === experts.length ? 'all' : 'local',
          text: '先在限定范围试点，再根据实际结果调整。',
          participantIds: distinct.map((m) => m.participantId),
          evidence: distinct.map((m) => ({ messageId: m.id, relation: 'supports' })),
        },
      ],
    };
  }
  if (purpose === 'summary')
    return {
      content:
        '本场讨论围绕适用条件和评价指标展开。\n\n专家明确支持先在限定范围试点，再根据实际结果调整。具体实施范围和衡量方法仍需进一步验证。',
    };
  throw Error(`Unknown fixture purpose ${purpose}`);
}
export async function startProvider(
  responder: Responder = defaultResponse,
  options: ProviderOptions = {},
) {
  const calls: RecordedCall[] = [];
  let failures: { status: number; count: number } | undefined;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    const call = {
      path: req.url!,
      body,
      authorization: req.headers.authorization,
      apiKey: req.headers['x-api-key'] as string | undefined,
    };
    calls.push(call);
    if (failures && failures.count-- > 0) {
      res.writeHead(failures.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'UPSTREAM_PRIVATE_DETAIL' } }));
      return;
    }
    try {
      const raw = body.input?.at(-1)?.content || body.messages?.at(-1)?.content || '{}';
      const userText = typeof raw === 'string' ? raw : raw[0].text;
      const task = userText.startsWith('Return only {"ok":true}')
        ? { purpose: 'test', input: {} }
        : JSON.parse(userText);
      const value = await responder(task, call),
        text = typeof value === 'string' ? value : JSON.stringify(value);
      if (body.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
        res.flushHeaders();
        const frame = (event: string | null, data: unknown) => {
          const payload = `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
          const bytes = Buffer.from(payload);
          const split = bytes.findIndex((b) => b >= 0xe0);
          // Deliberately allow a transport boundary inside a Chinese UTF-8 character.
          if (split >= 0) {
            res.write(bytes.subarray(0, split + 1));
            res.write(bytes.subarray(split + 1));
          } else res.write(bytes);
        };
        const responses = req.url?.endsWith('/responses'),
          anthropic = req.url?.endsWith('/messages');
        if (responses) {
          frame('response.created', {
            type: 'response.created',
            response: { id: 'fixture-response', status: 'in_progress' },
          });
          frame('response.reasoning_text.delta', {
            type: 'response.reasoning_text.delta',
            delta: 'HIDDEN_REASONING',
          });
        } else if (anthropic) {
          frame('message_start', {
            type: 'message_start',
            message: {
              id: 'fixture-message',
              type: 'message',
              role: 'assistant',
              content: [],
              usage: { input_tokens: 20, output_tokens: 0 },
            },
          });
          frame('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'thinking', thinking: '' },
          });
          frame('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: 'HIDDEN_REASONING' },
          });
          frame('content_block_stop', { type: 'content_block_stop', index: 0 });
          frame('content_block_start', {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'text', text: '' },
          });
        } else {
          frame(null, {
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', reasoning_content: 'HIDDEN_REASONING' },
                finish_reason: null,
              },
            ],
          });
        }
        const chars = Array.from(text),
          size = Math.max(1, options.streamChunkSize || 8);
        let textSoFar = '';
        for (let at = 0, index = 0; at < chars.length; at += size, index++) {
          if (res.destroyed || res.writableEnded) return;
          const delta = chars.slice(at, at + size).join('');
          textSoFar += delta;
          if (responses)
            frame('response.output_text.delta', {
              type: 'response.output_text.delta',
              response_id: 'fixture-response',
              item_id: 'fixture-output',
              output_index: 0,
              content_index: 0,
              delta,
            });
          else if (anthropic)
            frame('content_block_delta', {
              type: 'content_block_delta',
              index: 1,
              delta: { type: 'text_delta', text: delta },
            });
          else
            frame(null, {
              choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
            });
          await options.afterStreamChunk?.({ task, call, index, textSoFar });
          if (options.streamDelayMs) await new Promise((r) => setTimeout(r, options.streamDelayMs));
        }
        if (res.destroyed || res.writableEnded) return;
        if (responses)
          frame('response.completed', {
            type: 'response.completed',
            response: {
              id: 'fixture-response',
              status: 'completed',
              output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
              usage: { input_tokens: 20, output_tokens: 10 },
            },
          });
        else if (anthropic) {
          frame('content_block_stop', { type: 'content_block_stop', index: 1 });
          frame('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 10 },
          });
          frame('message_stop', { type: 'message_stop' });
        } else {
          frame(null, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
          frame(null, { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10 } });
          frame(null, '[DONE]');
        }
        res.end();
        return;
      }
      const result = req.url?.endsWith('/responses')
        ? {
            output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
            usage: { input_tokens: 20, output_tokens: 10 },
          }
        : req.url?.endsWith('/messages')
          ? {
              content: [
                { type: 'thinking', thinking: 'HIDDEN_REASONING' },
                { type: 'text', text },
              ],
              usage: { input_tokens: 20, output_tokens: 10 },
            }
          : {
              choices: [{ message: { content: text, reasoning_content: 'HIDDEN_REASONING' } }],
              usage: { prompt_tokens: 20, completion_tokens: 10 },
            };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch {
      if (res.headersSent) res.destroy();
      else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{}');
      }
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${addr.port}/v1`,
    calls,
    fail: (status: number, count = 1) => {
      failures = { status, count };
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
