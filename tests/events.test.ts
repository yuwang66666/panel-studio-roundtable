import { describe, it, expect } from 'vitest';
import { projectEvent } from '../packages/domain/src/events';
import { makeSample } from '../packages/domain/src/samples';
import { harness } from './fixtures/harness';
import type { PublicEvent, SpeechDraft } from '../packages/contracts/src/index';
describe('SSE 与事件归并', () => {
  it('deduplicates events, rejects gaps and isolates discussions', () => {
    const s = makeSample(0),
      event: PublicEvent = {
        discussionId: s.discussion.id,
        seq: 1,
        schemaVersion: 1,
        occurredAt: 'now',
        type: 'discussion.status_changed',
        payload: { discussion: s.discussion },
      };
    const next = projectEvent(s, event)!;
    expect(next.lastEventSeq).toBe(1);
    expect(projectEvent(next, event)).toBe(next);
    expect(projectEvent(s, { ...event, seq: 3 })).toBeNull();
    expect(projectEvent(s, { ...event, discussionId: 'other' })).toBe(s);
  });
  function streamingState() {
    const s = makeSample(0);
    s.discussion.status = 'running';
    s.messages = s.messages.filter((m) => m.kind !== 'summary');
    const draft: SpeechDraft = {
      turnId: 'stream-turn',
      discussionId: s.discussion.id,
      participantId: s.participants[1].id,
      generation: s.discussion.generation,
      kind: 'expert',
      content: '我们需要',
      replyToMessageId: s.messages[0].id,
      startedAt: '2026-11-18T12:00:00Z',
    };
    const update: PublicEvent = {
      discussionId: s.discussion.id,
      seq: 1,
      schemaVersion: 1,
      occurredAt: draft.startedAt,
      type: 'speech.updated',
      payload: { draft },
    };
    return { s, draft, update };
  }
  it('replaces the growing draft without duplicating text or adding a committed message', () => {
    const { s, draft, update } = streamingState();
    const first = projectEvent(s, update)!;
    const second = projectEvent(first, {
      ...update,
      seq: 2,
      payload: { draft: { ...draft, content: '我们需要更多证据。' } },
    })!;
    expect(second.draft?.content).toBe('我们需要更多证据。');
    expect(second.messages).toEqual(s.messages);
    expect(projectEvent(second, update)).toBe(second);
    expect(projectEvent(first, { ...update, seq: 4 })).toBeNull();
    const reset = projectEvent(second, {
      ...update,
      seq: 3,
      payload: { draft: { ...draft, content: '' } },
    })!;
    expect(reset.draft?.content).toBe('');
    expect(reset.draft?.turnId).toBe(draft.turnId);
  });
  it('isolates draft ownership and ignores old generations and already-committed turns', () => {
    const { s, draft, update } = streamingState();
    expect(projectEvent(s, { ...update, discussionId: 'other' })).toBe(s);
    for (const invalid of [
      { ...draft, discussionId: 'other' },
      { ...draft, participantId: 'other-expert' },
      { ...draft, generation: draft.generation + 1 },
      { ...draft, turnId: s.messages[0].turnId },
    ]) {
      expect(projectEvent(s, { ...update, payload: { draft: invalid } })?.draft).toBeNull();
    }
  });
  it('clears only the matching draft and atomically replaces it with the committed turn', () => {
    const { s, draft, update } = streamingState();
    const streaming = projectEvent(s, update)!;
    const cleared: PublicEvent = {
      discussionId: s.discussion.id,
      seq: 2,
      schemaVersion: 1,
      occurredAt: 'now',
      type: 'speech.cleared',
      payload: { turnId: 'another-turn' },
    };
    expect(projectEvent(streaming, cleared)?.draft).toEqual(draft);
    expect(
      projectEvent(streaming, { ...cleared, payload: { turnId: draft.turnId } })?.draft,
    ).toBeNull();
    const message = {
      ...s.messages[1],
      id: 'committed-stream',
      turnId: draft.turnId,
      content: '我们需要更多证据。',
      messageSeq: s.messages.length + 1,
    };
    const commit: PublicEvent = {
      discussionId: s.discussion.id,
      seq: 2,
      schemaVersion: 1,
      occurredAt: 'now',
      type: 'message.committed',
      payload: { message, discussion: s.discussion },
    };
    const completed = projectEvent(streaming, commit)!;
    expect(completed.draft).toBeNull();
    expect(completed.messages).toHaveLength(s.messages.length + 1);
    expect(completed.messages.at(-1)?.content).toBe(message.content);
    expect(projectEvent(completed, commit)).toBe(completed);
    expect(projectEvent(completed, { ...commit, seq: 3 })?.messages).toHaveLength(
      s.messages.length + 1,
    );
  });
  it('drops previews when execution stops or advances and supports a streaming moderator summary', () => {
    const { s, draft, update } = streamingState();
    const streaming = projectEvent(s, update)!;
    for (const status of [
      'completed',
      'failed',
      'interrupted',
      'casting',
      'awaiting_confirmation',
    ] as const) {
      const event: PublicEvent = {
        discussionId: s.discussion.id,
        seq: 2,
        schemaVersion: 1,
        occurredAt: 'now',
        type: 'discussion.status_changed',
        payload: { discussion: { ...s.discussion, status } },
      };
      expect(projectEvent(streaming, event)?.draft).toBeNull();
    }
    expect(
      projectEvent(streaming, {
        discussionId: s.discussion.id,
        seq: 2,
        schemaVersion: 1,
        occurredAt: 'now',
        type: 'discussion.status_changed',
        payload: { discussion: { ...s.discussion, generation: draft.generation + 1 } },
      })?.draft,
    ).toBeNull();
    s.discussion.status = 'summarizing';
    const summaryDraft: SpeechDraft = {
      ...draft,
      kind: 'summary',
      participantId: s.participants[0].id,
      content: '本场讨论',
    };
    const summary = projectEvent(s, { ...update, payload: { draft: summaryDraft } })!;
    expect(summary.draft).toEqual(summaryDraft);
    const done = projectEvent(summary, {
      discussionId: s.discussion.id,
      seq: 2,
      schemaVersion: 1,
      occurredAt: 'now',
      type: 'summary.ready',
      payload: {
        discussion: { ...s.discussion, status: 'completed' },
        message: {
          ...s.messages[0],
          id: 'summary-message',
          kind: 'summary',
          turnId: draft.turnId,
          content: '本场讨论形成局部共识。',
          messageSeq: s.messages.length + 1,
        },
      },
    })!;
    expect(done.draft).toBeNull();
    expect(done.discussion.status).toBe('completed');
    expect(done.messages.at(-1)?.kind).toBe('summary');
  });
  it('replays persisted events and honors Last-Event-ID over initial query cursor', async () => {
    const h = await harness();
    const controller = new AbortController();
    try {
      const r = await h.command('POST', '/api/discussions', { topic: '如何保证实时事件不丢失？' }),
        id = r.json().discussion.id;
      await h.discussions.idle(id);
      const initial = h.repo.snapshot(id),
        running = h.repo.start(id, initial.discussion.version, initial.discussion.castVersion, 3);
      h.repo.appendMessage(id, running.discussion.generation, {
        turnId: 'test',
        participantId: running.participants[1].id,
        kind: 'expert',
        content: '先保存，再推送。',
        replyToMessageId: null,
      });
      const events = h.repo.eventsAfter(id, initial.lastEventSeq);
      const address = await h.app.listen({ port: 0, host: '127.0.0.1' });
      const response = await fetch(`${address}/api/discussions/${id}/events?after=0`, {
        headers: { 'Last-Event-ID': String(initial.lastEventSeq) },
        signal: controller.signal,
      });
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const reader = response.body!.getReader();
      let buffer = '',
        received: PublicEvent[] = [];
      while (received.length < events.length) {
        const chunk = await reader.read();
        buffer += new TextDecoder().decode(chunk.value);
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop()!;
        for (const block of blocks) {
          const data = block.split('\n').find((l) => l.startsWith('data: '));
          if (data) received.push(JSON.parse(data.slice(6)));
        }
      }
      expect(received.map((e) => e.seq)).toEqual(events.map((e) => e.seq));
      controller.abort();
      await reader.cancel().catch(() => {});
    } finally {
      controller.abort();
      await h.close();
    }
  });
});
