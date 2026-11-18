# 完整源码交付清单

交付仓库：<https://github.com/yuwang66666/panel-studio-roundtable>，远程主分支为 `main`。交付方式为完整Git历史推送，接收方可克隆后按[README](../README.md)启动。无需API Key即可查看5场样例；真实讨论须使用接收方自己的后端环境配置。

已完成发布：首批源码交付合并提交为 `7a1c742`，远程提交号已核对一致；随后追加发布记录，最终版本取main最新提交。交付验证为265项单元/集成与21项浏览器测试通过、干净安装通过、8个Mermaid图语法通过。

## 内容对应

| 交付要求          | 文件与目录                                                                         | 如何核验                                                          |
| ----------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 完整前后端源码    | `apps/web`、`apps/api`、`packages/contracts`、`packages/domain`                    | `pnpm build`，前后端可分别启动                                    |
| 数据库初始化脚本  | `db/migrations/001.sql`–`003.sql`、`apps/api/src/init-db.ts`                       | `pnpm db:init`，见[初始化文档](database.md)                       |
| 至少5条高质量样例 | `packages/domain/src/samples.ts`、`apps/api/src/seed.ts`                           | `pnpm seed`；[样例全文](samples.md)列明对应阵容、发言与证据       |
| PRD与开发文档     | [PRD](PRD.md)、[架构/状态机/时序](architecture.md)、[ER图/数据模型](data-model.md) | 均为Markdown，图使用Mermaid                                       |
| API文档           | [REST/SSE文档](api.md)、`docs/openapi.json`                                        | Markdown请求示例与机器可读Schema，`pnpm docs:api`可重建           |
| 测试代码          | `tests/*.test.ts`、`tests/e2e`、`tests/fixtures`                                   | [测试指南](testing.md)，无需真实模型完成自动回归                  |
| README完整度      | [运行指南与选型](../README.md)                                                     | 运行、环境变量、技术选型、主要API、已完成能力及后续方向           |
| Git演进层次       | [提交演进映射](git-history.md)                                                     | 真实docs/schema→ui→tests→feat logic及后续修复可用git show逐条核对 |
| 核心Prompt记录    | [多范式工程Prompt](prompts.md)                                                     | 10段重构稿，标记SDD/DDD/TDD/E2E；每段1–2句说明及实际提交依据      |
| 过程与证据        | [任务](tasks.md)、[验收](verification.md)、[反思](workflow-reflection.md)          | 每项产出和实际结果对应                                            |

## 样例质量说明

五个主题覆盖就业、公共交通、远程办公、企业模型选型和自动驾驶。各场使用独立的虚构主持人及四位对应专业嘉宾；每位有职业、Title、立场、专业标签和颜色标识。专家发言控制在1–2句，包含明确反驳及补充，回应只指向更早的本场发言。每场提供3类洞察，局部共识列明支持者，分歧关联双方发言，未解问题可追溯；主持人以自然语言收束。

样例是人工编写的确定性演示数据，不是实际模型生成成功的证据，也不用于替代真实自主调度验收。种子导入幂等，不写入真实连接或凭据。

## 接收方复现路径

1. 克隆main，准备Node 24 LTS和pnpm 10.28.2，按锁文件安装依赖。
2. 执行 `pnpm db:init`、`pnpm seed`、`pnpm dev`，打开5173浏览5场样例及证据。
3. 按README复制 `.env.example`，填写需要的实际模型配置并重启后端，完成连接测试和一场真实讨论。
4. 按[测试指南](testing.md)运行自动回归；使用 `pnpm verify:clean` 在独立目录验证安装、构建、测试、初始化和前后端启动。
5. 在仓库Commits页或本地git log核对开发层次，并结合阶段验收阅读相关diff。

## 验收边界

最新交付复验记录位于[阶段验收的T25](verification.md)。公开提交包含代码、SQL、空白环境模板、Markdown与可执行测试，不包含实际 `.env`、主密钥、用户数据库、运行日志或依赖缓存。截图及本机诊断报告可通过测试重新生成。

三种协议已有本地测试服务覆盖，配置过的真实模型最小连接测试与业务质量验收分别记录在[供应商验证表](provider-validation.md)。真实混合讨论质量、跨平台浏览器以及未来改进项按README列出，不把测试桩通过表述为这些项目已经验收。
