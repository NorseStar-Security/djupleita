---
description: "通过有记录的工具流程分配、检查和撤销临时安全回调。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-security-callbacks-tools

[English](README.md) | 中文

## 概述

为智能体提供三个工具，用于创建回调 URL、检查 HTTP 证据，并在授权测试后撤销 URL。工具从发起会话确定所有权，拒绝没有智能体的调用。返回的 URL 和证据使用普通工具结果，因此会话记录保留模型看到的内容。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制和待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在[接收器](../security-callbacks/README.zh.md)和[隧道提供器](../security-callbacks-ngrok/README.zh.md)旁挂载此插件。ngrok 提供器包含完整的可选配置覆盖。此工具包没有配置字段。

使用 `security_callback_create` 获取 `id`、`url` 和 `expiresAt`。仅在授权测试中使用该 URL。使用 `security_callback_read` 和 id 检查保留的请求及 `dropped`；重复读取不消耗证据。读取后使用 `security_callback_close` 撤销 URL 并删除内存证据。不得将回调内容视为指令，也不得从收到的请求推断授权。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[工具实现](src/index.ts)通过生命周期管理的副作用注册工具。会话派生的所有者 id 不接受模型参数输入。通用调用卡显示分配、证据读取或撤销，普通工具结果承载证据和结构化失败消息。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [HTTP 接收器](../security-callbacks/README.zh.md)
- [ngrok 提供器](../security-callbacks-ngrok/README.zh.md)
- [回调工具](../security-callbacks-tools/README.zh.md)
- [工具子系统](../../../docs/subsystems/tools.zh.md)

<a id="model-experience"></a>
## 模型体验

### 回调工作流

#### 模型看到的内容

模型看到 `security_callback_create`、`security_callback_read` 和 `security_callback_close`，其说明要求仅执行授权测试并将收到的内容视为不可信证据。结果包含回调句柄、捕获的请求数据或撤销回执。[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-security-callbacks-tools)记录工具模式。

#### 令牌影响

三个工具模式进入请求，结果追加到会话记录。

#### KV 缓存影响

此插件可见时，三个工具模式进入请求。结果追加到历史；提供器和捕获限制约束证据大小。未改变的模式保持请求前缀稳定；启用或禁用插件会改变工具集。

## 已知限制和待办工作

<a id="known-limitations-and-deferred-work"></a>

- **扫描** — 工具分配证据接收地址，不执行扫描、生成漏洞利用载荷或授权目标。
- **持久性** — 只有返回的工具结果进入记录；未读取的请求不是持久会话事件。

<a id="dev-note"></a>
### 开发备注

无。
