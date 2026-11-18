import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { Repository } from '../apps/api/src/repository';
import { DiscussionEngine, type InsightsPort } from '../apps/api/src/engine';
import { SpeechService } from '../apps/api/src/speech';
import { AppError } from '../apps/api/src/errors';
import type { ModelGateway, ModelRequest } from '../apps/api/src/gateway';
import type { DiscussionSnapshot } from '../packages/contracts/src/index';
import { makeSample } from '../packages/domain/src/samples';
import { harness } from './fixtures/harness';
import { defaultResponse } from './fixtures/provider';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const opened: { repo: Repository; dir: string }[] = [];
function setup() {
  mkdirSync(resolve('.tmp'), { recursive: true });
  const dir = mkdtempSync(resolve('.tmp/participant-state-'));
  const entry = { repo: new Repository(dir), dir };
  opened.push(entry);
  const repo = entry.repo;
  const connection = repo.saveConnection({
    name: '状态测试',
    provider: 'custom',
    protocol: 'openai-chat',
    baseUrl: 'http://127.0.0.1:1/v1',
    model: 'state-fixture',
    apiKey: 'state-test-key',
    active: true,
    structuredOutput: false,
  });
  function ready(topic = '如何准确展示专家的实际运行状态？', turns = 1) {
    const initial = repo.createDiscussion(topic, 4, connection.id, turns);
    const cast = repo.saveCast(
      initial.discussion.id,
      initial.discussion.generation,
      makeSample(0).participants.map((p, i) => ({
        ...p,
        id: `${initial.discussion.id}-p${i}`,
        discussionId: initial.discussion.id,
        status: 'idle',
        publicFocus: null,
      })),
    );
    return repo.start(
      initial.discussion.id,
      cast.discussion.version,
      cast.discussion.castVersion,
      3,
    );
  }
  return { repo, entry, ready };
}
afterEach(() => {
  for (const { repo, dir } of opened.splice(0)) {
    repo.close();
    if (!dir.startsWith(resolve('.tmp') + sep)) throw Error('Invalid cleanup path');
    rmSync(dir, { recursive: true, force: true });
  }
});
function stub(handler: (r: ModelRequest<unknown>) => Promise<unknown>): ModelGateway {
  return { generate: handler } as unknown as ModelGateway;
}
function actor(repo: Repository, s: DiscussionSnapshot, index = 1) {
  return repo
    .snapshot(s.discussion.id)
    .participants.find((p) => p.id === s.participants[index].id)!;
}
function addOpening(repo: Repository, s: DiscussionSnapshot) {
  repo.appendMessage(s.discussion.id, s.discussion.generation, {
    turnId: 'opening',
    participantId: s.participants[0].id,
    kind: 'opening',
    content: '请根据专业背景讨论可靠的判断依据。',
    replyToMessageId: null,
  });
  return repo.snapshot(s.discussion.id);
}
function localClosing(repo: Repository): InsightsPort {
  return {
    onMessage() {},
    async finish(id, generation) {
      const s = repo.snapshot(id);
      repo.appendMessage(id, generation, {
        turnId: 'summary',
        participantId: s.participants[0].id,
        kind: 'summary',
        content: '状态验收已结束，已保存公开讨论记录。',
        replyToMessageId: null,
        summaryMeta: {
          source: 'local',
          throughMessageSeq: s.messages.at(-1)?.messageSeq || 0,
          insightsThroughMessageSeq: s.discussion.insightsThrough,
          model: null,
          provider: null,
          connectionId: null,
          connectionVersion: null,
          fallbackUsed: true,
          reason: 'models_unavailable',
        },
      });
    },
  };
}
function idleSignal(repo: Repository, id: string, participantId: string) {
  const settled = gate();
  const inspect = () => {
    if (repo.snapshot(id).participants.find((p) => p.id === participantId)?.status === 'idle') {
      repo.events.off(id, inspect);
      settled.release();
    }
  };
  repo.events.on(id, inspect);
  return { promise: settled.promise, close: () => repo.events.off(id, inspect) };
}
const privateFocus = 'PRIVATE_INTENT_REASONING_NOT_FOR_PUBLIC_STATE';
const intent = (action = 'raise', targetMessageId: string | null = null) => ({
  action,
  targetMessageId,
  proposedFocus: privateFocus,
});
function assertPublicBoundary(repo: Repository, id: string) {
  const published = JSON.stringify({
    snapshot: repo.snapshot(id),
    events: repo.eventsAfter(id, 0, 10000),
  });
  expect(published).not.toContain(privateFocus);
  expect(published).not.toContain('proposedFocus');
  expect(published).not.toContain('reasoning_content');
}

describe('专家公开状态与运行生命周期', () => {
  it('marks all intent requests preparing, releases pass/invalid/error candidates and keeps only the selected speaker active', async () => {
    const { repo, ready } = setup(),
      s = addOpening(repo, ready());
    const id = s.discussion.id;
    const gates = [gate(), gate(), gate(), gate()],
      allEntered = gate(),
      speechEntered = gate(),
      speechDone = gate();
    let entered = 0,
      speechRequest!: ModelRequest<unknown>;
    const model = stub(async (r) => {
      if (r.purpose === 'intent') {
        const index = s.participants.findIndex((p) => p.id === r.participantId) - 1;
        if (++entered === 4) allEntered.release();
        await gates[index].promise;
        if (index === 3) throw new AppError('UPSTREAM_AUTH', '测试连接失败', 502);
        return index === 1
          ? intent('pass')
          : index === 2
            ? intent('rebut', 'foreign-message')
            : intent();
      }
      if (r.purpose === 'utterance') {
        speechRequest = r;
        speechEntered.release();
        await speechDone.promise;
        return { sentences: ['需要检验公开证据。'] };
      }
      throw Error(`Unexpected model purpose ${r.purpose}`);
    });
    const pending = new DiscussionEngine(repo, model, localClosing(repo)).run(
      id,
      new AbortController().signal,
    );
    const outcomes = [2, 3, 4].map((index) => idleSignal(repo, id, s.participants[index].id));
    try {
      await allEntered.promise;
      for (let index = 1; index <= 4; index++) {
        expect(actor(repo, s, index).status).toBe('preparing');
        expect(actor(repo, s, index).publicFocus).toBeTruthy();
      }
      for (const index of [1, 2, 3]) gates[index].release();
      await Promise.all(outcomes.map((o) => o.promise));
      expect(actor(repo, s).status).toBe('preparing');
      for (let index = 2; index <= 4; index++) expect(actor(repo, s, index).status).toBe('idle');
      gates[0].release();
      await speechEntered.promise;
      expect(actor(repo, s).status).toBe('preparing');
      expect(repo.snapshot(id).draft?.content).toBe('');
      speechRequest.onText!('需要检验公开证据。');
      expect(actor(repo, s).status).toBe('speaking');
      expect(repo.snapshot(id).participants.filter((p) => p.status === 'speaking')).toHaveLength(1);
      assertPublicBoundary(repo, id);
      speechDone.release();
      await pending;
      expect(
        repo.snapshot(id).participants.every((p) => p.status === 'idle' && p.publicFocus === null),
      ).toBe(true);
      expect(repo.snapshot(id).discussion.status).toBe('completed');
    } finally {
      outcomes.forEach((o) => o.close());
      gates.forEach((g) => g.release());
      speechDone.release();
      await pending.catch(() => {});
    }
  });

  it('returns unselected valid candidates to idle before the selected speech begins', async () => {
    const { repo, ready } = setup(),
      s = addOpening(repo, ready());
    const speechEntered = gate(),
      release = gate();
    let chosen = '';
    const pending = new DiscussionEngine(
      repo,
      stub(async (r) => {
        if (r.purpose === 'intent') return intent();
        chosen = r.participantId!;
        speechEntered.release();
        await release.promise;
        r.onText!('先明确评价范围。');
        return { sentences: ['先明确评价范围。'] };
      }),
      localClosing(repo),
    ).run(s.discussion.id, new AbortController().signal);
    try {
      await speechEntered.promise;
      const experts = repo
        .snapshot(s.discussion.id)
        .participants.filter((p) => p.role === 'expert');
      expect(experts.find((p) => p.id === chosen)?.status).toBe('preparing');
      expect(experts.filter((p) => p.id !== chosen).every((p) => p.status === 'idle')).toBe(true);
      assertPublicBoundary(repo, s.discussion.id);
    } finally {
      release.release();
      await pending;
    }
  });

  it('waits for public text before speaking, resets to preparing on repair and atomically returns idle on commit', async () => {
    const { repo, ready } = setup(),
      s = ready(),
      entered = gate(),
      done = gate();
    let request!: ModelRequest<unknown>;
    const pending = new SpeechService(
      repo,
      stub(async (r) => {
        request = r;
        entered.release();
        await done.promise;
        return { sentences: ['修复后的公开观点。'] };
      }),
    ).speak(s, s.participants[1].id, 'expert', new AbortController().signal, {
      focus: privateFocus,
    });
    try {
      await entered.promise;
      expect(actor(repo, s).status).toBe('preparing');
      expect(repo.snapshot(s.discussion.id).draft?.content).toBe('');
      request.onText!(' \n\t');
      expect(actor(repo, s).status).toBe('preparing');
      request.onText!('');
      request.onText!('首版公开观点');
      expect(actor(repo, s).status).toBe('speaking');
      expect(repo.snapshot(s.discussion.id).draft?.content).toBe('首版公开观点');
      request.onText!('');
      expect(actor(repo, s).status).toBe('preparing');
      expect(repo.snapshot(s.discussion.id).draft?.content).toBe('');
      request.onText!('修复后的公开观点。');
      expect(actor(repo, s).status).toBe('speaking');
      assertPublicBoundary(repo, s.discussion.id);
      done.release();
      await pending;
      const final = repo.snapshot(s.discussion.id);
      expect(actor(repo, s)).toMatchObject({ status: 'idle', publicFocus: null });
      expect(final.draft).toBeNull();
      expect(final.messages).toHaveLength(1);
      expect(final.messages[0].content).toBe('修复后的公开观点。');
    } finally {
      done.release();
      await pending.catch(() => {});
    }
  });

  it.each([false, true])(
    'clears state and draft on cancellation (public text already sent: %s)',
    async (sent) => {
      const { repo, ready } = setup(),
        s = ready(),
        controller = new AbortController(),
        entered = gate();
      let request!: ModelRequest<unknown>;
      const pending = new SpeechService(
        repo,
        stub(async (r) => {
          request = r;
          entered.release();
          await new Promise<void>((_, reject) =>
            controller.signal.addEventListener(
              'abort',
              () => reject(new AppError('CANCELLED', '测试取消', 409)),
              { once: true },
            ),
          );
          return {};
        }),
      ).speak(s, s.participants[1].id, 'expert', controller.signal);
      const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
      try {
        await entered.promise;
        expect(actor(repo, s).status).toBe('preparing');
        if (sent) {
          request.onText!('尚未完成的公开观点');
          expect(actor(repo, s).status).toBe('speaking');
        }
        controller.abort();
        await rejected;
        expect(actor(repo, s)).toMatchObject({ status: 'idle', publicFocus: null });
        expect(repo.snapshot(s.discussion.id).draft).toBeNull();
        expect(repo.snapshot(s.discussion.id).messages).toEqual([]);
        expect(() => request.onText!('取消后迟到的文本')).toThrow();
      } finally {
        controller.abort();
        await pending.catch(() => {});
      }
    },
  );

  it('clears preparing state when speech generation fails before any public text', async () => {
    const { repo, ready } = setup(),
      s = ready(),
      entered = gate(),
      release = gate();
    const pending = new SpeechService(
      repo,
      stub(async () => {
        entered.release();
        await release.promise;
        throw new AppError('TIMEOUT', '测试超时', 504);
      }),
    ).speak(s, s.participants[1].id, 'expert', new AbortController().signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
    try {
      await entered.promise;
      expect(actor(repo, s).status).toBe('preparing');
      release.release();
      await rejected;
      expect(actor(repo, s)).toMatchObject({ status: 'idle', publicFocus: null });
      expect(repo.snapshot(s.discussion.id).draft).toBeNull();
    } finally {
      release.release();
      await pending.catch(() => {});
    }
  });

  it('keeps simultaneous discussion states isolated when one call is cancelled', async () => {
    const { repo, ready } = setup(),
      a = ready('甲场：如何提高公共交通覆盖？'),
      b = ready('乙场：远程办公怎样衡量成效？');
    const requests = new Map<string, ModelRequest<unknown>>(),
      entered = gate();
    const controllers = [new AbortController(), new AbortController()];
    const speech = new SpeechService(
      repo,
      stub(async (r) => {
        requests.set(r.discussionId!, r);
        if (requests.size === 2) entered.release();
        await new Promise<void>((_, reject) =>
          r.signal!.addEventListener(
            'abort',
            () => reject(new AppError('CANCELLED', '测试取消', 409)),
            { once: true },
          ),
        );
        return {};
      }),
    );
    const pending = [a, b].map((s, index) =>
      speech.speak(s, s.participants[1].id, 'expert', controllers[index].signal),
    );
    const outcomes = pending.map((p) => p.catch(() => {}));
    try {
      await entered.promise;
      requests.get(a.discussion.id)!.onText!('甲场正在展示的公开观点');
      expect(actor(repo, a).status).toBe('speaking');
      expect(actor(repo, b).status).toBe('preparing');
      const other = repo.snapshot(b.discussion.id);
      controllers[0].abort();
      await outcomes[0];
      expect(actor(repo, a)).toMatchObject({ status: 'idle', publicFocus: null });
      expect(repo.snapshot(b.discussion.id)).toEqual(other);
      expect(JSON.stringify(other)).not.toContain('甲场正在展示的公开观点');
    } finally {
      controllers.forEach((c) => c.abort());
      await Promise.all(outcomes);
    }
  });

  it('persists active state for snapshot reload, then resets it on recovery and rejects late generations', () => {
    const { repo, entry, ready } = setup(),
      s = ready(),
      id = s.discussion.id,
      gen = s.discussion.generation;
    repo.setParticipantState(
      id,
      gen,
      s.participants[1].id,
      'preparing',
      '关注公开讨论中的适用条件',
    );
    repo.beginSpeechDraft(id, gen, {
      turnId: 'turn',
      participantId: s.participants[1].id,
      kind: 'expert',
      replyToMessageId: null,
    });
    repo.updateSpeechDraft(id, gen, 'turn', '中断前的公开片段');
    expect(actor(repo, s).status).toBe('speaking');
    const prior = repo.snapshot(id);
    repo.close();
    entry.repo = new Repository(entry.dir);
    expect(entry.repo.snapshot(id)).toEqual(prior);
    entry.repo.recover();
    const recovered = entry.repo.snapshot(id);
    expect(recovered.discussion.status).toBe('interrupted');
    expect(recovered.draft).toBeNull();
    expect(recovered.participants.every((p) => p.status === 'idle' && p.publicFocus === null)).toBe(
      true,
    );
    expect(() =>
      entry.repo.setParticipantState(id, gen, s.participants[1].id, 'speaking', '过期关注点'),
    ).toThrow();
    expect(() => entry.repo.updateSpeechDraft(id, gen, 'turn', '迟到文本')).toThrow();
    expect(entry.repo.snapshot(id)).toEqual(recovered);
  });

  it('rolls back state, public draft and events together when publishing a fragment fails', async () => {
    const { repo, ready } = setup(),
      s = ready(),
      entered = gate(),
      done = gate();
    let request!: ModelRequest<unknown>;
    const pending = new SpeechService(
      repo,
      stub(async (r) => {
        request = r;
        entered.release();
        await done.promise;
        return { sentences: ['最终公开观点。'] };
      }),
    ).speak(s, s.participants[1].id, 'expert', new AbortController().signal);
    try {
      await entered.promise;
      const before = repo.snapshot(s.discussion.id);
      expect(() =>
        repo.transaction(() => {
          request.onText!('事务内的临时观点');
          expect(actor(repo, s).status).toBe('speaking');
          throw Error('rollback');
        }),
      ).toThrow('rollback');
      expect(repo.snapshot(s.discussion.id)).toEqual(before);
      expect(repo.eventsAfter(s.discussion.id, before.lastEventSeq)).toEqual([]);
    } finally {
      done.release();
      await pending;
    }
  });

  it('does not publish a new speech after early finish while experts are still assessing', async () => {
    const { repo, ready } = setup(),
      s = addOpening(repo, ready()),
      entered = gate(),
      release = gate();
    let calls = 0;
    const pending = new DiscussionEngine(
      repo,
      stub(async (r) => {
        expect(r.purpose).toBe('intent');
        if (++calls === 4) entered.release();
        await release.promise;
        return intent();
      }),
      localClosing(repo),
    ).run(s.discussion.id, new AbortController().signal);
    try {
      await entered.promise;
      expect(
        repo
          .snapshot(s.discussion.id)
          .participants.filter((p) => p.role === 'expert')
          .every((p) => p.status === 'preparing'),
      ).toBe(true);
      repo.requestFinish(s.discussion.id, repo.discussion(s.discussion.id).version);
      release.release();
      await pending;
      const final = repo.snapshot(s.discussion.id);
      expect(final.participants.every((p) => p.status === 'idle' && p.publicFocus === null)).toBe(
        true,
      );
      expect(final.messages.filter((m) => m.kind === 'expert')).toEqual([]);
      assertPublicBoundary(repo, s.discussion.id);
    } finally {
      release.release();
      await pending.catch(() => {});
    }
  });

  it('resets assessment states on cancellation and ignores late intent completions', async () => {
    const { repo, ready } = setup(),
      s = addOpening(repo, ready()),
      controller = new AbortController(),
      entered = gate(),
      release = gate();
    let calls = 0;
    const pending = new DiscussionEngine(
      repo,
      stub(async (r) => {
        expect(r.purpose).toBe('intent');
        if (++calls === 4) entered.release();
        await release.promise;
        return intent();
      }),
      localClosing(repo),
    ).run(s.discussion.id, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    try {
      await entered.promise;
      controller.abort();
      release.release();
      await rejected;
      expect(
        repo
          .snapshot(s.discussion.id)
          .participants.every((p) => p.status === 'idle' && p.publicFocus === null),
      ).toBe(true);
      expect(repo.snapshot(s.discussion.id).messages.filter((m) => m.kind === 'expert')).toEqual(
        [],
      );
      assertPublicBoundary(repo, s.discussion.id);
    } finally {
      controller.abort();
      release.release();
      await pending.catch(() => {});
    }
  });

  it('shows queued experts preparing before the real HTTP gateway grants connection slots', async () => {
    const entered = gate(),
      release = gate();
    let assessing = 0;
    const h = await harness(async (task) => {
      if (task.purpose === 'intent') {
        if (++assessing === 2) entered.release();
        await release.promise;
      }
      return defaultResponse(task);
    });
    let id = '';
    try {
      const created = h.repo.createDiscussion(
        '模型排队时是否仍准确显示专家状态？',
        4,
        h.connection.id,
        1,
      );
      id = created.discussion.id;
      h.discussions.cast(id);
      await h.discussions.idle(id);
      const cast = h.repo.snapshot(id);
      const running = h.repo.start(id, cast.discussion.version, cast.discussion.castVersion, 3);
      addOpening(h.repo, running);
      h.discussions.run(id);
      await entered.promise;
      expect(assessing).toBe(2);
      expect(
        h.repo
          .snapshot(id)
          .participants.filter((p) => p.role === 'expert')
          .every((p) => p.status === 'preparing'),
      ).toBe(true);
      h.repo.requestFinish(id, h.repo.discussion(id).version);
      release.release();
      await h.discussions.idle(id);
      expect(
        h.repo
          .snapshot(id)
          .participants.every((p) => p.status === 'idle' && p.publicFocus === null),
      ).toBe(true);
      expect(h.repo.snapshot(id).messages.filter((m) => m.kind === 'expert')).toEqual([]);
    } finally {
      release.release();
      if (id) await h.discussions.idle(id);
      await h.close();
    }
  });
});
