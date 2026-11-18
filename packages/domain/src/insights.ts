import type { DiscussionSnapshot, Insight } from '@panel/contracts';
export function validateInsightEvidence(
  s: DiscussionSnapshot,
  insights: Omit<Insight, 'revision' | 'throughMessageSeq'>[],
  through: number,
) {
  const messages = new Map(
      s.messages
        .filter((m) => m.kind !== 'summary' && m.messageSeq <= through)
        .map((m) => [m.id, m]),
    ),
    experts = new Set(s.participants.filter((p) => p.role === 'expert').map((p) => p.id));
  if (new Set(insights.map((i) => i.id)).size !== insights.length) throw Error('洞察标识重复');
  for (const i of insights) {
    if (!i.evidence.length || i.evidence.some((e) => !messages.has(e.messageId)))
      throw Error('洞察必须引用已提供的发言');
    if (
      new Set(i.participantIds).size !== i.participantIds.length ||
      i.participantIds.some((id) => !experts.has(id))
    )
      throw Error('洞察专家引用无效');
    const support = new Set(
      i.evidence
        .filter((e) => e.relation === 'supports')
        .map((e) => messages.get(e.messageId)!.participantId)
        .filter((id) => experts.has(id)),
    );
    if (i.kind === 'consensus') {
      if (
        support.size < 2 ||
        support.size !== i.participantIds.length ||
        i.participantIds.some((id) => !support.has(id))
      )
        throw Error('共识需要至少两位专家明确支持');
      if (i.scope === null || (i.scope === 'all' && support.size !== experts.size))
        throw Error('共识范围与证据不匹配');
    } else if (i.scope !== null) throw Error('只有共识可声明共识范围');
    if (
      i.kind === 'divergence' &&
      new Set(
        i.evidence
          .map((e) => messages.get(e.messageId)!.participantId)
          .filter((id) => experts.has(id)),
      ).size < 2
    )
      throw Error('分歧需要至少两位专家的发言');
  }
}
