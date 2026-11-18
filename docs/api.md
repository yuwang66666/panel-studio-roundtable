# API 与事件约定

REST 统一 /api 前缀。错误返回 `{error:{code,message}}`，不包含上游原始响应或请求凭据。

## 接口速查

本地地址 `http://127.0.0.1:3001/api`；浏览器通过5173同源代理调用。机器可读契约为 [openapi.json](openapi.json)，由 `pnpm docs:api` 生成；下表与示例为Markdown阅读入口。

| 方法与完整路径                            | 请求                                                                    | 成功响应                                          |
| ----------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------- |
| GET `/api/health`                         | 无                                                                      | 200 `{ok:true}`                                   |
| GET `/api/model-connections`              | 无                                                                      | 200 模型摘要数组，含id/version/hasApiKey，不含Key |
| POST `/api/model-connections/:id/test`    | `{}`                                                                    | 200 `{ok:true,message}`，执行一次最小模型调用     |
| GET / PATCH `/api/settings`               | PATCH为 `{defaultModeratorConnectionId}`                                | 200 当前设置                                      |
| GET `/api/discussions`                    | status可选，limit默认50/最大100，cursor透传                             | 200 `{items,nextCursor}`                          |
| POST `/api/discussions`                   | `{topic,expertCount?,moderatorConnectionId?}`                           | 202 初始Snapshot，阵容后台生成                    |
| GET `/api/discussions/:id/snapshot`       | 无                                                                      | 200 Snapshot                                      |
| PUT `/api/discussions/:id/agent-bindings` | `{expectedVersion,castVersion,bindings:[{participantId,connectionId}]}` | 200 新Snapshot                                    |
| POST `/api/discussions/:id/start`         | `{expectedVersion,castVersion}`                                         | 202 Snapshot                                      |
| POST `/api/discussions/:id/finish`        | `{expectedVersion}`                                                     | 202 Snapshot                                      |
| POST `/api/discussions/:id/retry`         | `{expectedVersion}`                                                     | 202 Snapshot                                      |
| DELETE `/api/discussions/:id`             | `{expectedVersion}`                                                     | 200 `{id,deleted:true}`                           |
| GET `/api/discussions/:id/usage`          | 无                                                                      | 200 `{calls,errorCalls,inputTokens,outputTokens}` |
| GET `/api/discussions/:id/events`         | after或Last-Event-ID                                                    | 200 `text/event-stream`                           |
| GET `/api/openapi.json`                   | 无                                                                      | 200 OpenAPI 3.0.3文档                             |

Snapshot包含 `discussion`、`participants`、`bindings`、`messages`、`draft`、`insights`、`lastEventSeq`。创建话题须为5–500字符，专家人数默认4、范围2–6；bindings必须覆盖主持人及全部专家。保存绑定会改变version，开始前必须使用返回的新版本。事件序号不替代控制命令版本。

## 调用示例与错误处理

只读样例查询不需要模型配置：

```powershell
$snapshot = Invoke-RestMethod http://127.0.0.1:3001/api/discussions/sample-1/snapshot
$snapshot.participants | Select-Object name, occupation, stance
```

以下创建示例会使用已配置的默认主持人并产生模型调用。先完成环境配置；网络重试同一请求时保留原Idempotency-Key，新动作使用新键。

```powershell
$headers = @{ 'X-Panel-Client' = 'local'; 'Idempotency-Key' = [guid]::NewGuid().ToString() }
$body = @{ topic = '城市如何改善公共交通的可靠性？'; expertCount = 4 } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3001/api/discussions `
  -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
```

参数错误400应先改输入；403检查Origin或本地客户端请求头；404重新获取列表；409重新取快照并检查状态/版本，不盲目重放旧版本；429等待容量释放。模型调用失败返回安全错误信息，具体阶段可从讨论的failureStage/error读取。删除后旧创建幂等键返回410，模型配置写接口返回405。JSON写入的内容类型不正确返回415。

## 版本、事件与隐私契约

模型目录：GET `/model-connections` 返回模型连接摘要（包含 active 状态，不含密钥）；网页只提供启用模型供选择。POST `/model-connections/:id/test` 使用后端保存的凭据执行最小调用，JSON 请求体为 `{}`。GET/PATCH `/settings` 查询或选择默认主持人连接。

模型配置只从根目录 `.env` 加载，由后端启动时同步。旧 POST `/model-connections` 与 PATCH `/model-connections/:id` 不再接收配置，合法本地 JSON 请求返回 `405` 与错误码 `ENV_MANAGED`。来源和内容类型检查仍先于路由执行。没有网页密钥输入、创建、编辑或启停模型流程。字段和加载规则见 README 的“预先配置模型”。

讨论：POST `/discussions` 创建并异步生成阵容，GET `/discussions` 支持 status/cursor/limit；GET `/:id/snapshot`；PUT `/:id/agent-bindings`；POST `/:id/start`、`/:id/finish`、`/:id/retry`；GET `/:id/events?after=N` 提供 SSE。

创建和讨论控制命令要求 Idempotency-Key。start/bindings 同时校验 expectedVersion 和 castVersion；finish/retry 校验 expectedVersion。保存绑定后返回新版本。非法参数 400，不存在 404，版本/状态冲突 409，资源限制 429。

DELETE `/discussions/:id` 接收 JSON `{expectedVersion:number}`，返回 `{id,deleted:true}`，无需 Idempotency-Key，重复删除仍返回200。待确认、已完成、失败和中断讨论可以删除；生成阵容、讨论、总结中或后台尚未退出的讨论返回409，版本过期同样返回409。删除在一个事务中清理发言、洞察、证据、角色、绑定、草稿、收尾任务、事件、调用记录及本场控制命令回执，共享模型配置和其他讨论保留。创建命令仅留下不含讨论正文的删除标记，旧创建幂等键重放返回410 `DISCUSSION_DELETED`，避免重建已删除的会话。删除也执行本地来源和JSON请求校验。

删除后快照返回404；已连接的SSE客户端收到临时 `event: deleted`（data为 `{id}`）并关闭连接。该通知不占用事件序号，客户端清除本场缓存并显示已删除提示；断线后通过快照404识别删除。

SSE event 使用 `panel`，id 使用讨论内 eventSeq；data 为共享 PublicEventSchema 定义的 JSON。重连优先使用 Last-Event-ID，初次连接使用 after。每 20 秒心跳，慢连接断开后按游标补发。公开事件仅包含状态、阵容、发言或洞察增量。浏览器使用快照初始化并按 seq 归并，不使用内部意愿作为聊天内容。

参与者快照沿用 `status: idle|preparing|speaking` 和 `publicFocus: string|null`。idle在界面显示“待机”；preparing包括全员参与判断、排队、等待公开首段和修复；speaking仅在出现非空白公开正文后成立。放弃、无效、未获选、提交、取消、失败及重启复位为idle，并清除过期关注点。`publicFocus`由后端从公开专业标签和本场正式目标发言序号构造，不返回意愿`proposedFocus`、完整意愿JSON、reasoning或thinking。旧快照字段结构保持不变。

快照新增 `draft: SpeechDraft | null`，包含 `turnId`、`discussionId`、`participantId`、`generation`、`kind`、`content`、`replyToMessageId`、`startedAt`。kind 为 expert/opening/probe/summary；content 为累计公开正文，允许空串表示等待首段或重新生成。草稿不属于 `messages`，没有 messageSeq。

| 流式与状态事件              | payload                                  | 客户端行为                                                                  |
| --------------------------- | ---------------------------------------- | --------------------------------------------------------------------------- |
| `speech.updated`            | `{ draft }`                              | 按 turnId、generation 和讨论归属校验后全文替换，不能把 content 追加到旧文本 |
| `speech.cleared`            | `{ turnId }`                             | 仅清除匹配的当前草稿                                                        |
| `message.committed`         | 既有正式消息及讨论信息                   | 清除相同 turnId 草稿，再按消息 ID/turnId 去重加入正式记录                   |
| `participant.state_changed` | `{ participantId, status, publicFocus }` | 仅更新对应参与者状态卡，不作为Transcript发言；重复事件仍按seq去重           |

草稿和事件入库后才推送，刷新通过 snapshot 恢复；续传、缺口和去重与其他公开事件相同。终态或 generation 变化时丢弃过期草稿。失败和取消不会把未校验草稿变成正式发言；只有正式消息可用于引用和洞察证据。草稿公开正文最多6000字符，专家展示额外限制为400字符。

草稿开始、正文出现、修复清空及正式提交所对应的参与者状态在同一事务中保存；事务失败不留下只有草稿或只有状态的部分结果。前端先以快照恢复状态，再接续事件游标；状态播报由专家席一个聚合的aria-live区域承担，不把关注点或正文的每个片段逐字播报。

所有公开对象采用严格 Zod 白名单。具体字段与枚举以 packages/contracts 为可执行来源。后端监听 127.0.0.1，写接口校验 Origin 及 JSON 内容类型；没有 Origin 的本地 CLI 需显式发送 X-Panel-Client: local。

文件访问不属于公开API：Vite开发服务和构建预览在文件路由检查发现敏感路径或白名单外目标时返回403，不返回文件内容，模块加载也拒绝读取白名单外的实际文件。保护范围包括环境配置、数据库与伴随文件、密钥、后端源码及工作区私有目录；普通路径、`/@fs/`、编码路径、资源查询参数及文件链接均经过文件边界检查。公开前端路由、客户端依赖和同源`/api`代理保持可用。

新总结消息携带可选的 `summaryMeta`（旧历史消息可以缺省）。字段包括 `source: model|local`、`throughMessageSeq`、`insightsThroughMessageSeq`、`model`、`provider`、`connectionId`、`connectionVersion`、`fallbackUsed` 和 `reason`。本地来源的模型及连接字段均为null，reason为models_unavailable/budget_exhausted/deadline_exceeded；模型来源使用实际执行总结的本场冻结连接。总结覆盖序号必须等于最后一条正式讨论发言，洞察覆盖序号必须等于已保存的真实进度。

`summary.ready`沿用现有事件，携带包含summaryMeta的正式消息；同一事务清除草稿和内部收尾任务并进入completed。模型故障自动进入备用或本地整理，正常情况下不再要求用户反复点击retry。重启时已有收尾任务自动恢复；内部尝试队列、失败连接与计数不进入公开快照。取消、过期或存储错误仍保留既有错误处理，避免错误提交。

总结正文不改变REST或SSE的JSON传输格式。模型响应仍为严格外层对象，但新提交的`kind=summary`消息，其`content`必须为通过完整校验的规范自然语言；后端可剥离有界的单字段`content`/`summary`或JSON字符串包装，未知对象、数组、结构化片段及额外隐藏字段不能作为正文保存。无效输出沿用收尾尝试预算，不增加无限修复路径。总结的`speech.updated.payload.draft.content`只含安全正文投影，不完整或模糊结构部分可暂缓为空，普通自然语言仍按累计文本更新。

历史快照保留原存量消息与`summaryMeta`，不因显示格式问题重写数据库。客户端对历史总结安全提取正文；无法提取时仅在阅读层构建明确标识的本地整理，范围限于该总结之前的同场正式发言，并说明原记录未修改。显示来源不沿用原模型成功标识，证据链接使用实际整理范围；缺省`summaryMeta`的旧记录同样适用。本地摘录中结构化源文本显示可追溯提示而非序列化原文，原始发言仍可通过引用定位。
