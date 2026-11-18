import { describe, it, expect } from 'vitest';
import { buildContext, validShortUtterance } from '../packages/domain/src/context';
import { makeSample } from '../packages/domain/src/samples';
import { harness } from './fixtures/harness';
import { defaultResponse } from './fixtures/provider';
import { SpeechService } from '../apps/api/src/speech';
describe('上下文与短发言', () => {
  it('includes old reply target outside recent window and excludes future messages', () => {
    const s = makeSample(0);
    s.insights = [];
    const first = s.messages[1];
    s.messages = Array.from({ length: 25 }, (_, i) => ({
      ...first,
      id: `m${i + 1}`,
      messageSeq: i + 1,
    }));
    const context = buildContext(s, s.participants[1].id, 20, 'm1');
    expect(context.messages.map((m) => m.id)).toContain('m1');
    expect(context.messages).toHaveLength(13);
    expect(context.messages.every((m) => m.messageSeq <= 20)).toBe(true);
    expect(() => buildContext(s, s.participants[1].id, 20, 'm25')).toThrow();
  });
  it('handles Chinese punctuation, decimals, abbreviations and hidden multiple sentences', () => {
    expect(validShortUtterance(['成本下降了3.5%，仍需观察。', 'Dr. Wang 建议先测试。'])).toBe(true);
    expect(validShortUtterance(['第一句话。第二句话。'])).toBe(false);
    expect(validShortUtterance(['a'.repeat(251)])).toBe(false);
    expect(validShortUtterance(['一。', '二。', '三。'])).toBe(false);
  });
  it('repairs overlong speech once, commits only a validated message and restores public state', async () => {
    let attempts = 0;
    const h = await harness((task) =>
      task.purpose === 'utterance' && ++attempts === 1
        ? { sentences: ['第一句。第二句。第三句。'] }
        : defaultResponse(task),
    );
    try {
      const r = await h.command('POST', '/api/discussions', {
          topic: '如何提高不同专家之间的讨论质量？',
        }),
        id = r.json().discussion.id;
      await h.discussions.idle(id);
      const ready = h.repo.snapshot(id),
        running = h.repo.start(id, ready.discussion.version, ready.discussion.castVersion, 3),
        p = running.participants[1];
      const speech = new SpeechService(h.repo, h.gateway);
      const m = await speech.speak(running, p.id, 'expert', new AbortController().signal);
      expect(m.content).not.toContain('第三句');
      expect(attempts).toBe(2);
      expect(h.repo.snapshot(id).messages).toHaveLength(1);
      expect(h.repo.snapshot(id).participants.find((x) => x.id === p.id)?.status).toBe('idle');
    } finally {
      await h.close();
    }
  });
});
