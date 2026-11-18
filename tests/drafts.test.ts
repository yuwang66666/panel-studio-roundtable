import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { Repository } from '../apps/api/src/repository';
import { SpeechService } from '../apps/api/src/speech';
import type { ModelGateway } from '../apps/api/src/gateway';
import { AppError } from '../apps/api/src/errors';
import { makeSample } from '../packages/domain/src/samples';
import { buildContext } from '../packages/domain/src/context';
const opened: { repo: Repository; dir: string }[] = [];
function setup() {
  mkdirSync(resolve('.tmp'), { recursive: true });
  const dir = mkdtempSync(resolve('.tmp/drafts-'));
  const repo = new Repository(dir);
  const entry = { repo, dir };
  opened.push(entry);
  const connection = repo.saveConnection({
    name: '测试模型',
    provider: 'custom',
    protocol: 'openai-chat',
    baseUrl: 'http://127.0.0.1:1/v1',
    model: 'fixture',
    apiKey: 'fixture-only',
    active: true,
    structuredOutput: false,
  });
  const ready = () => {
    const s = repo.createDiscussion('流式发言如何在断线后保持一致？', 4, connection.id);
    const cast = repo.saveCast(
      s.discussion.id,
      s.discussion.generation,
      makeSample(0).participants.map((p, i) => ({
        ...p,
        id: `${s.discussion.id}-p${i}`,
        discussionId: s.discussion.id,
      })),
    );
    return repo.start(s.discussion.id, cast.discussion.version, cast.discussion.castVersion, 3);
  };
  return { entry, repo, ready };
}
afterEach(() => {
  for (const { repo, dir } of opened.splice(0)) {
    repo.close();
    if (!dir.startsWith(resolve('.tmp') + sep)) throw new Error('invalid cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});
describe('流式发言持久化与生命周期', () => {
  it('keeps a recoverable draft outside the transcript and atomically replaces it on commit', () => {
    const { repo, ready } = setup(),
      s = ready(),
      id = s.discussion.id,
      gen = s.discussion.generation;
    const input = {
      turnId: 'turn',
      participantId: s.participants[1].id,
      kind: 'expert' as const,
      replyToMessageId: null,
    };
    repo.beginSpeechDraft(id, gen, input);
    repo.updateSpeechDraft(id, gen, input.turnId, '正在展开的观点');
    const partial = repo.snapshot(id);
    expect(partial.messages).toEqual([]);
    expect(partial.draft?.content).toBe('正在展开的观点');
    expect(JSON.stringify(buildContext(partial, input.participantId, 0))).not.toContain(
      '正在展开的观点',
    );
    expect(() =>
      repo.transaction(() => {
        repo.updateSpeechDraft(id, gen, input.turnId, '不应保存的片段');
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    expect(repo.snapshot(id)).toEqual(partial);
    expect(() =>
      repo.transaction(() => {
        repo.appendMessage(id, gen, { ...input, content: '已经完整且通过校验。' });
        throw new Error('rollback commit');
      }),
    ).toThrow();
    expect(repo.snapshot(id)).toEqual(partial);
    const message = repo.appendMessage(id, gen, { ...input, content: '已经完整且通过校验。' });
    const final = repo.snapshot(id);
    expect(final.draft).toBeNull();
    expect(final.messages).toEqual([message]);
    expect(repo.appendMessage(id, gen, { ...input, content: '重复请求。' })).toEqual(message);
    expect(() => repo.updateSpeechDraft(id, gen, 'turn', '迟到内容')).toThrow();
    expect(repo.eventsAfter(id, partial.lastEventSeq).at(-1)?.type).toBe('message.committed');
  });
  it('isolates discussions, validates references and refuses concurrent drafts', () => {
    const { repo, ready } = setup(),
      a = ready(),
      b = ready();
    const input = {
      turnId: 'same-turn-name',
      participantId: a.participants[1].id,
      kind: 'expert' as const,
      replyToMessageId: null,
    };
    expect(() => repo.beginSpeechDraft(b.discussion.id, b.discussion.generation, input)).toThrow();
    expect(() =>
      repo.beginSpeechDraft(a.discussion.id, a.discussion.generation, {
        ...input,
        replyToMessageId: 'other-message',
      }),
    ).toThrow();
    repo.beginSpeechDraft(a.discussion.id, a.discussion.generation, input);
    expect(() =>
      repo.beginSpeechDraft(a.discussion.id, a.discussion.generation, {
        ...input,
        turnId: 'other-turn',
      }),
    ).toThrow();
    repo.beginSpeechDraft(b.discussion.id, b.discussion.generation, {
      ...input,
      participantId: b.participants[1].id,
    });
    repo.updateSpeechDraft(a.discussion.id, a.discussion.generation, input.turnId, '甲场内容');
    expect(repo.snapshot(b.discussion.id).draft?.content).toBe('');
    repo.clearSpeechDraft(a.discussion.id, a.discussion.generation - 1, input.turnId);
    expect(repo.snapshot(a.discussion.id).draft?.content).toBe('甲场内容');
  });
  it('persists snapshots across database reopen but clears unfinished text on process recovery', () => {
    const { repo, entry, ready } = setup(),
      s = ready(),
      id = s.discussion.id,
      gen = s.discussion.generation;
    repo.beginSpeechDraft(id, gen, {
      turnId: 'turn',
      participantId: s.participants[1].id,
      kind: 'expert',
      replyToMessageId: null,
    });
    repo.updateSpeechDraft(id, gen, 'turn', '恢复前的草稿');
    const before = repo.snapshot(id);
    repo.close();
    entry.repo = new Repository(entry.dir);
    expect(entry.repo.snapshot(id)).toEqual(before);
    entry.repo.recover();
    expect(entry.repo.snapshot(id).draft).toBeNull();
    expect(entry.repo.snapshot(id).messages).toEqual([]);
    expect(entry.repo.discussion(id).status).toBe('interrupted');
    expect(() => entry.repo.updateSpeechDraft(id, gen, 'turn', '迟到')).toThrow();
    expect(
      entry.repo.eventsAfter(id, before.lastEventSeq).some((e) => e.type === 'speech.cleared'),
    ).toBe(true);
  });
  it('publishes partial text while awaiting output and clears it if cancelled', async () => {
    const { repo, ready } = setup(),
      s = ready(),
      controller = new AbortController();
    let started!: () => void;
    const partial = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gateway = {
      generate: async (request: { onText: (text: string) => void }) => {
        request.onText('这句话还没有完成');
        started();
        await new Promise<void>((resolve) =>
          controller.signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        throw new AppError('CANCELLED', '测试取消', 409);
      },
    } as unknown as ModelGateway;
    const pending = new SpeechService(repo, gateway).speak(
      s,
      s.participants[1].id,
      'expert',
      controller.signal,
    );
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await partial;
    expect(repo.snapshot(s.discussion.id).draft?.content).toBe('这句话还没有完成');
    expect(repo.snapshot(s.discussion.id).messages).toEqual([]);
    controller.abort();
    await rejected;
    expect(repo.snapshot(s.discussion.id).draft).toBeNull();
    expect(repo.snapshot(s.discussion.id).participants[1].status).toBe('idle');
  });
  it('resets a repaired attempt before showing new text and only commits the validated result', async () => {
    const { repo, ready } = setup(),
      s = ready();
    const gateway = {
      generate: async (request: { onText: (text: string) => void }) => {
        request.onText('第一版未通过校验');
        request.onText('');
        expect(repo.snapshot(s.discussion.id).draft?.content).toBe('');
        request.onText('修复后的发言。');
        return { sentences: ['修复后的发言。'] };
      },
    } as unknown as ModelGateway;
    const m = await new SpeechService(repo, gateway).speak(
      s,
      s.participants[1].id,
      'expert',
      new AbortController().signal,
    );
    expect(repo.snapshot(s.discussion.id).messages).toEqual([m]);
    expect(m.content).toBe('修复后的发言。');
    expect(repo.snapshot(s.discussion.id).draft).toBeNull();
  });
});
