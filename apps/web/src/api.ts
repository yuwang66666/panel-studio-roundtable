import type { DiscussionSnapshot, ModelConnectionSummary } from '@panel/contracts';
import { makeSample } from '../../../packages/domain/src/samples';
export const isPreview = window.location.pathname.startsWith('/preview');
const samples = Array.from({ length: 5 }, (_, i) => makeSample(i));
const previewConnections: ModelConnectionSummary[] = [
  {
    id: 'preview-model',
    name: '样例模型',
    provider: 'custom',
    protocol: 'openai-chat',
    baseUrl: 'https://example.invalid/v1',
    model: 'preview-model',
    structuredOutput: false,
    active: true,
    version: 1,
    hasApiKey: false,
    testedAt: null,
    testStatus: 'untested',
    createdAt: '2026-11-18T00:00:00.000Z',
  },
];
let defaultConnection: string | null = previewConnections[0].id;
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
export async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  if (isPreview) return previewRequest(path, method, body) as T;
  const response = await fetch(`/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(method !== 'GET' ? { 'Idempotency-Key': crypto.randomUUID() } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.error?.message || '请求失败，请重试', response.status);
  return data;
}
function previewRequest(path: string, method: string, body: any): unknown {
  if (path === '/settings') {
    if (method === 'PATCH') defaultConnection = body.defaultModeratorConnectionId;
    return { defaultModeratorConnectionId: defaultConnection };
  }
  if (path === '/model-connections' && method === 'GET') return previewConnections;
  if (path.startsWith('/model-connections'))
    throw Error('原型仅展示样例模型，真实模型请在项目 .env 中配置。');
  if (path.startsWith('/discussions?') || path === '/discussions') {
    if (method === 'POST') {
      const s = makeSample(0);
      s.discussion = {
        ...s.discussion,
        id: crypto.randomUUID(),
        topic: body.topic,
        expertCount: body.expertCount,
        status: 'awaiting_confirmation',
      };
      s.participants = s.participants
        .slice(0, body.expertCount + 1)
        .map((p) => ({ ...p, discussionId: s.discussion.id }));
      s.messages = [];
      s.insights = [];
      samples.unshift(s);
      return s;
    }
    return {
      items: samples.map((s) => ({
        ...s.discussion,
        preview: s.messages.at(-1)?.content || '阵容等待确认',
      })),
      nextCursor: null,
    };
  }
  const id = path.split('/')[2];
  const s = samples.find((s) => s.discussion.id === id);
  if (method === 'DELETE' && path === `/discussions/${id}`) {
    if (s) {
      if (['casting', 'running', 'summarizing'].includes(s.discussion.status))
        throw Error('讨论正在进行，请等待结束后再删除。');
      if (s.discussion.version !== body?.expectedVersion)
        throw Error('讨论已更新，请取消后重新选择要删除的会话。');
      samples.splice(samples.indexOf(s), 1);
    }
    return { id, deleted: true };
  }
  if (!s) throw Error('讨论不存在');
  if (path.endsWith('/agent-bindings')) {
    s.bindings = body.bindings.map((b: any) => ({
      ...b,
      connectionVersion: 1,
      model: previewConnections.find((c) => c.id === b.connectionId)?.model || '',
      provider: 'custom',
    }));
    s.discussion.version++;
  }
  if (path.endsWith('/start')) throw Error('原型只用于页面验证。真实讨论将在后端接入后启用。');
  return s satisfies DiscussionSnapshot;
}
