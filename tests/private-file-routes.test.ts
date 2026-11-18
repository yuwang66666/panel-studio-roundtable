import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { request as httpRequest } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { createClientFileSecurity } from '../apps/web/server-security';

const marker = 'PRIVATE_FIXTURE_CONTENT_MUST_NEVER_REACH_BROWSER';
const slash = (path: string) => path.replace(/\\/g, '/');
let workspace: string, webRoot: string, address: URL;
let server:
  | {
      close(): Promise<void>;
      transformRequest(url: string): Promise<unknown>;
      config: { webSocketToken: string; safeModulePaths: Set<string> };
    }
  | undefined;
function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
function get(path: string, method = 'GET') {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest(
      { hostname: address.hostname, port: address.port, path, method },
      (response) => {
        const body: Buffer[] = [];
        response.on('data', (chunk) => body.push(Buffer.from(chunk)));
        response.on('end', () =>
          resolve({ status: response.statusCode!, body: Buffer.concat(body).toString() }),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });
}
const fsPath = (path: string) => `/@fs/${slash(path)}`;
const encodedPath = (path: string) => encodeURI(path);

beforeAll(async () => {
  mkdirSync(resolve('.tmp'), { recursive: true });
  // A clean checkout may itself live beneath .tmp; that ancestor is not a reason
  // to deny its explicitly configured client directory.
  workspace = mkdtempSync(resolve('.tmp/private-file-routes-'));
  webRoot = resolve(workspace, 'apps/web');
  write(
    resolve(webRoot, 'index.html'),
    '<!doctype html><html lang="zh-CN"><body>中文界面<script type="module" src="/src/main.ts"></script></body></html>',
  );
  write(
    resolve(webRoot, 'src/main.ts'),
    'import { shared } from "../../../packages/domain/src/中文.ts"; import { client } from "fixture-client"; console.log(shared, client);',
  );
  write(resolve(workspace, 'packages/domain/src/中文.ts'), 'export const shared = "共享模块正常";');
  write(
    resolve(workspace, 'packages/contracts/src/index.ts'),
    'export const contract = "公开契约";',
  );
  write(
    resolve(webRoot, 'node_modules/fixture-client/package.json'),
    '{"name":"fixture-client","type":"module","exports":"./index.js"}',
  );
  write(
    resolve(webRoot, 'node_modules/fixture-client/index.js'),
    'export const client = "客户端依赖正常";',
  );
  write(
    resolve(webRoot, 'public/logo.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg"><title>公开图标</title></svg>',
  );
  for (const path of [
    '.env',
    '.env.local',
    '.data/master.key',
    '.data/panel.sqlite',
    '.data/panel.sqlite-wal',
    '.tmp/backup.json',
    '.git/config',
    'apps/api/src/private.ts',
    'db/migrations/private.sql',
    'other-private.json',
    'apps/web/.env.local',
    'apps/web/public/secret.key',
    'apps/web/public/.data/copied.json',
    'apps/web/node_modules/fixture-client/.env',
  ])
    write(resolve(workspace, path), marker);
  // The fixture uses real runtime dependencies through the same kind of junction
  // pnpm uses, while all private fixtures are confined to its own workspace.
  symlinkSync(resolve('node_modules'), resolve(workspace, 'node_modules'), 'junction');
  symlinkSync(resolve(workspace, 'apps/api'), resolve(webRoot, 'src/server-link'), 'junction');
  symlinkSync(resolve(workspace, 'apps/api'), resolve(webRoot, 'public/server-link'), 'junction');
  const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
  const vite = await import(pathToFileURL(require.resolve('vite')).href);
  const security = createClientFileSecurity(webRoot, workspace);
  const instance = await vite.createServer({
    configFile: false,
    root: webRoot,
    logLevel: 'silent',
    plugins: [security.plugin],
    optimizeDeps: { noDiscovery: true },
    server: { host: '127.0.0.1', port: 0, fs: security.fs },
  });
  server = instance;
  await instance.listen();
  address = new URL(`http://127.0.0.1:${instance.httpServer.address().port}`);
});
afterAll(async () => {
  await server?.close();
  if (workspace?.startsWith(resolve('.tmp') + sep))
    rmSync(workspace, { recursive: true, force: true });
});

describe('开发服务器私有文件访问边界', () => {
  it.each(['GET', 'HEAD'])(
    'denies workspace private files over absolute file routes with %s',
    async (method) => {
      for (const path of [
        '.env',
        '.env.local',
        '.data/master.key',
        '.data/panel.sqlite',
        '.data/panel.sqlite-wal',
        '.tmp/backup.json',
        '.git/config',
        'apps/api/src/private.ts',
        'db/migrations/private.sql',
        'other-private.json',
      ]) {
        const result = await get(encodedPath(fsPath(resolve(workspace, path))), method);
        expect(result.status, path).toBe(403);
        expect(result.body).not.toContain(marker);
      }
    },
  );

  it.each(['?raw', '?url', '?import', '?raw&import', '?url&import'])(
    'does not expose forbidden files through module queries %s',
    async (query) => {
      for (const path of [
        '.data/master.key',
        '.tmp/backup.json',
        'apps/api/src/private.ts',
        'other-private.json',
      ]) {
        const result = await get(encodedPath(fsPath(resolve(workspace, path))) + query);
        expect(result.status).toBe(403);
        expect(result.body).not.toContain(marker);
      }
    },
  );

  it('rejects encoded separators, repeated encoding, traversal, backslashes and alternate id routes', async () => {
    const privatePath = fsPath(resolve(workspace, '.data/master.key'));
    const variants = [
      encodeURI(privatePath).replace('/.data/', '/%2edata/'),
      encodeURI(privatePath).replace('/.data/', '/%252edata/'),
      '/' + encodeURIComponent(privatePath.slice(1)),
      '/' + encodeURI(privatePath.slice(1).replaceAll('/', '\\')),
      encodedPath(fsPath(resolve(webRoot, 'src'))) + '/%2e%2e/%2e%2e/%2e%2e/.data/master.key',
      '/%2e%2e/%2e%2e/.data/master.key',
      '/src/%252e%252e/%252e%252e/.data/master.key',
      encodedPath(privatePath.replace('/@fs/', '/@id/')),
      encodedPath(privatePath) + '%3fraw',
      '/@fs/%00/private',
    ];
    for (const path of variants) {
      const result = await get(path);
      expect(result.status, path).toBe(403);
      expect(result.body).not.toContain(marker);
    }
  });

  it.each(['GET', 'HEAD'])(
    'blocks private files and backend junctions inside public and source folders with %s',
    async (method) => {
      for (const path of [
        '/.env.local',
        '/.data/master.key',
        '/secret.key',
        '/.data/copied.json',
        '/src/server-link/src/private.ts',
        '/server-link/src/private.ts',
        '/src/server-link/src/private.ts?raw',
        '/node_modules/fixture-client/.env',
      ]) {
        const result = await get(path, method);
        expect(result.status, path).toBe(403);
        expect(result.body).not.toContain(marker);
      }
    },
  );

  it('rejects private transformed modules even if Vite has marked an imported path as safe', async () => {
    const file = resolve(workspace, 'other-private.json');
    server!.config.safeModulePaths.add(slash(file));
    let error: unknown;
    try {
      await server!.transformRequest(fsPath(file) + '?raw');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(marker);
    const result = await get(encodedPath(fsPath(file)) + '?raw');
    expect(result.status).toBe(403);
    expect(result.body).not.toContain(marker);
  });

  it('keeps Chinese SPA routes, client modules, shared source, public assets and dependencies available', async () => {
    for (const [path, content] of [
      ['/', '中文界面'],
      ['/discussions/' + encodeURIComponent('中文话题'), '中文界面'],
      ['/src/main.ts', '共享模块'],
      [encodedPath(fsPath(resolve(workspace, 'packages/domain/src/中文.ts'))), '共享模块正常'],
      [encodedPath(fsPath(resolve(workspace, 'packages/contracts/src/index.ts'))), '公开契约'],
      ['/node_modules/fixture-client/index.js', '客户端依赖正常'],
      ['/logo.svg', '公开图标'],
      ['/@vite/client', 'WebSocket'],
    ]) {
      const result = await get(path);
      expect(result.status, path).toBe(200);
      expect(result.body, path).toContain(
        content === '共享模块' ? 'packages/domain/src/' : content,
      );
      expect(result.body).not.toContain(marker);
    }
  });

  it('keeps the Vite HMR websocket connected', async () => {
    const socket = new WebSocket(
      `ws://${address.host}/?token=${server!.config.webSocketToken}`,
      'vite-hmr',
    );
    try {
      const connected = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('HMR connection timed out')), 3000);
        socket.addEventListener(
          'message',
          (event) => {
            clearTimeout(timeout);
            resolve(String(event.data));
          },
          { once: true },
        );
        socket.addEventListener(
          'error',
          () => {
            clearTimeout(timeout);
            reject(new Error('HMR connection failed'));
          },
          { once: true },
        );
      });
      expect(JSON.parse(connected)).toEqual({ type: 'connected' });
    } finally {
      socket.close();
    }
  });
});
