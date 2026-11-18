import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { parseEnv } from 'node:util';
import { readModelCatalog } from '../apps/api/src/model-catalog';
import { createApp } from '../apps/api/src/app';
import { makeSample } from '../packages/domain/src/samples';

const env = parseEnv(`
PANEL_MODELS=PRIMARY,SECOND,UNCONFIGURED
MODEL_PRIMARY_NAME=研究模型
MODEL_PRIMARY_PROVIDER=custom
MODEL_PRIMARY_PROTOCOL=openai-chat
MODEL_PRIMARY_BASE_URL=https://example.com/v1
MODEL_PRIMARY_MODEL=first-model
MODEL_PRIMARY_API_KEY='test-private#quoted-key'
MODEL_SECOND_NAME=同供应商的另一模型
MODEL_SECOND_PROVIDER=custom
MODEL_SECOND_PROTOCOL=openai-responses
MODEL_SECOND_BASE_URL=https://example.com/v1
MODEL_SECOND_MODEL=second-model
MODEL_SECOND_API_KEY=second-private
`);
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
const dirs: string[] = [];
function directory() {
  mkdirSync(resolve('.tmp'), { recursive: true });
  const dir = mkdtempSync(resolve('.tmp/catalog-'));
  dirs.push(dir);
  return dir;
}
async function open(dir: string, modelEnv: NodeJS.ProcessEnv) {
  const app = await createApp({ dataDir: dir, modelEnv });
  apps.push(app);
  return app;
}
async function close(app: Awaited<ReturnType<typeof createApp>>) {
  apps.splice(apps.indexOf(app), 1);
  await app.app.close();
}
afterEach(async () => {
  for (const app of apps.splice(0)) await app.app.close();
  for (const dir of dirs.splice(0)) {
    if (!dir.startsWith(resolve('.tmp') + sep)) throw new Error('invalid cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('预配置环境模型目录', () => {
  it('loads multiple models per provider, preserves quoted keys and skips blank templates', () => {
    expect(readModelCatalog({}).models).toEqual([]);
    const catalog = readModelCatalog(env);
    expect(catalog.models.map((m) => m.id)).toEqual(['env:PRIMARY', 'env:SECOND']);
    expect(catalog.models[0].input.apiKey).toBe('test-private#quoted-key');
    expect(catalog.models[1].input.protocol).toBe('openai-responses');
    expect(catalog.models.every((m) => m.input.provider === 'custom')).toBe(true);
  });

  it('rejects partial or invalid configuration without printing values or credentials', () => {
    for (const patch of [
      { PANEL_MODELS: 'PRIMARY,PRIMARY' },
      { PANEL_MODELS: 'invalid-private-id' },
      { MODEL_PRIMARY_API_KEY: '' },
      { MODEL_PRIMARY_PROTOCOL: 'private-invalid-protocol' },
      { MODEL_PRIMARY_BASE_URL: 'https://private-user:private-key@example.com' },
      { MODEL_PRIMARY_STRUCTURED_OUTPUT: 'private-invalid' },
      { PANEL_DEFAULT_MODERATOR: 'private-missing-model' },
    ]) {
      let error: unknown;
      try {
        readModelCatalog({ ...env, ...patch });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain('private');
      expect(String(error)).not.toContain('quoted-key');
    }
  });

  it('keeps identity, version, connection test and selected default across restart', async () => {
    const dir = directory();
    const first = await open(dir, env);
    expect(first.repo.settings().defaultModeratorConnectionId).toBe('env:PRIMARY');
    first.repo.markTest('env:PRIMARY', 1, true);
    first.repo.saveSettings('env:SECOND');
    const before = first.repo.listConnections();
    await close(first);
    const second = await open(dir, env);
    expect(second.repo.listConnections()).toEqual(before);
    expect(second.repo.settings().defaultModeratorConnectionId).toBe('env:SECOND');
    expect(
      (
        second.repo.db.prepare('SELECT count(*) AS n FROM model_connection_versions').get() as {
          n: number;
        }
      ).n,
    ).toBe(2);
  });

  it('rotates configuration while retaining the encrypted version frozen for an existing discussion', async () => {
    const dir = directory();
    const first = await open(dir, env);
    const created = first.repo.createDiscussion(
      '如何确认模型版本不会在讨论中变化？',
      4,
      'env:PRIMARY',
    );
    const cast = first.repo.saveCast(
      created.discussion.id,
      created.discussion.generation,
      makeSample(0).participants.map((p, i) => ({
        ...p,
        id: `p${i}`,
        discussionId: created.discussion.id,
      })),
    );
    first.repo.start(cast.discussion.id, cast.discussion.version, cast.discussion.castVersion, 3);
    await close(first);
    const second = await open(dir, {
      ...env,
      MODEL_PRIMARY_MODEL: 'rotated-model',
      MODEL_PRIMARY_API_KEY: 'rotated-private',
    });
    expect(second.repo.connection('env:PRIMARY').version).toBe(2);
    expect(second.repo.connection('env:PRIMARY').testStatus).toBe('untested');
    const frozen = second.repo.hostConnection(created.discussion.id);
    expect(frozen.model).toBe('first-model');
    expect(frozen.apiKey).toBe('test-private#quoted-key');
    const rows = second.repo.db.prepare('SELECT * FROM model_connection_versions').all();
    expect(JSON.stringify(rows)).not.toContain('private');
    expect(JSON.stringify(rows)).not.toContain('quoted-key');
  });

  it('deactivates removed models, preserves history and uses an explicit env default', async () => {
    const instance = await open(directory(), env);
    instance.repo.saveSettings('env:SECOND');
    instance.repo.syncModelCatalog(
      readModelCatalog({ ...env, PANEL_DEFAULT_MODERATOR: 'PRIMARY' }),
    );
    expect(instance.repo.settings().defaultModeratorConnectionId).toBe('env:PRIMARY');
    instance.repo.syncModelCatalog(readModelCatalog({ ...env, PANEL_MODELS: 'SECOND' }));
    expect(instance.repo.settings().defaultModeratorConnectionId).toBe('env:SECOND');
    expect(instance.repo.connection('env:PRIMARY').active).toBe(false);
    expect(instance.repo.connection('env:PRIMARY', 1).apiKey).toBe('test-private#quoted-key');
    expect(() =>
      instance.repo.createDiscussion('已经移除的模型不能开启新讨论', 4, 'env:PRIMARY'),
    ).toThrow();
    instance.repo.syncModelCatalog(readModelCatalog({}));
    expect(instance.repo.settings().defaultModeratorConnectionId).toBeNull();
    expect(instance.repo.listConnections().some((c) => c.active)).toBe(false);
  });

  it('publishes ready-to-select models without secrets and rejects web configuration writes', async () => {
    const instance = await open(directory(), env);
    const list = await instance.app.inject('/api/model-connections');
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(2);
    expect(list.body).not.toContain('private');
    expect(list.body).not.toContain('apiKey');
    for (const method of ['POST', 'PATCH'] as const) {
      const response = await instance.app.inject({
        method,
        url: '/api/model-connections' + (method === 'PATCH' ? '/env:PRIMARY' : ''),
        headers: { 'x-panel-client': 'local', 'content-type': 'application/json' },
        payload: { apiKey: 'injected-private' },
      });
      expect(response.statusCode).toBe(405);
      expect(response.json().error.code).toBe('ENV_MANAGED');
      expect(response.body).not.toContain('injected-private');
    }
    expect(instance.repo.connection('env:PRIMARY').version).toBe(1);
  });
});
