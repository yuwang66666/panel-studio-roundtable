import { describe, expect, it } from 'vitest';
import { buildParticipantFocus } from '../packages/domain/src/participant-focus';
import { makeSample } from '../packages/domain/src/samples';

describe('专家公开关注点边界', () => {
  it('uses the current expert’s public specialty and the last committed speech boundary', () => {
    const snapshot = makeSample(0);
    snapshot.participants[1].specialty = ['长期就业'];
    snapshot.participants[2].specialty = ['教育公平'];
    snapshot.messages.reverse();
    const before = structuredClone(snapshot);
    expect(buildParticipantFocus(snapshot, 'sample-1-p1', 'assessing')).toBe(
      '正在阅读截至第 5 条发言，关注长期就业。',
    );
    expect(buildParticipantFocus(snapshot, 'sample-1-p2', 'assessing')).toContain('教育公平');
    expect(snapshot).toEqual(before);
  });

  it('describes the actual response reference without copying the transcript text', () => {
    const snapshot = makeSample(0);
    const target = snapshot.messages[1];
    expect(buildParticipantFocus(snapshot, 'sample-1-p2', 'waiting', target.id)).toBe(
      '准备回应第 2 条发言，关注岗位转型。',
    );
    const speaking = buildParticipantFocus(snapshot, 'sample-1-p2', 'speaking', target.id);
    expect(speaking).toBe('正在回应第 2 条发言，关注岗位转型。');
    expect(speaking).not.toContain(target.content);
    expect(buildParticipantFocus(snapshot, 'sample-1-p2', 'waiting')).toBe(
      '准备从岗位转型补充新观点。',
    );
  });

  it('describes moderator work separately and handles a discussion without speech', () => {
    const snapshot = makeSample(0);
    expect(buildParticipantFocus(snapshot, 'sample-1-p0', 'assessing')).toContain('梳理公开观点');
    expect(buildParticipantFocus(snapshot, 'sample-1-p0', 'waiting', 'sample-1-m2')).toBe(
      '准备围绕第 2 条发言追问与串联。',
    );
    expect(buildParticipantFocus(snapshot, 'sample-1-p0', 'speaking')).toBe(
      '正在串联已公开的观点。',
    );
    snapshot.messages = [];
    expect(buildParticipantFocus(snapshot, 'sample-1-p0', 'waiting')).toBe('准备介绍本场话题。');
    expect(buildParticipantFocus(snapshot, 'sample-1-p1', 'assessing')).toBe(
      '正在结合岗位转型梳理话题。',
    );
  });

  it.each(['missing', 'sample-1-m6', 'foreign-message'])('rejects invalid target %s', (target) => {
    const snapshot = makeSample(0);
    snapshot.messages.push({
      ...snapshot.messages[1],
      id: 'foreign-message',
      discussionId: 'other',
    });
    expect(() => buildParticipantFocus(snapshot, 'sample-1-p1', 'waiting', target)).toThrow(
      '回应目标不属于当前讨论的正式发言',
    );
  });

  it('rejects a participant or message actor belonging to another discussion', () => {
    const snapshot = makeSample(0);
    snapshot.participants[1].discussionId = 'other';
    expect(() => buildParticipantFocus(snapshot, 'sample-1-p1', 'assessing')).toThrow(
      '参与者不属于当前讨论',
    );
    expect(() => buildParticipantFocus(snapshot, 'sample-1-p2', 'waiting', 'sample-1-m2')).toThrow(
      '回应目标不属于当前讨论的正式发言',
    );
  });

  it('normalizes whitespace and controls while retaining a short public specialty label', () => {
    const snapshot = makeSample(0);
    snapshot.participants[1].specialty = ['  AI\n\t伦理\u202e\u0000  '];
    const focus = buildParticipantFocus(snapshot, 'sample-1-p1', 'assessing');
    expect(focus).toBe('正在阅读截至第 5 条发言，关注AI 伦理。');
    expect(focus).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(focus.length).toBeLessThanOrEqual(120);
  });

  it('does not treat JSON, code, HTML or long paragraphs as a specialty label', () => {
    const snapshot = makeSample(0);
    const expert = snapshot.participants[1];
    expert.specialty = [
      '{"reasoning":"PRIVATE_JSON"}',
      '```json PRIVATE_CODE',
      '<think>PRIVATE_MARKUP</think>',
      '这是一大段并非专业标签的文本。'.repeat(30),
    ];
    expert.title = '产业研究';
    expect(buildParticipantFocus(snapshot, expert.id, 'waiting')).toBe(
      '准备从产业研究补充新观点。',
    );
    expert.title = '标题'.repeat(50);
    expert.occupation = '职业'.repeat(50);
    const fallback = buildParticipantFocus(snapshot, expert.id, 'speaking');
    expect(fallback).toBe('正在从专业视角阐述观点。');
    expect(fallback.length).toBeLessThanOrEqual(120);
    expect(fallback).not.toMatch(/PRIVATE|[{}<>`]/);
  });

  it('never reads intent, reasoning, stale public focus, transcript bodies or draft text', () => {
    const snapshot = makeSample(0);
    const expert = snapshot.participants[1];
    Object.assign(snapshot, { proposedFocus: 'PRIVATE_INTENT', reasoning: 'PRIVATE_REASONING' });
    Object.assign(expert, { proposedFocus: 'PRIVATE_ACTOR_INTENT', thinking: 'PRIVATE_THINKING' });
    expert.publicFocus = 'PRIVATE_STALE_FOCUS';
    snapshot.discussion.topic = 'PRIVATE_TOPIC_BODY';
    for (const message of snapshot.messages) message.content = 'PRIVATE_TRANSCRIPT_BODY';
    snapshot.draft = {
      turnId: 'draft',
      discussionId: snapshot.discussion.id,
      participantId: expert.id,
      generation: 1,
      kind: 'expert',
      content: 'PRIVATE_DRAFT',
      replyToMessageId: null,
      startedAt: '',
    };
    for (const phase of ['assessing', 'waiting', 'speaking'] as const) {
      const focus = buildParticipantFocus(snapshot, expert.id, phase, 'sample-1-m2');
      expect(focus).not.toContain('PRIVATE');
      expect(focus.length).toBeLessThanOrEqual(120);
    }
  });

  it('ignores foreign and summary sequences when describing the current reading boundary', () => {
    const snapshot = makeSample(0);
    snapshot.messages.push({
      ...snapshot.messages[1],
      id: 'foreign',
      discussionId: 'other',
      messageSeq: 999,
    });
    snapshot.messages.at(-2)!.messageSeq = 1000;
    expect(buildParticipantFocus(snapshot, 'sample-1-p1', 'assessing')).toContain('第 5 条发言');
  });
});
