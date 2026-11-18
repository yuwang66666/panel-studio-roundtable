import Fastify, { LogController } from 'fastify';
import { z } from 'zod';
import {
  ConnectionInputSchema,
  ConnectionPatchSchema,
  SettingsSchema,
  CreateDiscussionSchema,
  BindingsCommandSchema,
  VersionCommandSchema,
  StartCommandSchema,
  StatusSchema,
} from '@panel/contracts';
import { Repository } from './repository';
import { ModelGateway } from './gateway';
import { config } from './config';
import { AppError, safeError } from './errors';
import { DiscussionService } from './discussions';
import { registerEvents } from './sse';
import { openapi } from './openapi';
export async function createApp(
  options: {
    dataDir?: string;
    logger?: boolean;
    recover?: boolean;
    origins?: string[];
    gatewayOptions?: ConstructorParameters<typeof ModelGateway>[1];
  } = {},
) {
  const repo = new Repository(options.dataDir || config.dataDir);
  if (options.recover !== false) repo.recover();
  const gateway = new ModelGateway(repo, options.gatewayOptions || { ...config, retryDelay: 400 });
  const discussions = new DiscussionService(repo, gateway);
  const app = Fastify({
    logger: options.logger ?? false,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 65536,
  });
  registerEvents(app, repo);
  app.addHook('onRequest', async (req) => {
    const hostname = req.hostname;
    if (!['localhost', '127.0.0.1'].includes(hostname))
      throw new AppError('HOST_REJECTED', '仅允许本地访问', 403);
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    const origin = req.headers.origin;
    if (
      origin
        ? !(options.origins || config.origins).includes(origin)
        : req.headers['x-panel-client'] !== 'local'
    )
      throw new AppError('ORIGIN_REJECTED', '请求来源不允许', 403);
    if (!req.headers['content-type']?.startsWith('application/json'))
      throw new AppError('CONTENT_TYPE', '请使用 JSON 请求', 415);
  });
  app.setErrorHandler((error, req, reply) => {
    let e =
      error instanceof z.ZodError
        ? new AppError(
            'VALIDATION',
            error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；'),
          )
        : safeError(error);
    if ((error as any).statusCode === 400 && !(error instanceof AppError))
      e = new AppError('VALIDATION', '请求格式错误');
    req.log.warn({ code: e.code, requestId: req.id }, 'Request rejected');
    reply.code(e.status).send({ error: { code: e.code, message: e.message } });
  });
  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/openapi.json', async () => openapi());
  app.get<{ Params: { id: string } }>('/api/discussions/:id/usage', async (req) =>
    repo.usage(req.params.id),
  );
  app.get('/api/model-connections', async () => repo.listConnections());
  app.post('/api/model-connections', async (req, reply) => {
    const body = ConnectionInputSchema.parse(req.body);
    const key = req.headers['idempotency-key'];
    const result =
      typeof key === 'string'
        ? repo.command('connection:create', key, body, () => repo.saveConnection(body)).result
        : repo.saveConnection(body);
    return reply.code(201).send(result);
  });
  app.patch<{ Params: { id: string } }>('/api/model-connections/:id', async (req) => {
    const body = ConnectionPatchSchema.parse(req.body);
    const key = req.headers['idempotency-key'];
    return typeof key === 'string'
      ? repo.command('connection:' + req.params.id, key, body, () =>
          repo.patchConnection(req.params.id, body),
        ).result
      : repo.patchConnection(req.params.id, body);
  });
  app.post<{ Params: { id: string } }>('/api/model-connections/:id/test', async (req) => {
    const c = repo.connection(req.params.id);
    if (!c.active) throw new AppError('DISABLED', '请先启用连接', 409);
    try {
      await gateway.generate({
        connection: c,
        purpose: 'test',
        input: {},
        schema: z.object({ ok: z.literal(true) }).strict(),
      });
      repo.markTest(c.id, c.version, true);
      return { ok: true, message: '连接验证通过，可用于圆桌讨论。' };
    } catch (e) {
      repo.markTest(c.id, c.version, false);
      throw e;
    }
  });
  app.get('/api/settings', async () => repo.settings());
  app.patch('/api/settings', async (req) =>
    repo.saveSettings(SettingsSchema.parse(req.body).defaultModeratorConnectionId),
  );
  app.post('/api/discussions', async (req, reply) => {
    const body = CreateDiscussionSchema.parse(req.body),
      key = z.string().min(1).max(200).parse(req.headers['idempotency-key']);
    const { result, replayed } = repo.command('discussion:create', key, body, () => {
      const host = body.moderatorConnectionId || repo.settings().defaultModeratorConnectionId;
      if (!host) throw new AppError('NO_MODERATOR', '请先配置默认主持人模型');
      return repo.createDiscussion(body.topic, body.expertCount, host);
    });
    if (!replayed) discussions.cast(result.discussion.id);
    return reply.code(202).send(result);
  });
  app.get('/api/discussions', async (req) => {
    const q = z
      .object({
        status: StatusSchema.optional(),
        cursor: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(req.query);
    return repo.list(q.status, q.cursor, q.limit);
  });
  app.get<{ Params: { id: string } }>('/api/discussions/:id/snapshot', async (req) =>
    repo.snapshot(req.params.id),
  );
  app.put<{ Params: { id: string } }>('/api/discussions/:id/agent-bindings', async (req) => {
    const body = BindingsCommandSchema.parse(req.body),
      key = z.string().min(1).max(200).parse(req.headers['idempotency-key']);
    return repo.command(`bindings:${req.params.id}`, key, body, () =>
      repo.bind(req.params.id, body.expectedVersion, body.castVersion, body.bindings),
    ).result;
  });
  app.post<{ Params: { id: string } }>('/api/discussions/:id/retry', async (req, reply) => {
    const body = VersionCommandSchema.parse(req.body),
      key = z.string().min(1).max(200).parse(req.headers['idempotency-key']),
      id = req.params.id;
    const { result, replayed } = repo.command(`retry:${id}`, key, body, () => {
      const d = repo.checkVersion(id, body.expectedVersion);
      if (d.status !== 'failed') throw new AppError('CONFLICT', '当前阶段不能重试', 409);
      if (d.failureStage === 'cast') {
        repo.refreshCastConnection(id);
        return repo.transition(id, 'casting', {
          expectedVersion: body.expectedVersion,
          bumpGeneration: true,
        });
      }
      if (
        !['summary', 'insights'].includes(d.failureStage || '') ||
        !repo.snapshot(id).messages.length
      )
        throw new AppError('CONFLICT', '请通过结束操作生成总结', 409);
      return resumeSummary(id, body.expectedVersion);
    });
    if (!replayed) {
      if (result.discussion.status === 'casting') discussions.cast(id);
      else discussions.summarize(id);
    }
    return reply.code(202).send(result);
  });
  function resumeSummary(id: string, version: number) {
    const count = (
      repo.db
        .prepare("SELECT count(*) AS n FROM discussions WHERE status IN ('running','summarizing')")
        .get() as any
    ).n;
    if (count >= config.maxDiscussions)
      throw new AppError('CAPACITY', '同时运行的讨论已达到上限', 429);
    repo.allowClosingRetry(id);
    return repo.transition(id, 'summarizing', { expectedVersion: version, bumpGeneration: true });
  }
  app.post<{ Params: { id: string } }>('/api/discussions/:id/start', async (req, reply) => {
    const body = StartCommandSchema.parse(req.body),
      key = z.string().min(1).max(200).parse(req.headers['idempotency-key']),
      id = req.params.id;
    const { result, replayed } = repo.command(`start:${id}`, key, body, () =>
      repo.start(id, body.expectedVersion, body.castVersion, config.maxDiscussions),
    );
    if (!replayed) discussions.run(id);
    return reply.code(202).send(result);
  });
  app.post<{ Params: { id: string } }>('/api/discussions/:id/finish', async (req, reply) => {
    const body = VersionCommandSchema.parse(req.body),
      key = z.string().min(1).max(200).parse(req.headers['idempotency-key']),
      id = req.params.id;
    const { result, replayed } = repo.command(`finish:${id}`, key, body, () => {
      const d = repo.checkVersion(id, body.expectedVersion);
      if (d.status === 'running') return repo.requestFinish(id, body.expectedVersion);
      if (
        ['failed', 'interrupted'].includes(d.status) &&
        d.failureStage !== 'cast' &&
        repo.snapshot(id).messages.length
      )
        return resumeSummary(id, body.expectedVersion);
      throw new AppError('CONFLICT', '当前讨论不能结束或总结', 409);
    });
    if (!replayed && result.discussion.status === 'summarizing') discussions.summarize(id);
    return reply.code(202).send(result);
  });
  app.addHook('onClose', async () => {
    await discussions.close();
    repo.close();
  });
  return { app, repo, gateway, discussions };
}
