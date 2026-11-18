import { describe, it, expect } from 'vitest';
import { harness } from './fixtures/harness';
import { defaultResponse } from './fixtures/provider';
describe('创建与阵容确认', () => {
  it('creates exactly four experts plus moderator, persists bindings and deduplicates creation', async () => {
    const h = await harness();
    try {
      const body = { topic: '人工智能如何改变初级岗位？', expertCount: 4 };
      const a = await h.command('POST', '/api/discussions', body, 'create-1');
      expect(a.statusCode).toBe(202);
      const id = a.json().discussion.id;
      await h.discussions.idle(id);
      const s = h.repo.snapshot(id);
      expect(s.discussion.status).toBe('awaiting_confirmation');
      expect(s.participants.filter((p) => p.role === 'expert')).toHaveLength(4);
      expect(s.participants.filter((p) => p.role === 'moderator')).toHaveLength(1);
      expect(s.bindings).toHaveLength(5);
      const again = await h.command('POST', '/api/discussions', body, 'create-1');
      expect(again.json().discussion.id).toBe(id);
      expect(h.provider.calls).toHaveLength(1);
      const bind = await h.command('PUT', `/api/discussions/${id}/agent-bindings`, {
        expectedVersion: s.discussion.version,
        castVersion: s.discussion.castVersion,
        bindings: s.bindings.map((b) => ({
          participantId: b.participantId,
          connectionId: b.connectionId,
        })),
      });
      expect(bind.statusCode).toBe(200);
      expect(bind.json().discussion.version).toBe(s.discussion.version + 1);
    } finally {
      await h.close();
    }
  });
  it('repairs invalid cast once, exposes safe failure and retries against current credential version', async () => {
    let invalid = true;
    const h = await harness((task) =>
      task.purpose === 'cast' && invalid ? { moderator: {}, experts: [] } : defaultResponse(task),
    );
    try {
      const r = await h.command('POST', '/api/discussions', { topic: '城市公共交通如何建设？' });
      const id = r.json().discussion.id;
      await h.discussions.idle(id);
      let d = h.repo.discussion(id);
      expect(d.status).toBe('failed');
      expect(d.failureStage).toBe('cast');
      expect(h.provider.calls).toHaveLength(2);
      invalid = false;
      h.repo.patchConnection(h.connection.id, { model: 'updated-model' });
      expect(
        (await h.command('POST', `/api/discussions/${id}/retry`, { expectedVersion: d.version }))
          .statusCode,
      ).toBe(202);
      await h.discussions.idle(id);
      expect(h.repo.discussion(id).status).toBe('awaiting_confirmation');
      expect(h.provider.calls.at(-1)?.body.model).toBe('updated-model');
    } finally {
      await h.close();
    }
  });
});
