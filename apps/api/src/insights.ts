import { randomUUID } from 'node:crypto';
import {
  InsightOutputSchema,
  ProseOutputSchema,
  type Message,
  type SummaryMeta,
} from '@panel/contracts';
import { validateInsightEvidence } from '../../../packages/domain/src/insights';
import { buildLocalSummary } from '../../../packages/domain/src/local-summary';
import type { Repository } from './repository';
import type { ModelGateway } from './gateway';
import type { InsightsPort } from './engine';
import { AppError } from './errors';
import { openSpeechDraft } from './speech-draft';

type Job = {
  generation: number;
  pending: boolean;
  promise: Promise<void>;
  error: unknown;
  controller: AbortController;
};
export type ClosingOptions = { timeoutMs?: number; maxModelAttempts?: number };
export function isModelFailure(error: unknown): error is AppError {
  return (
    error instanceof AppError &&
    [
      'TIMEOUT',
      'UPSTREAM_AUTH',
      'UPSTREAM_RATE_LIMIT',
      'UPSTREAM_TEMPORARY',
      'UPSTREAM_NETWORK',
      'UPSTREAM_REQUEST',
      'UPSTREAM_STREAM',
      'INVALID_OUTPUT',
      'BUDGET',
      'CAPACITY',
      'MODEL_FAILURE',
    ].includes(error.code)
  );
}
export class InsightsService implements InsightsPort {
  private jobs = new Map<string, Job>();
  private finishes = new Map<string, { generation: number; promise: Promise<void> }>();
  constructor(
    private repo: Repository,
    private gateway: ModelGateway,
    private options: ClosingOptions = {},
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
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const job: Job = {
      generation,
      pending: true,
      promise: Promise.resolve(),
      error: null,
      controller,
    };
    job.promise = Promise.resolve()
      .then(async () => {
        while (job.pending && !combined.aborted) {
          job.pending = false;
          await this.update(id, generation, combined);
        }
      })
      .catch((error) => {
        job.error = error;
      })
      .finally(() => {
        if (this.jobs.get(id) === job) this.jobs.delete(id);
      });
    this.jobs.set(id, job);
    return job.promise;
  }
  async update(id: string, generation: number, signal: AbortSignal, closing = false) {
    const s = this.repo.snapshot(id);
    this.repo.guard(id, generation, ['running', 'summarizing']);
    const messages = s.messages.filter((m) => m.kind !== 'summary'),
      through = messages.at(-1)?.messageSeq || 0;
    if (s.discussion.insightsThrough >= through) return;
    const moderator = s.participants.find((p) => p.role === 'moderator')!;
    const output = await this.gateway.generate({
      connection: this.repo.hostConnection(id),
      purpose: 'insights',
      discussionId: id,
      participantId: moderator.id,
      generation,
      signal,
      ...(closing ? { maxRetries: 0 as const, maxRepairs: 0 as const } : {}),
      input: {
        context: {
          topic: s.discussion.topic,
          participants: s.participants,
          messages,
          insights: s.insights,
          throughMessageSeq: through,
        },
      },
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
  finish(id: string, generation: number, signal: AbortSignal): Promise<void> {
    const existing = this.finishes.get(id);
    if (existing?.generation === generation) return existing.promise;
    const job = { generation, promise: Promise.resolve() };
    job.promise = this.finalize(id, generation, signal).finally(() => {
      if (this.finishes.get(id) === job) this.finishes.delete(id);
    });
    this.finishes.set(id, job);
    return job.promise;
  }
  private async finalize(id: string, generation: number, signal: AbortSignal) {
    const assertCurrent = () => {
      if (signal.aborted) throw new AppError('CANCELLED', '收尾已取消', 409);
      this.repo.guard(id, generation, ['summarizing']);
    };
    assertCurrent();
    const job = this.repo.ensureClosingJob(id, generation, {
      timeoutMs: this.options.timeoutMs ?? 360000,
      maxAttempts: this.options.maxModelAttempts ?? 4,
    });
    const remaining = job.deadlineAt - Date.now();
    const deadline = AbortSignal.timeout(Math.max(0, remaining));
    const combined = AbortSignal.any([signal, deadline]);
    const expired = () => deadline.aborted || Date.now() >= job.deadlineAt;
    const background = this.jobs.get(id);
    if (background) {
      const abortBackground = () => background.controller.abort();
      combined.addEventListener('abort', abortBackground, { once: true });
      if (combined.aborted || remaining <= 0) abortBackground();
      try {
        await background.promise;
      } finally {
        combined.removeEventListener('abort', abortBackground);
      }
      assertCurrent();
      if (
        background.error &&
        !isModelFailure(background.error) &&
        !(background.error instanceof AppError && background.error.code === 'CANCELLED')
      )
        throw background.error;
    }
    const pending = this.repo.snapshot(id);
    const last = pending.messages.filter((m) => m.kind !== 'summary').at(-1)?.messageSeq || 0;
    if (!expired() && !job.insightsAttempted && pending.discussion.insightsThrough < last) {
      this.repo.markClosingInsightsAttempted(id, generation);
      try {
        await this.update(id, generation, combined, true);
      } catch (error) {
        assertCurrent();
        const deadlineCancellation =
          expired() && error instanceof AppError && error.code === 'CANCELLED';
        if (!isModelFailure(error) && !deadlineCancellation) throw error;
        this.repo.recordClosingFailure(
          id,
          generation,
          expired() ? 'TIMEOUT' : (error as AppError).code,
        );
      }
    }
    assertCurrent();
    const s = this.repo.snapshot(id);
    const messages = s.messages.filter((m) => m.kind !== 'summary');
    const through = messages.at(-1)?.messageSeq || 0;
    const moderator = s.participants.find((p) => p.role === 'moderator')!;
    const turnId = randomUUID();
    const draft = openSpeechDraft(
      this.repo,
      id,
      generation,
      { turnId, participantId: moderator.id, kind: 'summary', replyToMessageId: null },
      signal,
    );
    const coverage = {
      throughMessageSeq: through,
      insightsThroughMessageSeq: s.discussion.insightsThrough,
    };
    try {
      this.repo.setParticipantState(
        id,
        generation,
        moderator.id,
        'speaking',
        '整理本场共识、分歧与待验证问题',
      );
      while (messages.length > 0 && !expired()) {
        assertCurrent();
        const attempt = this.repo.claimClosingAttempt(id, generation);
        if (!attempt) break;
        const connection = this.repo.connection(attempt.connectionId, attempt.connectionVersion);
        let output: { content: string };
        try {
          output = await this.gateway.generate({
            connection,
            purpose: 'summary',
            onText: draft.onText,
            discussionId: id,
            participantId: moderator.id,
            generation,
            signal: combined,
            maxRetries: 0,
            maxRepairs: 0,
            repairHint: attempt.repair,
            input: {
              context: {
                topic: s.discussion.topic,
                participants: s.participants,
                messages,
                insights: s.insights,
                ...coverage,
                insightsComplete: s.discussion.insightsThrough >= through,
              },
            },
            schema: ProseOutputSchema,
          });
        } catch (error) {
          assertCurrent();
          const deadlineCancellation =
            expired() && error instanceof AppError && error.code === 'CANCELLED';
          if (!isModelFailure(error) && !deadlineCancellation) throw error;
          this.repo.recordClosingFailure(
            id,
            generation,
            expired() ? 'TIMEOUT' : (error as AppError).code,
            attempt,
          );
          draft.onText('');
          continue;
        }
        assertCurrent();
        const primary = job.candidates[0];
        this.repo.appendMessage(id, generation, {
          turnId,
          participantId: moderator.id,
          kind: 'summary',
          content: output.content,
          replyToMessageId: null,
          summaryMeta: {
            source: 'model',
            ...coverage,
            model: connection.model,
            provider: connection.provider,
            connectionId: connection.id,
            connectionVersion: connection.version,
            fallbackUsed:
              connection.id !== primary?.connectionId ||
              connection.version !== primary?.connectionVersion,
            reason: null,
          },
        });
        return;
      }
      assertCurrent();
      const current = this.repo.snapshot(id);
      const reason: SummaryMeta['reason'] = expired()
        ? 'deadline_exceeded'
        : current.discussion.callCount >= current.discussion.maxCalls
          ? 'budget_exhausted'
          : 'models_unavailable';
      draft.onText('');
      this.repo.appendMessage(id, generation, {
        turnId,
        participantId: moderator.id,
        kind: 'summary',
        content: buildLocalSummary(current),
        replyToMessageId: null,
        summaryMeta: {
          source: 'local',
          ...coverage,
          model: null,
          provider: null,
          connectionId: null,
          connectionVersion: null,
          fallbackUsed: true,
          reason,
        },
      });
    } finally {
      draft.close();
    }
  }
  hasActive(id: string) {
    return this.jobs.has(id) || this.finishes.has(id);
  }
  async close() {
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.allSettled([...this.jobs.values()].map((j) => j.promise));
    await Promise.allSettled([...this.finishes.values()].map((j) => j.promise));
  }
}
