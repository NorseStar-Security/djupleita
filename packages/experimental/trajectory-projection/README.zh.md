---
description: "持久化轮次 trace 及带时间的模型、工具和范围 span，用于有界本地轨迹检查和独立 OTLP trace 导出。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-trajectory-projection

[English](README.md) | 中文

## 概述

将收集的智能体工作检查为轮次 trace，并查看带时间的模型、工具和范围 span。保留可见的安装身份和已记录的子级关系，不将共享网关流量归因于工具。增量 SQLite 索引可在重启后继续存在，并提供有界检查页面和已完成 span 导出页面。原始轨迹字节仍由收集器保存；本读取模型不是来源证明，也不是替代归档。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在教师拥有的进程中，将本提供方与[收集器存储提供方](../trajectory-collector-sqlite/README.zh.md)一同挂载。为投影指定所有者独占目录中的独立绝对 SQLite 路径。绝不能选择收集器数据库本身。需要支持 `node:sqlite` 的 Node.js 运行时和本地文件系统。

```yaml
- name: '@deepseek-ai/dsh-experimental-trajectory-projection'
  config:
    path: /var/lib/trajectory-projection/projection.sqlite
```

[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-trajectory-projection)列出了轮询、存储、span 和查询上限。查询返回完整页面，或明确报告大小故障；页面超过字节预算时应减少请求条目数量。Trace 搜索使用 SQLite 的 ASCII 大小写折叠和字面子串匹配，而不是 SQL 模式。最新和最旧页面使用不可变的排他游标；刷新后的状态字段可能变化，但身份排序保持稳定。

读取 `status()` 可区分索引中、空闲和终止故障。来源、容量检查或存储操作失败时，后台索引会停止，不会推进受影响的记录。只要存储仍可读取，最后提交的视图仍可检查。在经过审查的重建前，应保留两个归档并修复原因。重新加载不会擦除持久化故障或重置游标。

Trace 视图包含选定的元数据和首末来源游标，不重复保存提示词、推理、参数或工具结果。使用收集器的安装和会话筛选器及有界记录页面来读取完整证据。被阻止的范围决策具有明确元数据。共享环境网络观察仍是共享环境观察，不是某个特定工具导致连接的证据。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者细节——点击展开</summary>

[提供方](src/index.ts)在同一个 SQLite 事务中提交来源进度和派生行，并使用 WAL 和 `synchronous=FULL`。它增量读取收集器；前台查询绝不重放来源历史。安装、会话和轮次身份决定稳定的 OTel 兼容 trace ID。Span ID 包含其 trace 和已记录的调用或序号身份。轮次之外的事件使用明确标注的会话活动 trace。

工具调用开启 span，其结果关闭 span。模型结算使用最早的持久化流记录时间戳，空流则仅使用结算时间；这不是请求分发延迟。范围决策和其他事件成为已记录的时间点。轮次结束会将未完成的工具 span 结算为不完整。系统时钟后退时会生成非负时长，并附带明确的 `clockRegressed` 和 `recordedEndTime` 元数据。

会话头部保留父会话身份。只有与该头部一致时，父级拥有的子级目录才能标识父 trace。较晚发现的目录会丰富 trace 概览，但不会重写不可变的已完成导出 span。系统不虚构跨 trace 的父 span，也不虚构网络与工具之间的因果关系。

已完成的 span 获得持久化单调完成游标，绝不清理或重新编号。导出消费方独立于收集器日志导出确认来检查点记录此数据流。持久化的投影代际身份可防止消费方在数据库替换后重用检查点。[测试](tests/projection.spec.ts)覆盖真实 Loader 组合、回读、重放身份、故障隔离、配额和达到静止状态的释放。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [收集器服务](../trajectory-collector/README.zh.md)——完整来源记录和可信身份。
- [OTLP 导出器](../trajectory-export-otlp/README.zh.md)——单独确认的远程传输。
- [范围审计消费方](../network-scope-guard/README.zh.md)——范围决策和环境归因语义。

<a id="model-experience"></a>
## 模型体验

无，因为本提供方读取已收集的证据，不添加模型请求、提示词、工具或会话事件。

#### KV 缓存影响

请求 token 和请求前缀均不改变。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

- 在索引和重启检查完成前保留收集器记录。尚未投影的间隙、游标后退，以及变化或已清理的重启锚点会停止索引。不提供静默恢复、来源代际回退、迁移或自动重建。
- 元数据投影不会验证每一个由事件拥有方定义的字段，也不会证明学生控制的来源数据。它检查自身解释的字段；未知事件类型仍作为可见时间点，不虚构模型或工具语义。
- SQLite 工作是同步的。存储配额限制保留状态；开放 span 上限限制轮次结算。搜索和筛选列表可能扫描保留的 trace 行。完整页面和 span 预算不提供流式处理，也不提供恒定内存的来源读取器。
- 已完成 span 及其代际身份无限期保留。保留管理、加密、备份、多个投影写入方和精确的因果父 span 关系需要单独的运营或领域支持。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
