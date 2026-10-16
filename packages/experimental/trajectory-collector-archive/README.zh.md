---
description: "将完整的持久化会话及可选附件二进制复制到可信的本地轨迹收集器；配置身份、有限轮询和失败处理。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-trajectory-collector-archive

[English](README.md) | 中文

## 概述

将持久化轨迹复制到本地收集器，而不修改源会话。覆盖活跃、非活跃及子会话，保留完整头部和事件 JSON。依靠收集器的持久化重放回执安全重启，无需第二套检查点数据库。可选择在确认事件前复制其引用的图像和文件字节；其中可能包含敏感内容，因此必须显式配置。安装、学生和班级标签来自可信的讲师配置，而不是学生认证。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

将此配置行挂载到已提供 `sessionPersistence` 和 `trajectoryCollector` 的组合中，例如使用 [JSONL 后端](../../session/session-persistence-jsonl/README.zh.md)和 [SQLite 收集器](../trajectory-collector-sqlite/README.zh.md)。此包是消费者，不是研究工具，也不是可通过配置档安装的组合包。

### 何时选择

需要在独立于智能体的情况下检查完整持久化记录（包括进程重启后）时，选择本地归档。需要经确认的远程记录投递时，另行添加[收集器 OTLP 导出器](../trajectory-export-otlp/README.zh.md)。不要将可信本地标签当作学生已认证的证据，也不要将本地接收入口直接暴露给不可信上传；[HTTP 收集器](../trajectory-collector-http/README.zh.md)负责该授权边界。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-experimental-trajectory-collector-archive'
  config:
    installationId: fixture-installation
    studentId: fixture-student
    cohortId: fixture-cohort
```

将这些测试标签替换为讲师分配的部署身份。将此配置和收集器状态放在研究智能体不可写的位置。此配置行不会为学生注册、获取凭据或授予网络访问权限。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `installationId` | 必填 | 可信本地安装标签 |
| `studentId` | 必填 | 可信本地学生标签，不是经过认证的声明 |
| `cohortId` | 必填 | 可信本地班级标签 |
| `copyAttachments` | `false` | 显式允许通过 `attachments` 复制可能敏感的图像/文件二进制 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-trajectory-collector-archive)定义全部轮询、缓存、字节和遍历限制。复制二进制需要已挂载附件提供方。关闭复制时，事件 JSON 仍包含原始附件引用，但归档不会声称这些二进制已被复制。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

每轮扫描枚举持久化元数据，以一致规则排序会话 ID，并轮换处理有限子集。每个会话的事件读取量受限。有限的内存修订缓存避免重新打开未变化的日志；缓存淘汰和进程重启通过持久化收集器回执重放，不重复存储记录。收集器发现冲突时停止接收，而不替换已提交的证据。

头部记录使用序号 `-1`、类型 `session/header`、头部的 `createdAt`，以及精确的 `JSON.stringify({header,inheritedEventCount})`。后续记录保留各事件的序号、类型、时间戳和 `JSON.stringify(event)` 字节。归档保存持久化提供方当前的逻辑值（包括继承事件）；不会重写或刷新源日志，也不会排序 JSON 键。

启用二进制复制后，有限遍历会查找事件任意位置的结构化 `{type: 'image' | 'file', attachment: ...}` 部分。读取只使用 `attachments.readImage` 或 `attachments.readFileStream`，不会打开任意路径或 URL。声明大小、实际大小和 SHA-256 必须一致才提交二进制，之后才确认包含它的事件。二进制存储名称采用摘要，使显示名称不同的相同字节可以去重；原始名称保留在事件 JSON 中。

源、附件或收集器失败会停止工作器，输出不含私有诊断的可操作错误，并在宿主提供时请求 `appExit(1)`。没有此钩子的嵌入式宿主必须监控错误日志。已提交前缀可能保留；修复失败依赖并重新加载插件即可安全重放。卸载会取消读取和定时器，然后等待已启动的收集器提交并关闭其读取句柄后才完成。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 配置和插件生命周期 |
| [`src/archive.ts`](src/archive.ts) | 只读轮询、修订缓存和记录确认 |
| [`src/attachments.ts`](src/attachments.ts) | 有限附件发现、读取和完整性检查 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [持久化接口](../../session/session-persistence/README.zh.md) — 源读取句柄和修订。
- [收集器接口](../trajectory-collector/README.zh.md) — 记录回执、身份和二进制存储。
- [SQLite 收集器](../trajectory-collector-sqlite/README.zh.md) — 私有持久化本地证据。
- [OTLP 导出](../trajectory-export-otlp/README.zh.md) — 经确认的远程记录投递。
- [课程收集器部署](../../../course/trajectory-collector/README.zh.md) — 讲师运维和认证假设。

<a id="model-experience"></a>
## 模型体验

无，因为此包只读取持久化会话并复制归档数据，不添加模型请求、工具、提示词或 Session 事件。

#### KV 缓存影响

归档不改变模型上下文，并保留已有的可复用前缀；提供方缓存行为不属于此包的职责。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

归档是只读证据收集，不是认证或真实性证明服务。

- 可信本地身份需要讲师控制的配置。控制源机器的学生可以抑制或伪造日志；此处未实现注册和自动学生上传。
- 只归档持久化提供方列表暴露的会话。未持久化的实时片段、被忽略的损坏或不支持头部、物理历史版本及压缩源文件不会作为原始文件系统工件备份。
- 二进制复制默认关闭，且仅覆盖规范图像/文件部分。工具输出字符串、任意路径、溢出文件、外部 URL 和其他未引用文件不会被复制。字节或遍历预算耗尽时，在确认受影响事件前停止接收；重放前应提高相应预算或修复源数据。
- 轮询引入延迟，并枚举全部会话元数据，尽管访问会话数、事件读取、缓存游标及附件遍历受限。完整记录 JSON 不会被截断；收集器配额或大小拒绝会停止接收。
- 失败可能留下已提交前缀，需要运维修复并重新加载插件。卸载会等待进行中的收集器操作，因此完成时间取决于所挂载收集器何时结束这些操作。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
