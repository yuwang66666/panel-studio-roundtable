import type { SpeechDraft } from '@panel/contracts';
import type { Repository } from './repository';
import { AppError } from './errors';

export function openSpeechDraft(
  repo: Repository,
  id: string,
  generation: number,
  input: Pick<SpeechDraft, 'turnId' | 'participantId' | 'kind' | 'replyToMessageId'>,
  signal: AbortSignal,
) {
  if (signal.aborted) throw new AppError('CANCELLED', '流式发言已取消', 409);
  repo.beginSpeechDraft(id, generation, input);
  let lastSentAt = 0,
    lastText = '';
  return {
    onText(text: string) {
      if (signal.aborted) throw new AppError('CANCELLED', '流式发言已取消', 409);
      const content = text.slice(0, input.kind === 'expert' ? 400 : 6000);
      if (!content) lastSentAt = 0;
      if (content === lastText || (content && Date.now() - lastSentAt < 100)) return;
      repo.updateSpeechDraft(id, generation, input.turnId, content);
      lastText = content;
      lastSentAt = content ? Date.now() : 0;
    },
    close() {
      repo.clearSpeechDraft(id, generation, input.turnId);
    },
  };
}
