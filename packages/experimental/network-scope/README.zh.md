---
description: "为可替换的执行提供者与裁判/审计消费者提供只读范围策略检查。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-network-scope

[English](README.md) | 中文

## 概述

检查教师定义的网络范围，而不授予新权限。消费者可以检查结构化 HTTP 目标、观察就绪状态并读取有序的环境审计流。请为执行环境选择提供者；本服务不安装防火墙，也不运行研究工具。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

请挂载具体提供者，而非此抽象服务。课程组合挂载 [`network-scope-linux`](../network-scope-linux/README.zh.md) 和 [`network-scope-guard`](../network-scope-guard/README.zh.md)。本包没有配置。

实现 `NetworkScopePolicy.inspect(after, targets, signal)` 以提供 `ctx.networkScope`。省略游标可建立当前位置；后续游标读取包含起点的连续记录。提供者必须通过声明的 `NetworkScopeError` 错误码拒绝取消、无效响应、不可变身份变化和被覆盖的游标。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者详情 — 点击展开</summary>

[服务定义](src/index.ts)将策略检查与特权执行进程分离。[类型](src/types.ts)区分结构化预检目标与整个环境的流量。任何 API 都不能编辑策略、批准例外或关闭执行约束。Cordis 拥有提供者生命周期，并拒绝重复的服务实现。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Linux 课程运行时](../../../course/scope-runtime/README.zh.md) — 部署、策略与执行边界。
- [工具子系统](../../../docs/subsystems/tools.zh.md) — 原生与 PTC 调用的执行管线。
- [测试策略](../../../docs/testing.zh.md) — 组合与录制 Session 的验证证据。

<a id="model-experience"></a>
## 模型体验

Indirectly, through 呈现策略状态与操作拒绝的范围感知消费方。

#### KV Cache effect

本服务不贡献提示词或 schema，也不改变模型前缀。消费者拥有所有写入日志的模型可见结果。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **需要外部约束** — 仅有检查服务无法约束任意代码、浏览器后台流量、远程执行器或套接字。
- **共享环境** — 当前协议描述一个不可变的 Linux 命名空间策略，而非逐 Session 或公司归属授权。

<a id="dev-note"></a>
### 开发备注

无。
