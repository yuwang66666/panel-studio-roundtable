import type { DiscussionSnapshot, Insight, Message } from '@panel/contracts';
import { validateInsightEvidence } from './insights';

function excerpt(value: string, limit: number) {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…（节选）` : text;
}

/** An extractive record of saved speech. It does not invent new agreements or arguments. */
export function buildLocalSummary(s: DiscussionSnapshot): string {
  const participants = s.participants.filter((p) => p.discussionId === s.discussion.id);
  const actors = new Map(participants.map((p) => [p.id, p]));
  const messages = s.messages
    .filter(
      (m) =>
        m.discussionId === s.discussion.id &&
        m.kind !== 'summary' &&
        m.content.trim() &&
        actors.has(m.participantId) &&
        (m.kind === 'expert') === (actors.get(m.participantId)!.role === 'expert'),
    )
    .sort((a, b) => a.messageSeq - b.messageSeq);
  const last = messages.at(-1)?.messageSeq || 0;
  const through = Math.min(s.discussion.insightsThrough, last);
  const byId = new Map(messages.map((m) => [m.id, m]));
  const verified: Insight[] = s.insights.filter((insight) => {
    if (insight.throughMessageSeq > through) return false;
    try {
      validateInsightEvidence(
        { ...s, participants, messages },
        [insight],
        insight.throughMessageSeq,
      );
      return true;
    } catch {
      return false;
    }
  });
  const lines = [
    '本地整理摘要',
    '',
    `主题：${excerpt(s.discussion.topic, 500)}`,
    '根据已保存发言与已核验洞察整理；观点摘录保持原发言归属。',
  ];
  if (!messages.length) {
    lines.push('', '当前没有已保存的有效发言，尚无法整理专家观点、共识或分歧。');
    return lines.join('\n');
  }
  lines.push(`整理覆盖截至发言 #${last} 的全部已保存发言。`);
  if (through < last)
    lines.push(`洞察仅覆盖前${through}条发言，后续观点见发言摘录；未进一步推断共识或分歧。`);
  const cite = (m: Message, limit: number) =>
    `“${excerpt(m.content, limit)}”（发言 #${m.messageSeq}）`;
  const hostMessages = messages.filter((m) => m.kind !== 'expert');
  if (hostMessages.length) {
    lines.push('', '主持人问题与引导');
    for (const m of hostMessages)
      lines.push(`${actors.get(m.participantId)!.name}：${cite(m, 180)}`);
  }
  lines.push('', '专家观点摘录');
  for (const participant of participants.filter((p) => p.role === 'expert')) {
    const spoken = messages.filter(
      (m) => m.participantId === participant.id && m.kind === 'expert',
    );
    lines.push(`${participant.name}（${participant.title}）`);
    if (!spoken.length) lines.push('尚未发言，不据此推断其立场或是否支持其他观点。');
    else for (const m of spoken) lines.push(cite(m, 400));
  }
  for (const [kind, heading, empty] of [
    ['consensus', '已核验共识', '尚无已核验共识记录。'],
    ['divergence', '已记录分歧', '尚无已核验分歧记录，不代表各方已达成一致。'],
    ['open_question', '待解问题', '尚无已核验的待解问题记录。'],
  ] as const) {
    lines.push('', heading);
    const insights = verified.filter((i) => i.kind === kind);
    if (!insights.length) lines.push(empty);
    for (const insight of insights) {
      const evidence = [...new Set(insight.evidence.map((e) => byId.get(e.messageId)!.messageSeq))]
        .sort((a, b) => a - b)
        .map((seq) => `发言 #${seq}`)
        .join('、');
      const supporters = insight.participantIds.map((id) => actors.get(id)!.name).join('、');
      const scope =
        kind === 'consensus'
          ? `${insight.scope === 'all' ? '全体共识' : '局部共识'}；明确支持者：${supporters}。`
          : '';
      lines.push(`${excerpt(insight.text, 240)} ${scope}（依据：${evidence}）`);
    }
  }
  return lines.join('\n');
}
