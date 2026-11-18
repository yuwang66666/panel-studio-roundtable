import { IntentSchema, type Intent, type Message } from '@panel/contracts';
import { buildContext } from '../../../packages/domain/src/context';
import { validIntents, selectNextSpeaker } from '../../../packages/domain/src/scheduler';
import { buildParticipantFocus } from '../../../packages/domain/src/participant-focus';
import type { Repository } from './repository';
import type { ModelGateway } from './gateway';
import { SpeechService } from './speech';
import { AppError } from './errors';
export interface InsightsPort {
  onMessage(
    id: string,
    generation: number,
    message: Message,
    rebut: boolean,
    signal: AbortSignal,
  ): void;
  finish(id: string, generation: number, signal: AbortSignal): Promise<void>;
}
export class DiscussionEngine {
  private speech: SpeechService;
  constructor(
    private repo: Repository,
    private gateway: ModelGateway,
    private insights: InsightsPort,
  ) {
    this.speech = new SpeechService(repo, gateway);
  }
  async run(id: string, signal: AbortSignal) {
    const generation = this.repo.discussion(id).generation;
    try {
      await this.execute(id, signal);
    } finally {
      // A cancelled or failed round must not leave experts preparing indefinitely.
      if (this.repo.discussion(id).generation === generation) this.repo.clearStates(id);
    }
  }
  private async execute(id: string, signal: AbortSignal) {
    let s = this.repo.snapshot(id);
    const generation = s.discussion.generation,
      host = s.participants.find((p) => p.role === 'moderator')!;
    const waits: Record<string, number> = {};
    let emptyRounds = 0,
      failureRounds = 0,
      previousFocus: string | null = null,
      repeatedFocus = 0,
      lastProbeAt = 0;
    if (!s.messages.length && !s.discussion.finishRequested)
      await this.speech.speak(s, host.id, 'opening', signal);
    while (!signal.aborted) {
      s = this.repo.snapshot(id);
      const d = this.repo.guard(id, generation, ['running']),
        expertMessages = s.messages.filter((m) => m.kind === 'expert');
      if (
        d.finishRequested ||
        expertMessages.length >= d.maxUtterances ||
        d.maxCalls - d.callCount < d.expertCount + 1 + 12
      )
        break;
      const moderatorCount = s.messages.filter(
        (m) => m.kind === 'opening' || m.kind === 'probe',
      ).length;
      if (
        moderatorCount < 4 &&
        (repeatedFocus >= 3 ||
          (s.insights.some((i) => i.kind === 'divergence' && i.status !== 'resolved') &&
            expertMessages.length - lastProbeAt >= 3))
      ) {
        try {
          const probe = await this.speech.speak(s, host.id, 'probe', signal);
          this.insights.onMessage(id, generation, probe, false, signal);
        } catch (e) {
          if (e instanceof AppError && ['BUDGET', 'CANCELLED'].includes(e.code)) break;
          throw e;
        }
        repeatedFocus = 0;
        lastProbeAt = expertMessages.length;
        continue;
      }
      const through = s.messages.at(-1)?.messageSeq || 0;
      const results = await Promise.allSettled(
        s.participants
          .filter((p) => p.role === 'expert')
          .map(async (p) => {
            try {
              if (signal.aborted) throw new AppError('CANCELLED', '参与判断已取消', 409);
              this.repo.setParticipantState(
                id,
                generation,
                p.id,
                'preparing',
                buildParticipantFocus(s, p.id, 'assessing'),
              );
              const context = buildContext(s, p.id, through),
                connection = this.repo.actorConnection(id, p.id);
              const output = await this.gateway.generate({
                connection,
                purpose: 'intent',
                input: { context },
                schema: IntentSchema,
                discussionId: id,
                participantId: p.id,
                generation,
                signal,
              });
              if (signal.aborted) throw new AppError('CANCELLED', '参与判断已取消', 409);
              const current = this.repo.guard(id, generation, ['running']);
              const intent = {
                ...output,
                participantId: p.id,
                basedOnMessageSeq: through,
              } satisfies Intent;
              const waiting =
                !current.finishRequested && validIntents([intent], s.messages, through).length > 0;
              this.repo.setParticipantState(
                id,
                generation,
                p.id,
                waiting ? 'preparing' : 'idle',
                waiting ? buildParticipantFocus(s, p.id, 'waiting', intent.targetMessageId) : null,
              );
              return intent;
            } catch (error) {
              const current = this.repo.discussion(id);
              if (current.generation === generation && current.status === 'running')
                this.repo.setParticipantState(id, generation, p.id, 'idle', null);
              throw error;
            }
          }),
      );
      if (signal.aborted) throw new AppError('CANCELLED', '参与判断已取消', 409);
      this.repo.guard(id, generation, ['running']);
      if (this.repo.discussion(id).finishRequested) break;
      const intents = results
        .filter((r): r is PromiseFulfilledResult<Intent> => r.status === 'fulfilled')
        .map((r) => r.value);
      if (!intents.length) {
        if (++failureRounds >= 3)
          throw new AppError('MODEL_FAILURE', '多个模型连续调用失败，已有讨论内容已保存', 502);
        continue;
      }
      const chosen = selectNextSpeaker(intents, s.messages, through, waits, previousFocus);
      for (const p of s.participants.filter((p) => p.role === 'expert'))
        if (p.id !== chosen?.participantId)
          this.repo.setParticipantState(id, generation, p.id, 'idle', null);
      if (!chosen) {
        if (
          emptyRounds >= 2 ||
          s.messages.filter((m) => m.kind === 'opening' || m.kind === 'probe').length >= 4
        )
          break;
        emptyRounds++;
        try {
          const m = await this.speech.speak(s, host.id, 'probe', signal);
          this.insights.onMessage(id, generation, m, false, signal);
        } catch (e) {
          if (e instanceof AppError && ['BUDGET', 'CANCELLED'].includes(e.code)) break;
          throw e;
        }
        continue;
      }
      for (const i of validIntents(intents, s.messages, through))
        waits[i.participantId] =
          i.participantId === chosen.participantId ? 0 : (waits[i.participantId] || 0) + 1;
      emptyRounds = 0;
      try {
        const message = await this.speech.speak(s, chosen.participantId, 'expert', signal, {
          targetMessageId: chosen.targetMessageId,
          focus: chosen.proposedFocus,
        });
        failureRounds = 0;
        repeatedFocus =
          chosen.proposedFocus && chosen.proposedFocus === previousFocus ? repeatedFocus + 1 : 1;
        previousFocus = chosen.proposedFocus;
        this.insights.onMessage(id, generation, message, chosen.action === 'rebut', signal);
      } catch (e) {
        if (e instanceof AppError && ['BUDGET', 'CANCELLED'].includes(e.code)) break;
        if (++failureRounds >= 3)
          throw new AppError('MODEL_FAILURE', '专家发言连续未能通过验证，已有内容已保存', 502);
      }
    }
    if (signal.aborted) throw new AppError('CANCELLED', '讨论已中断', 409);
    this.repo.clearStates(id);
    this.repo.transition(id, 'summarizing', { generation });
    await this.insights.finish(id, generation, signal);
  }
}
