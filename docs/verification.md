# 阶段验收证据

## T00 · 2026-11-18

- `scripts/tool.ps1 install`：成功，pnpm 10.28.2，已生成锁文件。
- `scripts/tool.ps1 build`：Vite 生产构建与前后端 TypeScript 检查通过。
- `scripts/tool.ps1 dev`：前端 127.0.0.1:5173，后端 127.0.0.1:3001 分别启动。
- 后端 `/api/health` 与前端代理 `/api/health`：均返回 `{ok:true}`；前端首页 HTTP 200。
- 已发现并修复：SQLite 安装缓存越界；子进程找到未激活的 nvm pnpm。修正为项目内缓存和可用 runtime 的 PATH。

## T01 · 2026-11-18

- `scripts/tool.ps1 test`：4/4 通过，覆盖状态跳跃、人数边界、公开对象拒绝密钥/隐藏推理、6 专家预算。
- `scripts/tool.ps1 typecheck`：前后端通过。
- PRD、架构、ER 与 API 文档和共享契约一致；version 用于命令锁，eventSeq 用于公开变更。

## T02 · 2026-11-18

- build、typecheck 通过；2 个 Playwright 场景通过，覆盖四宽度、样例证据定位、连接配置、创建阵容。
- 截图检查桌面三栏、手机页签和滚动区域。
- 首次测试发现 API Key 的可访问名称包含说明文字，修正显式 aria-label 后重跑通过。

## T03 · 2026-11-18

- 7/7 测试、typecheck 通过。五组样例符合严格 Schema，证据均属于本场。
- 模型测试服务支持三种响应协议及限流注入；确定性业务输出覆盖阵容、意愿、发言、洞察和总结。

## T04 · 2026-11-18

- 12/12 测试与 typecheck 通过。
- 强制事务抛错后快照和事件完全回滚；同一 turn 只写入一次；跨讨论角色引用失败。
- 凭据密文存储，历史版本仍可解析，启动后修改模型不改变已有绑定。
- 首次发现 SQL INSERT 列数不匹配，改为显式列名后全部复测通过。

## T05 · 2026-11-18

- 19/19 测试与 typecheck 通过；三种协议均向本地 HTTP 模型服务完成调用。
- 覆盖 429 重试、401 不重试、JSON 一次修复、超时、取消、跨域写拒绝、公开响应无密钥。
- 正式同源代理的 model-connections/settings 均 HTTP 200。
- 首次检查修复了测试根目录缺少 zod、Chat Completions 分支括号错误，并重启了编译失败后未自动恢复的开发服务。
- DeepSeek/Claude/Qwen/GPT/Kimi 的真实账户连接均尚未提供，未声称真实供应商验证完成。
