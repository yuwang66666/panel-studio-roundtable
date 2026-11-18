# 阶段验收证据

## T00 · 2026-11-18

- `scripts/tool.ps1 install`：成功，pnpm 10.28.2，已生成锁文件。
- `scripts/tool.ps1 build`：Vite 生产构建与前后端 TypeScript 检查通过。
- `scripts/tool.ps1 dev`：前端 127.0.0.1:5173，后端 127.0.0.1:3001 分别启动。
- 后端 `/api/health` 与前端代理 `/api/health`：均返回 `{ok:true}`；前端首页 HTTP 200。
- 已发现并修复：SQLite 安装缓存越界；子进程找到未激活的 nvm pnpm。修正为项目内缓存和可用 runtime 的 PATH。
