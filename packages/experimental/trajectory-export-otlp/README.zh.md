---
description: "将完整的持久化轨迹复制到 Logfire 或其他 OTLP 日志接收端，支持确认检查点及离线恢复。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-trajectory-export-otlp

[English](README.md) | 中文

## 概述

将完整的持久化轨迹导出为 OTLP protobuf 日志，不采样，也不要求反馈。在教师拥有的进程中显式启用此消费方。成功确认推动私有检查点前进；交付不可用时保留本地历史以便恢复。完整内容导出要求明确同意；默认 harness 配置保持不变。

添加可选的 `/traces` 入口，可在完整日志副本之外导出已完成的轮次、模型、工具、范围及已记录事件 span。稳定的投影标识让兼容的 OTLP trace 接收端显示轮次内嵌套关系，而不改变 Agent 行为。

## 目录

- [使用此包](#use-this-package)
- [添加已完成的 trace](#add-completed-traces)
- [交付与恢复](#delivery-and-recovery)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

在专用 `dsh` 配置中挂载持久化提供方及此消费方。[教师部署](../../../course/trajectory-collector/README.zh.md)提供配置及秘密文件挂载。字段及默认值由[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-trajectory-export-otlp)生成。

对于多安装实例接收，应挂载 `@deepseek-ai/dsh-experimental-trajectory-export-otlp/collector`，而非此包的根入口，并配置[收集器存储提供方](../trajectory-collector-sqlite/README.zh.md)。两个入口使用相同交付设置；收集器入口需要 `trajectoryCollector`，而非会话持久化。`collectorBatchBytes` 默认为 4 MiB，且不得超过存储提供方的读取预算；`eventsPerSession` 限制收集器页面长度。完整记录无法放入预算时停止导出，而不是跳过。

```yaml
- insert:
    - name: '@deepseek-ai/dsh-session-persistence-jsonl'
      config:
        root: /var/lib/course-sessions
        compression: none
    - name: '@deepseek-ai/dsh-experimental-trajectory-export-otlp'
      config:
        endpoint: https://logfire-us.pydantic.dev/v1/logs
        tokenFile: /run/secrets/logfire_write_token
        stateDir: /var/lib/trajectory
        sourceId: instructor-assigned-archive-id
        allowFullContent: true
```

端点包含 `/v1/logs`。选择项目所在区域及仅写 token；[Logfire OTLP 指南](https://pydantic.dev/docs/logfire/migrate/overview/)说明了 Bearer 授权。每次请求均从私有文件读取 token，因此无需重新加载即可轮换。配置、环境变量、状态文件及诊断信息均不包含 token 值。源内容不会脱敏：提示词、推理、工具参数及结果、已持久化模型流、错误和插件审计数据可能包含秘密。应使用实验账户、获准的保留策略及明确的收集同意。`sourceId` 是教师分配的命名空间，不是经过验证的学生身份。

<a id="add-completed-traces"></a>
## 添加已完成的 trace

先挂载[基于收集器的投影](../trajectory-projection/README.zh.md)，再在同一教师进程中挂载 `@deepseek-ai/dsh-experimental-trajectory-export-otlp/traces`。将 `endpoint` 设为接收端的 HTTPS `/v1/traces` URL，将 `tokenFile` 设为其私有轮换 Bearer token 文件，将 `sourceId` 设为归档命名空间，并设置 `allowFullContent: true`。为此入口分配独立的 `stateDir`，绝不能与任一日志入口共用。trace 入口需要 `trajectoryProjection`，而非会话持久化。现有日志挂载保持不变。

此入口仅读取不可变的已完成 span。它保留投影的确定性 trace/span ID、毫秒时间戳、真实的轮次内父 ID、可信安装实例身份及选定的已记录事实。它将已记录的阻止或错误 span 标记为 OTLP 错误。未结束的轮次在结算前不会作为已完成根 span 出现。这是导航视图，不能替代完整原始日志或二进制附件。

`spansPerPage` 默认为 128，`pageBytes` 默认为 4 MiB；两者必须符合投影的读取限制。每个完整 span 使用一个请求，受 `maxRequestBytes` 限制（默认为 256 KiB）。页面或 span 过大会停止导出，而不是裁剪事实或跳过完成记录。共享的响应、超时、重试、token 轮换、取消及健康文件行为与下文日志入口一致。

`stateDir/traces.json` 仅在完整 OTLP 成功响应后前进，并将游标绑定至端点、来源命名空间及持久化投影代际标识。投影被替换或游标不可能时停止导出。trace 确认绝不推进收集器的主要日志导出游标。保留此私有检查点及投影：故意使用新检查点会以相同 ID 回放已完成 span，但不保证接收端去重。宿主崩溃及确认丢失也可能导致 span 回放。

若不可变投影行包含相应证据，子会话 ID 及父 trace ID 会作为关联属性导出。仅父 trace ID 无法确定发起操作的父 span，因此导出器不会虚构 OpenTelemetry Link 或跨 trace 父节点。迟到的目录证据不会重写已经完成的 span。私有回环测试验证 protobuf 嵌套、关联、重试及重启和拒绝处理；教师必须另行使用凭据验证所选远程接收端。

<a id="delivery-and-recovery"></a>
## 交付与恢复

消费方发现 `ctx.sessionPersistence` 暴露的所有会话，包括非活动会话及子会话。它通过只读句柄读取已验证的逻辑头部及事件，绝不追加、迁移、删除或获取写入所有权。应额外使用操作系统只读源挂载。压缩归档需要匹配提供方的压缩设置；历史版本使用提供方当前的逻辑解释，而不是原始文件字节。

头部使用序号 `-1`；事件保留其规范序号及时间戳。属性包括 `dsh.source.id`、`dsh.session.id`、`dsh.event.seq`、`dsh.event.type` 以及稳定的 `dsh.record.id`/`dsh.record.sha256`。超过 `fragmentBytes` 的记录变为带有 `dsh.record.part` 和 `dsh.record.parts` 的有序 base64 分片。按分片标识去重、排序、拼接解码字节并校验 SHA-256，即可重建精确的 JSON UTF-8 字节。普通记录的正文为可读 JSON。不会静默裁剪内容。

收集器入口在保持记录正文不变的同时，独立添加服务器可信的 `dsh.course.installation.id`、`dsh.course.student.id` 及 `dsh.course.cohort.id`。持久化接收收据提供记录 ID，区分不同安装实例中冲突的会话 ID。学生提供的事件属性不能替换此身份。仅完整成功的远程交付才推进存储的持久化主要导出游标。即使导出器检查点目录改变，存储也将游标绑定到目的地指纹。本地二进制对象不会发送至 OTLP。

每个分片都必须收到有效完整的 OTLP 成功响应，其记录检查点才会前进。超时及确认丢失可能导致重复记录：这是至少一次交付，而非恰好一次交付或 Logfire 侧去重。网络故障及 HTTP 429/502/503/504 使用指数抖动及 `Retry-After` 重试。部分拒绝、其他 HTTP 状态、无效确认、源变更及损坏检查点会显式停止导出，不推进受影响的记录。[OTLP 规范](https://opentelemetry.io/docs/specs/otlp/)禁止自动重试部分拒绝。

检查 `stateDir/health.json` 及控制台日志。`retrying` 表示交付不可用；`failed` 要求教师调查并在修复后重新加载；`stopped` 表示取消后工作已排空。`idle` 表示一次扫描结束，而非不会有新事件到来。检查点或健康文件写入失败会停止后续导出并输出控制台错误。若启动器提供现有的 `appExit` 钩子，启动失败及工作进程的终止性失败会通过它请求退出码 1；未提供该钩子的嵌入宿主必须监控健康状态及日志。保留源归档直至确认接收；对磁盘耗尽及长时间延迟设置告警。此处不管理源保留策略。

检查点替换是原子的，但不执行 fsync；宿主崩溃可能使检查点回退并回放已接收数据。检查点绑定端点、来源命名空间及分片大小。更改这些设置要求使用新的私有状态目录进行经审查的回放，可能导致远程重复。每个状态目录仅运行一个收集器，限于同一宿主及 PID 命名空间。重新打开时检查游标前一条事件；这不是整个归档的完整性证明。

所有者锁记录 PID，而非容器身份。异常终止可能留下陈旧锁；PID 复用，尤其是重建容器后，可能阻止自动接管。应先停止共享该状态目录的全部收集器，确认此前的所有者已停止，再仅移除 `stateDir/owner.lock` 并重新启动。切勿删除仍在运行的所有者的锁，也不要通过清空事件检查点来解决争用。不支持在同时运行的多个 PID 命名空间之间共享状态。

<a id="understand-the-implementation"></a>
## 理解实现

现有持久化 Service Definition 和 JSONL Service Provider 保持不变；此包承担 Consumer 角色。隔离的 OpenTelemetry 日志记录器和维护中的 protobuf 序列化器生成标准日志及可选 trace，不安装全局遥测提供方。支持确认的传输负责受限请求及响应、HTTPS、手动重定向、取消及轮换文件凭据。生命周期管理的工作进程在各自的同宿主检查点锁下串行交付，卸载时中止请求及重试等待，关闭句柄并排空工作后返回。它们既不使用尽力而为的实时遥测队列，也不扩大仅反馈后端的同意策略。

<a id="further-exploration"></a>
## 进一步探索

- [持久化服务](../../session/session-persistence/README.zh.md) — 只读句柄及持久性语义。
- [JSONL 提供方](../../session/session-persistence-jsonl/README.zh.md) — 归档配置。
- [Trace 投影](../trajectory-projection/README.zh.md) — 确定性 span 标识、已记录时间、关联及查询预算。
- [课程注册提案](../../../.agents/notes/proposed/architecture/2026-10-15-course-telemetry-enrollment.zh.md) — 必需的连接与身份工作。

<a id="model-experience"></a>
## 模型体验

无，因为此消费方导出已持久化事件，不添加提示词、工具或会话事件。

#### KV Cache 影响

不改变请求 token 或请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 日志保留完整事件副本；可选 trace 提供选定的已记录元数据，供兼容接收端显示瀑布图。此包不渲染本地仪表板、不归档二进制附件、不接收学生上传，也不实现注册。崩溃前从未持久化的事件无法恢复。
- 每次交付一条逻辑记录；大量历史可能积压。内存及读取成本也取决于持久化提供方，它可能加载完整会话。协议预算不限制提供方内存。
- 提供方可能从列表中省略无法读取的会话头部，并在自身日志中报告。应监控这些诊断；循环处于 idle 并不能证明每个源产物均有效或已被发现。
- 真实 Logfire 交付需要教师的端点、token 及验收运行；mock OTLP 测试无法验证供应商的保留、限制、查询行为或访问控制。

### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>
