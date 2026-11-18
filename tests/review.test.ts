import { describe, it, expect } from 'vitest';
import { harness } from './fixtures/harness';
import { defaultResponse } from './fixtures/provider';
describe('最终可靠性检查', () => {
  it('enforces global and per-connection model concurrency', async () => {
    let active = 0,
      peak = 0;
    const perKey = new Map<string, number>(),
      peakByKey = new Map<string, number>();
    const h = await harness(async (task, call) => {
      const key = call.authorization || call.apiKey || '';
      active++;
      peak = Math.max(peak, active);
      perKey.set(key, (perKey.get(key) || 0) + 1);
      peakByKey.set(key, Math.max(peakByKey.get(key) || 0, perKey.get(key)!));
      try {
        await new Promise((r) => setTimeout(r, 20));
        return defaultResponse(task);
      } finally {
        active--;
        perKey.set(key, perKey.get(key)! - 1);
      }
    });
    try {
      const { z } = await import('zod');
      const second = h.repo.saveConnection({
        name: 'second',
        provider: 'gpt',
        protocol: 'openai-responses',
        baseUrl: h.provider.baseUrl,
        model: 'second',
        apiKey: 'another-key',
        structuredOutput: false,
        active: true,
      });
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          h.gateway.generate({
            connection: h.repo.connection(i % 2 ? second.id : h.connection.id),
            purpose: 'test',
            input: {},
            schema: z.object({ ok: z.literal(true) }),
          }),
        ),
      );
      expect(peak).toBeLessThanOrEqual(4);
      expect(peak).toBeGreaterThan(1);
      expect([...peakByKey.values()].every((v) => v <= 2)).toBe(true);
    } finally {
      await h.close();
    }
  });
  it('does not commit malformed evidence and refuses a summary without explicit transcript coverage', async () => {
    const h = await harness();
    try {
      const r = await h.command('POST', '/api/discussions', {
          topic: '如何避免错误证据进入讨论总结？',
        }),
        id = r.json().discussion.id;
      await h.discussions.idle(id);
      let s = h.repo.snapshot(id);
      s = h.repo.start(id, s.discussion.version, s.discussion.castVersion, 3);
      const m = h.repo.appendMessage(id, s.discussion.generation, {
        turnId: 'one',
        participantId: s.participants[1].id,
        kind: 'expert',
        content: '证据必须能追溯。',
        replyToMessageId: null,
      });
      const before = h.repo.snapshot(id);
      expect(() =>
        h.repo.saveInsights(id, s.discussion.generation, 1, [
          {
            id: 'wrong',
            kind: 'consensus',
            status: 'stable',
            scope: 'all',
            text: '全体同意',
            revision: 1,
            throughMessageSeq: 1,
            participantIds: s.participants.filter((p) => p.role === 'expert').map((p) => p.id),
            evidence: [{ messageId: m.id, relation: 'supports' }],
          },
        ]),
      ).toThrow();
      expect(h.repo.snapshot(id)).toEqual(before);
      h.repo.transition(id, 'summarizing');
      expect(() =>
        h.repo.appendMessage(id, s.discussion.generation, {
          turnId: 'summary',
          participantId: s.participants[0].id,
          kind: 'summary',
          content: '未经完整覆盖的总结。',
          replyToMessageId: null,
        }),
      ).toThrow();
      expect(h.repo.discussion(id).status).toBe('summarizing');
    } finally {
      await h.close();
    }
  });
});
