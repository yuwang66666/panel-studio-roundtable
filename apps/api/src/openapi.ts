import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  ConnectionSummarySchema,
  CreateDiscussionSchema,
  BindingsCommandSchema,
  VersionCommandSchema,
  StartCommandSchema,
  SettingsSchema,
  SnapshotSchema,
  DiscussionSchema,
  PublicEventSchema,
} from '@panel/contracts';
const schemas = {
  Empty: z.object({}).strict(),
  ConnectionSummary: ConnectionSummarySchema,
  CreateDiscussion: CreateDiscussionSchema,
  BindingsCommand: BindingsCommandSchema,
  VersionCommand: VersionCommandSchema,
  StartCommand: StartCommandSchema,
  Settings: SettingsSchema,
  Snapshot: SnapshotSchema,
  Discussion: DiscussionSchema,
  PublicEvent: PublicEventSchema,
};
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown) => ({ 'application/json': { schema } });
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const keyParam = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  schema: { type: 'string', minLength: 1, maxLength: 200 },
};
function operation(
  summary: string,
  output: unknown,
  input?: string,
  code = 200,
  hasId = false,
  idem = false,
) {
  return {
    summary,
    parameters: [...(hasId ? [idParam] : []), ...(idem ? [keyParam] : [])],
    ...(input ? { requestBody: { required: true, content: json(ref(input)) } } : {}),
    responses: {
      [code]: { description: '成功', content: json(output) },
      400: { description: '参数错误' },
      403: { description: '本地来源校验失败' },
      404: { description: '资源不存在' },
      409: { description: '状态或版本冲突' },
      429: { description: '并发或调用预算限制' },
      502: { description: '模型调用或输出校验失败' },
    },
  };
}
export function openapi() {
  return {
    openapi: '3.0.3',
    info: {
      title: 'AI Panel Studio 本地 API',
      version: '0.1.0',
      description:
        '模型配置与凭据从根目录 .env 由后端启动时加载，网页仅选择已配置模型。旧 POST /model-connections 与 PATCH /model-connections/{id} 对合法本地 JSON 请求返回 405 ENV_MANAGED。写接口只允许配置的本地 Origin；无 Origin 的 CLI 需发送 X-Panel-Client: local。所有公开响应均为白名单类型，不包含密钥。',
    },
    servers: [{ url: '/api' }],
    paths: {
      '/health': {
        get: operation('健康检查', { type: 'object', properties: { ok: { type: 'boolean' } } }),
      },
      '/model-connections': {
        get: operation('列出环境管理的模型摘要，选择时使用 active=true 的项', {
          type: 'array',
          items: ref('ConnectionSummary'),
        }),
      },
      '/model-connections/{id}/test': {
        post: operation(
          '最小真实调用测试',
          { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' } } },
          'Empty',
          200,
          true,
        ),
      },
      '/settings': {
        get: operation('查询默认主持人', ref('Settings')),
        patch: operation('设置默认主持人', ref('Settings'), 'Settings'),
      },
      '/discussions': {
        get: {
          ...operation('查询讨论列表', {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                items: {
                  allOf: [
                    ref('Discussion'),
                    { type: 'object', properties: { preview: { type: 'string' } } },
                  ],
                },
              },
              nextCursor: { type: 'string', nullable: true },
            },
          }),
          parameters: [
            { name: 'status', in: 'query', schema: { type: 'string' } },
            { name: 'cursor', in: 'query', schema: { type: 'string' } },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
            },
          ],
        },
        post: operation(
          '创建讨论并异步生成阵容',
          ref('Snapshot'),
          'CreateDiscussion',
          202,
          false,
          true,
        ),
      },
      '/discussions/{id}/snapshot': {
        get: operation('读取一致快照与事件游标', ref('Snapshot'), undefined, 200, true),
      },
      '/discussions/{id}/usage': {
        get: operation(
          '查询调用和 token 用量',
          {
            type: 'object',
            properties: {
              calls: { type: 'integer' },
              errorCalls: { type: 'integer' },
              inputTokens: { type: 'integer' },
              outputTokens: { type: 'integer' },
            },
          },
          undefined,
          200,
          true,
        ),
      },
      '/discussions/{id}/agent-bindings': {
        put: operation(
          '更新确认阶段的模型分配',
          ref('Snapshot'),
          'BindingsCommand',
          200,
          true,
          true,
        ),
      },
      '/discussions/{id}/start': {
        post: operation(
          '冻结连接版本并启动唯一执行器',
          ref('Snapshot'),
          'StartCommand',
          202,
          true,
          true,
        ),
      },
      '/discussions/{id}/finish': {
        post: operation(
          '请求结束或对中断讨论生成总结',
          ref('Snapshot'),
          'VersionCommand',
          202,
          true,
          true,
        ),
      },
      '/discussions/{id}/retry': {
        post: operation(
          '按失败阶段重试阵容或总结',
          ref('Snapshot'),
          'VersionCommand',
          202,
          true,
          true,
        ),
      },
      '/discussions/{id}/events': {
        get: {
          summary: '持久事件 SSE 流；event: panel；id: eventSeq；缺口重置 event: reset',
          parameters: [
            idParam,
            { name: 'after', in: 'query', schema: { type: 'integer', minimum: 0 } },
            { name: 'Last-Event-ID', in: 'header', schema: { type: 'integer', minimum: 0 } },
          ],
          responses: {
            200: {
              description: '按游标补发的公开事件，Last-Event-ID 优先于 after；20秒心跳。',
              content: { 'text/event-stream': { schema: { type: 'string' } } },
            },
          },
        },
      },
    },
    components: {
      schemas: Object.fromEntries(
        Object.entries(schemas).map(([name, schema]) => [
          name,
          zodToJsonSchema(schema, { $refStrategy: 'none', target: 'openApi3' }),
        ]),
      ),
    },
  };
}
