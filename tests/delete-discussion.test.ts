import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { createApp } from '../apps/api/src/app';
import { makeSample } from '../packages/domain/src/samples';
import type { DiscussionStatus } from '../packages/contracts/src/index';

const opened: { instance: Awaited<ReturnType<typeof createApp>>; dir: string }[] = [];
const headers = { 'x-panel-client': 'local', 'content-type': 'application/json' };
const tables = [
  'insight_evidence',
  'insights',
  'speech_drafts',
  'closing_jobs',
  'messages',
  'agent_bindings',
  'participants',
  'discussion_events',
  'model_runs',
];
async function setup() {
  mkdirSync(resolve('.tmp'), { recursive: true });
  const dir = mkdtempSync(resolve('.tmp/delete-history-'));
  const instance = await createApp({ dataDir: dir, recover: false });
  opened.push({ instance, dir });
  const { repo } = instance;
  repo.importSample(makeSample(0));
  repo.importSample(makeSample(1));
  const remove = (id = 'sample-1', version = repo.discussion(id).version) =>
    instance.app.inject({
      method: 'DELETE',
      url: `/api/discussions/${id}`,
      headers,
      payload: { expectedVersion: version },
    });
  return { ...instance, remove };
}
function status(s: Awaited<ReturnType<typeof setup>>, value: DiscussionStatus) {
  const d = { ...s.repo.discussion('sample-1'), status: value };
  s.repo.db
    .prepare('UPDATE discussions SET status=?,data_json=? WHERE id=?')
    .run(value, JSON.stringify(d), d.id);
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { instance, dir } of opened.splice(0)) {
    await instance.app.close();
    if (!dir.startsWith(resolve('.tmp') + sep)) throw Error('Invalid cleanup path');
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('历史讨论删除', () => {
  it('removes all discussion data and receipts while preserving other discussions and shared models', async () => {
    const s = await setup(),
      { repo } = s,
      beforeOther = repo.snapshot('sample-2'),
      snapshot = repo.snapshot('sample-1'),
      id = snapshot.discussion.id;
    const connection = repo.saveConnection({
      name: '共享模型',
      provider: 'custom',
      protocol: 'openai-chat',
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'delete-test',
      apiKey: 'TEST_ONLY_PRIVATE_KEY',
      active: true,
      structuredOutput: false,
    });
    repo.saveSettings(connection.id);
    repo.db
      .prepare('INSERT INTO agent_bindings VALUES(?,?,?,?,?)')
      .run(id, snapshot.participants[0].id, connection.id, connection.version, '{}');
    // Residual drafts/tasks must be removed as well, even after an interrupted process.
    repo.db
      .prepare('INSERT INTO speech_drafts VALUES(?,?,?,?,?)')
      .run(id, 'stale-draft', 1, snapshot.participants[0].id, '{}');
    repo.db.prepare('INSERT INTO closing_jobs VALUES(?,?,?)').run(id, 1, '{}');
    repo.db.prepare('INSERT INTO discussion_events VALUES(?,?,?)').run(id, 1, '{}');
    for (const discussionId of [id, 'sample-2'])
      repo.recordRun({
        discussionId,
        purpose: 'summary',
        connection: repo.connection(connection.id),
        latencyMs: 10,
        usage: { inputTokens: 10, outputTokens: 20 },
        errorCode: null,
      });
    for (const scope of ['bindings', 'retry', 'start', 'finish'])
      repo.command(`${scope}:${id}`, `${scope}-key`, {}, () => snapshot);
    repo.command('start:sample-2', 'other-key', {}, () => beforeOther);
    for (const table of tables)
      expect(
        (repo.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE discussion_id=?`).get(id) as any)
          .n,
      ).toBeGreaterThan(0);

    const response = await s.remove(id, snapshot.discussion.version);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id, deleted: true });
    for (const table of tables)
      expect(
        repo.db.prepare(`SELECT 1 FROM ${table} WHERE discussion_id=?`).get(id),
      ).toBeUndefined();
    expect(repo.db.prepare('SELECT 1 FROM discussions WHERE id=?').get(id)).toBeUndefined();
    expect(repo.db.prepare('SELECT scope FROM command_receipts').all()).toEqual([
      { scope: 'start:sample-2' },
    ]);
    expect(repo.snapshot('sample-2')).toEqual(beforeOther);
    expect(repo.usage('sample-2').calls).toBe(1);
    expect(repo.settings().defaultModeratorConnectionId).toBe(connection.id);
    expect(repo.connection(connection.id).apiKey).toBe('TEST_ONLY_PRIVATE_KEY');
    expect(repo.db.pragma('foreign_key_check')).toEqual([]);
    expect((await s.app.inject(`/api/discussions/${id}/snapshot`)).statusCode).toBe(404);
    expect((await s.remove(id, snapshot.discussion.version)).statusCode).toBe(200);
    expect((await s.app.inject('/api/discussions')).json().items.map((d: any) => d.id)).toEqual([
      'sample-2',
    ]);
  });

  it('discards saved command payloads and prevents old create/start requests from reviving deleted history', async () => {
    const s = await setup(),
      snapshot = s.repo.snapshot('sample-1'),
      body = { topic: snapshot.discussion.topic, expertCount: 4 };
    s.repo.command('discussion:create', 'old-create', body, () => snapshot);
    s.repo.command(
      'start:sample-1',
      'old-start',
      { expectedVersion: 1, castVersion: 1 },
      () => snapshot,
    );
    await s.remove();
    const receipts = s.repo.db.prepare('SELECT result_json FROM command_receipts').all();
    expect(receipts).toEqual([
      { result_json: JSON.stringify({ deletedDiscussionId: 'sample-1' }) },
    ]);
    const create = await s.app.inject({
      method: 'POST',
      url: '/api/discussions',
      headers: { ...headers, 'idempotency-key': 'old-create' },
      payload: body,
    });
    expect(create.statusCode).toBe(410);
    expect(create.json().error.code).toBe('DISCUSSION_DELETED');
    const start = await s.app.inject({
      method: 'POST',
      url: '/api/discussions/sample-1/start',
      headers: { ...headers, 'idempotency-key': 'old-start' },
      payload: { expectedVersion: 1, castVersion: 1 },
    });
    expect(start.statusCode).toBe(404);
    expect(s.repo.list().items).toHaveLength(1);
  });

  it('rolls back every deleted row and receipt if the database rejects the final delete', async () => {
    const s = await setup(),
      before = s.repo.snapshot('sample-1');
    s.repo.command('discussion:create', 'rollback-create', {}, () => before);
    const receipt = s.repo.db.prepare('SELECT * FROM command_receipts').all();
    s.repo.db.exec(
      "CREATE TRIGGER reject_delete BEFORE DELETE ON discussions WHEN OLD.id='sample-1' BEGIN SELECT RAISE(ABORT,'test write failure'); END",
    );
    expect((await s.remove()).statusCode).toBe(500);
    expect(s.repo.snapshot('sample-1')).toEqual(before);
    expect(s.repo.db.prepare('SELECT * FROM command_receipts').all()).toEqual(receipt);
    expect(s.repo.db.pragma('foreign_key_check')).toEqual([]);
  });

  it.each(['awaiting_confirmation', 'failed', 'interrupted'] as const)(
    'allows deletion of inactive %s discussions',
    async (value) => {
      const s = await setup();
      status(s, value);
      expect((await s.remove()).statusCode).toBe(200);
    },
  );
  it.each(['casting', 'running', 'summarizing'] as const)(
    'rejects deletion of %s discussions without changing their history',
    async (value) => {
      const s = await setup();
      status(s, value);
      const before = s.repo.snapshot('sample-1');
      expect((await s.remove()).statusCode).toBe(409);
      expect(s.repo.snapshot('sample-1')).toEqual(before);
    },
  );

  it('rejects stale versions, disallowed origins, and invalid commands', async () => {
    const s = await setup(),
      before = s.repo.snapshot('sample-1');
    expect((await s.remove('sample-1', before.discussion.version + 1)).statusCode).toBe(409);
    const request = {
      method: 'DELETE' as const,
      url: '/api/discussions/sample-1',
      payload: { expectedVersion: before.discussion.version },
    };
    expect(
      (await s.app.inject({ ...request, headers: { ...headers, origin: 'https://example.com' } }))
        .statusCode,
    ).toBe(403);
    expect((await s.app.inject({ ...request, headers, payload: {} })).statusCode).toBe(400);
    expect(s.repo.snapshot('sample-1')).toEqual(before);
  });

  it('rejects an interrupted discussion waiting in the recovery queue', async () => {
    const s = await setup();
    status(s, 'interrupted');
    s.discussions.resumeRecovered(['sample-1'], 0);
    expect(s.discussions.hasActive('sample-1')).toBe(false);
    expect((await s.remove()).statusCode).toBe(409);
    expect(s.repo.discussion('sample-1').status).toBe('interrupted');
  });

  it('waits for a failed discussion to release its active task before allowing deletion', async () => {
    const s = await setup();
    const connection = s.repo.saveConnection({
      name: '测试模型',
      provider: 'custom',
      protocol: 'openai-chat',
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'pending-test',
      apiKey: 'TEST_ONLY_KEY',
      active: true,
      structuredOutput: false,
    });
    const snapshot = s.repo.createDiscussion('删除与后台任务需要如何隔离？', 4, connection.id);
    let release!: () => void;
    const pending = new Promise<never>((_resolve, reject) => {
      release = () => reject(new Error('Test task stopped'));
    });
    vi.spyOn(s.gateway, 'generate').mockImplementation(() => pending);
    const id = snapshot.discussion.id;
    s.discussions.cast(id);
    await Promise.resolve();
    s.repo.transition(id, 'failed', { failureStage: 'cast', error: 'Test failure' });
    expect((await s.remove(id)).statusCode).toBe(409);
    release();
    await s.discussions.idle(id);
    expect((await s.remove(id)).statusCode).toBe(200);
  });

  it('notifies and closes existing event streams after deletion', async () => {
    const s = await setup();
    const address = await s.app.listen({ port: 0, host: '127.0.0.1' });
    const response = await fetch(`${address}/api/discussions/sample-1/events`, {
      signal: AbortSignal.timeout(2000),
    });
    expect(response.status).toBe(200);
    expect((await s.remove()).statusCode).toBe(200);
    const body = await response.text();
    expect(body).toContain('event: deleted');
    expect(body).toContain('data: {"id":"sample-1"}');
    expect((await s.app.inject('/api/discussions/sample-1/events')).statusCode).toBe(404);
  });
});
