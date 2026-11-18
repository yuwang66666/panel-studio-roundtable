import { describe, expect, it } from 'vitest';
import { buildLocalSummary } from '../packages/domain/src/local-summary';
import { makeSample } from '../packages/domain/src/samples';

describe('本地整理摘要', () => {
  it('quotes every saved expert statement with its real sequence and retains verified evidence', () => {
    const s = makeSample(0);
    const summary = buildLocalSummary(s);
    expect(summary).toMatch(/^本地整理摘要/);
    expect(summary).toContain(s.discussion.topic);
    for (const m of s.messages.filter((m) => m.kind === 'expert')) {
      expect(summary).toContain(m.content);
      expect(summary).toContain(`（发言 #${m.messageSeq}）`);
    }
    expect(summary).toContain('局部共识；明确支持者：陈知远、周以宁、沈若衡');
    expect(summary).toContain('依据：发言 #2、发言 #4、发言 #5');
    expect(summary).toContain(s.insights.find((i) => i.kind === 'divergence')!.text);
    expect(summary).toContain(s.insights.find((i) => i.kind === 'open_question')!.text);
    expect(summary).not.toContain(s.messages.at(-1)!.content);
  });

  it('does not treat a silent expert as supporting an agreement or invent an absent dispute', () => {
    const s = makeSample(0);
    s.messages = s.messages.filter((m) => m.participantId !== s.participants[4].id);
    s.insights = [];
    const summary = buildLocalSummary(s);
    expect(summary).toContain('沈若衡（社会视角）\n尚未发言');
    expect(summary).toContain('尚无已核验共识记录');
    expect(summary).toContain('尚无已核验分歧记录，不代表各方已达成一致');
    expect(summary).not.toContain('全体共识；');
  });

  it('states incomplete insight coverage and still includes the final saved opinion', () => {
    const s = makeSample(0);
    s.discussion.insightsThrough = 3;
    s.insights[0].text = 'UNVERIFIED_LATE_INSIGHT';
    const summary = buildLocalSummary(s);
    expect(summary).toContain('洞察仅覆盖前3条发言，后续观点见发言摘录');
    expect(summary).not.toContain('UNVERIFIED_LATE_INSIGHT');
    expect(summary).toContain(s.messages[4].content);
    expect(summary).toContain('发言 #5');
  });

  it('excludes drafts, old summaries, foreign actors and foreign evidence', () => {
    const s = makeSample(0);
    s.draft = {
      turnId: 'draft',
      discussionId: s.discussion.id,
      participantId: s.participants[1].id,
      generation: s.discussion.generation,
      kind: 'expert',
      content: 'PRIVATE_DRAFT',
      replyToMessageId: null,
      startedAt: '',
    };
    s.messages.at(-1)!.content = 'OLD_SUMMARY';
    s.messages.push({
      ...s.messages[1],
      id: 'foreign',
      discussionId: 'another',
      content: 'FOREIGN_MESSAGE',
    });
    s.participants.push({
      ...s.participants[1],
      id: 'foreign-actor',
      discussionId: 'another',
      name: 'FOREIGN_ACTOR',
    });
    s.messages.push({
      ...s.messages[1],
      id: 'bad-actor',
      participantId: 'foreign-actor',
      content: 'FOREIGN_ACTOR_MESSAGE',
    });
    s.insights.push({
      ...s.insights[0],
      id: 'foreign-insight',
      text: 'FOREIGN_INSIGHT',
      evidence: [{ messageId: 'foreign', relation: 'supports' }],
    });
    const summary = buildLocalSummary(s);
    for (const hidden of [
      'PRIVATE_DRAFT',
      'OLD_SUMMARY',
      'FOREIGN_MESSAGE',
      'FOREIGN_ACTOR',
      'FOREIGN_INSIGHT',
    ])
      expect(summary).not.toContain(hidden);
  });

  it('rejects unsupported all-panel consensus even when the insight claims it is verified', () => {
    const s = makeSample(0);
    s.insights[0] = { ...s.insights[0], scope: 'all', text: 'UNSUPPORTED_ALL_PANEL' };
    const summary = buildLocalSummary(s);
    expect(summary).not.toContain('UNSUPPORTED_ALL_PANEL');
    expect(summary).toContain('尚无已核验共识记录');
  });

  it('marks excerpts and keeps references and the last message when a saved item is oversized', () => {
    const s = makeSample(0);
    s.messages[0].content = '开'.repeat(300);
    s.messages[1].content = '长'.repeat(500);
    s.insights[0].text = '共'.repeat(300);
    const summary = buildLocalSummary(s);
    expect(summary).toContain(`${'长'.repeat(400)}…（节选）”（发言 #2）`);
    expect(summary).toContain(`${'开'.repeat(180)}…（节选）”（发言 #1）`);
    expect(summary).toContain(`${'共'.repeat(240)}…（节选）`);
    expect(summary).toContain(s.messages[4].content);
    expect(summary).toContain('（发言 #5）');
  });

  it('reports an empty transcript without manufacturing content from a previous summary', () => {
    const s = makeSample(0);
    s.messages = s.messages.filter((m) => m.kind === 'summary');
    const summary = buildLocalSummary(s);
    expect(summary).toContain('当前没有已保存的有效发言');
    expect(summary).not.toContain(s.insights[0].text);
    expect(summary).not.toContain(s.messages[0].content);
  });
});
