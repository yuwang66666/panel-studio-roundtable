import type { DiscussionSnapshot } from '@panel/contracts';

export type ParticipantFocusPhase = 'assessing' | 'waiting' | 'speaking';

function publicLabel(value: string): string | null {
  const label = value
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  // These are short, already-public role labels, never paragraphs or model response payloads.
  if (!label || label.length > 32 || /[{}\[\]<>`"“”:\uFF1A。！？!?；;]/u.test(label)) return null;
  return label;
}

/** Build a public activity cue from saved role labels and committed transcript references only. */
export function buildParticipantFocus(
  snapshot: DiscussionSnapshot,
  participantId: string,
  phase: ParticipantFocusPhase,
  targetMessageId: string | null = null,
): string {
  const discussionId = snapshot.discussion.id;
  const participants = snapshot.participants.filter((p) => p.discussionId === discussionId);
  const participant = participants.find((p) => p.id === participantId);
  if (!participant) throw Error('参与者不属于当前讨论');
  const participantIds = new Set(participants.map((p) => p.id));
  const messages = snapshot.messages.filter(
    (m) =>
      m.discussionId === discussionId &&
      m.kind !== 'summary' &&
      participantIds.has(m.participantId) &&
      Number.isSafeInteger(m.messageSeq) &&
      m.messageSeq > 0,
  );
  const target = targetMessageId ? messages.find((m) => m.id === targetMessageId) : undefined;
  if (targetMessageId && !target) throw Error('回应目标不属于当前讨论的正式发言');
  const through = Math.max(0, ...messages.map((m) => m.messageSeq));
  const direction =
    [...participant.specialty, participant.title, participant.occupation]
      .map(publicLabel)
      .find((label): label is string => label !== null) || '专业视角';

  if (participant.role === 'moderator') {
    if (phase === 'assessing')
      return through
        ? `正在阅读截至第 ${through} 条发言，梳理公开观点。`
        : '正在梳理本场话题与不同专业视角。';
    if (target)
      return phase === 'waiting'
        ? `准备围绕第 ${target.messageSeq} 条发言追问与串联。`
        : `正在围绕第 ${target.messageSeq} 条发言追问与串联。`;
    if (!through) return phase === 'waiting' ? '准备介绍本场话题。' : '正在介绍本场话题。';
    return phase === 'waiting' ? '准备串联已公开的观点。' : '正在串联已公开的观点。';
  }
  if (phase === 'assessing')
    return through
      ? `正在阅读截至第 ${through} 条发言，关注${direction}。`
      : `正在结合${direction}梳理话题。`;
  if (target)
    return phase === 'waiting'
      ? `准备回应第 ${target.messageSeq} 条发言，关注${direction}。`
      : `正在回应第 ${target.messageSeq} 条发言，关注${direction}。`;
  return phase === 'waiting' ? `准备从${direction}补充新观点。` : `正在从${direction}阐述观点。`;
}
