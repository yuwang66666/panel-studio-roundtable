import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { SnapshotSchema } from '../packages/contracts/src/index';

const root = resolve('docs/real-cases');
const paths = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((d) =>
    readdirSync(resolve(root, d.name))
      .filter((f) => /^case-\d+\.json$/.test(f))
      .map((f) => resolve(root, d.name, f)),
  );
const records = paths.map((path) => ({ path, record: JSON.parse(readFileSync(path, 'utf8')) }));
const escape = (s: string) => s.replaceAll('|', '｜').replaceAll('\n', '<br>');
const index = [
  '# 真实 API 圆桌案例',
  '本目录记录新建讨论的实际模型调用结果，未使用模型测试桩、预写阵容或预写发言。模型标识为服务商/中转接口配置值，不代表独立核实了中转站背后的模型身份。模型输出原文保留，观点和数据不等于已核实的外部事实。',
  '验收配置：每场 1 位主持人、4 位专家，最多 8 次专家发言；使用正式阵容生成、全员参与判断、发言仲裁、流式正文、洞察和收尾代码。通过服务层运行于独立数据库，不覆盖用户历史；本批不是新的浏览器 E2E 验收，也不代表默认 16 次发言的压力验收。',
  '| 主题 | 状态 | 专家发言 | 洞察 | 总结来源 | 调用 / 错误 | 全文 |',
  '| --- | --- | --- | --- | --- | --- | --- |',
];
const manifest: { path: string; sha256: string }[] = [];
for (const { path, record } of records) {
  const s = SnapshotSchema.parse(record.snapshot);
  const summary = s.messages.find((m) => m.kind === 'summary');
  const names = new Map(s.participants.map((p) => [p.id, p.name]));
  const seq = new Map(s.messages.map((m) => [m.id, m.messageSeq]));
  const link = relative(root, path).replaceAll('\\', '/');
  const md = link.replace('.json', '.md');
  const source =
    summary?.summaryMeta?.source === 'model'
      ? `模型：${summary.summaryMeta.model}${summary.summaryMeta.fallbackUsed ? '（切换备用模型）' : ''}`
      : summary
        ? '本地整理兜底'
        : '未生成';
  const resultStatus =
    s.discussion.status !== 'completed'
      ? s.discussion.status
      : summary?.summaryMeta?.source !== 'model'
        ? 'completed（本地兜底）'
        : !s.insights.length || s.discussion.insightsThrough !== summary.messageSeq - 1
          ? 'completed（洞察不完整）'
          : !record.eventEvidence?.timeline.some(
                (e: any) =>
                  e.type === 'insights.updated' && e.status === 'running' && e.insights.length,
              )
            ? 'completed（未观察到实时洞察）'
            : '完整链路完成';
  index.push(
    `| ${escape(s.discussion.topic)} | ${resultStatus} | ${s.messages.filter((m) => m.kind === 'expert').length} | ${s.insights.length} | ${source} | ${record.usage.calls} / ${record.usage.errorCalls} | [全文](${md}) · [JSON](${link}) |`,
  );
  const lines = [
    `# ${s.discussion.topic}`,
    `来源：真实 API。讨论 ID：\`${s.discussion.id}\`。`,
    `业务链路检查：${resultStatus}（不替代人工语义抽检）。`,
    `开始：${record.startedAt}；结束：${record.finishedAt}（UTC，转换北京时间 +08:00）。状态：${s.discussion.status}。`,
    `总结来源：${source}。共 ${record.usage.calls} 次调用，${record.usage.errorCalls} 次错误；接口报告输入 ${record.usage.inputTokens}、输出 ${record.usage.outputTokens} tokens（缺失用量按 0 汇总，不推算价格）。`,
    `[原始公开快照与调用记录](${path.split(/[\\/]/).at(-1)})。公开记录不含 Key、Base URL、请求头、模型隐藏推理或内部参与意愿。`,
    '## 动态生成的阵容',
    '| 姓名 | 职业 / Title | 立场 | 模型 |',
    '| --- | --- | --- | --- |',
    ...s.participants.map(
      (p) =>
        `| ${escape(p.name)} | ${escape(p.occupation + ' / ' + p.title)} | ${escape(p.stance)} | ${s.bindings.find((b) => b.participantId === p.id)?.model || '未绑定'} |`,
    ),
    '',
    '## 发言全文',
  ];
  for (const m of s.messages)
    lines.push(
      `\n### #${m.messageSeq} ${names.get(m.participantId)} · ${m.kind}${m.replyToMessageId ? ` · 回应 #${seq.get(m.replyToMessageId)}` : ''}\n`,
      m.content,
    );
  lines.push('\n## 最终洞察\n');
  for (const i of s.insights)
    lines.push(
      `- **${i.kind}${i.scope ? ' / ' + i.scope : ''}**：${i.text}；涉及：${i.participantIds.map((id) => names.get(id)).join('、')}；证据：${i.evidence.map((e) => '#' + seq.get(e.messageId) + ' ' + e.relation).join('；')}。`,
    );
  const ev = record.eventEvidence;
  if (ev)
    lines.push(
      '\n## 实时事件核验\n',
      `数据库保存 ${ev.totalEvents} 个公开事件；非空正文草稿更新 ${ev.nonemptyDraftUpdates} 次；观察到状态 ${ev.participantStatesObserved.join('、')}。`,
      ...ev.timeline
        .filter((e: any) => e.type === 'insights.updated')
        .map(
          (e: any) =>
            `- ${e.occurredAt}：事件 #${e.seq}，讨论状态 ${e.status}，洞察覆盖消息 #${e.throughMessageSeq}，${e.insights.length} 条洞察。`,
        ),
    );
  lines.push(
    '\n## 错误记录\n',
    ...record.calls
      .filter((c: any) => c.error_code)
      .map(
        (c: any) =>
          `- ${c.created_at}：${c.model} / ${c.purpose} / ${c.error_code}（${c.latency_ms} ms）。`,
      ),
  );
  if (!record.calls.some((c: any) => c.error_code)) lines.push('本场已记录调用无错误。');
  if (s.discussion.error)
    lines.push(`阶段失败：${s.discussion.failureStage}；${s.discussion.error}。`);
  writeFileSync(path.replace('.json', '.md'), lines.join('\n') + '\n');
  manifest.push({
    path: link,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  });
}
index.push(
  '',
  '失败尝试与成功重跑分开保存，不删除失败记录。模型总结与本地整理兜底分别标注；`completed` 不能单独证明模型总结成功。',
  '',
  '人工抽检的有效互动与语义问题见 [质量复核](quality-review.md)，不把格式和引用检查当作语义正确性的证明。',
  '',
  '## 复现',
  '',
  '配置后端 `.env` 后运行 `pnpm verify:real`（产生真实 API 费用，默认五场、每场最多 8 次专家发言）。可用 `REAL_HOST`、`REAL_EXPERTS` 选择 `env:别名`；`REAL_CASE_OFFSET` 从 0 开始、`REAL_CASE_COUNT` 控制范围，`REAL_UTTERANCES` 可设 3–16。每次用新的 `REAL_RUN_ID`；脚本拒绝覆盖已存在的运行数据库。',
  '',
  '运行结束后执行 `pnpm docs:real` 导出 Markdown 与 SHA-256 清单，执行 `pnpm test -- tests/real-cases.test.ts` 检查已保存证据（不产生模型调用）。JSON 是本地服务实际响应与调用记录的脱敏导出，不是供应商签名证明。发布前还应使用本机实际凭据扫描导出文件。',
  '',
  '本批使用 Qwen 主持，并在模型选型主题追加 GPT 主持重跑；专家使用 Qwen / DeepSeek / Kimi / GPT。每场具体绑定见正文。Claude 未参与本批完整讨论，不扩大其既有最小连接测试结论。原有离线预置样例见 [samples.md](../samples.md)。',
);
writeFileSync(resolve(root, 'README.md'), index.join('\n') + '\n');
writeFileSync(resolve(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Exported ${records.length} real API attempts.`);
