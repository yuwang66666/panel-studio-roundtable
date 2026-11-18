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
