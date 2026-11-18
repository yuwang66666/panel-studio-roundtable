import { randomUUID } from 'node:crypto';
import {
  UtteranceOutputSchema,
  ProseOutputSchema,
  type Message,
  type DiscussionSnapshot,
} from '@panel/contracts';
import { buildContext, validShortUtterance } from '../../../packages/domain/src/context';
import { AppError } from './errors';
import type { Repository } from './repository';
import type { ModelGateway } from './gateway';
import { openSpeechDraft } from './speech-draft';
export class SpeechService {
  constructor(
    private repo: Repository,
    private gateway: ModelGateway,
  ) {}
  async speak(
    s: DiscussionSnapshot,
    participantId: string,
    kind: Exclude<Message['kind'], 'summary'>,
    signal: AbortSignal,
    options: { targetMessageId?: string | null; focus?: string | null; turnId?: string } = {},
  ) {
    const d = s.discussion,
      generation = d.generation,
      target = options.targetMessageId || null,
      through = s.messages.at(-1)?.messageSeq || 0;
    const context = buildContext(s, participantId, through, target),
      connection = this.repo.actorConnection(d.id, participantId);
    const turnId = options.turnId || randomUUID();
    const draft = openSpeechDraft(
      this.repo,
      d.id,
      generation,
      { turnId, participantId, kind, replyToMessageId: target },
      signal,
    );
    try {
      this.repo.setParticipantState(
        d.id,
        generation,
        participantId,
        'preparing',
        options.focus || null,
      );
      this.repo.setParticipantState(
        d.id,
        generation,
        participantId,
        'speaking',
        options.focus || null,
      );
      let content: string;
      if (kind === 'expert') {
        const output = await this.gateway.generate({
          connection,
          purpose: 'utterance',
          discussionId: d.id,
          participantId,
          generation,
          signal,
          onText: draft.onText,
          input: { context, focus: options.focus },
          schema: UtteranceOutputSchema,
          validate: (r) => {
            if (!validShortUtterance(r.sentences))
              throw new AppError('INVALID_OUTPUT', '专家发言必须为1–2个简短句子', 502);
          },
        });
        content = output.sentences.join('');
      } else {
        const output = await this.gateway.generate({
          connection,
          purpose: kind,
          discussionId: d.id,
          participantId,
          generation,
          signal,
          onText: draft.onText,
          input: { context },
          schema: ProseOutputSchema,
        });
        content = output.content;
      }
      if (signal.aborted) throw new AppError('CANCELLED', '发言已取消', 409);
      return this.repo.appendMessage(d.id, generation, {
        turnId,
        participantId,
        kind,
        content,
        replyToMessageId: target,
      });
    } finally {
      draft.close();
      const current = this.repo.discussion(d.id);
      if (current.generation === generation && ['running', 'summarizing'].includes(current.status))
        this.repo.setParticipantState(d.id, generation, participantId, 'idle', null);
    }
  }
}
