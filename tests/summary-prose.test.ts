import { describe, expect, it } from 'vitest';
import { extractSummaryProse, projectSummaryProse } from '../packages/domain/src/summary-prose';

const prose = '本场讨论认为，应先明确适用范围。\n\n仍有分歧：评价标准需要进一步验证。';

describe('总结自然语言边界', () => {
  it('preserves Chinese prose, paragraph breaks, punctuation and Markdown lists', () => {
    const text =
      '# 主持人总结\n\n“局部共识”不等于全体赞成。\n\n- 先做小范围验证。\n- 记录适用条件。\n\n1. 对照现有证据。';
    expect(extractSummaryProse(`\uFEFF  ${text.replace(/\n/g, '\r\n')} \n`)).toBe(text);
    expect(projectSummaryProse(text)).toBe(text);
  });

  it.each([
    JSON.stringify(prose),
    JSON.stringify({ content: prose }),
    JSON.stringify({ summary: prose }),
    JSON.stringify({ content: JSON.stringify({ summary: prose }) }),
    JSON.stringify({ content: { summary: prose } }),
    `\uFEFF\n\n\`\`\`json\n${JSON.stringify({ content: prose })}\n\`\`\`\n`,
    `~~~JSON\n${JSON.stringify({ summary: prose })}\n~~~`,
  ])('unwraps a bounded public wrapper without showing its serialization (%#)', (input) => {
    expect(extractSummaryProse(input)).toBe(prose);
    expect(projectSummaryProse(input)).toBe(input.trimStart().startsWith('"') ? '' : prose);
  });

  it.each([
    '{"content":"公开正文","reasoning":"PRIVATE_REASONING"}',
    '{"summary":"公开正文","thinking":"PRIVATE_THINKING"}',
    '{"content":"公开正文","summary":"另一个正文"}',
    '{"reasoning":"PRIVATE_REASONING"}',
    '{"consensus":["公开观点"],"disagreements":["另一个观点"]}',
    '["第一段","第二段"]',
    '{"content":["第一段","第二段"]}',
    '{"content":{"private":"PRIVATE_REASONING"}}',
    'null',
    'true',
    'false',
    '42',
    '-1.5e3',
  ])('rejects unsupported objects, arrays and non-prose scalars (%#)', (input) => {
    expect(extractSummaryProse(input)).toBeNull();
    expect(projectSummaryProse(input)).toBe('');
  });

  it('rejects malformed or embedded structures instead of stripping arbitrary fields', () => {
    for (const input of [
      '{"content":"未结束',
      '结论如下：{"content":"结构化片段"}。',
      '结论如下：\n```json\n{"answer":"片段"}\n```',
      '说明："reasoning":"PRIVATE_REASONING"',
      '结论如下：["第一项","第二项"]',
      '```typescript\nconst summary = "正文";\n```',
      '```json\n{"content":"正文"}\n```\n额外文字',
      '{"content":"正文"}\n额外文字',
    ]) {
      expect(extractSummaryProse(input)).toBeNull();
    }
  });

  it('accepts natural quotation and technical terms without treating them as field names', () => {
    for (const input of [
      '“先验证”是目前的共同建议。',
      '专家将评价标准称为 "可复现性"。',
      '"Efficiency" is one possible criterion.',
      '2026年的实施范围仍需讨论。',
      'true 与 false 只是命题标签，不是讨论结论。',
      '应该解释 JSON 的作用，避免输出原始对象。',
    ])
      expect(extractSummaryProse(input)).toBe(input);
  });

  it('rejects empty, control-only, oversized and excessively nested content', () => {
    for (const input of [
      '',
      ' \uFEFF\n ',
      '12345',
      '...',
      '正文\u0000',
      '文'.repeat(64_001),
      ' '.repeat(64_001),
    ])
      expect(extractSummaryProse(input)).toBeNull();
    expect(extractSummaryProse('文'.repeat(6001))).toHaveLength(6001);
    let encoded = prose;
    for (let i = 0; i < 8; i++) encoded = JSON.stringify(encoded);
    expect(extractSummaryProse(encoded)).toBeNull();
    expect(projectSummaryProse(encoded)).toBe('');
  });

  it('never exposes partial JSON syntax while a supported wrapper arrives character by character', () => {
    const wrapped = JSON.stringify({ content: JSON.stringify({ summary: prose }) });
    for (let i = 0; i < wrapped.length; i++)
      expect(projectSummaryProse(wrapped.slice(0, i))).toBe('');
    expect(projectSummaryProse(wrapped)).toBe(prose);
  });

  it('holds scalar and fence prefixes until they become readable prose', () => {
    for (const input of [
      't',
      'tr',
      'tru',
      'true',
      'f',
      'fal',
      'n',
      'nul',
      '-',
      '1',
      '1.',
      '1e',
      '1e+',
      '`',
      '``',
      '```j',
      '~~',
      '~~~json',
    ])
      expect(projectSummaryProse(input)).toBe('');
    expect(projectSummaryProse('true并不代表所有专家赞成。')).toBe('true并不代表所有专家赞成。');
    expect(projectSummaryProse('1. 首先核对证据。')).toBe('1. 首先核对证据。');
  });

  it('streams ordinary Chinese text and stops before an embedded serialized fragment', () => {
    for (let i = 1; i <= prose.length; i++)
      expect(projectSummaryProse(prose.slice(0, i))).toBe(prose.slice(0, i).trim());
    for (const suffix of [
      '{',
      '{"reasoning":"PRIVATE"}',
      '[',
      '["PRIVATE"]',
      '`',
      '```json\n{"PRIVATE":1}',
      '"',
      '"thinking":"PRIVATE"',
    ]) {
      expect(projectSummaryProse(`已经形成局部共识。${suffix}`)).toBe('已经形成局部共识。');
    }
  });

  it('does not recursively surface hidden values in otherwise public wrappers', () => {
    const malicious = JSON.stringify({
      content: JSON.stringify({ content: prose, thinking: 'PRIVATE' }),
    });
    for (let i = 0; i <= malicious.length; i++)
      expect(projectSummaryProse(malicious.slice(0, i))).toBe('');
    expect(extractSummaryProse(malicious)).toBeNull();
  });

  it('buffers a quoted token that could become a bare JSON key in the next fragment', () => {
    for (const text of [
      '"summary":"公开内容"',
      '"reasoning":"PRIVATE_REASONING"',
      '"content": "正文", "thinking": "PRIVATE_THINKING"',
    ]) {
      expect(extractSummaryProse(text)).toBeNull();
      for (let i = 0; i <= text.length; i++) {
        expect(projectSummaryProse(text.slice(0, i))).toBe('');
        expect(projectSummaryProse(`公开说明。${text.slice(0, i)}`)).toBe('公开说明。');
      }
    }
    const encoded = JSON.stringify(prose);
    expect(projectSummaryProse(encoded)).toBe('');
    expect(extractSummaryProse(encoded)).toBe(prose);
  });
});
