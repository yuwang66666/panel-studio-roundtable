# API 与事件约定

REST 统一 /api 前缀。错误返回 `{error:{code,message}}`，不包含上游原始响应或请求凭据。

模型目录：GET `/model-connections` 返回模型连接摘要（包含 active 状态，不含密钥）；网页只提供启用模型供选择。POST `/model-connections/:id/test` 使用后端保存的凭据执行最小调用，JSON 请求体为 `{}`。GET/PATCH `/settings` 查询或选择默认主持人连接。

模型配置只从根目录 `.env` 加载，由后端启动时同步。旧 POST `/model-connections` 与 PATCH `/model-connections/:id` 不再接收配置，合法本地 JSON 请求返回 `405` 与错误码 `ENV_MANAGED`。来源和内容类型检查仍先于路由执行。没有网页密钥输入、创建、编辑或启停模型流程。字段和加载规则见 README 的“预先配置模型”。

讨论：POST `/discussions` 创建并异步生成阵容，GET `/discussions` 支持 status/cursor/limit；GET `/:id/snapshot`；PUT `/:id/agent-bindings`；POST `/:id/start`、`/:id/finish`、`/:id/retry`；GET `/:id/events?after=N` 提供 SSE。

创建和讨论控制命令要求 Idempotency-Key。start/bindings 同时校验 expectedVersion 和 castVersion；finish/retry 校验 expectedVersion。保存绑定后返回新版本。非法参数 400，不存在 404，版本/状态冲突 409，资源限制 429。

SSE event 使用 `panel`，id 使用讨论内 eventSeq；data 为共享 PublicEventSchema 定义的 JSON。重连优先使用 Last-Event-ID，初次连接使用 after。每 20 秒心跳，慢连接断开后按游标补发。公开事件仅包含状态、阵容、发言或洞察增量。浏览器使用快照初始化并按 seq 归并，不使用内部意愿作为聊天内容。

所有公开对象采用严格 Zod 白名单。具体字段与枚举以 packages/contracts 为可执行来源。后端监听 127.0.0.1，写接口校验 Origin 及 JSON 内容类型；没有 Origin 的本地 CLI 需显式发送 X-Panel-Client: local。
