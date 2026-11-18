import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, copyFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join, sep } from 'node:path';
const root = process.cwd(),
  pnpm = process.env.npm_execpath;
if (!pnpm) throw Error('请通过 pnpm verify:clean 运行');
const listing = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  cwd: root,
  encoding: 'utf8',
});
if (listing.status !== 0) throw Error(listing.stderr);
mkdirSync(join(root, '.tmp'), { recursive: true });
const clean = mkdtempSync(join(root, '.tmp', 'clean-'));
for (const file of listing.stdout.trim().split('\n').filter(Boolean)) {
  const dest = resolve(clean, file);
  if (!dest.startsWith(clean + sep)) throw Error('Invalid source path');
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(resolve(root, file), dest);
}
const env = {
  ...process.env,
  npm_config_cache: join(root, '.cache', 'npm'),
  npm_config_devdir: join(root, '.cache', 'node-gyp'),
  API_PORT: '3003',
  DATA_DIR: join(clean, '.data'),
};
const checks = [];
function run(args) {
  const result = spawnSync(process.execPath, [pnpm, ...args], {
    cwd: clean,
    env,
    encoding: 'utf8',
    timeout: 180000,
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    throw Error(`Clean check failed: ${args.join(' ')}`);
  }
  checks.push(args.join(' '));
  console.log(`PASS ${args.join(' ')}`);
}
run(['install', '--frozen-lockfile', '--store-dir', join(root, '.pnpm-store')]);
run(['build']);
run(['seed']);
run(['seed']);
const child = spawn(process.execPath, ['--import', 'tsx', 'apps/api/src/index.ts'], {
  cwd: clean,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let log = '';
child.stdout.on('data', (x) => (log += x));
child.stderr.on('data', (x) => (log += x));
try {
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch('http://127.0.0.1:3003/api/health');
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) throw Error(`Clean startup failed: ${log}`);
  const list = await (await fetch('http://127.0.0.1:3003/api/discussions')).json();
  if (list.items.length !== 5 || !list.items.every((d) => d.isSample))
    throw Error('Clean seed is not idempotent');
  const connections = await (await fetch('http://127.0.0.1:3003/api/model-connections')).json();
  if (connections.length !== 0) throw Error('Unexpected copied credentials');
  const spec = await (await fetch('http://127.0.0.1:3003/api/openapi.json')).json();
  if (spec.openapi !== '3.0.3') throw Error('Missing OpenAPI');
  checks.push(
    'isolated API health; exactly 5 samples after two seed runs; no copied connections; OpenAPI available',
  );
  const report = {
    source: root,
    isolatedCopy: clean,
    node: process.version,
    checks,
    result: 'passed',
  };
  writeFileSync(
    join(root, 'docs', 'clean-verification.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
}
