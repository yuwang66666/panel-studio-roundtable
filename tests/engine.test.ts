import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Intent, Message } from '../packages/contracts/src/index';
import { selectNextSpeaker } from '../packages/domain/src/scheduler';
import { DiscussionEngine, type InsightsPort } from '../apps/api/src/engine';
import { harness } from './fixtures/harness';
import { defaultResponse } from './fixtures/provider';
const m = (id: string, p: string, seq: number): Message => ({
  id,
  participantId: p,
  messageSeq: seq,
  discussionId: 'd',
  turnId: id,
  kind: 'expert',
  content: '观点。',
  replyToMessageId: null,
  createdAt: '',
});
const intent = (p: string, action: Intent['action'], target: string | null = null): Intent => ({
  participantId: p,
  action,
  targetMessageId: target,
  basedOnMessageSeq: 2,
  proposedFocus: p,
});
function testInsights(repo: ReturnType<typeof Object> & any): InsightsPort {
  return {
    onMessage() {},
    async finish(id, generation) {
      const s = repo.snapshot(id);
      repo.saveInsights(id, generation, s.messages.at(-1)?.messageSeq || 0, []);
      repo.appendMessage(id, generation, {
        turnId: randomUUID(),
        participantId: s.participants[0].id,
        kind: 'summary',
        content: '测试收尾已完成。',
        replyToMessageId: null,
      });
    },
  };
}
describe('调度与讨论执行', () => {
  it('prioritizes rebuttal, promotes long-waiting experts, filters stale and invalid intents', () => {
    const msgs = [m('m1', 'a', 1), m('m2', 'b', 2)];
    const choices = [
      intent('a', 'raise'),
      intent('b', 'rebut', 'm1'),
      intent('c', 'supplement', 'm2'),
    ];
    expect(selectNextSpeaker(choices, msgs, 2, {}).participantId).toBe('b');
    expect(selectNextSpeaker(choices, msgs, 2, { a: 3 }).participantId).toBe('a');
    expect(
      selectNextSpeaker(
        [{ ...intent('x', 'rebut', 'other') }, { ...intent('y', 'raise'), basedOnMessageSeq: 1 }],
        msgs,
        2,
        {},
      ),
    ).toBeNull();
  });
  it('limits consecutive speakers when another expert volunteers and breaks ties stably', () => {
    const msgs = [m('m1', 'a', 1), m('m2', 'a', 2)];
    expect(
      selectNextSpeaker([intent('a', 'raise'), intent('b', 'supplement', 'm1')], msgs, 2, {})
        .participantId,
    ).toBe('b');
    expect(
      selectNextSpeaker([intent('c', 'raise'), intent('b', 'raise')], [], 2, {}).participantId,
    ).toBe('b');
  });
  it('runs all expert intent calls from matching transcript boundaries', async () => {
    const h = await harness();
    try {
      const created = h.repo.createDiscussion('怎样让多智能体有效地交流？', 4, h.connection.id, 4);
      h.discussions.cast(created.discussion.id);
      await h.discussions.idle(created.discussion.id);
      let s = h.repo.snapshot(created.discussion.id);
      s = h.repo.start(s.discussion.id, s.discussion.version, s.discussion.castVersion, 3);
      await new DiscussionEngine(h.repo, h.gateway, testInsights(h.repo)).run(
        s.discussion.id,
        new AbortController().signal,
      );
      const done = h.repo.snapshot(s.discussion.id);
      expect(done.discussion.status).toBe('completed');
      expect(done.messages.filter((m) => m.kind === 'expert')).toHaveLength(4);
      const calls = h.provider.calls
        .map((c) => JSON.parse(c.body.messages?.at(-1).content))
        .filter((t) => t.purpose === 'intent');
      expect(calls).toHaveLength(16);
      for (let i = 0; i < calls.length; i += 4)
        expect(
          new Set(calls.slice(i, i + 4).map((c) => c.input.context.throughMessageSeq)).size,
        ).toBe(1);
    } finally {
      await h.close();
    }
  });
  it('all-pass triggers exactly two moderator invitations and then closes', async () => {
    const h = await harness((task) =>
      task.purpose === 'intent'
        ? { action: 'pass', targetMessageId: null, proposedFocus: null }
        : defaultResponse(task),
    );
    try {
      const r = await h.command('POST', '/api/discussions', {
        topic: '如何判断讨论是否已经充分？',
      });
      const id = r.json().discussion.id;
      await h.discussions.idle(id);
      const ready = h.repo.snapshot(id);
      h.repo.start(id, ready.discussion.version, ready.discussion.castVersion, 3);
      await new DiscussionEngine(h.repo, h.gateway, testInsights(h.repo)).run(
        id,
        new AbortController().signal,
      );
      const s = h.repo.snapshot(id);
      expect(s.messages.filter((m) => m.kind === 'probe')).toHaveLength(2);
      expect(s.messages.filter((m) => m.kind === 'expert')).toHaveLength(0);
      expect(s.discussion.status).toBe('completed');
    } finally {
      await h.close();
    }
  });
});
