import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { Repository } from '../apps/api/src/repository';
import { makeSample } from '../packages/domain/src/samples';
import {
  MessageSchema,
  SummaryMetaSchema,
  type DiscussionSnapshot,
  type SummaryMeta,
} from '../packages/contracts/src/index';

const opened: { repo: Repository; dir: string }[] = [];
function setup() {
  mkdirSync(resolve('.tmp'), { recursive: true });
  const dir = mkdtempSync(resolve('.tmp/closing-repo-'));
  const repo = new Repository(dir);
  const entry = { repo, dir };
  opened.push(entry);
  const save = (name: string) =>
    repo.saveConnection({
      name,
      provider: 'custom',
      protocol: 'openai-chat',
      baseUrl: 'http://127.0.0.1:1/v1',
      model: name,
      apiKey: 'PRIVATE_CLOSING_TEST_KEY',
      active: true,
      structuredOutput: false,
    });
  const primary = save('primary'),
    backup = save('backup');
  const ready = (summarizing = true, withMessage = true) => {
    const initial = repo.createDiscussion('故障后如何保留可靠的讨论结果？', 4, primary.id);
    const id = initial.discussion.id;
    const cast = repo.saveCast(
      id,
      initial.discussion.generation,
      makeSample(0).participants.map((p, i) => ({
        ...p,
        id: `${id}-p${i}`,
        discussionId: id,
      })),
    );
    const bound = repo.bind(
      id,
      cast.discussion.version,
      cast.discussion.castVersion,
      cast.participants.map((p, i) => ({
        participantId: p.id,
        connectionId: i === 1 || i === 2 ? backup.id : primary.id,
      })),
    );
    const running = repo.start(id, bound.discussion.version, bound.discussion.castVersion, 3);
    if (withMessage)
      repo.appendMessage(id, running.discussion.generation, {
        turnId: 'expert-turn',
        participantId: running.participants[1].id,
        kind: 'expert',
        content: '已保存的观点需要保留证据。',
        replyToMessageId: null,
      });
    if (summarizing) repo.transition(id, 'summarizing');
    return repo.snapshot(id);
  };
  return { repo, entry, primary, backup, ready, save };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const { repo, dir } of opened.splice(0)) {
    repo.close();
    if (!dir.startsWith(resolve('.tmp') + sep)) throw new Error('invalid cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});
const options = { timeoutMs: 10000, maxAttempts: 5 };
function localMeta(s: DiscussionSnapshot): SummaryMeta {
  return {
    source: 'local',
    throughMessageSeq: s.messages.at(-1)?.messageSeq || 0,
    insightsThroughMessageSeq: s.discussion.insightsThrough,
    model: null,
    provider: null,
    connectionId: null,
    connectionVersion: null,
    fallbackUsed: true,
    reason: 'models_unavailable',
  };
}
function summaryInput(s: DiscussionSnapshot, meta = localMeta(s)) {
  return {
    turnId: 'summary-turn',
    participantId: s.participants[0].id,
    kind: 'summary' as const,
    content: '本地整理：已保存的观点需要保留证据。',
    replyToMessageId: null,
    summaryMeta: meta,
  };
}

describe('持久收尾任务与总结来源', () => {
  it('keeps historical summaries readable and rejects extra private metadata', () => {
    const old = makeSample(0).messages.find((m) => m.kind === 'summary')!;
    expect(MessageSchema.parse(old).summaryMeta).toBeUndefined();
    const meta = localMeta(makeSample(0));
    expect(SummaryMetaSchema.parse(meta)).toEqual(meta);
    expect(() => SummaryMetaSchema.parse({ ...meta, apiKey: 'secret' })).toThrow();
  });

  it('freezes deduplicated candidates in moderator-first order and rotates bounded attempts', () => {
    const { repo, primary, backup, ready } = setup(),
      s = ready();
    const id = s.discussion.id,
      gen = s.discussion.generation;
    const job = repo.ensureClosingJob(id, gen, options);
    expect(job.candidates).toEqual([
      { connectionId: primary.id, connectionVersion: 1 },
      { connectionId: backup.id, connectionVersion: 1 },
    ]);
    repo.patchConnection(backup.id, { model: 'changed-later', active: false });
    expect(repo.ensureClosingJob(id, gen, { timeoutMs: 1, maxAttempts: 1 })).toEqual(job);
    expect(repo.claimClosingAttempt(id, gen)).toEqual({
      ...job.candidates[0],
      attempt: 1,
      repair: false,
    });
    repo.recordClosingFailure(id, gen, 'INVALID_OUTPUT', job.candidates[0]);
    expect(repo.claimClosingAttempt(id, gen)).toEqual({
      ...job.candidates[1],
      attempt: 2,
      repair: true,
    });
    repo.recordClosingFailure(id, gen, 'UPSTREAM_AUTH', job.candidates[1]);
    expect(repo.claimClosingAttempt(id, gen)?.attempt).toBe(3);
    expect(repo.claimClosingAttempt(id, gen)).toEqual({
      ...job.candidates[0],
      attempt: 5,
      repair: false,
    });
    expect(repo.claimClosingAttempt(id, gen)).toBeNull();
    expect(repo.closingJob(id, gen)?.attempts).toBe(5);
    expect(JSON.stringify(repo.closingJob(id, gen))).not.toContain('PRIVATE_CLOSING_TEST_KEY');
    expect(JSON.stringify(repo.snapshot(id))).not.toContain('unavailableConnections');
  });

  it('rolls back attempt claims, failure state and insight markers with their transaction', () => {
    const { repo, ready } = setup(),
      s = ready();
    const id = s.discussion.id,
      gen = s.discussion.generation;
    const before = repo.ensureClosingJob(id, gen, options);
    expect(() =>
      repo.transaction(() => {
        const attempt = repo.claimClosingAttempt(id, gen)!;
        repo.markClosingInsightsAttempted(id, gen);
        repo.recordClosingFailure(id, gen, 'UPSTREAM_REQUEST', attempt);
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    expect(repo.closingJob(id, gen)).toEqual(before);
    repo.markClosingInsightsAttempted(id, gen);
    expect(repo.closingJob(id, gen)?.insightsAttempted).toBe(true);
  });

  it('rejects stale generations and foreign connections without changing another discussion', () => {
    const { repo, ready, save } = setup(),
      a = ready(),
      b = ready();
    const aid = a.discussion.id,
      agen = a.discussion.generation;
    const before = repo.ensureClosingJob(aid, agen, options);
    const bjob = repo.ensureClosingJob(b.discussion.id, b.discussion.generation, options);
    const foreign = save('foreign');
    expect(() =>
      repo.recordClosingFailure(aid, agen, 'UPSTREAM_AUTH', {
        connectionId: foreign.id,
        connectionVersion: foreign.version,
      }),
    ).toThrow();
    expect(() => repo.claimClosingAttempt(aid, agen - 1)).toThrow();
    expect(() => repo.markClosingInsightsAttempted(aid, agen - 1)).toThrow();
    expect(() => repo.ensureClosingJob(aid, agen - 1, options)).toThrow();
    expect(repo.closingJob(aid, agen - 1)).toBeNull();
    expect(repo.closingJob(aid, agen)).toEqual(before);
    repo.claimClosingAttempt(aid, agen);
    expect(repo.closingJob(b.discussion.id, b.discussion.generation)).toEqual(bjob);
  });

  it('stops claiming when deadline or call budget is exhausted', () => {
    const { repo, ready } = setup(),
      a = ready(),
      b = ready();
    const ajob = repo.ensureClosingJob(a.discussion.id, a.discussion.generation, options);
    repo.ensureClosingJob(b.discussion.id, b.discussion.generation, options);
    for (let i = b.discussion.callCount; i < b.discussion.maxCalls; i++)
      repo.reserveCall(b.discussion.id, b.discussion.generation, true);
    expect(repo.claimClosingAttempt(b.discussion.id, b.discussion.generation)).toBeNull();
    expect(repo.closingJob(b.discussion.id, b.discussion.generation)?.attempts).toBe(0);
    vi.spyOn(Date, 'now').mockReturnValue(ajob.deadlineAt);
    expect(repo.claimClosingAttempt(a.discussion.id, a.discussion.generation)).toBeNull();
    expect(repo.closingJob(a.discussion.id, a.discussion.generation)?.attempts).toBe(0);
  });

  it('preserves closing budgets across restart and returns only interrupted summaries for recovery', () => {
    const { repo, entry, ready } = setup(),
      closing = ready(),
      running = ready(false);
    const id = closing.discussion.id,
      gen = closing.discussion.generation;
    repo.ensureClosingJob(id, gen, options);
    const attempt = repo.claimClosingAttempt(id, gen)!;
    repo.markClosingInsightsAttempted(id, gen);
    repo.recordClosingFailure(id, gen, 'UPSTREAM_AUTH', attempt);
    const before = repo.closingJob(id, gen)!;
    repo.close();
    entry.repo = new Repository(entry.dir);
    const reopened = entry.repo;
    expect(reopened.recover()).toEqual([id]);
    const nextGen = reopened.discussion(id).generation;
    expect(reopened.discussion(id).status).toBe('interrupted');
    expect(reopened.discussion(running.discussion.id).status).toBe('interrupted');
    expect(reopened.closingJob(id, nextGen)).toEqual({ ...before, generation: nextGen });
    expect(reopened.closingJob(id, gen)).toBeNull();
    reopened.transition(id, 'summarizing');
    expect(reopened.ensureClosingJob(id, nextGen, { timeoutMs: 90000, maxAttempts: 20 })).toEqual({
      ...before,
      generation: nextGen,
    });
    expect(reopened.claimClosingAttempt(id, nextGen)).toMatchObject({
      ...before.candidates[1],
      attempt: 2,
    });
    expect(reopened.snapshot(id).messages).toHaveLength(1);
  });

  it('resets an old job only for an explicit new-generation retry', () => {
    const { repo, ready } = setup(),
      s = ready();
    const id = s.discussion.id,
      gen = s.discussion.generation;
    repo.ensureClosingJob(id, gen, options);
    const attempt = repo.claimClosingAttempt(id, gen)!;
    repo.markClosingInsightsAttempted(id, gen);
    repo.recordClosingFailure(id, gen, 'UPSTREAM_AUTH', attempt);
    repo.transition(id, 'failed', { failureStage: 'summary' });
    const next = repo.transition(id, 'summarizing', { bumpGeneration: true });
    const fresh = repo.ensureClosingJob(id, next.discussion.generation, {
      timeoutMs: 20000,
      maxAttempts: 2,
    });
    expect(fresh).toMatchObject({
      generation: next.discussion.generation,
      attempts: 0,
      maxAttempts: 2,
      insightsAttempted: false,
      lastErrorCode: null,
      unavailableConnections: [],
    });
  });

  it('recovers graceful-shutdown jobs without renewing budgets and does not resume failed work', () => {
    const { repo, entry, ready } = setup(),
      interrupted = ready(),
      failed = ready();
    const id = interrupted.discussion.id,
      gen = interrupted.discussion.generation;
    repo.ensureClosingJob(id, gen, options);
    repo.claimClosingAttempt(id, gen);
    repo.markClosingInsightsAttempted(id, gen);
    const before = repo.closingJob(id, gen)!;
    repo.transition(id, 'interrupted', { bumpGeneration: true, failureStage: 'summary' });
    repo.ensureClosingJob(failed.discussion.id, failed.discussion.generation, options);
    repo.transition(failed.discussion.id, 'failed', { failureStage: 'summary' });
    repo.close();
    entry.repo = new Repository(entry.dir);
    const reopened = entry.repo;
    expect(reopened.recover()).toEqual([id]);
    const currentGen = reopened.discussion(id).generation;
    expect(reopened.closingJob(id, currentGen)).toEqual({ ...before, generation: currentGen });
    expect(reopened.recover()).toEqual([id]);
    expect(reopened.closingJob(id, currentGen)).toEqual({ ...before, generation: currentGen });
    expect(reopened.discussion(failed.discussion.id).status).toBe('failed');
  });

  it('commits a local summary without faking insight coverage and atomically removes its draft/job', () => {
    const { repo, ready } = setup(),
      s = ready();
    const id = s.discussion.id,
      gen = s.discussion.generation;
    repo.ensureClosingJob(id, gen, options);
    const input = summaryInput(s);
    repo.beginSpeechDraft(id, gen, {
      turnId: input.turnId,
      participantId: input.participantId,
      kind: input.kind,
      replyToMessageId: input.replyToMessageId,
    });
    repo.updateSpeechDraft(id, gen, input.turnId, '正在整理');
    const before = repo.snapshot(id),
      beforeJob = repo.closingJob(id, gen);
    expect(() =>
      repo.transaction(() => {
        repo.appendMessage(id, gen, input);
        throw new Error('rollback summary');
      }),
    ).toThrow('rollback summary');
    expect(repo.snapshot(id)).toEqual(before);
    expect(repo.closingJob(id, gen)).toEqual(beforeJob);
    repo.appendMessage(id, gen, input);
    const after = repo.snapshot(id);
    expect(after.discussion.status).toBe('completed');
    expect(after.discussion.insightsThrough).toBe(0);
    expect(after.messages.at(-1)?.summaryMeta).toEqual(localMeta(s));
    expect(after.draft).toBeNull();
    expect(repo.closingJob(id, gen)).toBeNull();
    expect(repo.eventsAfter(id, before.lastEventSeq).at(-1)?.type).toBe('summary.ready');
    expect(() => repo.appendMessage(id, gen, { ...input, turnId: 'duplicate-summary' })).toThrow();
    expect(after.messages.filter((m) => m.kind === 'summary')).toHaveLength(1);
  });

  it('validates summary coverage, source and frozen connection without accepting foreign metadata', () => {
    const { repo, ready, backup, save } = setup(),
      s = ready();
    const id = s.discussion.id,
      gen = s.discussion.generation;
    const input = summaryInput(s),
      foreign = save('outside');
    const { summaryMeta: omitted, ...withoutMeta } = input;
    expect(() => repo.appendMessage(id, gen, withoutMeta)).toThrow();
    for (const meta of [
      { ...omitted, throughMessageSeq: 0 },
      { ...omitted, insightsThroughMessageSeq: 1 },
      { ...omitted, model: 'invented' },
      { ...omitted, source: 'model' as const },
      {
        ...omitted,
        source: 'model' as const,
        model: foreign.model,
        provider: foreign.provider,
        connectionId: foreign.id,
        connectionVersion: foreign.version,
      },
    ])
      expect(() => repo.appendMessage(id, gen, { ...input, summaryMeta: meta })).toThrow();
    const newBackup = repo.patchConnection(backup.id, { model: 'new-model' });
    expect(() =>
      repo.appendMessage(id, gen, {
        ...input,
        summaryMeta: {
          ...omitted,
          source: 'model',
          model: newBackup.model,
          provider: newBackup.provider,
          connectionId: newBackup.id,
          connectionVersion: newBackup.version,
        },
      }),
    ).toThrow();
    repo.appendMessage(id, gen, {
      ...input,
      summaryMeta: {
        ...omitted,
        source: 'model',
        model: backup.model,
        provider: backup.provider,
        connectionId: backup.id,
        connectionVersion: backup.version,
        reason: null,
      },
    });
    expect(repo.snapshot(id).messages.at(-1)?.summaryMeta?.connectionVersion).toBe(1);
  });

  it('forbids summary metadata on expert messages and keeps empty interruptions out of auto-resume', () => {
    const { repo, ready } = setup(),
      s = ready(false, false);
    expect(() =>
      repo.appendMessage(s.discussion.id, s.discussion.generation, {
        ...summaryInput(s),
        kind: 'expert',
        participantId: s.participants[1].id,
      }),
    ).toThrow();
    repo.transition(s.discussion.id, 'summarizing');
    expect(repo.recover()).toEqual([]);
    expect(repo.discussion(s.discussion.id).status).toBe('interrupted');
  });
});
