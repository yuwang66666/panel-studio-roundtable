import { randomUUID } from 'node:crypto';
import { CastOutputSchema, type Discussion, type Participant } from '@panel/contracts';
import type { Repository } from './repository';
import type { ModelGateway } from './gateway';
import { AppError, safeError } from './errors';
import { DiscussionEngine } from './engine';
import { InsightsService, isModelFailure, type ClosingOptions } from './insights';
export class DiscussionService {
  private active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private stopping = false;
  private recoveryQueue: string[] = [];
  private recoveryLimit = 3;
  private recoveryWaiters = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  readonly insights: InsightsService;
  readonly engine: DiscussionEngine;
  constructor(
    readonly repo: Repository,
    readonly gateway: ModelGateway,
    closingOptions: ClosingOptions = {},
  ) {
    this.insights = new InsightsService(repo, gateway, closingOptions);
    this.engine = new DiscussionEngine(repo, gateway, this.insights);
  }
  run(id: string) {
    this.launch(id, 'discussion', (signal) => this.engine.run(id, signal));
  }
  summarize(id: string) {
    this.launch(id, 'summary', (signal) =>
      this.insights.finish(id, this.repo.discussion(id).generation, signal),
    );
  }
  resumeRecovered(ids: string[], maxConcurrent: number) {
    this.recoveryLimit = maxConcurrent;
    for (const id of ids) {
      if (this.recoveryWaiters.has(id)) continue;
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      this.recoveryWaiters.set(id, { promise, resolve });
      this.recoveryQueue.push(id);
    }
    this.drainRecovery();
  }
  private drainRecovery() {
    while (!this.stopping && this.recoveryQueue.length) {
      const active = (
        this.repo.db
          .prepare(
            "SELECT count(*) AS n FROM discussions WHERE status IN ('running','summarizing')",
          )
          .get() as { n: number }
      ).n;
      if (active >= this.recoveryLimit) return;
      const id = this.recoveryQueue.shift()!;
      const d = this.repo.discussion(id);
      if (d.status !== 'interrupted') {
        this.resolveRecovery(id);
        continue;
      }
      this.repo.transition(id, 'summarizing', { generation: d.generation });
      this.summarize(id);
    }
  }
  private resolveRecovery(id: string) {
    this.recoveryWaiters.get(id)?.resolve();
    this.recoveryWaiters.delete(id);
  }
  cast(id: string) {
    this.launch(id, 'cast', async (signal) => {
      const d = this.repo.discussion(id),
        connection = this.repo.hostConnection(id);
      const cast = await this.gateway.generate({
        connection,
        purpose: 'cast',
        discussionId: id,
        generation: d.generation,
        input: { topic: d.topic, expertCount: d.expertCount },
        schema: CastOutputSchema,
        signal,
        validate: (cast) => {
          const all = [cast.moderator, ...cast.experts];
          if (
            cast.experts.length !== d.expertCount ||
            new Set(all.map((p) => p.name)).size !== all.length ||
            new Set(cast.experts.map((p) => p.occupation + '|' + p.title)).size !== d.expertCount ||
            new Set(cast.experts.map((p) => p.stance)).size !== d.expertCount
          )
            throw new AppError('INVALID_OUTPUT', '阵容人数或差异性不符合要求', 502);
        },
      });
      const participants: Participant[] = [cast.moderator, ...cast.experts].map((p, i) => ({
        ...p,
        id: randomUUID(),
        discussionId: id,
        role: i === 0 ? 'moderator' : 'expert',
        colorKey: i,
        status: 'idle',
        publicFocus: null,
      }));
      this.repo.saveCast(id, d.generation, participants);
    });
  }
  protected launch(
    id: string,
    stage: Discussion['failureStage'],
    work: (signal: AbortSignal) => Promise<void>,
  ) {
    if (this.active.has(id)) return;
    const controller = new AbortController();
    const generation = this.repo.discussion(id).generation;
    const promise = Promise.resolve()
      .then(() => work(controller.signal))
      .catch(async (error) => {
        let d = this.repo.discussion(id);
        if (
          d.generation !== generation ||
          !['casting', 'running', 'summarizing'].includes(d.status)
        )
          return;
        if (
          !this.stopping &&
          !controller.signal.aborted &&
          d.status === 'running' &&
          isModelFailure(error)
        ) {
          this.repo.clearStates(id);
          this.repo.transition(id, 'summarizing', { generation });
          try {
            await this.insights.finish(id, generation, controller.signal);
            return;
          } catch (closingError) {
            error = closingError;
            d = this.repo.discussion(id);
            if (d.generation !== generation || d.status !== 'summarizing') return;
          }
        }
        controller.abort();
        const e = safeError(error);
        this.repo.transition(
          id,
          this.stopping && d.status !== 'casting' ? 'interrupted' : 'failed',
          {
            generation,
            bumpGeneration: this.stopping,
            failureStage:
              e.code === 'INSIGHTS_FAILED'
                ? 'insights'
                : d.status === 'summarizing'
                  ? 'summary'
                  : stage,
            error: this.stopping ? '服务已停止，已有讨论内容已保存' : e.message,
          },
        );
        this.repo.clearStates(id);
      })
      .finally(() => {
        if (this.active.get(id)?.controller === controller) this.active.delete(id);
        this.resolveRecovery(id);
        this.drainRecovery();
      });
    this.active.set(id, { controller, promise });
  }
  hasActive(id: string) {
    return this.active.has(id);
  }
  hasPending(id: string) {
    return this.active.has(id) || this.recoveryWaiters.has(id) || this.insights.hasActive(id);
  }
  async idle(id: string) {
    await this.recoveryWaiters.get(id)?.promise;
    await this.active.get(id)?.promise;
  }
  async close() {
    this.stopping = true;
    this.recoveryQueue = [];
    for (const id of this.recoveryWaiters.keys()) this.resolveRecovery(id);
    for (const job of this.active.values()) job.controller.abort();
    await Promise.allSettled([...this.active.values()].map((j) => j.promise));
    await this.insights.close();
  }
}
