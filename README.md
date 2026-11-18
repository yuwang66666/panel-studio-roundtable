# 圆桌 · AI Panel Studio

本地运行的中文多智能体圆桌讨论应用。按话题动态生成专家，为每位专家分配不同模型，让专家基于公开讨论自主选择参与，并实时形成带发言证据的共识、分歧和主持人总结。

## 启动

推荐 Node.js 24 LTS、pnpm 10.28.2。首次运行：

```powershell
pnpm install --frozen-lockfile
pnpm seed
pnpm dev
```

本机默认 Node 没有激活时，项目提供 PowerShell 入口，会优先使用已安装的 Codex Node 运行环境，并将安装缓存放在项目目录内：

```powershell
.\scripts\tool.ps1 install --frozen-lockfile
.\scripts\tool.ps1 seed
.\scripts\dev.ps1
```

打开 <http://127.0.0.1:5173>。前端端口 5173，后端仅监听 127.0.0.1:3001。二者独立运行，也可分别启动：

```powershell
pnpm --filter @panel/api dev
pnpm --filter @panel/web dev
```

开发环境支持 Vite 热更新和后端监听重启；重启会中断正在运行的讨论，历史发言保留，可请求收尾总结。生产前端构建使用 `pnpm build`，本项目按本地开发服务器运行方式交付，不包含云部署。

## 开始真实讨论

1. 打开“模型设置”，填写连接名称、服务商、接口协议、基础地址、实际模型 ID 和 API Key。
2. 保存后点击“测试连接”。测试会产生一次最小 API 调用；失败时检查 Key、权限、模型名、协议和地址。
3. 选择默认主持人。它默认负责阵容、主持、洞察和总结。
4. 创建话题并选择 2–6 位专家；默认 4 位专家加 1 位主持人。
5. 阵容生成后，为每位角色选择连接；不同专家可以使用不同服务商，也可共用连接。确认后冻结连接版本并启动。
6. 在演播厅阅读发言，点击回应与洞察来源回到原文。可以提前结束并生成总结。

支持 Chat Completions 兼容协议、OpenAI Responses、Anthropic Messages。服务商与协议分开设置；模型 ID 由实际账号提供，不预填未经验证的模型版本。自定义中转地址可修改。启用原生 JSON 输出前需确认服务商支持；默认通过 Prompt 和严格 Schema 验证输出。

API Key 加密保存在本地 `.data/panel.sqlite`，主密钥在 `.data/master.key`。备份和恢复时应一起保留二者；主密钥丢失后不能解密已有连接。连接摘要不会回显 Key，前端不将 Key 写入 localStorage。运行中的讨论使用冻结版本，后续编辑仅影响新启动的讨论。Git 已忽略数据库、密钥、环境文件和缓存。

## 样例与验收状态

`pnpm seed` 幂等初始化 5 场历史样例，每场都有阵容、发言、证据洞察和总结。所有样例均明确标识为预置内容。

自动验收已覆盖三种协议的本地 HTTP 模型测试服务、混合协议讨论、两场并行隔离、异常恢复及真实 Edge 浏览器操作。**尚未提供真实供应商 API 配置，真实模型输出质量、延迟和计费尚未验收。** 详见 [供应商验证表](docs/provider-validation.md)。`/preview` 路径仅用于静态界面原型验证，不调用模型。

## 验证命令

```powershell
pnpm test                 # 单元、接口、SQLite、模型协议、SSE和隔离检查
pnpm build                # 前端生产构建 + 前后端类型检查
pnpm test:e2e             # 四种宽度的原型与交互检查
pnpm test:e2e:live        # 隔离数据库中的真实前后端浏览器流程
pnpm verify:clean         # 将源文件复制到独立目录，重新安装、构建、初始化并启动验证
pnpm docs:api             # 从共享 Zod 契约重新生成 OpenAPI
pnpm format:check         # 源文件格式检查
```

本机也可使用 `.\scripts\tool.ps1 test` 等对应入口。E2E 默认使用本机 Microsoft Edge；其他环境可安装 Playwright Chromium，并将两份 Playwright 配置的 `channel` 改为已安装浏览器。正式 E2E 采用独立端口 5174，不使用工作空间中的实际模型连接；独立安装检查使用后端端口 3003。

## 架构与接口

前端为 React / Vite / TypeScript，TanStack Query 管理查询，Zustand 管理按讨论隔离的事件投影。后端为 Fastify 模块化单体，SQLite / Drizzle 保存业务数据，SSE 从持久事件日志推送。模型网关负责三协议、全局/连接/讨论并发、超时、重试与输出校验。

- 模型连接：`GET/POST /api/model-connections`，`PATCH /api/model-connections/:id`，`POST /api/model-connections/:id/test`。
- 默认主持人：`GET/PATCH /api/settings`。
- 讨论：`POST/GET /api/discussions`，`GET /:id/snapshot`，`PUT /:id/agent-bindings`，`POST /:id/start`、`/:id/finish`、`/:id/retry`。
- 实时事件：`GET /api/discussions/:id/events?after=N`，自动重连使用 Last-Event-ID。
- 用量：`GET /api/discussions/:id/usage`。没有单位价格配置时只提供调用次数与 token，不估算人民币费用。
- OpenAPI：`GET /api/openapi.json`；离线文件 [docs/openapi.json](docs/openapi.json)。

讨论写命令使用 Idempotency-Key；start/bindings 同时校验阵容和讨论版本。CLI 写请求需提供 `Content-Type: application/json` 与 `X-Panel-Client: local`。浏览器通过 Vite 同源代理访问，后端验证写请求 Origin 与本地主机名。

## 默认控制与恢复

最多 16 次专家发言，主持人开场/追问最多 4 次；每轮全员判断，反驳和补充优先，申请等待 3 轮后提升机会，有其他候选时同一专家最多连续发言 2 次。无人参与时最多引导两次，重复观点和持续分歧也可触发主持人追问。

每 3 条专家发言或出现反驳触发洞察；总结前强制覆盖最后发言。每场预留 12 次收尾调用；用户显式重试收尾时，如剩余不足 12 次，补齐至 12 次。普通调用超时 60 秒、总结 90 秒，暂时性网络/服务错误最多重试 2 次，输出最多修复 1 次。

默认全局模型并发 4、单连接 2、单场 4、同时运行讨论 3 场。可复制 `.env.example` 为 `.env` 调整已列出的参数；修改后重启后端。`DATA_DIR` 默认是仓库 `.data`；配置自定义路径时请使用绝对路径。修改端口时同时调整代理和 `ALLOWED_ORIGINS`。

阵容失败可重试；总结失败可保留已有发言重试；中断场次可请求总结，首版不续跑到原轮次。已有总结不会反向参与共识计算。当前版本为匿名本地单实例，不包括账号、联网检索、音视频、时间轴回放或云部署。

过程记录见 [任务清单](docs/tasks.md)、[阶段验收](docs/verification.md)、[真实 Prompt 记录](docs/prompts.md)、[开发反思](docs/workflow-reflection.md)、[架构](docs/architecture.md) 与 [数据模型](docs/data-model.md)。按用户选择，本次交付保留本地 Git 仓库及逐阶段提交，不执行远程推送。
