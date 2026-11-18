import { PublicEventSchema } from '../packages/contracts/src/index';
import type { Repository } from '../apps/api/src/repository';

/** Project persisted public events, excluding drafts and internal model decisions. */
export function realCaseEvents(db: Repository['db'], id: string) {
  const rows = db
    .prepare('SELECT data_json FROM discussion_events WHERE discussion_id=? ORDER BY event_seq')
    .all(id) as { data_json: string }[];
  const events = rows.map((row) => PublicEventSchema.parse(JSON.parse(row.data_json)));
  const states = new Set<string>();
  let nonemptyDraftUpdates = 0;
  const timeline: unknown[] = [];
  for (const event of events) {
    if (event.type === 'participant.state_changed') states.add(event.payload.status);
    if (event.type === 'speech.updated' && event.payload.draft.content.trim())
      nonemptyDraftUpdates++;
    if (event.type === 'insights.updated')
      timeline.push({
        seq: event.seq,
        type: event.type,
        occurredAt: event.occurredAt,
        status: event.payload.discussion.status,
        throughMessageSeq: event.payload.discussion.insightsThrough,
        insights: event.payload.insights,
      });
    if (event.type === 'message.committed' || event.type === 'summary.ready')
      timeline.push({
        seq: event.seq,
        type: event.type,
        occurredAt: event.occurredAt,
        messageId: event.payload.message.id,
        messageSeq: event.payload.message.messageSeq,
      });
    if (event.type === 'discussion.status_changed' || event.type === 'discussion.failed')
      timeline.push({
        seq: event.seq,
        type: event.type,
        occurredAt: event.occurredAt,
        status: event.payload.discussion.status,
      });
  }
  return {
    totalEvents: events.length,
    participantStatesObserved: [...states].sort(),
    nonemptyDraftUpdates,
    timeline,
  };
}
