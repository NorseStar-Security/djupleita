---
description: "循环与工具执行 guard 的包映射，涵盖重复调用提醒、超时和显式启用的域名范围。"
kind: "package-group"
---

# guard/：循环与工具执行策略

[English](README.md) | 中文

## 概述

`guard/` 组使工具调用保持高效并遵守配置策略。`repeat-tool-reminder` 在重复调用后提醒模型改变方法，`timeout-policy` 则限制声明了超时的调用。两者都在 `dsh` 基础组合包中默认启用。显式启用的 `scope-judge` 在执行前阻止范围外的域名，并拒绝无法确定目标的工具。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

为你的组合选择策略；各包参考说明配置与限制。

| 包 | 提供什么 |
|---|---|
| [`repeat-tool-reminder/`](repeat-tool-reminder/README.zh.md) | 在模型重复完全相同的工具调用时提醒它，使其改变方法或结束任务 |
| [`timeout-policy/`](timeout-policy/README.zh.md) | 为声明了限时的工具调用设置超时，让模型得到清晰错误而不是无限等待 |
| [`scope-judge/`](scope-judge/README.zh.md) | 在执行前阻止范围外域名，并拒绝未分类工具 |

-----

<a id="related-documentation"></a>
## 相关文档

先从工具子系统参考了解工具调用流水线，再看重复提醒的配置与策略背后的超时库决策。

- [工具子系统参考](../../docs/subsystems/tools.zh.md)——guard 所依赖的工具调用流水线与决策。
- [生成配置目录](../../docs/config-catalog.zh.md#deepseek-aidsh-repeat-tool-reminder)——重复调用提醒的每个受支持字段。
- [超时截止时间库 Agent Note](../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.zh.md)——`timeout-policy` 所执行的时序／终止拆分。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
