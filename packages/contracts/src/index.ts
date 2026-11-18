import { z } from 'zod';
export const APP_NAME = 'AI Panel Studio';
export const StatusSchema = z.enum([
  'casting',
  'awaiting_confirmation',
  'running',
  'summarizing',
  'completed',
  'failed',
  'interrupted',
]);
export type DiscussionStatus = z.infer<typeof StatusSchema>;
export const ProtocolSchema = z.enum(['openai-chat', 'openai-responses', 'anthropic']);
export const ProviderSchema = z.enum(['deepseek', 'claude', 'qwen', 'gpt', 'kimi', 'custom']);
const id = z.string().min(1).max(100);
const timestamp = z.string();
export const ConnectionInputSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    provider: ProviderSchema,
    protocol: ProtocolSchema,
    baseUrl: z
      .string()
      .url()
      .refine((v) => {
        const u = new URL(v);
        return (
          ['http:', 'https:'].includes(u.protocol) &&
          !u.username &&
          !u.password &&
          !u.search &&
          !u.hash
        );
      }, '地址不能包含用户名、密码、查询参数或片段'),
    model: z.string().trim().min(1).max(120),
    apiKey: z.string().trim().min(1).max(4096),
    structuredOutput: z.boolean().default(false),
    active: z.boolean().default(true),
  })
  .strict();
export const ConnectionPatchSchema = ConnectionInputSchema.partial();
export const ConnectionSummarySchema = ConnectionInputSchema.omit({ apiKey: true })
  .extend({
    id,
    version: z.number().int().positive(),
    hasApiKey: z.boolean(),
    testedAt: timestamp.nullable(),
    testStatus: z.enum(['untested', 'passed', 'failed']),
    createdAt: timestamp,
  })
  .strict();
export type ConnectionInput = z.infer<typeof ConnectionInputSchema>;
export type ModelConnectionSummary = z.infer<typeof ConnectionSummarySchema>;
export const ParticipantSchema = z
  .object({
    id,
    discussionId: id,
    role: z.enum(['moderator', 'expert']),
    name: z.string(),
    occupation: z.string(),
    title: z.string(),
    stance: z.string(),
    specialty: z.array(z.string()),
    colorKey: z.number().int().min(0).max(6),
    status: z.enum(['idle', 'preparing', 'speaking']),
    publicFocus: z.string().nullable(),
  })
  .strict();
export type Participant = z.infer<typeof ParticipantSchema>;
export const BindingSchema = z
  .object({
    participantId: id,
    connectionId: id,
    connectionVersion: z.number().int().positive(),
    model: z.string(),
    provider: ProviderSchema,
  })
  .strict();
export type AgentBinding = z.infer<typeof BindingSchema>;
export const SummaryMetaSchema = z
  .object({
    source: z.enum(['model', 'local']),
    throughMessageSeq: z.number().int().nonnegative(),
    insightsThroughMessageSeq: z.number().int().nonnegative(),
    model: z.string().min(1).max(120).nullable(),
    provider: ProviderSchema.nullable(),
    connectionId: id.nullable(),
    connectionVersion: z.number().int().positive().nullable(),
    fallbackUsed: z.boolean(),
    reason: z.enum(['models_unavailable', 'budget_exhausted', 'deadline_exceeded']).nullable(),
  })
  .strict();
export type SummaryMeta = z.infer<typeof SummaryMetaSchema>;
export const MessageSchema = z
  .object({
    id,
    discussionId: id,
    messageSeq: z.number().int().positive(),
    turnId: id,
    participantId: id,
    kind: z.enum(['opening', 'probe', 'expert', 'summary']),
    content: z.string().min(1),
    replyToMessageId: id.nullable(),
    createdAt: timestamp,
    summaryMeta: SummaryMetaSchema.optional(),
  })
  .strict();
export type Message = z.infer<typeof MessageSchema>;
export const SpeechDraftSchema = z
  .object({
    turnId: id,
    discussionId: id,
    participantId: id,
    generation: z.number().int().nonnegative(),
    kind: MessageSchema.shape.kind,
    content: z.string().max(6000),
    replyToMessageId: id.nullable(),
    startedAt: timestamp,
  })
  .strict();
export type SpeechDraft = z.infer<typeof SpeechDraftSchema>;
export const InsightSchema = z
  .object({
    id,
    kind: z.enum(['consensus', 'divergence', 'open_question']),
    status: z.enum(['emerging', 'stable', 'revised', 'resolved']),
    scope: z.enum(['local', 'all']).nullable(),
    text: z.string(),
    revision: z.number().int().positive(),
    throughMessageSeq: z.number().int().nonnegative(),
    participantIds: z.array(id),
    evidence: z.array(
      z.object({ messageId: id, relation: z.enum(['supports', 'opposes', 'qualifies']) }).strict(),
    ),
  })
  .strict();
export type Insight = z.infer<typeof InsightSchema>;
export const DiscussionSchema = z
  .object({
    id,
    topic: z.string(),
    expertCount: z.number().int().min(2).max(6),
    status: StatusSchema,
    version: z.number().int().positive(),
    castVersion: z.number().int().nonnegative(),
    generation: z.number().int().nonnegative(),
    finishRequested: z.boolean(),
    failureStage: z.enum(['cast', 'discussion', 'insights', 'summary']).nullable(),
    error: z.string().nullable(),
    maxUtterances: z.number().int().positive(),
    maxCalls: z.number().int().positive(),
    callCount: z.number().int().nonnegative(),
    insightsThrough: z.number().int().nonnegative(),
    isSample: z.boolean(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export type Discussion = z.infer<typeof DiscussionSchema>;
export const SnapshotSchema = z
  .object({
    discussion: DiscussionSchema,
    participants: z.array(ParticipantSchema),
    bindings: z.array(BindingSchema),
    messages: z.array(MessageSchema),
    draft: SpeechDraftSchema.nullable().default(null),
    insights: z.array(InsightSchema),
    lastEventSeq: z.number().int().nonnegative(),
  })
  .strict();
export type DiscussionSnapshot = z.infer<typeof SnapshotSchema>;
const envelope = {
  discussionId: id,
  seq: z.number().int().positive(),
  schemaVersion: z.literal(1),
  occurredAt: timestamp,
};
export const PublicEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...envelope,
      type: z.literal('speech.updated'),
      payload: z.object({ draft: SpeechDraftSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('speech.cleared'),
      payload: z.object({ turnId: id }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('discussion.status_changed'),
      payload: z.object({ discussion: DiscussionSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('cast.ready'),
      payload: z
        .object({
          discussion: DiscussionSchema,
          participants: z.array(ParticipantSchema),
          bindings: z.array(BindingSchema),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('participant.state_changed'),
      payload: z
        .object({
          participantId: id,
          status: ParticipantSchema.shape.status,
          publicFocus: z.string().nullable(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('message.committed'),
      payload: z.object({ message: MessageSchema, discussion: DiscussionSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('insights.updated'),
      payload: z
        .object({ insights: z.array(InsightSchema), discussion: DiscussionSchema })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('summary.ready'),
      payload: z.object({ message: MessageSchema, discussion: DiscussionSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('discussion.failed'),
      payload: z.object({ discussion: DiscussionSchema }).strict(),
    })
    .strict(),
]);
export type PublicEvent = z.infer<typeof PublicEventSchema>;
export const CreateDiscussionSchema = z
  .object({
    topic: z.string().trim().min(5, '话题至少 5 个字').max(500),
    expertCount: z.number().int().min(2).max(6).default(4),
    moderatorConnectionId: id.optional(),
  })
  .strict();
export const VersionCommandSchema = z
  .object({ expectedVersion: z.number().int().positive() })
  .strict();
export const StartCommandSchema = VersionCommandSchema.extend({
  castVersion: z.number().int().positive(),
});
export const BindingsCommandSchema = StartCommandSchema.extend({
  bindings: z
    .array(z.object({ participantId: id, connectionId: id }).strict())
    .min(3)
    .max(7),
});
export const SettingsSchema = z.object({ defaultModeratorConnectionId: id.nullable() }).strict();
export const IntentSchema = z
  .object({
    action: z.enum(['pass', 'raise', 'interrupt', 'supplement', 'rebut']),
    targetMessageId: id.nullable(),
    proposedFocus: z.string().max(120).nullable(),
  })
  .strict();
export type Intent = z.infer<typeof IntentSchema> & {
  participantId: string;
  basedOnMessageSeq: number;
};
export const RoleOutputSchema = z
  .object({
    name: z.string().trim().min(1).max(30),
    occupation: z.string().min(1).max(60),
    title: z.string().min(1).max(60),
    stance: z.string().min(1).max(240),
    specialty: z.array(z.string().min(1).max(40)).min(1).max(5),
  })
  .strict();
export const CastOutputSchema = z
  .object({ moderator: RoleOutputSchema, experts: z.array(RoleOutputSchema).min(2).max(6) })
  .strict();
export const UtteranceOutputSchema = z
  .object({ sentences: z.array(z.string().trim().min(1).max(250)).min(1).max(2) })
  .strict();
export const ProseOutputSchema = z.object({ content: z.string().trim().min(1).max(6000) }).strict();
export const InsightOutputSchema = z
  .object({
    insights: z.array(InsightSchema.omit({ revision: true, throughMessageSeq: true })).max(20),
  })
  .strict();
export const STATUS_LABEL: Record<DiscussionStatus, string> = {
  casting: '生成阵容',
  awaiting_confirmation: '等待确认',
  running: '讨论中',
  summarizing: '生成总结',
  completed: '已完成',
  failed: '需要处理',
  interrupted: '已中断',
};
export const PROVIDER_LABEL = {
  deepseek: 'DeepSeek',
  claude: 'Claude',
  qwen: 'Qwen',
  gpt: 'GPT',
  kimi: 'Kimi',
  custom: '自定义',
};
