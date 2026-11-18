import type { Discussion, DiscussionSnapshot, PublicEvent, SpeechDraft } from '@panel/contracts';
function retainDraft(discussion: Discussion, draft: SpeechDraft | null) {
  return draft &&
    draft.discussionId === discussion.id &&
    draft.generation === discussion.generation &&
    (draft.kind === 'summary'
      ? discussion.status === 'summarizing'
      : discussion.status === 'running')
    ? draft
    : null;
}
export function projectEvent(s: DiscussionSnapshot, event: PublicEvent): DiscussionSnapshot | null {
  if (event.discussionId !== s.discussion.id || event.seq <= s.lastEventSeq) return s;
  if (event.seq !== s.lastEventSeq + 1) return null;
  const next = { ...s, lastEventSeq: event.seq };
  switch (event.type) {
    case 'cast.ready':
      return { ...next, ...event.payload, draft: retainDraft(event.payload.discussion, s.draft) };
    case 'discussion.status_changed':
    case 'discussion.failed':
      return {
        ...next,
        discussion: event.payload.discussion,
        draft: retainDraft(event.payload.discussion, s.draft),
      };
    case 'speech.updated': {
      const draft = retainDraft(s.discussion, event.payload.draft);
      if (
        !draft ||
        !s.participants.some(
          (p) =>
            p.id === draft.participantId && (draft.kind === 'expert') === (p.role === 'expert'),
        ) ||
        s.messages.some((m) => m.turnId === draft.turnId)
      )
        return next;
      return { ...next, draft };
    }
    case 'speech.cleared':
      return { ...next, draft: s.draft?.turnId === event.payload.turnId ? null : s.draft };
    case 'participant.state_changed':
      return {
        ...next,
        participants: s.participants.map((p) =>
          p.id === event.payload.participantId
            ? { ...p, status: event.payload.status, publicFocus: event.payload.publicFocus }
            : p,
        ),
      };
    case 'message.committed':
    case 'summary.ready':
      return {
        ...next,
        discussion: event.payload.discussion,
        draft:
          s.draft?.turnId === event.payload.message.turnId
            ? null
            : retainDraft(event.payload.discussion, s.draft),
        messages: s.messages.some(
          (m) => m.id === event.payload.message.id || m.turnId === event.payload.message.turnId,
        )
          ? s.messages
          : [...s.messages, event.payload.message],
      };
    case 'insights.updated':
      return { ...next, discussion: event.payload.discussion, insights: event.payload.insights };
  }
}
