import type { DiscussionSnapshot, ModelConnectionSummary } from '@panel/contracts';
import { makeSample } from '../../../packages/domain/src/samples';
export const isPreview = window.location.pathname.startsWith('/preview');
const samples = Array.from({ length: 5 }, (_, i) => makeSample(i));
let previewConnections: ModelConnectionSummary[] = [];
let defaultConnection: string | null = null;
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
  if (!response.ok) throw new Error(data.error?.message || '请求失败，请重试');
  return data;
}
function previewRequest(path: string, method: string, body: any): unknown {
  if (path === '/settings') {
    if (method === 'PATCH') defaultConnection = body.defaultModeratorConnectionId;
    return { defaultModeratorConnectionId: defaultConnection };
  }
  if (path === '/model-connections') {
    if (method === 'POST') {
      const { apiKey: _, ...rest } = body;
      const c = {
        ...rest,
        id: crypto.randomUUID(),
        version: 1,
        hasApiKey: true,
        testedAt: null,
        testStatus: 'untested',
        createdAt: new Date().toISOString(),
      };
      previewConnections.push(c);
      return c;
    }
    return previewConnections;
  }
  if (path.startsWith('/model-connections/')) {
    const c = previewConnections.find((c) => c.id === path.split('/')[2]);
    if (!c) throw Error('连接不存在');
    if (path.endsWith('/test')) throw Error('原型不调用模型，请在正式模式配置连接。');
    const { apiKey: _, ...rest } = body;
    Object.assign(c, rest);
    return c;
  }
  if (path.startsWith('/discussions?') || path === '/discussions') {
    if (method === 'POST') {
      const s = structuredClone(samples[0]);
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
  const s = samples.find((s) => s.discussion.id === path.split('/')[2]);
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
