import { randomUUID } from 'node:crypto';
import { InsightOutputSchema, ProseOutputSchema, type Message } from '@panel/contracts';
import { validateInsightEvidence } from '../../../packages/domain/src/insights';
import type { Repository } from './repository';
import type { ModelGateway } from './gateway';
import type { InsightsPort } from './engine';
import { AppError } from './errors';
import { openSpeechDraft } from './speech-draft';
type Job = { generation: number; pending: boolean; promise: Promise<void>; error: unknown };
export class InsightsService implements InsightsPort {
  private jobs = new Map<string, Job>();
  constructor(
    private repo: Repository,
    private gateway: ModelGateway,
  ) {}
  onMessage(
    id: string,
    generation: number,
    _message: Message,
    rebut: boolean,
    signal: AbortSignal,
  ) {
    const s = this.repo.snapshot(id),
      newExperts = s.messages.filter(
        (m) => m.kind === 'expert' && m.messageSeq > s.discussion.insightsThrough,
      ).length;
    if (newExperts >= 3 || rebut) this.schedule(id, generation, signal);
  }
  private schedule(id: string, generation: number, signal: AbortSignal) {
    const existing = this.jobs.get(id);
    if (existing && existing.generation === generation) {
      existing.pending = true;
      return existing.promise;
    }
    const job: Job = { generation, pending: true, promise: Promise.resolve(), error: null };
    job.promise = Promise.resolve()
      .then(async () => {
        while (job.pending && !signal.aborted) {
          job.pending = false;
          await this.update(id, generation, signal);
        }
      })
      .catch((e) => {
        job.error = e;
      })
      .finally(() => {
        if (this.jobs.get(id) === job) this.jobs.delete(id);
      });
    this.jobs.set(id, job);
    return job.promise;
  }
  async update(id: string, generation: number, signal: AbortSignal) {
    const s = this.repo.snapshot(id);
    this.repo.guard(id, generation, ['running', 'summarizing']);
    const messages = s.messages.filter((m) => m.kind !== 'summary'),
      through = messages.at(-1)?.messageSeq || 0;
    if (s.discussion.insightsThrough >= through) return;
    const moderator = s.participants.find((p) => p.role === 'moderator')!;
    const context = {
      topic: s.discussion.topic,
      participants: s.participants,
      messages,
      insights: s.insights,
      throughMessageSeq: through,
    };
    const output = await this.gateway.generate({
      connection: this.repo.hostConnection(id),
      purpose: 'insights',
      discussionId: id,
      participantId: moderator.id,
      generation,
      signal,
      input: { context },
      schema: InsightOutputSchema,
      validate: (r) => validateInsightEvidence(s, r.insights, through),
    });
    if (signal.aborted) throw new AppError('CANCELLED', '洞察任务已取消', 409);
    this.repo.saveInsights(
      id,
      generation,
      through,
      output.insights.map((i) => ({
        ...i,
        revision: (s.insights.find((old) => old.id === i.id)?.revision || 0) + 1,
        throughMessageSeq: through,
      })),
    );
  }
  async finish(id: string, generation: number, signal: AbortSignal) {
    await this.jobs.get(id)?.promise;
    const pending = this.repo.snapshot(id),
      last = pending.messages.filter((m) => m.kind !== 'summary').at(-1)?.messageSeq || 0;
    if (pending.discussion.insightsThrough < last) {
      try {
        await this.update(id, generation, signal);
      } catch (e) {
        if (e instanceof AppError && ['CANCELLED', 'STALE_RESULT'].includes(e.code)) throw e;
        throw new AppError('INSIGHTS_FAILED', '最终洞察未能覆盖全部发言，请重试收尾', 502);
      }
    }
    const s = this.repo.snapshot(id),
      moderator = s.participants.find((p) => p.role === 'moderator')!;
    this.repo.setParticipantState(
      id,
      generation,
      moderator.id,
      'speaking',
      '整理本场共识、分歧与待验证问题',
    );
    const turnId = randomUUID();
    const draft = openSpeechDraft(
      this.repo,
      id,
      generation,
      { turnId, participantId: moderator.id, kind: 'summary', replyToMessageId: null },
      signal,
    );
    try {
      const output = await this.gateway.generate({
        connection: this.repo.hostConnection(id),
        purpose: 'summary',
        onText: draft.onText,
        discussionId: id,
        participantId: moderator.id,
        generation,
        signal,
        input: {
          context: {
            topic: s.discussion.topic,
            participants: s.participants,
            messages: s.messages.filter((m) => m.kind !== 'summary'),
            insights: s.insights,
          },
        },
        schema: ProseOutputSchema,
      });
      if (signal.aborted) throw new AppError('CANCELLED', '总结已取消', 409);
      this.repo.appendMessage(id, generation, {
        turnId,
        participantId: moderator.id,
        kind: 'summary',
        content: output.content,
        replyToMessageId: null,
      });
    } finally {
      draft.close();
    }
  }
  async close() {
    await Promise.allSettled([...this.jobs.values()].map((j) => j.promise));
  }
}
