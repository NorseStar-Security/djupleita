---
description: "配置和调试只读 Linux 网关提供者，以执行教师定义的域名/IP 范围。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-network-scope-linux

[English](README.md) | 中文

## 概述

从课程网关读取实时策略、就绪状态、目标决策和网络拒绝。请求使用本地 Unix 套接字，绝不经过研究用 HTTP 代理。提供者固定首次网关身份与策略哈希，并拒绝意外变化。它无法安装、扩大或关闭网络规则。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

仅在教师控制的[课程运行时](../../../course/scope-runtime/README.zh.md)内挂载此提供者，然后挂载裁判消费者。本包本身不会创建 Linux 隔离。

```yaml
- name: '@deepseek-ai/dsh-experimental-network-scope-linux'
- name: '@deepseek-ai/dsh-experimental-network-scope-guard'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `socketPath` | `/run/course-public/control.sock` | 教师拥有的只读检查套接字的绝对路径 |
| `timeoutMs` | `3000` | 整个检查操作的截止时间，单位毫秒 |
| `maxResponseBytes` | `2097152` | 响应正文的最大字节数 |

[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-network-scope-linux)定义接受的配置。传输或健康检查失败会通过消费者阻止分发；请先恢复网关再重试。身份变化、无效输出和审计缺口需要教师调查并重新加载消费者。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者详情 — 点击展开</summary>

[提供者](src/index.ts)向 root 拥有的网关套接字发送有界 `/inspect` 请求。课程将其所在卷挂载为只读，因此研究进程不能替换该端点。[解码器](src/protocol.ts)在暴露不可变快照前验证协议身份与连续审计序号。释放会取消并排空其 HTTP 请求。此握手观察可信部署；它不是密码学证明，也不能证明任意主机上的隔离约束。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Linux 课程运行时](../../../course/scope-runtime/README.zh.md) — 部署、策略与执行边界。
- [工具子系统](../../../docs/subsystems/tools.zh.md) — 原生与 PTC 调用的执行管线。
- [测试策略](../../../docs/testing.zh.md) — 组合与录制 Session 的验证证据。

<a id="model-experience"></a>
## 模型体验

Indirectly, through network-scope-guard 消费者呈现的策略状态和分发拒绝。

#### KV Cache effect

传输不贡献模型 token，也不改变提示词。消费者拥有状态结果与拒绝消息。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **部署前提** — 在无限制主机上挂载此插件不会创建网络边界；仍然需要专用 Linux 运行时。
- **有限审计保留** — 网关保留 1024 条事件。消费者必须检测被覆盖的游标并停止，而不能声称完整覆盖。

<a id="dev-note"></a>
### 开发备注

无。
