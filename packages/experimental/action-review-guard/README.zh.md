---
description: "在每次原生、PTC 外层与内层、MCP 和子 Agent 工具主体执行前要求可信持久化审核。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-action-review-guard

[English](README.md) | 中文

## 概述

保持研究能力可用，同时要求对每次可执行工具操作单独审核。原生工具、PTC 外层与嵌套调用、MCP 工具和子 Agent 都使用同一个守卫。拒绝、缺失 Session、审计失败、审核服务不可用或守卫被移除都会阻止调度。权限预设无法覆盖此要求。

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

在专用 Linux 课程组合中，将此消费者挂载到已有的工具、[`network-scope-linux`](../network-scope-linux/README.zh.md) 与 [`action-review-linux`](../action-review-linux/README.zh.md) 服务旁。它不提供权限预设、豁免、批准或部署预算设置。

```yaml
- name: '@deepseek-ai/dsh-experimental-network-scope-linux'
- name: '@deepseek-ai/dsh-experimental-action-review-linux'
- name: '@deepseek-ai/dsh-experimental-action-review-guard'
```

守卫在工具服务存在时立即激活，包括任一必需提供者初始缺失的情况。每次调用都会重新检查网络就绪状态，确认审核状态属于同一网关和策略，提交完整操作，并在委托前将可信回执追加到其 Session。无 Agent 请求使用 `sessionId: null`，不能执行，即使错误的审核服务返回允许也不例外。此基线不提供教师批准路径。

传输故障拒绝受影响的调用，不复用此前的允许决策。无效响应、身份变化或 Session 审计失败会关闭后续准入。卸载守卫或必需提供者会保留 root 生命周期的拒绝锁，包括重新挂载后；教师必须调查问题、恢复必需服务并重启进程。已经运行的工具主体不会被追溯终止。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>维护者细节 — 点击展开</summary>

[消费者](src/index.ts) 使用已有的预执行 waterfall 和单调工具守卫，不修改 Agent 循环或各适配器。许可关联到注册表创建的精确执行对象。后续宽松监听器不能替代缺失或被拒绝的审核。嵌套调用通过运行环境的不透明父 token 绑定已知父调用身份。

[记录](src/types.ts) 分别保留决策与最终调度结果。外部回执确认可信持久化存储；Session 副本必须在执行前同步提交。结果追加失败会关闭后续准入，但不能撤销已执行的主体。消费者卸载会取消并等待待处理审核结束；应用 root 保留工具服务监听器，以及旧注册表和替换注册表上的关闭守卫，直到进程重启。

[真实 Loader fixture](tests/loader.spec.ts) 观察工具主体计数器、完整请求字节、逐调用回执、子 Session、PTC 子调度、取消、存储故障及强制卸载行为。它们模拟本地网关和外部程序运行环境；Linux 约束与真实评估器准确性需要独立部署检查。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Linux 课程运行环境](../../../course/scope-runtime/README.zh.md) — 部署与可信审核配置。
- [工具子系统](../../../docs/subsystems/tools.zh.md) — 原生与嵌套调度。
- [测试策略](../../../docs/testing.zh.md) — 组合与输出证据。

<a id="model-experience"></a>
## 模型体验

### 调度拒绝

#### 模型看到什么

拒绝调用通过常规已记录工具结果返回 `Action review denied tool dispatch (${code}).`。缺失 Session 使用 `Action review denied tool dispatch (ACTION_CONTEXT_REQUIRED); a trusted Session is required.`。关闭准入使用 `Action review admission is closed; restore required services and restart the process.`。工具运行环境添加常规错误前缀。不注册额外提示或 schema。

#### Token 影响

每次拒绝调用增加一条简短工具结果。决策发现与回执属于仅日志插件记录，不增加对话 token。可信审核服务的评估请求具有独立的部署成本。

#### KV Cache 影响

结果追加到保留历史并保持此前对话前缀。加载与卸载守卫不改变工具 schema；卸载仍会关闭准入，直到重启。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **仍必须隔离** — 审核脚本不会拦截其每个子进程、重定向或浏览器后台流量；应保留下层目标和操作约束。
- **移除后重启** — 此强制消费者有意不支持热卸载后转为无限制访问。恢复已移除的守卫需要教师控制的进程重启。
- **可信进程假设** — 任意同进程代码或宿主机管理员可绕过插件 API；它不构成针对二者的安全边界。

<a id="dev-note"></a>
### 开发备注

无。
