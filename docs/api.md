# API 与事件约定

REST 统一 /api 前缀。错误返回 `{error:{code,message}}`，不包含上游原始响应或请求凭据。

模型目录：GET `/model-connections` 返回模型连接摘要（包含 active 状态，不含密钥）；网页只提供启用模型供选择。POST `/model-connections/:id/test` 使用后端保存的凭据执行最小调用，JSON 请求体为 `{}`。GET/PATCH `/settings` 查询或选择默认主持人连接。

模型配置只从根目录 `.env` 加载，由后端启动时同步。旧 POST `/model-connections` 与 PATCH `/model-connections/:id` 不再接收配置，合法本地 JSON 请求返回 `405` 与错误码 `ENV_MANAGED`。来源和内容类型检查仍先于路由执行。没有网页密钥输入、创建、编辑或启停模型流程。字段和加载规则见 README 的“预先配置模型”。

讨论：POST `/discussions` 创建并异步生成阵容，GET `/discussions` 支持 status/cursor/limit；GET `/:id/snapshot`；PUT `/:id/agent-bindings`；POST `/:id/start`、`/:id/finish`、`/:id/retry`；GET `/:id/events?after=N` 提供 SSE。

创建和讨论控制命令要求 Idempotency-Key。start/bindings 同时校验 expectedVersion 和 castVersion；finish/retry 校验 expectedVersion。保存绑定后返回新版本。非法参数 400，不存在 404，版本/状态冲突 409，资源限制 429。

SSE event 使用 `panel`，id 使用讨论内 eventSeq；data 为共享 PublicEventSchema 定义的 JSON。重连优先使用 Last-Event-ID，初次连接使用 after。每 20 秒心跳，慢连接断开后按游标补发。公开事件仅包含状态、阵容、发言或洞察增量。浏览器使用快照初始化并按 seq 归并，不使用内部意愿作为聊天内容。

快照新增 `draft: SpeechDraft | null`，包含 `turnId`、`discussionId`、`participantId`、`generation`、`kind`、`content`、`replyToMessageId`、`startedAt`。kind 为 expert/opening/probe/summary；content 为累计公开正文，允许空串表示等待首段或重新生成。草稿不属于 `messages`，没有 messageSeq。

| 流式相关事件        | payload                | 客户端行为                                                                  |
| ------------------- | ---------------------- | --------------------------------------------------------------------------- |
| `speech.updated`    | `{ draft }`            | 按 turnId、generation 和讨论归属校验后全文替换，不能把 content 追加到旧文本 |
| `speech.cleared`    | `{ turnId }`           | 仅清除匹配的当前草稿                                                        |
| `message.committed` | 既有正式消息及讨论信息 | 清除相同 turnId 草稿，再按消息 ID/turnId 去重加入正式记录                   |

草稿和事件入库后才推送，刷新通过 snapshot 恢复；续传、缺口和去重与其他公开事件相同。终态或 generation 变化时丢弃过期草稿。失败和取消不会把未校验草稿变成正式发言；只有正式消息可用于引用和洞察证据。草稿公开正文最多6000字符，专家展示额外限制为400字符。

所有公开对象采用严格 Zod 白名单。具体字段与枚举以 packages/contracts 为可执行来源。后端监听 127.0.0.1，写接口校验 Origin 及 JSON 内容类型；没有 Origin 的本地 CLI 需显式发送 X-Panel-Client: local。

新总结消息携带可选的 `summaryMeta`（旧历史消息可以缺省）。字段包括 `source: model|local`、`throughMessageSeq`、`insightsThroughMessageSeq`、`model`、`provider`、`connectionId`、`connectionVersion`、`fallbackUsed` 和 `reason`。本地来源的模型及连接字段均为null，reason为models_unavailable/budget_exhausted/deadline_exceeded；模型来源使用实际执行总结的本场冻结连接。总结覆盖序号必须等于最后一条正式讨论发言，洞察覆盖序号必须等于已保存的真实进度。

`summary.ready`沿用现有事件，携带包含summaryMeta的正式消息；同一事务清除草稿和内部收尾任务并进入completed。模型故障自动进入备用或本地整理，正常情况下不再要求用户反复点击retry。重启时已有收尾任务自动恢复；内部尝试队列、失败连接与计数不进入公开快照。取消、过期或存储错误仍保留既有错误处理，避免错误提交。
