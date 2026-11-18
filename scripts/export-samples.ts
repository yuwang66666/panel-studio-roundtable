import { writeFileSync } from 'node:fs';
import { makeSample, SAMPLE_TOPICS } from '../packages/domain/src/samples';
import { SnapshotSchema } from '../packages/contracts/src/index';

const sections = [
  '# 预置讨论样例',
  '由 `pnpm docs:samples` 从 `packages/domain/src/samples.ts` 生成。5 场均为人工编写的演示内容，嘉宾为虚构角色，不是真实模型调用记录。无须 API Key 即可通过 `pnpm seed` 导入，并在首页查看。',
  '每场包含 1 位主持人、4 位与话题对应的专家、开场、4 条有回应关系的专家发言、局部共识、明确分歧、未解问题及自然语言总结。证据只引用本场已保存的发言；未将沉默算作支持。样例不绑定实际模型连接，调用次数为 0。',
  '初始化只补入缺失样例，不覆盖已存在的同 ID 样例或真实讨论。更新后的样例可在新数据库及 `/preview` 查看；正式历史不会被文案更新改写。',
];
for (let index = 0; index < SAMPLE_TOPICS.length; index++) {
  const s = SnapshotSchema.parse(makeSample(index));
  const names = new Map(s.participants.map((p) => [p.id, p.name]));
  const seq = new Map(s.messages.map((m) => [m.id, m.messageSeq]));
  sections.push(`## ${index + 1}. ${s.discussion.topic}`, `样例 ID：\`${s.discussion.id}\`。`);
  sections.push(
    [
      '| 姓名 | 身份 / Title | 立场 |',
      '| --- | --- | --- |',
      ...s.participants.map((p) => `| ${p.name} | ${p.occupation} / ${p.title} | ${p.stance} |`),
    ].join('\n'),
  );
  for (const m of s.messages) {
    sections.push(
      `**第 ${m.messageSeq} 条 · ${names.get(m.participantId)}${m.kind === 'summary' ? ' · 主持人总结' : ''}${m.replyToMessageId ? ` · 回应第 ${seq.get(m.replyToMessageId)} 条` : ''}**`,
      m.content,
    );
  }
  sections.push(
    [
      '| 洞察 | 内容 | 明确涉及的专家 | 证据 |',
      '| --- | --- | --- | --- |',
      ...s.insights.map(
        (i) =>
          `| ${{ consensus: '局部共识', divergence: '分歧', open_question: '未解问题' }[i.kind]} | ${i.text} | ${i.participantIds.map((id) => names.get(id)).join('、')} | ${i.evidence.map((e) => `第 ${seq.get(e.messageId)} 条（${{ supports: '支持', opposes: '反对', qualifies: '限定条件' }[e.relation]}）`).join('；')} |`,
      ),
    ].join('\n'),
  );
}
writeFileSync(new URL('../docs/samples.md', import.meta.url), sections.join('\n\n') + '\n');
console.log('已导出 5 场预置话题、独立嘉宾阵容、发言及证据至 docs/samples.md。');
