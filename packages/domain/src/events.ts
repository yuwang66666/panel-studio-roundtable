import type { DiscussionSnapshot, PublicEvent } from '@panel/contracts';
export function projectEvent(s: DiscussionSnapshot, event: PublicEvent): DiscussionSnapshot | null {
  if (event.discussionId !== s.discussion.id || event.seq <= s.lastEventSeq) return s;
  if (event.seq !== s.lastEventSeq + 1) return null;
  const next = { ...s, lastEventSeq: event.seq };
  switch (event.type) {
    case 'cast.ready':
      return { ...next, ...event.payload };
    case 'discussion.status_changed':
    case 'discussion.failed':
      return { ...next, discussion: event.payload.discussion };
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
        messages: s.messages.some((m) => m.id === event.payload.message.id)
          ? s.messages
          : [...s.messages, event.payload.message],
      };
    case 'insights.updated':
      return { ...next, discussion: event.payload.discussion, insights: event.payload.insights };
  }
}
