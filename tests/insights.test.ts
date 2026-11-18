import { describe, it, expect } from 'vitest';
import { validateInsightEvidence } from '../packages/domain/src/insights';
import { makeSample } from '../packages/domain/src/samples';
import { harness } from './fixtures/harness';
import { defaultResponse } from './fixtures/provider';
describe('洞察与最终总结', () => {
  it('rejects unsupported whole-panel consensus and foreign evidence', () => {
    const s = makeSample(0),
      i = s.insights[0];
    expect(() => validateInsightEvidence(s, [{ ...i, scope: 'all' }], 5)).toThrow();
    expect(() =>
      validateInsightEvidence(
        s,
        [{ ...i, evidence: [{ messageId: 'other-discussion', relation: 'supports' }] }],
        5,
      ),
    ).toThrow();
    expect(() => validateInsightEvidence(s, [i], 5)).not.toThrow();
  });
  it('completes real HTTP orchestration with live evidence and a final summary', async () => {
    const h = await harness();
    try {
      const r = await h.command('POST', '/api/discussions', {
          topic: '如何选择适合企业的模型部署方案？',
        }),
        id = r.json().discussion.id;
      await h.discussions.idle(id);
      const s = h.repo.snapshot(id);
      const started = await h.command('POST', `/api/discussions/${id}/start`, {
        expectedVersion: s.discussion.version,
        castVersion: s.discussion.castVersion,
      });
      expect(started.statusCode).toBe(202);
      await h.discussions.idle(id);
      const end = h.repo.snapshot(id);
      expect(end.discussion.status).toBe('completed');
      expect(end.messages.filter((m) => m.kind === 'expert')).toHaveLength(16);
      expect(end.messages.at(-1)?.kind).toBe('summary');
      expect(end.discussion.insightsThrough).toBe(end.messages.at(-2)?.messageSeq);
      expect(end.insights.length).toBeGreaterThan(0);
      const events = h.repo.eventsAfter(id, 0, 1000);
      expect(
        events.some(
          (e) => e.type === 'insights.updated' && e.payload.discussion.status === 'running',
        ),
      ).toBe(true);
      expect(JSON.stringify(end)).not.toContain('HIDDEN_REASONING');
      expect(JSON.stringify(end)).not.toContain('not-a-real-key');
    } finally {
      await h.close();
    }
  });
  it('keeps transcript and completes locally when every summary attempt fails', async () => {
    const h = await harness((task) =>
      task.purpose === 'summary' ? 'invalid json' : defaultResponse(task),
    );
    try {
      const created = h.repo.createDiscussion(
        '如何对讨论过程进行可靠验证？',
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
      expect(s.discussion.status).toBe('completed');
      expect(s.discussion.failureStage).toBeNull();
      expect(s.messages.filter((m) => m.kind === 'expert')).toHaveLength(3);
      expect(s.messages.filter((m) => m.kind === 'summary')).toHaveLength(1);
      expect(s.messages.at(-1)?.summaryMeta).toMatchObject({
        source: 'local',
        reason: 'models_unavailable',
      });
      expect(s.messages.at(-1)?.content).toContain('本地整理摘要');
    } finally {
      await h.close();
    }
  });
});
