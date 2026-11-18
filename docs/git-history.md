# Git 提交演进

仓库保留开发过程中真实产生的提交、父子关系和时间，未压成一个“完整源码”提交，也未为了展示顺序重写既有历史。起点先完成可运行工程，随后固化契约、建立界面和测试，再按讨论生命周期实现逻辑；后续需求以独立feat/fix提交推进。

```mermaid
flowchart LR
  Init[工程初始化] --> Contract[docs / schema / 契约]
  Contract --> UI[ui / 组件 / 原型]
  UI --> Test[tests / 模型桩 / 样例]
  Test --> Repo[feat / 数据与模型网关]
  Repo --> Logic[feat / 阵容 / 调度 / 洞察]
  Logic --> Realtime[SSE / 并行 / E2E]
  Realtime --> Iteration[流式 / 收尾 / 公开边界修复]
  Iteration --> Delivery[交付文档 / 样例 / 干净复验]
```

## 可核对的阶段提交

| 层次                    | 提交      | 实际产出                                                                 |
| ----------------------- | --------- | ------------------------------------------------------------------------ |
| 工程                    | `913edfa` | 验证过的本地TypeScript workspace                                         |
| docs/schema             | `2de7405` | 领域契约、生命周期、公开边界                                             |
| ui-components           | `49a4ebf` | 深色演播厅与页面原型                                                     |
| tests                   | `0ef736c` | 确定性模型协议测试桩、样例校验                                           |
| feat: persistence       | `a01401a` | 隔离讨论、事务、消息与事件存储                                           |
| feat: gateway           | `1dae61b` | 多模型协议与凭据配置                                                     |
| feat: cast              | `d8bc745` | 动态角色及版本化绑定                                                     |
| feat: speech            | `477c564` | 上下文窗口、回应目标、短发言校验                                         |
| feat: orchestration     | `b2dab1c` | 自主参与、公平仲裁与轮次控制                                             |
| feat: insights          | `d144d33` | 证据洞察和最终总结                                                       |
| feat: realtime          | `a6c56d4` | 持久SSE与浏览器恢复                                                      |
| tests: isolation        | `e26c1b6` | 并行、取消和收尾预算                                                     |
| tests: browser          | `225b114` | 混合协议、响应式与无障碍                                                 |
| docs: first delivery    | `41fff44` | 首轮MVP交付、样例与干净安装                                              |
| feat: env catalog       | `833c08e` | 按用户变更改为后端环境配置模型                                           |
| docs: real probes       | `8ff00c3` | 顺序真实连接验证记录                                                     |
| fix: relay probes       | `96e5f37` | 连接探针和中转凭据复测                                                   |
| feat: streaming         | `44af781` | 可恢复流式正文草稿                                                       |
| fix: insights limits    | `2c77eea` | 洞察独立超时和token额度                                                  |
| fix: summary limits     | `8816b1e` | 总结期限及阶段错误说明                                                   |
| feat: resilient closing | `6a0b477` | 有限备用模型与本地摘要                                                   |
| feat: history deletion  | `42fe6e6` | 确认删除、事务清理与跨页同步                                             |
| feat: public status     | `d5ae2a2` | 专家状态同步、公开关注点隔离                                             |
| fix: summary prose      | `a1492c5` | 自然语言总结与JSON原文隔离                                               |
| fix: technical audit    | `c93feb3` | 私有文件边界、全站容器滚动、平板和超宽布局                               |
| feat: delivery data     | `4048c0d` | 五套话题专属阵容、短发言与证据校验、独立初始化、可生成的Markdown样例全文 |

前25次为交付整理开始前的本地开发提交；本次样例和初始化入口形成第26次提交，文档和复验继续追加，最终提交号以仓库main为准。早期提交包含当时有效的网页配置设计，后续环境配置提交体现用户要求的变更；旧历史不会被改写为当前设计。

远程最初有 `2fd31c3`（Initial commit），内容为项目名称和一句MVP说明。交付时通过合并保留该历史，README由现有完整运行及交付指南承接，不强制覆盖远程提交。

## 复查方法

```sh
git log --reverse --oneline
git log --graph --oneline --decorate --all
git show --stat 2de7405
git show --stat 49a4ebf
git show --stat 0ef736c
git show --stat b2dab1c
```

提交信息用于导航，真实改动以diff为准；每阶段验收命令、失败修复和通过结果见[阶段验收](verification.md)，真实过程指令见[Prompt记录](prompts.md)。
