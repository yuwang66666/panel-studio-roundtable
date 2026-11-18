import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import { createApp } from '../apps/api/src/app';
import { readModelCatalog } from '../apps/api/src/model-catalog';
import { startProvider } from './fixtures/provider';
const opts = {
  globalConcurrency: 4,
  connectionConcurrency: 2,
  timeout: 2000,
  summaryTimeout: 2000,
  retryDelay: 2,
};
async function setup(responder?: Parameters<typeof startProvider>[0]) {
  mkdirSync(resolve('.tmp'), { recursive: true });
  const dir = mkdtempSync(resolve('.tmp/gateway-'));
  const provider = await startProvider(responder);
  const instance = await createApp({ dataDir: dir, gatewayOptions: opts });
  return {
    ...instance,
    provider,
    close: async () => {
      await instance.app.close();
      await provider.close();
      if (!dir.startsWith(resolve('.tmp') + requireSeparator())) throw Error('invalid cleanup');
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
function requireSeparator() {
  return process.platform === 'win32' ? '\\' : '/';
}
const headers = { 'x-panel-client': 'local', 'content-type': 'application/json' };
describe('模型网关和设置 API', () => {
  it.each(['openai-chat', 'openai-responses', 'anthropic'] as const)(
    'validates %s protocol and never publishes private fields',
    async (protocol) => {
      const s = await setup();
      try {
        s.repo.syncModelCatalog(
          readModelCatalog({
            PANEL_MODELS: 'TEST',
            MODEL_TEST_NAME: protocol,
            MODEL_TEST_PROVIDER: 'custom',
            MODEL_TEST_PROTOCOL: protocol,
            MODEL_TEST_BASE_URL: s.provider.baseUrl,
            MODEL_TEST_MODEL: 'test-model',
            MODEL_TEST_API_KEY: 'secret-test-key',
          }),
        );
        const created = await s.app.inject('/api/model-connections');
        expect(created.statusCode).toBe(200);
        expect(created.body).not.toContain('secret-test-key');
        const c = created.json()[0];
        const tested = await s.app.inject({
          method: 'POST',
          url: `/api/model-connections/${c.id}/test`,
          headers,
          payload: {},
        });
        expect(tested.statusCode).toBe(200);
        expect(s.repo.listConnections()[0].testStatus).toBe('passed');
        const call = s.provider.calls[0];
        expect(protocol === 'anthropic' ? call.apiKey : call.authorization).toContain(
          'secret-test-key',
        );
        expect(call.body.instructions).toBeUndefined();
        expect(call.body.system).toBeUndefined();
        expect(call.body.messages?.some((message: any) => message.role === 'system') || false).toBe(
          false,
        );
        expect((call.body.input || call.body.messages)[0]).toEqual({
          role: 'user',
          content: 'Return only {"ok":true}',
        });
        expect((await s.app.inject('/api/model-connections')).body).not.toContain(
          'HIDDEN_REASONING',
        );
        expect((s.repo.db.prepare('SELECT count(*) as n FROM model_runs').get() as any).n).toBe(1);
        const opening = await s.gateway.generate({
          connection: s.repo.connection(c.id),
          purpose: 'opening',
          input: { topic: '如何组织中文圆桌讨论？' },
          schema: z.object({ content: z.string().min(1) }).strict(),
        });
        expect(opening.content).toContain('欢迎来到圆桌');
        const business = s.provider.calls[1].body;
        const instructions =
          business.instructions ||
          business.system ||
          business.messages?.find((message: any) => message.role === 'system')?.content;
        expect(instructions).toContain('中文 AI 圆桌');
        expect(instructions).toContain('以主持人身份');
        expect(JSON.parse((business.input || business.messages).at(-1).content)).toEqual({
          purpose: 'opening',
          input: { topic: '如何组织中文圆桌讨论？' },
        });
      } finally {
        await s.close();
      }
    },
  );
  it.each([
    { label: 'plain text', output: 'The connection is working.' },
    { label: 'extra JSON fields', output: { ok: true, extra: 'unrequested' } },
  ])(
    'rejects HTTP 200 with $label and marks the connection failed after one repair',
    async ({ output }) => {
      const s = await setup(() => output);
      try {
        const c = s.repo.saveConnection({
          name: 'test',
          provider: 'custom',
          protocol: 'anthropic',
          baseUrl: s.provider.baseUrl,
          model: 'test',
          apiKey: 'secret',
          active: true,
          structuredOutput: false,
        });
        const response = await s.app.inject({
          method: 'POST',
          url: `/api/model-connections/${c.id}/test`,
          headers,
          payload: {},
        });
        expect(response.statusCode).toBe(502);
        expect(response.json().error.code).toBe('INVALID_OUTPUT');
        expect(s.provider.calls).toHaveLength(2);
        expect(s.provider.calls[0].body.messages[0].content).toBe('Return only {"ok":true}');
        expect(s.provider.calls[1].body.messages[0].content).toBe(
          'Return only {"ok":true}\nThe previous response was invalid. Return exactly one JSON object with no other text.',
        );
        expect(s.repo.listConnections()[0].testStatus).toBe('failed');
        const publicConnections = await s.app.inject('/api/model-connections');
        expect(publicConnections.json()[0].testStatus).toBe('failed');
        expect(publicConnections.body).not.toContain('secret');
      } finally {
        await s.close();
      }
    },
  );
  it('retries 429 but never retries authentication failure or leaks upstream details', async () => {
    const s = await setup();
    try {
      const c = s.repo.saveConnection({
        name: 'test',
        provider: 'custom',
        protocol: 'openai-chat',
        baseUrl: s.provider.baseUrl,
        model: 'test',
        apiKey: 'secret',
        active: true,
        structuredOutput: false,
      });
      s.provider.fail(429);
      await s.gateway.generate({
        connection: s.repo.connection(c.id),
        purpose: 'test',
        input: {},
        schema: z.object({ ok: z.literal(true) }),
      });
      expect(s.provider.calls).toHaveLength(2);
      s.provider.fail(401);
      const r = await s.app.inject({
        method: 'POST',
        url: `/api/model-connections/${c.id}/test`,
        headers,
        payload: {},
      });
      expect(r.statusCode).toBe(502);
      expect(r.body).not.toContain('UPSTREAM_PRIVATE_DETAIL');
      expect(s.provider.calls).toHaveLength(3);
      expect(s.repo.listConnections()[0].testStatus).toBe('failed');
    } finally {
      await s.close();
    }
  });
  it('repairs malformed output once then fails, and rejects cross-origin writes', async () => {
    const s = await setup(() => '{bad-json');
    try {
      const c = s.repo.saveConnection({
        name: 'test',
        provider: 'custom',
        protocol: 'anthropic',
        baseUrl: s.provider.baseUrl,
        model: 'test',
        apiKey: 'secret',
        active: true,
        structuredOutput: false,
      });
      await expect(
        s.gateway.generate({
          connection: s.repo.connection(c.id),
          purpose: 'test',
          input: {},
          schema: z.object({ ok: z.literal(true) }),
        }),
      ).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
      expect(s.provider.calls).toHaveLength(2);
      expect(
        (
          await s.app.inject({
            method: 'PATCH',
            url: '/api/settings',
            headers: { ...headers, origin: 'https://evil.example' },
            payload: { defaultModeratorConnectionId: c.id },
          })
        ).statusCode,
      ).toBe(403);
    } finally {
      await s.close();
    }
  });
  it('aborts an in-flight request', async () => {
    const s = await setup(async () => {
      await new Promise((r) => setTimeout(r, 150));
      return { ok: true };
    });
    try {
      const c = s.repo.saveConnection({
        name: 'test',
        provider: 'custom',
        protocol: 'openai-chat',
        baseUrl: s.provider.baseUrl,
        model: 'test',
        apiKey: 'secret',
        active: true,
        structuredOutput: false,
      });
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 15);
      await expect(
        s.gateway.generate({
          connection: s.repo.connection(c.id),
          purpose: 'test',
          input: {},
          schema: z.object({ ok: z.literal(true) }),
          signal: ctrl.signal,
        }),
      ).rejects.toMatchObject({ code: 'CANCELLED' });
    } finally {
      await s.close();
    }
  });
  it('times out without retrying and records invalid output as an error', async () => {
    const s = await setup(async () => {
      await new Promise((r) => setTimeout(r, 80));
      return { ok: true };
    });
    try {
      const c = s.repo.saveConnection({
        name: 'test',
        provider: 'custom',
        protocol: 'openai-chat',
        baseUrl: s.provider.baseUrl,
        model: 'test',
        apiKey: 'secret',
        active: true,
        structuredOutput: false,
      });
      const { ModelGateway } = await import('../apps/api/src/gateway');
      const short = new ModelGateway(s.repo, { ...opts, timeout: 15 });
      await expect(
        short.generate({
          connection: s.repo.connection(c.id),
          purpose: 'test',
          input: {},
          schema: z.object({ ok: z.literal(true) }),
        }),
      ).rejects.toMatchObject({ code: 'TIMEOUT' });
      expect(s.provider.calls.length).toBeLessThanOrEqual(1);
      expect(
        (
          s.repo.db
            .prepare('SELECT error_code FROM model_runs ORDER BY rowid DESC LIMIT 1')
            .get() as any
        ).error_code,
      ).toBe('TIMEOUT');
    } finally {
      await s.close();
    }
  });
});
