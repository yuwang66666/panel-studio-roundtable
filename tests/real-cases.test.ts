import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { SnapshotSchema } from '../packages/contracts/src/index';
import { validateInsightEvidence } from '../packages/domain/src/insights';
import { extractSummaryProse } from '../packages/domain/src/summary-prose';

const root = resolve('docs/real-cases');
const files = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((d) =>
    readdirSync(resolve(root, d.name))
      .filter((f) => /^case-\d+\.json$/.test(f))
      .map((f) => `${d.name}/${f}`),
  );
const records = files.map((path) => ({
  path,
  data: JSON.parse(readFileSync(resolve(root, path), 'utf8')),
}));

describe('保存的真实 API 案例证据（离线核验，不发起模型调用）', () => {
  it('contains five distinct complete topics with live insights, final coverage and model summaries', () => {
    const complete = records.filter(
      ({ data }) =>
        data.snapshot.discussion.status === 'completed' &&
        data.snapshot.insights.length > 0 &&
        data.snapshot.messages.filter((m: any) => m.kind === 'expert').length >= 4 &&
        data.eventEvidence.timeline.some(
          (e: any) =>
            e.type === 'insights.updated' && e.status === 'running' && e.insights.length > 0,
        ) &&
        data.snapshot.messages.some(
          (m: any) =>
            m.kind === 'summary' &&
            m.summaryMeta?.source === 'model' &&
            data.snapshot.discussion.insightsThrough === m.messageSeq - 1,
        ),
    );
    expect(
      new Set(complete.map(({ data }) => data.snapshot.discussion.topic)).size,
    ).toBeGreaterThanOrEqual(5);
  });
  it('matches the published integrity manifest', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
    expect(manifest.length).toBe(files.length);
    for (const entry of manifest)
      expect(
        createHash('sha256')
          .update(readFileSync(resolve(root, entry.path)))
          .digest('hex'),
      ).toBe(entry.sha256);
  });
  it.each(records)(
    '$path: keeps calls, references, summary coverage and event evidence consistent',
    ({ data }) => {
      const s = SnapshotSchema.parse(data.snapshot);
      expect(data.provenance).toBe('real-api');
      expect(s.discussion.isSample).toBe(false);
      expect(data.usage.calls).toBe(data.calls.length);
      expect(data.usage.errorCalls).toBe(data.calls.filter((c: any) => c.error_code).length);
      expect(data.calls.length).toBeGreaterThan(0);
      for (const call of data.calls) {
        expect(call.model).not.toMatch(/test-model|fixture|mock/i);
        expect(Object.keys(call)).not.toEqual(expect.arrayContaining(['apiKey']));
      }
      if (s.discussion.status !== 'completed') {
        expect(s.discussion.failureStage).not.toBeNull();
        expect(data.usage.errorCalls).toBeGreaterThan(0);
        return;
      }
      expect(s.participants).toHaveLength(5);
      expect(s.bindings).toHaveLength(5);
      const experts = s.messages.filter((m) => m.kind === 'expert');
      expect(experts.length).toBeGreaterThanOrEqual(4);
      const speakingProviders = new Set(
        experts.map((m) => s.bindings.find((b) => b.participantId === m.participantId)!.provider),
      );
      expect(speakingProviders.size).toBeGreaterThanOrEqual(2);
      const ids = new Set<string>();
      for (const [index, m] of s.messages.entries()) {
        expect(m.messageSeq).toBe(index + 1);
        expect(m.discussionId).toBe(s.discussion.id);
        if (m.replyToMessageId) expect(ids.has(m.replyToMessageId)).toBe(true);
        expect(ids.has(m.id)).toBe(false);
        ids.add(m.id);
        if (m.kind === 'expert') {
          expect(m.content.length).toBeLessThanOrEqual(400);
          expect(
            [...new Intl.Segmenter('zh', { granularity: 'sentence' }).segment(m.content)].filter(
              (x) => x.segment.trim(),
            ).length,
          ).toBeLessThanOrEqual(2);
          const binding = s.bindings.find((b) => b.participantId === m.participantId)!;
          expect(
            data.calls.some(
              (c: any) =>
                c.participant_id === m.participantId &&
                c.purpose === 'utterance' &&
                c.model === binding.model &&
                c.connection_id === binding.connectionId &&
                !c.error_code,
            ),
          ).toBe(true);
        }
      }
      validateInsightEvidence(s, s.insights, s.discussion.insightsThrough);
      const summary = s.messages.at(-1)!;
      expect(summary.kind).toBe('summary');
      expect(summary.summaryMeta?.throughMessageSeq).toBe(summary.messageSeq - 1);
      expect(extractSummaryProse(summary.content)).toBe(summary.content);
      if (summary.summaryMeta?.source === 'model')
        expect(
          data.calls.some(
            (c: any) =>
              c.purpose === 'summary' && c.model === summary.summaryMeta?.model && !c.error_code,
          ),
        ).toBe(true);
      else {
        expect(summary.summaryMeta?.source).toBe('local');
        expect(summary.summaryMeta?.fallbackUsed).toBe(true);
        expect(summary.summaryMeta?.model).toBeNull();
      }
      expect(data.eventEvidence.nonemptyDraftUpdates).toBeGreaterThan(0);
      expect(data.eventEvidence.participantStatesObserved).toEqual([
        'idle',
        'preparing',
        'speaking',
      ]);
      for (const e of data.eventEvidence.timeline.filter((e: any) => e.type === 'insights.updated'))
        validateInsightEvidence(s, e.insights, e.throughMessageSeq);
    },
  );
});
