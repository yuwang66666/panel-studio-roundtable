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

## 预先配置模型

模型、接口地址和 API Key 统一在仓库根目录 `.env` 配置。网页直接显示可选模型，不需要手动添加连接，也不提供密钥输入框。

首次配置时，如果根目录还没有 `.env`，复制模板：

```powershell
Copy-Item .env.example .env
```

模板已准备 DeepSeek、Claude、Qwen、GPT、Kimi 的服务商、协议和基础地址。填写需要使用的条目中的 `MODEL` 和 `API_KEY`，按实际服务商或中转服务调整地址与协议，然后启动或重启后端。未使用条目的 `MODEL` 和 `API_KEY` 都保持为空，会自动跳过；只填写其中一个会在启动时报告对应变量名。

例如一个模型条目由以下字段组成（模型 ID 与密钥需换成实际值）：

```dotenv
PANEL_MODELS=DEEPSEEK
PANEL_DEFAULT_MODERATOR=DEEPSEEK
MODEL_DEEPSEEK_NAME="研究模型"
MODEL_DEEPSEEK_PROVIDER=deepseek
MODEL_DEEPSEEK_PROTOCOL=openai-chat
MODEL_DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
MODEL_DEEPSEEK_MODEL="填写账号可用的实际模型ID"
MODEL_DEEPSEEK_API_KEY="填写实际API Key"
MODEL_DEEPSEEK_STRUCTURED_OUTPUT=false
```

`PANEL_MODELS` 是以逗号分隔的模型标识清单。标识以大写字母开头，只包含大写字母、数字和下划线，最多40字符。每个标识对应一组 `MODEL_<标识>_*` 字段。同一服务商的多个模型使用不同标识，例如 `DEEPSEEK_FAST` 与 `DEEPSEEK_REASONING`；复制完整字段组并加入清单即可，共用凭据时也填写实际密钥。标识决定连接身份，修改显示名称用 `NAME`，不要通过改标识改名。

`PANEL_DEFAULT_MODERATOR` 可留空：优先保留网页已选且仍有效的默认模型，否则使用清单中第一个可用模型。填写时必须指向完整配置的标识，每次重启都会将它设为默认主持人。网页中的默认选择在本次运行期间仍可调整。

支持 `openai-chat`（Chat Completions 兼容协议）、`openai-responses` 和 `anthropic`（Anthropic Messages）。服务商品牌与协议分别填写，不按模型名称猜测协议。`PROVIDER` 可填 `deepseek`、`claude`、`qwen`、`gpt`、`kimi`、`custom`；基础地址不附加 `/chat/completions` 等操作路径。`STRUCTURED_OUTPUT` 默认为 `false`，服务商支持原生 JSON 输出时才改为 `true`。默认使用 Prompt 和严格 Schema 验证输出。

含 `#` 或空格的值加引号；此配置不支持 `${变量名}` 插值。`.env` 只由后端读取，不会作为前端配置打包，也不应使用 `VITE_` 前缀保存密钥。`.env` 中的密钥是明文；后端同步连接版本后，历史凭据使用 AES-256-GCM 加密保存在 `.data/panel.sqlite`，主密钥位于 `.data/master.key`。备份历史数据库时需同时保留主密钥。`.env`、数据库及密钥文件均已被 Git 忽略，`.env.example` 只保存空白模板。

后端启动时以环境模型清单为准：相同配置不会重复创建连接版本；配置或密钥改变后生成新版本，并清除该版本的旧测试状态；从清单移除的模型以及旧网页创建的连接停用，历史版本仍保留。讨论启动时冻结模型版本，历史发言与绑定不被改写。修改 `.env` 后需要重启后端，重启会中断运行中的讨论，已保存内容可继续查看和请求总结。

## 开始真实讨论

1. 完成 `.env` 预配置并启动服务后，打开“模型设置”，直接浏览已配置的模型。
2. 点击“测试连接”。测试会产生一次最小 API 调用；失败时在 `.env` 检查 Key、权限、模型 ID、协议和地址，修改后重启再测。
3. 选择默认主持人。它默认负责阵容、主持、洞察和总结。
4. 创建话题并选择 2–6 位专家；默认 4 位专家加 1 位主持人。
5. 阵容生成后，为每位角色从列表选择模型；不同专家可以使用不同服务商，也可共用模型。确认后冻结连接版本并启动。
6. 在演播厅阅读流式发言，点击回应与洞察来源回到原文。可以提前结束并生成总结。

模型摘要不会返回 API Key，网页不接收或持久化密钥。尚未完整配置任何模型时，可以阅读历史样例，真实讨论按钮保持不可用。

## 流式发言

专家发言、主持人开场、追问和最终总结会在生成过程中逐段显示，发言旁标注“正在生成”。支持 Chat Completions、Responses 和 Anthropic Messages 的真实 SSE；若上游忽略流式参数并返回普通 JSON，则完成后一次显示，不模拟打字效果。

正在生成的正文作为独立草稿保存，刷新或断线重连可恢复。完整输出通过句数、长度及格式校验后，同一位置替换成正式发言；草稿不计入发言数，不进入下一轮上下文或洞察证据。只展示公开正文，不显示 JSON 包装、参与意愿或隐藏推理。输出修复或网络重试时清空旧草稿再生成，失败、取消和服务重启时清除未完成草稿，保留已提交发言。

停留在讨论区底部时自动跟随新片段；上翻阅读时保留当前位置，以“发言更新中”或新发言条数提示，点击后回到底部。手机“现场”页签同样支持流式显示，并遵循系统的减少动态效果设置。

## 样例与验收状态

`pnpm seed` 幂等初始化 5 场历史样例，每场都有阵容、发言、证据洞察和总结。所有样例均明确标识为预置内容。

自动验收已覆盖三种协议的本地 HTTP 模型测试服务、混合协议讨论、两场并行隔离、异常恢复及真实 Edge 浏览器操作。**已配置的5个模型目前均通过最小连接测试。Claude曾对圆桌角色指令返回自然语言拒绝，角色兼容性和真实讨论完整闭环及质量、计费仍待验收。** 连接测试采用中性短请求并严格校验JSON，仅证明当前配置能完成最小JSON调用。详见 [供应商验证表](docs/provider-validation.md)。`/preview` 路径仅用于静态界面原型验证，不调用模型。

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

本机也可使用 `.\scripts\tool.ps1 test` 等对应入口。E2E 默认使用本机 Microsoft Edge；其他环境可安装 Playwright Chromium，并将两份 Playwright 配置的 `channel` 改为已安装浏览器。正式 E2E 采用独立端口 5174和隔离.env中的测试模型，原型 E2E 使用独立端口5175；均不使用工作空间中的实际模型连接。独立安装检查使用后端端口3003和公开空白.env模板，清除继承的模型环境变量，不复制本地凭据。

正式流程与原型的测试产物分别保存于 `test-results/live` 和 `test-results/prototype`，依次运行不会互相清除截图。流式截图为 `test-results/live/streaming-desktop.png` 与 `streaming-mobile.png`。

## 架构与接口

前端为 React / Vite / TypeScript，TanStack Query 管理查询，Zustand 管理按讨论隔离的事件投影。后端为 Fastify 模块化单体，SQLite / Drizzle 保存业务数据，SSE 从持久事件日志推送。模型网关负责三协议、全局/连接/讨论并发、超时、重试与输出校验。

- 模型目录：`GET /api/model-connections` 返回无密钥摘要，`POST /api/model-connections/:id/test` 验证已配置模型。旧创建和修改接口返回 `405 ENV_MANAGED`，模型配置只从 `.env` 加载。
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
