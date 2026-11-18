# 测试与验收指南

## 无真实API Key运行

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm test:e2e
pnpm test:e2e:live
pnpm test:e2e:layout
pnpm format:check
pnpm verify:clean
```

在本机可把 `pnpm` 换为 `.\scripts\tool.ps1`。测试桩只监听本机并按业务用途返回确定性结果；API集成使用临时数据库，测试不删除用户历史。`live`指真实前后端与浏览器联调，模型端仍是本地测试服务，不表示真实供应商验收。

## 测试层次

| 层次           | 入口或代表文件                                                    | 核心断言                                                         |
| -------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| 契约/纯逻辑    | `contracts`、`speech`、`engine`、`participant-focus`              | 生命周期、短发言、同轮上下文、调度公平性、公开关注点             |
| 数据库/事务    | `repository`、`drafts`、`closing-repository`、`delete-discussion` | 原子提交、幂等、复合引用、删除清理、重启恢复                     |
| HTTP模型协议   | `gateway`、`streaming`、`insights-limits`、`summary-limits`       | 三协议请求与流、鉴权/限流/超时/JSON修复、取消、用量              |
| 讨论与证据     | `casting`、`insights`、`isolation`、`events`                      | 动态阵容、证据归属、局部共识、并行隔离、SSE游标与重连            |
| 收尾与隐私     | `summary-resilience`、`summary-prose*`、`participant-state`       | 备用模型/本地整理、自然语言、隐藏字段隔离、迟到结果拒绝          |
| 浏览器文件边界 | `private-file-routes`                                             | 假私密文件GET/HEAD、编码/查询/链接绕过拦截；合法模块/HMR保持可用 |
| 样例           | `fixtures`                                                        | 5场Schema、短发言、同场回应、证据及对应嘉宾完整                  |
| 浏览器         | `tests/e2e/*.spec.ts`                                             | 完整流程、删除、断线与刷新、滚动位置、页签与键盘                 |

## 浏览器环境与证据

默认配置使用已安装的Microsoft Edge（`channel: msedge`）。其他环境先执行 `pnpm exec playwright install chromium`，再从三份 `playwright*.config.ts` 移除 `channel: 'msedge'`，使用Playwright Chromium。当前记录的实际浏览器验收环境为Windows和Edge；其他平台不冒记通过。

| 套件           | 端口 | 产物目录                 |
| -------------- | ---- | ------------------------ |
| 原型           | 5175 | `test-results/prototype` |
| 真实前后端流程 | 5174 | `test-results/live`      |
| 五宽度布局     | 5176 | `test-results/layout`    |

布局覆盖375、768、1024、1440、2560px和375×568短视口，并使用长列表验证真实溢出与末项可达。截图目录被Git忽略；克隆后运行测试即可生成。测试失败的截图用于诊断，不能将“页面能打开”替代实际断言通过。

## 失败定位与真实验收范围

端口被占用时先确认是否存在另一个测试进程；不要结束用户正在运行的3001/5173服务。原生SQLite依赖安装失败时核对Node版本及平台构建工具。出现断言失败时保留错误输出和截图，先运行对应文件，再在改动稳定后运行完整回归。

最新实际计数与耗时见[阶段验收](verification.md)，真实模型的账户、协议及业务验证边界见[供应商记录](provider-validation.md)。模型连接最小测试成功不能替代整场讨论质量、延迟及成本验收。
