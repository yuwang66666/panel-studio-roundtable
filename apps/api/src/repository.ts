import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import {
  ConnectionInputSchema,
  ConnectionSummarySchema,
  SnapshotSchema,
  DiscussionSchema,
  PublicEventSchema,
  type ConnectionInput,
  type ModelConnectionSummary,
  type Discussion,
  type DiscussionSnapshot,
  type Participant,
  type AgentBinding,
  type Message,
  type Insight,
  type PublicEvent,
  type DiscussionStatus,
} from '@panel/contracts';
import { assertTransition, callBudget } from '@panel/domain';
import { connections } from './schema';
import { AppError, conflict } from './errors';
export type PrivateConnection = ModelConnectionSummary & { apiKey: string };
const now = () => new Date().toISOString();
export class Repository {
  readonly db: Database.Database;
  readonly orm: ReturnType<typeof drizzle>;
  readonly events = new EventEmitter();
  private readonly key: Buffer;
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true });
    const keyPath = join(directory, 'master.key');
    if (!existsSync(keyPath)) {
      if (existsSync(join(directory, 'panel.sqlite')))
        throw new AppError(
          'MASTER_KEY_MISSING',
          '数据库已存在但本地主密钥缺失，请恢复对应 master.key',
          500,
        );
      writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
    }
    this.key = readFileSync(keyPath);
    if (this.key.length !== 32) throw new Error('Invalid local master key');
    this.db = new Database(join(directory, 'panel.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.transaction(() =>
      this.db.exec(
        readFileSync(new URL('../../../db/migrations/001.sql', import.meta.url), 'utf8'),
      ),
    )();
    this.orm = drizzle(this.db);
    this.events.setMaxListeners(100);
  }
  close() {
    this.events.removeAllListeners();
    this.db.close();
  }
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
  private encrypt(value: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }
  private decrypt(value: string) {
    const b = Buffer.from(value, 'base64'),
      cipher = createDecipheriv('aes-256-gcm', this.key, b.subarray(0, 12));
    cipher.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([cipher.update(b.subarray(28)), cipher.final()]).toString('utf8');
  }
  listConnections() {
    return this.orm
      .select()
      .from(connections)
      .all()
      .map((r) => ConnectionSummarySchema.parse(JSON.parse(r.dataJson)));
  }
  connection(id: string, version?: number): PrivateConnection {
    const current = this.orm.select().from(connections).where(eq(connections.id, id)).get();
    if (!current) throw new AppError('NOT_FOUND', '模型连接不存在', 404);
    const row = this.db
      .prepare('SELECT * FROM model_connection_versions WHERE connection_id=? AND version=?')
      .get(id, version || current.version) as any;
    if (!row) throw new AppError('NOT_FOUND', '模型连接版本不存在', 404);
    return {
      ...ConnectionSummarySchema.parse(JSON.parse(row.data_json)),
      apiKey: this.decrypt(row.encrypted_key),
    };
  }
  saveConnection(input: ConnectionInput, id?: string) {
    return this.transaction(() => {
      const parsed = ConnectionInputSchema.parse(input);
      const previous = id ? this.connection(id) : undefined;
      const { apiKey, ...publicConfig } = parsed;
      const summary: ModelConnectionSummary = {
        ...publicConfig,
        id: id || randomUUID(),
        version: (previous?.version || 0) + 1,
        hasApiKey: true,
        testedAt: null,
        testStatus: 'untested',
        createdAt: previous?.createdAt || now(),
      };
      this.orm
        .insert(connections)
        .values({
          id: summary.id,
          version: summary.version,
          active: +summary.active,
          dataJson: JSON.stringify(summary),
        })
        .onConflictDoUpdate({
          target: connections.id,
          set: {
            version: summary.version,
            active: +summary.active,
            dataJson: JSON.stringify(summary),
          },
        })
        .run();
      this.db
        .prepare('INSERT INTO model_connection_versions VALUES(?,?,?,?)')
        .run(summary.id, summary.version, JSON.stringify(summary), this.encrypt(apiKey));
      return ConnectionSummarySchema.parse(summary);
    });
  }
  patchConnection(id: string, patch: Partial<ConnectionInput>) {
    const existing = this.connection(id);
    const input = {
      name: existing.name,
      provider: existing.provider,
      protocol: existing.protocol,
      baseUrl: existing.baseUrl,
      model: existing.model,
      apiKey: existing.apiKey,
      active: existing.active,
      structuredOutput: existing.structuredOutput,
      ...patch,
    };
    return this.saveConnection(input, id);
  }
  markTest(id: string, version: number, passed: boolean) {
    this.transaction(() => {
      const c = this.listConnections().find((c) => c.id === id);
      if (!c || c.version !== version) return;
      c.testStatus = passed ? 'passed' : 'failed';
      c.testedAt = now();
      this.db
        .prepare('UPDATE model_connections SET data_json=? WHERE id=?')
        .run(JSON.stringify(c), id);
      this.db
        .prepare(
          'UPDATE model_connection_versions SET data_json=? WHERE connection_id=? AND version=?',
        )
        .run(JSON.stringify(c), id, version);
    });
  }
  settings() {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key='defaultModeratorConnectionId'")
      .get() as any;
    return { defaultModeratorConnectionId: row ? (JSON.parse(row.value) as string | null) : null };
  }
  saveSettings(id: string | null) {
    if (id && !this.connection(id).active) throw conflict('请选择启用的模型连接');
    this.db
      .prepare(
        'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run('defaultModeratorConnectionId', JSON.stringify(id));
    return this.settings();
  }
  command<T>(
    scope: string,
    key: string,
    input: unknown,
    fn: () => T,
  ): { result: T; replayed: boolean } {
    return this.transaction(() => {
      const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const receipt = this.db
        .prepare('SELECT * FROM command_receipts WHERE scope=? AND idempotency_key=?')
        .get(scope, key) as any;
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw conflict('同一幂等标识不能用于不同请求');
        return { result: JSON.parse(receipt.result_json) as T, replayed: true };
      }
      const result = fn();
      this.db
        .prepare('INSERT INTO command_receipts VALUES(?,?,?,?)')
        .run(scope, key, fingerprint, JSON.stringify(result));
      return { result, replayed: false };
    });
  }
  createDiscussion(topic: string, expertCount: number, hostId: string, maxUtterances = 16) {
    return this.transaction(() => {
      const host = this.connection(hostId);
      if (!host.active) throw conflict('主持人模型连接已停用');
      const d: Discussion = {
        id: randomUUID(),
        topic,
        expertCount,
        status: 'casting',
        version: 1,
        castVersion: 0,
        generation: 1,
        finishRequested: false,
        failureStage: null,
        error: null,
        maxUtterances,
        maxCalls: callBudget(expertCount, maxUtterances),
        callCount: 0,
        insightsThrough: 0,
        isSample: false,
        createdAt: now(),
        updatedAt: now(),
      };
      this.db
        .prepare(
          'INSERT INTO discussions (id,status,version,generation,updated_at,data_json,host_connection_id,host_version) VALUES(?,?,?,?,?,?,?,?)',
        )
        .run(
          d.id,
          d.status,
          d.version,
          d.generation,
          d.updatedAt,
          JSON.stringify(d),
          host.id,
          host.version,
        );
      this.emit(d.id, 'discussion.status_changed', { discussion: d });
      return this.snapshot(d.id);
    });
  }
  discussion(id: string): Discussion {
    const r = this.db.prepare('SELECT data_json FROM discussions WHERE id=?').get(id) as any;
    if (!r) throw new AppError('NOT_FOUND', '讨论不存在', 404);
    return DiscussionSchema.parse(JSON.parse(r.data_json));
  }
  private persist(d: Discussion) {
    d.updatedAt = now();
    DiscussionSchema.parse(d);
    this.db
      .prepare(
        'UPDATE discussions SET status=?,version=?,generation=?,updated_at=?,data_json=? WHERE id=?',
      )
      .run(d.status, d.version, d.generation, d.updatedAt, JSON.stringify(d), d.id);
  }
  snapshot(id: string): DiscussionSnapshot {
    return this.transaction(() => {
      const parse = (table: string, order = '') =>
        this.db
          .prepare(`SELECT data_json FROM ${table} WHERE discussion_id=? ${order}`)
          .all(id)
          .map((r: any) => JSON.parse(r.data_json));
      const seq = this.db
        .prepare(
          'SELECT COALESCE(MAX(event_seq),0) AS seq FROM discussion_events WHERE discussion_id=?',
        )
        .get(id) as any;
      return SnapshotSchema.parse({
        discussion: this.discussion(id),
        participants: parse('participants', 'ORDER BY rowid'),
        bindings: parse('agent_bindings'),
        messages: parse('messages', 'ORDER BY message_seq'),
        insights: parse('insights', 'ORDER BY rowid'),
        lastEventSeq: seq.seq,
      });
    });
  }
  list(status?: string, cursor?: string, limit = 50) {
    const all = this.db
      .prepare('SELECT data_json FROM discussions ORDER BY updated_at DESC,id DESC')
      .all()
      .map((r: any) => this.discussion(JSON.parse(r.data_json).id))
      .filter((d) => !status || d.status === status);
    const offset = cursor ? all.findIndex((d) => d.id === cursor) + 1 : 0;
    const selected = all.slice(offset, offset + limit);
    return {
      items: selected.map((d) => ({
        ...d,
        preview: (
          this.db
            .prepare(
              'SELECT data_json FROM messages WHERE discussion_id=? ORDER BY message_seq DESC LIMIT 1',
            )
            .get(d.id) as any
        )?.data_json
          ? JSON.parse(
              (
                this.db
                  .prepare(
                    'SELECT data_json FROM messages WHERE discussion_id=? ORDER BY message_seq DESC LIMIT 1',
                  )
                  .get(d.id) as any
              ).data_json,
            ).content
          : '',
      })),
      nextCursor: offset + limit < all.length ? selected.at(-1)?.id : null,
    };
  }
  guard(id: string, generation: number, allowed: DiscussionStatus[]) {
    const d = this.discussion(id);
    if (d.generation !== generation || !allowed.includes(d.status))
      throw new AppError('STALE_RESULT', '已忽略过期的模型结果', 409);
    return d;
  }
  checkVersion(id: string, expectedVersion: number) {
    const d = this.discussion(id);
    if (d.version !== expectedVersion) throw conflict();
    return d;
  }
  private emit(id: string, type: PublicEvent['type'], payload: unknown) {
    const seq = (
      this.db
        .prepare(
          'SELECT COALESCE(MAX(event_seq),0)+1 AS seq FROM discussion_events WHERE discussion_id=?',
        )
        .get(id) as any
    ).seq;
    const event = PublicEventSchema.parse({
      discussionId: id,
      seq,
      type,
      payload,
      schemaVersion: 1,
      occurredAt: now(),
    });
    this.db
      .prepare('INSERT INTO discussion_events VALUES(?,?,?)')
      .run(id, seq, JSON.stringify(event));
    queueMicrotask(() => this.events.emit(id));
    return event;
  }
  eventsAfter(id: string, seq: number, limit = 100): PublicEvent[] {
    return this.db
      .prepare(
        'SELECT data_json FROM discussion_events WHERE discussion_id=? AND event_seq>? ORDER BY event_seq LIMIT ?',
      )
      .all(id, seq, limit)
      .map((r: any) => PublicEventSchema.parse(JSON.parse(r.data_json)));
  }
  hostConnection(id: string) {
    const s = this.snapshot(id),
      host = s.participants.find((p) => p.role === 'moderator'),
      binding = s.bindings.find((b) => b.participantId === host?.id);
    if (binding) return this.connection(binding.connectionId, binding.connectionVersion);
    const r = this.db
      .prepare('SELECT host_connection_id,host_version FROM discussions WHERE id=?')
      .get(id) as any;
    return this.connection(r.host_connection_id, r.host_version);
  }
  refreshCastConnection(id: string) {
    const r = this.db
      .prepare('SELECT host_connection_id FROM discussions WHERE id=?')
      .get(id) as any;
    const c = this.connection(r.host_connection_id);
    if (!c.active) throw conflict('原主持人连接已停用，请启用或更新连接');
    this.db.prepare('UPDATE discussions SET host_version=? WHERE id=?').run(c.version, id);
  }
  actorConnection(id: string, participantId: string) {
    const b = this.snapshot(id).bindings.find((b) => b.participantId === participantId);
    if (!b) throw conflict('专家尚未分配模型');
    return this.connection(b.connectionId, b.connectionVersion);
  }
  saveCast(id: string, generation: number, participants: Participant[]) {
    return this.transaction(() => {
      const d = this.guard(id, generation, ['casting']);
      const host = this.hostConnection(id);
      if (
        participants.length !== d.expertCount + 1 ||
        participants.filter((p) => p.role === 'moderator').length !== 1 ||
        participants.some((p) => p.discussionId !== id)
      )
        throw conflict('阵容人数或归属不正确');
      this.db.prepare('DELETE FROM agent_bindings WHERE discussion_id=?').run(id);
      this.db.prepare('DELETE FROM participants WHERE discussion_id=?').run(id);
      for (const p of participants) {
        this.db.prepare('INSERT INTO participants VALUES(?,?,?)').run(p.id, id, JSON.stringify(p));
        this.putBinding(id, p.id, host);
      }
      d.status = 'awaiting_confirmation';
      d.castVersion++;
      d.version++;
      d.failureStage = null;
      d.error = null;
      this.persist(d);
      const s = this.snapshot(id);
      this.emit(id, 'cast.ready', {
        discussion: d,
        participants: s.participants,
        bindings: s.bindings,
      });
      return this.snapshot(id);
    });
  }
  private putBinding(id: string, participantId: string, c: PrivateConnection) {
    const b: AgentBinding = {
      participantId,
      connectionId: c.id,
      connectionVersion: c.version,
      model: c.model,
      provider: c.provider,
    };
    this.db
      .prepare(
        'INSERT INTO agent_bindings VALUES(?,?,?,?,?) ON CONFLICT(discussion_id,participant_id) DO UPDATE SET connection_id=excluded.connection_id,connection_version=excluded.connection_version,data_json=excluded.data_json',
      )
      .run(id, participantId, c.id, c.version, JSON.stringify(b));
  }
  bind(
    id: string,
    expectedVersion: number,
    castVersion: number,
    bindings: { participantId: string; connectionId: string }[],
  ) {
    return this.transaction(() => {
      const d = this.checkVersion(id, expectedVersion),
        s = this.snapshot(id);
      if (d.status !== 'awaiting_confirmation' || d.castVersion !== castVersion) throw conflict();
      if (
        bindings.length !== s.participants.length ||
        new Set(bindings.map((b) => b.participantId)).size !== s.participants.length ||
        bindings.some((b) => !s.participants.some((p) => p.id === b.participantId))
      )
        throw conflict('必须为当前阵容中的每位参与者分配模型');
      for (const b of bindings) {
        const c = this.connection(b.connectionId);
        if (!c.active) throw conflict('不能选择已停用的连接');
        this.putBinding(id, b.participantId, c);
      }
      d.version++;
      this.persist(d);
      const next = this.snapshot(id);
      this.emit(id, 'cast.ready', {
        discussion: d,
        participants: next.participants,
        bindings: next.bindings,
      });
      return this.snapshot(id);
    });
  }
  transition(
    id: string,
    next: DiscussionStatus,
    options: {
      expectedVersion?: number;
      generation?: number;
      bumpGeneration?: boolean;
      failureStage?: Discussion['failureStage'];
      error?: string | null;
    } = {},
  ) {
    return this.transaction(() => {
      const d = options.expectedVersion
        ? this.checkVersion(id, options.expectedVersion)
        : this.discussion(id);
      if (options.generation !== undefined && d.generation !== options.generation)
        throw new AppError('STALE_RESULT', '过期执行器', 409);
      assertTransition(d.status, next);
      d.status = next;
      d.version++;
      if (options.bumpGeneration) d.generation++;
      d.failureStage = options.failureStage ?? null;
      d.error = options.error ?? null;
      this.persist(d);
      this.emit(id, next === 'failed' ? 'discussion.failed' : 'discussion.status_changed', {
        discussion: d,
      });
      return this.snapshot(id);
    });
  }
  start(id: string, expectedVersion: number, castVersion: number, maxConcurrent: number) {
    return this.transaction(() => {
      const s = this.snapshot(id);
      this.checkVersion(id, expectedVersion);
      if (
        s.discussion.castVersion !== castVersion ||
        s.discussion.status !== 'awaiting_confirmation'
      )
        throw conflict();
      const running = (
        this.db
          .prepare(
            "SELECT count(*) AS n FROM discussions WHERE status IN ('running','summarizing')",
          )
          .get() as any
      ).n;
      if (running >= maxConcurrent) throw new AppError('CAPACITY', '同时运行的讨论已达到上限', 429);
      if (s.bindings.length !== s.participants.length) throw conflict('请完成全部模型分配');
      for (const b of s.bindings) {
        const c = this.connection(b.connectionId);
        if (!c.active) throw conflict('绑定的模型连接已停用，请重新分配');
        this.putBinding(id, b.participantId, c);
      }
      const frozen = this.snapshot(id);
      this.emit(id, 'cast.ready', {
        discussion: frozen.discussion,
        participants: frozen.participants,
        bindings: frozen.bindings,
      });
      return this.transition(id, 'running', { expectedVersion, bumpGeneration: true });
    });
  }
  requestFinish(id: string, expectedVersion: number) {
    return this.transaction(() => {
      const d = this.checkVersion(id, expectedVersion);
      if (d.status !== 'running') throw conflict();
      d.finishRequested = true;
      d.version++;
      this.persist(d);
      this.emit(id, 'discussion.status_changed', { discussion: d });
      return this.snapshot(id);
    });
  }
  allowClosingRetry(id: string) {
    const d = this.discussion(id);
    d.maxCalls = Math.max(d.maxCalls, d.callCount + 12);
    this.persist(d);
  }
  setParticipantState(
    id: string,
    generation: number,
    participantId: string,
    status: Participant['status'],
    publicFocus: string | null,
  ) {
    this.transaction(() => {
      this.guard(id, generation, ['running', 'summarizing']);
      const p = this.snapshot(id).participants.find((p) => p.id === participantId);
      if (!p) throw conflict('参与者不属于当前讨论');
      p.status = status;
      p.publicFocus = publicFocus;
      this.db
        .prepare('UPDATE participants SET data_json=? WHERE discussion_id=? AND id=?')
        .run(JSON.stringify(p), id, p.id);
      this.emit(id, 'participant.state_changed', { participantId, status, publicFocus });
    });
  }
  clearStates(id: string) {
    this.transaction(() => {
      for (const p of this.snapshot(id).participants) {
        if (p.status === 'idle' && p.publicFocus === null) continue;
        p.status = 'idle';
        p.publicFocus = null;
        this.db
          .prepare('UPDATE participants SET data_json=? WHERE id=?')
          .run(JSON.stringify(p), p.id);
        this.emit(id, 'participant.state_changed', {
          participantId: p.id,
          status: 'idle',
          publicFocus: null,
        });
      }
    });
  }
  appendMessage(
    id: string,
    generation: number,
    input: Omit<Message, 'id' | 'discussionId' | 'messageSeq' | 'createdAt'>,
  ) {
    return this.transaction(() => {
      const d = this.guard(
        id,
        generation,
        input.kind === 'summary' ? ['summarizing'] : ['running'],
      );
      const existing = this.db
        .prepare('SELECT data_json FROM messages WHERE discussion_id=? AND turn_id=?')
        .get(id, input.turnId) as any;
      if (existing) return JSON.parse(existing.data_json) as Message;
      const s = this.snapshot(id),
        p = s.participants.find((p) => p.id === input.participantId);
      if (!p || (input.kind === 'expert') !== (p.role === 'expert'))
        throw conflict('发言角色不匹配');
      if (
        input.kind === 'summary' &&
        d.insightsThrough < (s.messages.filter((m) => m.kind !== 'summary').at(-1)?.messageSeq || 0)
      )
        throw conflict('洞察尚未覆盖全部发言，不能提交总结');
      if (
        input.replyToMessageId &&
        !s.messages.some((m) => m.id === input.replyToMessageId && m.kind !== 'summary')
      )
        throw conflict('回应目标不属于当前讨论');
      const message: Message = {
        ...input,
        id: randomUUID(),
        discussionId: id,
        messageSeq: (s.messages.at(-1)?.messageSeq || 0) + 1,
        createdAt: now(),
      };
      this.db
        .prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)')
        .run(
          message.id,
          id,
          message.messageSeq,
          message.turnId,
          message.participantId,
          message.replyToMessageId,
          JSON.stringify(message),
        );
      p.status = 'idle';
      p.publicFocus = null;
      this.db
        .prepare('UPDATE participants SET data_json=? WHERE id=?')
        .run(JSON.stringify(p), p.id);
      if (input.kind === 'summary') {
        assertTransition(d.status, 'completed');
        d.status = 'completed';
        d.version++;
      }
      this.persist(d);
      this.emit(id, 'participant.state_changed', {
        participantId: p.id,
        status: 'idle',
        publicFocus: null,
      });
      this.emit(id, input.kind === 'summary' ? 'summary.ready' : 'message.committed', {
        message,
        discussion: d,
      });
      return message;
    });
  }
  saveInsights(id: string, generation: number, through: number, insights: Insight[]) {
    this.transaction(() => {
      const d = this.guard(id, generation, ['running', 'summarizing']);
      if (through < d.insightsThrough) throw new AppError('STALE_RESULT', '洞察版本已过期', 409);
      const s = this.snapshot(id);
      if (through > (s.messages.filter((m) => m.kind !== 'summary').at(-1)?.messageSeq || 0))
        throw conflict('洞察覆盖范围超出消息范围');
      const valid = new Map(
        s.messages
          .filter((m) => m.kind !== 'summary' && m.messageSeq <= through)
          .map((m) => [m.id, m]),
      );
      for (const i of insights) {
        if (
          i.evidence.some((e) => !valid.has(e.messageId)) ||
          i.participantIds.some(
            (pid) => !s.participants.some((p) => p.id === pid && p.role === 'expert'),
          )
        )
          throw conflict('洞察证据或专家不属于当前讨论');
        if (i.kind === 'consensus') {
          const supporting = new Set(
            i.evidence
              .filter((e) => e.relation === 'supports')
              .map((e) => valid.get(e.messageId)!.participantId)
              .filter((pid) => s.participants.some((p) => p.id === pid && p.role === 'expert')),
          );
          if (
            supporting.size < 2 ||
            i.participantIds.some((pid) => !supporting.has(pid)) ||
            i.participantIds.length !== supporting.size
          )
            throw conflict('共识需要至少两位专家的明确支持证据');
          if (i.scope === 'all' && supporting.size !== d.expertCount)
            throw conflict('全体共识缺少专家支持');
        }
      }
      this.db.prepare('DELETE FROM insights WHERE discussion_id=?').run(id);
      for (const i of insights) {
        this.db.prepare('INSERT INTO insights VALUES(?,?,?)').run(id, i.id, JSON.stringify(i));
        for (const e of i.evidence)
          this.db
            .prepare('INSERT INTO insight_evidence VALUES(?,?,?,?)')
            .run(id, i.id, e.messageId, e.relation);
      }
      d.insightsThrough = through;
      this.persist(d);
      this.emit(id, 'insights.updated', { insights, discussion: d });
    });
  }
  reserveCall(id: string, generation: number, closing: boolean) {
    this.transaction(() => {
      const d = this.guard(id, generation, ['casting', 'running', 'summarizing']);
      if (d.finishRequested && !closing) throw new AppError('CANCELLED', '讨论正在结束', 409);
      if (d.callCount >= d.maxCalls - (closing ? 0 : 12))
        throw new AppError('BUDGET', '模型调用预算不足，正在收尾', 429);
      d.callCount++;
      this.persist(d);
    });
  }
  usage(id: string) {
    this.discussion(id);
    const rows = this.db
      .prepare('SELECT usage_json,error_code FROM model_runs WHERE discussion_id=?')
      .all(id) as { usage_json: string | null; error_code: string | null }[];
    return rows.reduce(
      (a, r) => {
        const u = r.usage_json ? JSON.parse(r.usage_json) : {};
        return {
          calls: a.calls + 1,
          errorCalls: a.errorCalls + (r.error_code ? 1 : 0),
          inputTokens: a.inputTokens + (u.inputTokens || 0),
          outputTokens: a.outputTokens + (u.outputTokens || 0),
        };
      },
      { calls: 0, errorCalls: 0, inputTokens: 0, outputTokens: 0 },
    );
  }
  recordRun(r: {
    discussionId?: string;
    participantId?: string;
    purpose: string;
    connection: PrivateConnection;
    latencyMs: number;
    usage: unknown;
    errorCode: string | null;
  }) {
    this.db
      .prepare(
        'INSERT INTO model_runs (id,discussion_id,participant_id,purpose,connection_id,connection_version,model,prompt_version,latency_ms,usage_json,error_code,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        randomUUID(),
        r.discussionId || null,
        r.participantId || null,
        r.purpose,
        r.connection.id,
        r.connection.version,
        r.connection.model,
        'v1',
        r.latencyMs,
        r.usage ? JSON.stringify(r.usage) : null,
        r.errorCode,
        now(),
      );
  }
  recover() {
    for (const r of this.db
      .prepare(
        "SELECT id,status FROM discussions WHERE status IN ('casting','running','summarizing')",
      )
      .all() as any[]) {
      this.transition(r.id, r.status === 'casting' ? 'failed' : 'interrupted', {
        bumpGeneration: true,
        failureStage:
          r.status === 'casting' ? 'cast' : r.status === 'summarizing' ? 'summary' : 'discussion',
        error: '服务重启导致执行中断，已有内容已保存',
      });
      this.clearStates(r.id);
    }
  }
  importSample(s: DiscussionSnapshot) {
    this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM discussions WHERE id=?').get(s.discussion.id)) return;
      const d = s.discussion;
      this.db
        .prepare(
          'INSERT INTO discussions (id,status,version,generation,updated_at,data_json,host_connection_id,host_version) VALUES(?,?,?,?,?,?,?,?)',
        )
        .run(d.id, d.status, d.version, d.generation, d.updatedAt, JSON.stringify(d), null, null);
      for (const p of s.participants)
        this.db
          .prepare('INSERT INTO participants VALUES(?,?,?)')
          .run(p.id, d.id, JSON.stringify(p));
      for (const m of s.messages)
        this.db
          .prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)')
          .run(
            m.id,
            d.id,
            m.messageSeq,
            m.turnId,
            m.participantId,
            m.replyToMessageId,
            JSON.stringify(m),
          );
      for (const i of s.insights) {
        this.db.prepare('INSERT INTO insights VALUES(?,?,?)').run(d.id, i.id, JSON.stringify(i));
        for (const e of i.evidence)
          this.db
            .prepare('INSERT INTO insight_evidence VALUES(?,?,?,?)')
            .run(d.id, i.id, e.messageId, e.relation);
      }
      SnapshotSchema.parse(this.snapshot(d.id));
    });
  }
}
