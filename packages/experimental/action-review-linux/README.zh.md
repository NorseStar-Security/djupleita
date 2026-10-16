---
description: "为教师网关配置有界、无密钥的 Unix socket 操作审核。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-action-review-linux

[English](README.md) | 中文

## 概述

将完整工具操作提交到教师审核服务，而不在研究 worker 中存放模型密钥。提供者将持久化回执与实际请求字节核对，并固定网关、目标策略和审核配置身份。截止时间和字节上限拒绝不完整工作，不截断可执行输入。

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

在专用 Linux 课程运行环境中，将此提供者和 [`守卫`](../action-review-guard/README.zh.md) 挂载到已有的工具与 network-scope 服务旁。

```yaml
- name: '@deepseek-ai/dsh-experimental-action-review-linux'
- name: '@deepseek-ai/dsh-experimental-action-review-guard'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `socketPath` | `/run/course-public/control.sock` | 教师网关 socket 的绝对路径 |
| `timeoutMs` | `30000` | 完整请求与响应的毫秒截止时间 |
| `maxResponseBytes` | `1048576` | 完整 JSON 响应的字节上限 |
| `maxActionBytes` | `1048576` | 完整序列化请求的字节上限 |

提供者不暴露评估器、凭据或任意转发设置。传输故障后应恢复可信网关；身份或响应完整性故障后，应调查问题并重启强制守卫所在进程，再恢复研究。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>维护者细节 — 点击展开</summary>

[传输](src/index.ts) 只通过配置的 Unix socket 调用 `GET /review/status` 与 `POST /review`。[解码器](src/protocol.ts) 校验协议字段、有界身份、概率发现、精确输入 SHA-256、策略哈希以及正安全整数回执。首次成功响应固定部署身份，后续状态与审核调用必须一致。

取消、移除提供者以及完整交换截止时间都会关闭其请求；卸载等待请求结束。请求序列化会拒绝不支持的值，而不是静默丢弃字段。教师网关提交权威记录，并负责所有 LLM、JEV 或自定义评估器请求。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Linux 课程运行环境](../../../course/scope-runtime/README.zh.md) — 部署与可信审核配置。
- [工具子系统](../../../docs/subsystems/tools.zh.md) — 原生与嵌套调度。
- [测试策略](../../../docs/testing.zh.md) — 组合与输出证据。

<a id="model-experience"></a>
## 模型体验

间接影响：可信审核服务发出独立评估请求，action-review-guard 消费者记录拒绝结果。

#### KV Cache 影响

传输不改变 Agent 提示或 schema。审核延迟和评估器 token 成本取决于可信部署，而非 Agent 选择的模型。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **Linux 前提** — Unix 传输不安装隔离，需要受保护且由教师持有的 socket。
- **不是远程证明** — 部署身份检查无法抵御控制宿主机的学生或恶意同进程插件。

<a id="dev-note"></a>
### 开发备注

无。
