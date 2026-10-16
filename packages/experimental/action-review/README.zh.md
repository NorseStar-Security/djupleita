---
description: "定义完整工具操作提交、审核就绪状态与持久化准入确认。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-action-review

[English](README.md) | 中文

## 概述

为一次完整工具操作请求决策，并检查教师审核服务是否就绪。每份确认都标识实际提交字节、目标策略与审核部署。需要选择具体提供者和执行约束的消费者；此服务本身从不授权执行。

## 目录

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

挂载 [`action-review-linux`](../action-review-linux/README.zh.md) 与 [`action-review-guard`](../action-review-guard/README.zh.md)，不要挂载此抽象服务。此包没有配置项。

提供者为 `ctx.actionReview` 实现 `status(signal)` 与 `review(request, signal)`。审核必须先提交到可信存储，再返回回执。提供者拒绝取消、有损负载序列化、格式错误的输出以及部署身份变化。允许决策需要非空评估器发现；拒绝决策可以保留空或部分发现。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>维护者细节 — 点击展开</summary>

[服务定义](src/index.ts) 将操作审核与调度、提供者凭据、评估器选择和持久化存储分离。[类型](src/types.ts) 将完整操作绑定到网络策略，并区分就绪状态与已提交的准入决策。空 Session 身份不能授权执行；没有批准或策略编辑 API。

输入哈希覆盖实际原始 UTF-8 POST 请求体，包括操作和策略哈希，而非第二次 JSON 序列化。带品牌的哈希与回执保持普通 JSON 表示；回执是存储证据，而不是可重复使用的执行许可。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Linux 课程运行环境](../../../course/scope-runtime/README.zh.md) — 部署与可信审核配置。
- [工具子系统](../../../docs/subsystems/tools.zh.md) — 原生与嵌套调度。
- [测试策略](../../../docs/testing.zh.md) — 组合与输出证据。

<a id="model-experience"></a>
## 模型体验

间接影响：外部评估器评估提交的操作，守卫消费者呈现工具拒绝结果。

#### KV Cache 影响

此服务不增加 Agent 提示或工具 schema。可信审核服务负责独立评估请求；调度消费者负责记录拒绝结果。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **需要可信部署** — 此服务不建立网络隔离，也不保护研究进程可写的端点。
- **发现具有概率性** — 未发现风险不代表操作无害；目标和硬性操作约束仍然独立生效。

<a id="dev-note"></a>
### 开发备注

无。
