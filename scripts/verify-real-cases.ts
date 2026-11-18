/** Manual, billable verification. Uses real configured providers; never a fixture transport. */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createApp } from '../apps/api/src/app';
import { realCaseEvents } from './real-case-evidence';

const topics = [
  '生成式 AI 会取代初级岗位，还是创造新的机会？',
  '城市是否应优先发展公共交通？',
  '远程办公应该成为企业的长期制度吗？',
  '企业如何选择开源模型与商业模型？',
  '自动驾驶大规模落地，还缺少什么？',
];
const runId = process.env.REAL_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-');
const applicationSourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
if (!/^[A-Za-z0-9_-]+$/.test(runId))
  throw new Error('REAL_RUN_ID must be a simple directory name.');
const directory = resolve('.data', 'real-cases', runId);
if (existsSync(directory))
  throw new Error('Choose a new REAL_RUN_ID; existing evidence is preserved.');
const output = resolve('docs', 'real-cases', runId);
mkdirSync(output, { recursive: true });
const instance = await createApp({ dataDir: directory, modelEnv: process.env });
const { repo, discussions } = instance;
const host = process.env.REAL_HOST || 'env:QWEN';
const experts = (process.env.REAL_EXPERTS || 'env:QWEN,env:DEEPSEEK,env:KIMI,env:GPT').split(',');
const count = Number(process.env.REAL_CASE_COUNT || 5);
const offset = Number(process.env.REAL_CASE_OFFSET || 0);
const limit = Number(process.env.REAL_UTTERANCES || 8);
if (
  !Number.isInteger(offset) ||
  !Number.isInteger(count) ||
  offset < 0 ||
  count < 1 ||
  offset + count > topics.length ||
  !Number.isInteger(limit) ||
  limit < 3 ||
  limit > 16
) {
  await instance.app.close();
  throw new Error('Invalid case range or utterance limit (3–16).');
}
if ([host, ...experts].some((id) => !repo.listConnections().some((c) => c.id === id && c.active))) {
  await instance.app.close();
  throw new Error(
    'Configure the selected REAL_HOST and REAL_EXPERTS in backend environment variables first.',
  );
}
const results: unknown[] = [];
let currentId: string | undefined;
const log = (value: unknown) => console.log(JSON.stringify(value));
const timer = setInterval(() => {
  if (!currentId) return;
  const s = repo.snapshot(currentId);
  log({
    progress: currentId,
    status: s.discussion.status,
    messages: s.messages.length,
    calls: s.discussion.callCount,
  });
}, 30000);
try {
  for (let index = offset; index < offset + count; index++) {
    const startedAt = new Date().toISOString();
    let s = repo.createDiscussion(topics[index]!, 4, host, limit);
    currentId = s.discussion.id;
    log({ case: index + 1, id: currentId, stage: 'cast' });
    discussions.cast(currentId);
    await discussions.idle(currentId);
    s = repo.snapshot(currentId);
    if (s.discussion.status === 'awaiting_confirmation') {
      let expert = 0;
      s = repo.bind(
        currentId,
        s.discussion.version,
        s.discussion.castVersion,
        s.participants.map((p) => ({
          participantId: p.id,
          connectionId: p.role === 'moderator' ? host : experts[expert++ % experts.length]!,
        })),
      );
      repo.start(currentId, s.discussion.version, s.discussion.castVersion, 3);
      discussions.run(currentId);
      await discussions.idle(currentId);
    }
    s = repo.snapshot(currentId);
    const calls = repo.db
      .prepare(
        'SELECT id,participant_id,purpose,connection_id,connection_version,model,prompt_version,latency_ms,usage_json,error_code,created_at FROM model_runs WHERE discussion_id=? ORDER BY rowid',
      )
      .all(currentId);
    const record = {
      provenance: 'real-api',
      applicationSourceCommit,
      runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      expertUtteranceLimit: limit,
      snapshot: s,
      usage: repo.usage(currentId),
      calls,
      eventEvidence: realCaseEvents(repo.db, currentId),
    };
    // Explicit safe fields only: no connection URLs, keys, internal intentions, or provider raw bodies.
    writeFileSync(
      resolve(output, `case-${index + 1}.json`),
      JSON.stringify(record, null, 2) + '\n',
    );
    const summary = s.messages.find((m) => m.kind === 'summary');
    const result = {
      case: index + 1,
      topic: topics[index],
      id: currentId,
      status: s.discussion.status,
      expertMessages: s.messages.filter((m) => m.kind === 'expert').length,
      insights: s.insights.length,
      summarySource: summary?.summaryMeta?.source ?? null,
      usage: repo.usage(currentId),
    };
    results.push(result);
    writeFileSync(resolve(output, 'index.json'), JSON.stringify(results, null, 2) + '\n');
    log(result);
  }
} finally {
  clearInterval(timer);
  await instance.app.close();
}
