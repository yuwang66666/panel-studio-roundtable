import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin, ServerOptions } from 'vite';

const privateSegments = /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.data|\.tmp|\.git)(?:\/|$)/i;
const privateExtensions =
  /\.(?:key|pem|crt|sqlite(?:3)?(?:-(?:wal|shm|journal))?|db(?:-(?:wal|shm|journal))?)$/i;
const slash = (path: string) => path.replace(/\\/g, '/');

/** Serve client code and dependencies, never the pnpm workspace as a whole. */
export function createClientFileSecurity(
  webRoot: string,
  workspaceRoot = resolve(webRoot, '../..'),
) {
  const roots = [
    webRoot,
    resolve(workspaceRoot, 'packages/contracts/src'),
    resolve(workspaceRoot, 'packages/domain/src'),
    resolve(workspaceRoot, 'node_modules'),
  ].map((path) => resolve(path));
  const canonical = (path: string) => {
    try {
      return realpathSync.native(path);
    } catch {
      return resolve(path);
    }
  };
  const allowed = roots.map(canonical);
  const inside = (root: string, file: string) => {
    const path = relative(root, file);
    return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
  };
  const accessible = (file: string) => {
    const permittedWithin = (bases: string[], candidate: string) =>
      !privateExtensions.test(candidate) &&
      bases.some(
        (root) =>
          inside(root, candidate) && !privateSegments.test(slash(relative(root, candidate))),
      );
    if (!permittedWithin([...roots, ...allowed], resolve(file))) return false;
    const actual = canonical(file);
    return permittedWithin(allowed, actual);
  };
  const reject = (response: ServerResponse) => {
    response.writeHead(403, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end('禁止访问此资源。');
  };
  const guard =
    (publicDir: string | false) =>
    (request: IncomingMessage, response: ServerResponse, next: () => void) => {
      let path = (request.url || '/').split(/[?#]/, 1)[0];
      try {
        // Decode before policy checks, including encodings that another middleware
        // might otherwise decode a second time. Ambiguous/malformed paths fail closed.
        for (let n = 0; n < 4 && path.includes('%'); n++) path = decodeURIComponent(path);
      } catch {
        reject(response);
        return;
      }
      path = slash(path);
      if (
        /[%?#\u0000-\u001f\u007f]/.test(path) ||
        path.startsWith('//') ||
        path.split('/').includes('..') ||
        (!path.startsWith('/@fs/') && privateSegments.test(path)) ||
        privateExtensions.test(path)
      ) {
        reject(response);
        return;
      }
      if (path.startsWith('/@fs/')) {
        const file = path.slice('/@fs/'.length);
        if (!isAbsolute(file) || !accessible(file)) return reject(response);
      } else if (path.startsWith('/@id/')) {
        // Package/virtual ids are resolved by Vite; absolute ids must not bypass
        // the /@fs policy. The load hook checks their eventual physical targets.
        if (/^\/?(?:[a-z]:|\/)/i.test(path.slice('/@id/'.length))) return reject(response);
      } else if (!path.startsWith('/api/') && path !== '/api') {
        const relativePath = path.replace(/^\/+/, '');
        const file = resolve(webRoot, relativePath);
        if (!accessible(file)) return reject(response);
        // Vite's public-directory middleware deliberately skips fs.allow checks.
        if (publicDir) {
          const publicFile = resolve(publicDir, relativePath);
          if (existsSync(publicFile) && !accessible(publicFile)) return reject(response);
        }
      }
      next();
    };

  const fs: NonNullable<ServerOptions['fs']> = {
    strict: true,
    allow: [...new Set([...roots, ...allowed])],
    deny: [
      '.env',
      '.env.*',
      '*.{crt,pem,key,sqlite,sqlite3,db}',
      '*.{sqlite,sqlite3,db}-{wal,shm,journal}',
      ...['.git', '.data', '.tmp', 'apps/api', 'db'].map(
        (dir) => `${slash(resolve(workspaceRoot, dir))}/**`,
      ),
    ],
  };
  const plugin: Plugin = {
    name: 'panel-client-file-boundary',
    enforce: 'pre',
    configureServer(server) {
      server.middlewares.use(guard(server.config.publicDir));
    },
    configurePreviewServer(server) {
      server.middlewares.use(guard(server.config.publicDir));
    },
    load(id) {
      if (id.startsWith('\0')) return null;
      const file = id.split(/[?#]/, 1)[0];
      // Slash-prefixed virtual ids such as /@react-refresh are not disk files.
      if (isAbsolute(file) && existsSync(file) && !accessible(file))
        throw Error('禁止加载非客户端文件。');
      return null;
    },
  };
  return { fs, plugin };
}
