import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ModelGateway, type Purpose } from '../apps/api/src/gateway';
import {
  defaultGatewayOptions,
  readGatewayOptions,
  type GatewayOptions,
} from '../apps/api/src/gateway-options';
import type { PrivateConnection, Repository } from '../apps/api/src/repository';
import { startProvider, type Responder } from './fixtures/provider';

const schema = z.object({ ok: z.literal(true) }).strict();
const protocols = ['openai-chat', 'openai-responses', 'anthropic'] as const;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function setup(
  protocol: PrivateConnection['protocol'] = 'openai-chat',
  responder: Responder = () => ({ ok: true }),
  options: Partial<GatewayOptions> = {},
) {
  const provider = await startProvider(responder);
  const runs: { purpose: string; errorCode: string | null }[] = [];
  const repo = {
    recordRun: (run: { purpose: string; errorCode: string | null }) => runs.push(run),
  } as unknown as Repository;
  const connection = {
    id: 'insights-limits-test',
    version: 1,
    protocol,
    provider: 'custom',
    model: 'local-only',
    baseUrl: provider.baseUrl,
    apiKey: 'fixture-only',
    structuredOutput: false,
  } as PrivateConnection;
  const gateway = new ModelGateway(repo, { retryDelay: 1, ...options });
  return {
    provider,
    runs,
    request: (purpose: Purpose, signal?: AbortSignal) =>
      gateway.generate({ connection, purpose, input: {}, schema, signal }),
    close: provider.close,
  };
}

describe('洞察独立超时与输出额度', () => {
  it('keeps insights independent from ordinary and summary defaults', () => {
    const options = readGatewayOptions({});
    expect(options).toMatchObject({
      timeout: 60000,
      summaryTimeout: 240000,
      summaryMaxTokens: 8192,
      insightsTimeout: 180000,
      insightsMaxTokens: 8192,
    });
    expect(options).toEqual(defaultGatewayOptions);
  });

  it('loads independent environment overrides', () => {
    expect(
      readGatewayOptions({
        MODEL_TIMEOUT_MS: '45000',
        SUMMARY_TIMEOUT_MS: '95000',
        INSIGHTS_TIMEOUT_MS: '240000',
        INSIGHTS_MAX_TOKENS: '16384',
      }),
    ).toMatchObject({
      timeout: 45000,
      summaryTimeout: 95000,
      insightsTimeout: 240000,
      insightsMaxTokens: 16384,
    });
  });

  it.each(
    ['INSIGHTS_TIMEOUT_MS', 'INSIGHTS_MAX_TOKENS'].flatMap((name) =>
      ['0', '-1', '1.5', 'NaN', 'private-invalid-value'].map((value) => ({ name, value })),
    ),
  )('rejects invalid $name=$value without echoing its value', ({ name, value }) => {
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

  it.each(protocols)('sends default and overridden insight limits over %s', async (protocol) => {
    const standard = await setup(protocol);
    const custom = await setup(protocol, undefined, { insightsMaxTokens: 16384 });
    const field = protocol === 'openai-responses' ? 'max_output_tokens' : 'max_tokens';
    try {
      await standard.request('insights');
      expect(standard.provider.calls[0].body[field]).toBe(8192);
      for (const purpose of ['insights', 'summary', 'cast', 'opening'] as const)
        await custom.request(purpose);
      expect(custom.provider.calls.map((call) => call.body[field])).toEqual([
        16384, 8192, 4096, 1200,
      ]);
      expect(custom.provider.calls.every((call) => call.body.stream === undefined)).toBe(true);
    } finally {
      await standard.close();
      await custom.close();
    }
  });

  it('allows slow insights and summaries while an equal ordinary response times out', async () => {
    const s = await setup(
      'openai-chat',
      async () => {
        await delay(200);
        return { ok: true };
      },
      { timeout: 70, insightsTimeout: 1500, summaryTimeout: 1500 },
    );
    try {
      await expect(s.request('opening')).rejects.toMatchObject({ code: 'TIMEOUT' });
      await expect(s.request('insights')).resolves.toEqual({ ok: true });
      await expect(s.request('summary')).resolves.toEqual({ ok: true });
      expect(s.runs.map((run) => [run.purpose, run.errorCode])).toEqual([
        ['opening', 'TIMEOUT'],
        ['insights', null],
        ['summary', null],
      ]);
      expect(s.provider.calls).toHaveLength(3);
    } finally {
      await s.close();
    }
  });

  it('enforces the configured insight timeout even when ordinary calls have longer time', async () => {
    const s = await setup(
      'openai-chat',
      async () => {
        await delay(250);
        return { ok: true };
      },
      { timeout: 1500, insightsTimeout: 70 },
    );
    try {
      await expect(s.request('insights')).rejects.toMatchObject({ code: 'TIMEOUT' });
      expect(s.runs).toEqual([
        expect.objectContaining({ purpose: 'insights', errorCode: 'TIMEOUT' }),
      ]);
      expect(s.provider.calls).toHaveLength(1);
    } finally {
      await s.close();
    }
  });

  it('retains cancellation during the longer insight deadline', async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: () => void;
    const response = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const s = await setup('openai-chat', async () => {
      entered();
      await response;
      return { ok: true };
    });
    const controller = new AbortController();
    try {
      const pending = s.request('insights', controller.signal);
      const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
      await started;
      controller.abort();
      await rejected;
      expect(s.provider.calls).toHaveLength(1);
      expect(s.runs[0].errorCode).toBe('CANCELLED');
    } finally {
      finish();
      await s.close();
    }
  });

  it('uses insight limits for the single output repair as well', async () => {
    let attempts = 0;
    const s = await setup(
      'openai-chat',
      async () => {
        await delay(150);
        return ++attempts === 1 ? '{invalid-json' : { ok: true };
      },
      { timeout: 50, insightsTimeout: 1500, insightsMaxTokens: 12288 },
    );
    try {
      await expect(s.request('insights')).resolves.toEqual({ ok: true });
      expect(s.provider.calls).toHaveLength(2);
      expect(s.provider.calls.map((call) => call.body.max_tokens)).toEqual([12288, 12288]);
      expect(s.runs.map((run) => run.errorCode)).toEqual(['INVALID_OUTPUT', null]);
    } finally {
      await s.close();
    }
  });
});
