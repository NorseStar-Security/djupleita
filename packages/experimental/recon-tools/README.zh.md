---
description: "向模型提供被动优先侦察目录及显式获准的组件执行。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-recon-tools

[English](README.md) | 中文

## 概述

让模型检查可用侦察操作、选择获准目标，并一次运行一个受限操作。清单与失败使用普通工具结果，因此现有轨迹收集器能够保留并导出这些内容。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用此包

先挂载 [ProjectDiscovery 侦察](../recon-projectdiscovery/README.zh.md)，再将此项加入组合。插件没有配置。

```yaml
- name: '@deepseek-ai/dsh-experimental-recon-tools'
```

组合必须提供 `recon`、`tools` 与 `sandboxPolicy`。先使用 `recon_catalog`；调用 `recon_run` 时明确提供组件、目标列表及 `allowActive` 布尔值。范围由提供方决定，而非模型的同意。没有教师独立授权时，不得将标为范围外的结果作为后续目标。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

[消费方](src/index.ts)从调用会话解析文件策略，并将执行委托给 `ctx.recon`。Cordis 管理两项注册，并在卸载时移除它们。标准工具卡片显示参数及 JSON 文本结果；没有自定义客户端渲染器，也没有更改 agent-loop。持久化的 `tool/call` 与 `tool/result` 事件直接进入现有完整轨迹导出器，无需独立遥测路径。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Linux 课程运行时](../../../course/scope-runtime/README.zh.md) — 强制执行与部署。
- [工具子系统](../../../docs/subsystems/tools.zh.md) — 执行与事件。
- [测试策略](../../../docs/testing.zh.md) — 组合与回放证据。

<a id="model-experience"></a>
## 模型体验

### 工具 schema 与结果

#### 模型能看到什么

[recon_catalog](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-recon-tools) 与 [recon_run](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-recon-tools) 是 schema 的真源。结果包括目录条目，或带目标、策略 hash、覆盖率标记及资产观察结果的 JSON；失败是普通工具错误。

#### Token 影响

挂载后，两项工具 schema 固定加入上下文。目录与受提供方限制的结果按每次调用追加；不添加 system-prompt 文本。

#### KV Cache 影响

工具结果仅追加。挂载、卸载或更改工具 schema 可能替换 schema 前缀；重复调用不会改写先前消息。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **没有编排 agent**——被动优先指导不会自动调度多阶段任务；每项操作仍须显式请求。
- **外部强制执行**——移除此消费方只会移除工具，而不会移除网关；任意终端/浏览器能力仍需共享的 Linux 网络边界。

<a id="dev-note"></a>
### 开发备注

无。
