import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, copyFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join, sep } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
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
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('MODEL_') && !key.startsWith('PANEL_'),
    ),
  ),
  npm_config_cache: join(root, '.cache', 'npm'),
  npm_config_devdir: join(root, '.cache', 'node-gyp'),
  API_PORT: '3003',
  WEB_PORT: '5177',
  ALLOWED_ORIGINS: 'http://127.0.0.1:5177',
  DATA_DIR: join(clean, '.data'),
};
// Exercise the real startup loader with the public blank template, never local credentials.
copyFileSync(join(clean, '.env.example'), join(clean, '.env'));
const checks = [];
let unitTestsPassed = 0;
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
  if (args[0] === 'test') {
    const output = stripVTControlCharacters(result.stdout || '');
    const count = output.match(/Tests\s+(\d+) passed/);
    if (!count) throw Error('Missing clean test totals');
    unitTestsPassed = Number(count[1]);
  }
  console.log(`PASS ${args.join(' ')}`);
}
run(['install', '--frozen-lockfile', '--store-dir', join(root, '.pnpm-store')]);
run(['build']);
run(['test']);
run(['db:init']);
run(['seed']);
run(['seed']);
const child = spawn(process.execPath, ['--import', 'tsx', 'apps/api/src/index.ts'], {
  cwd: clean,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
const web = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], {
  cwd: join(clean, 'apps', 'web'),
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let log = '';
child.stdout.on('data', (x) => (log += x));
child.stderr.on('data', (x) => (log += x));
web.stdout.on('data', (x) => (log += x));
web.stderr.on('data', (x) => (log += x));
try {
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const responses = await Promise.all([
        fetch('http://127.0.0.1:3003/api/health'),
        fetch('http://127.0.0.1:5177/api/health'),
      ]);
      if (responses.every((response) => response.ok)) {
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
  for (const d of list.items) {
    const snapshot = await (
      await fetch(`http://127.0.0.1:3003/api/discussions/${d.id}/snapshot`)
    ).json();
    if (
      snapshot.participants.length !== 5 ||
      snapshot.messages.length !== 6 ||
      snapshot.insights.length !== 3
    )
      throw Error('Incomplete clean sample');
  }
  const connections = await (await fetch('http://127.0.0.1:3003/api/model-connections')).json();
  if (connections.length !== 0) throw Error('Unexpected copied credentials');
  const spec = await (await fetch('http://127.0.0.1:3003/api/openapi.json')).json();
  if (spec.openapi !== '3.0.3') throw Error('Missing OpenAPI');
  for (const route of ['/', '/src/main.tsx', '/@vite/client', '/@react-refresh']) {
    const response = await fetch('http://127.0.0.1:5177' + route);
    if (!response.ok) throw Error('Clean frontend module unavailable');
  }
  for (const path of ['.env', '.data/master.key', '.data/panel.sqlite', 'apps/api/src/config.ts']) {
    const route = '/@fs/' + join(clean, path).replaceAll('\\', '/');
    const response = await fetch('http://127.0.0.1:5177' + encodeURI(route), { method: 'HEAD' });
    if (response.status !== 403) throw Error('Clean private file boundary failed');
  }
  checks.push(
    'isolated API and frontend proxy health with blank .env template; exactly 5 complete samples after two seed runs; no copied connections or model environment; OpenAPI available',
    'client entry, Vite client and React refresh available; four private file routes return 403',
  );
  const report = {
    checkedAt: new Date().toISOString(),
    sourceRevision: spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).stdout.trim(),
    includesWorkingTree: true,
    source: root,
    isolatedCopy: clean,
    node: process.version,
    unitTestsPassed,
    checks,
    result: 'passed',
  };
  writeFileSync(
    join(root, 'docs', 'clean-verification.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await Promise.all(
    [child, web].map(async (process) => {
      if (process.exitCode !== null || process.signalCode !== null) return;
      const exited = new Promise((resolve) => process.once('exit', resolve));
      process.kill();
      await exited;
    }),
  );
}
