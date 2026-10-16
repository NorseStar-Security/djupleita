---
description: "组合面向目标的工具预检、scope_status 与 Session 网络审计，不使用能力拒绝列表。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-network-scope-guard

[English](README.md) | 中文

## 概述

在教师强制执行的网络边界之后继续使用浏览器、终端、代码执行和扫描器。分发前检查已知的 HTTP 目标参数，并阻止范围外目标。通过 `scope_status` 读取当前策略，并将环境网络决策保留在 Session 日志中。未知工具名称仍然可用；外部网关约束其实际流量。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在[课程运行时](../../../course/scope-runtime/README.zh.md)内挂载 [`network-scope-linux`](../network-scope-linux/README.zh.md) 提供者与本消费者。不要在此配置档同时挂载旧的仅检查参数的范围裁判：它会有意拒绝不透明能力。

```yaml
- name: '@deepseek-ai/dsh-experimental-network-scope-linux'
- name: '@deepseek-ai/dsh-experimental-network-scope-guard'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `pollIntervalMs` | `1000` | 后台健康/审计检查间隔，单位毫秒 |
| `targetTools` | 抓取和浏览器导航映射 | 精确工具名、顶层 `urlField` 和可省略参数的 `methodField`；未提供方法时使用 `GET` |

[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-network-scope-guard)定义精确的默认映射，包括 Playwright MCP 工具名。每次调用都执行新的就绪检查。映射的目标还会在工具主体执行前获得网关的权威决策。未映射调用可通过本裁判，但不会豁免于内核/网关策略。嵌套 PTC 分发使用同一管线。

传输失败或网关不健康会拒绝工具分发，直到检查成功。网关身份变化、无效观察、审计游标被覆盖和审计存储失败会停止依赖分发；教师必须先调查再重新加载。重新加载不会改变外部策略。网关失败时，本插件不会杀死已运行的不透明程序；保留的内核规则仍约束其网络。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者详情 — 点击展开</summary>

[消费者](src/index.ts)通过一个审计游标串行化预检与轮询。单调工具守卫使后续宽松监听器无法覆盖本消费者的拒绝。提供者拥有不可变策略决策；消费者从不解析 shell 程序或编辑防火墙。Cordis 卸载会移除守卫、工具和监听器，取消待处理检查并排空轮询。

[实验记录](src/types.ts)将带有工具调用 id 的实际分发前裁判决策，与有意不带该 id 的环境网络活动分离。每个活动 Session 都接收消费者运行时观察到的共享流；新附加的 Session 可能收到上次环境轮询后的活动。初次附加从网关当前游标开始。旧读取器保留并跳过这些可忽略记录；它们不影响模型上下文。它们不是防篡改或完整取证账本，迁移仅尽力保留它们。

[Loader 测试](tests/loader.spec.ts)验证分发效果、失败时拒绝、审计保留与卸载。[无密钥 CLI 场景](../../../snapshots/session/network-scope/snapshot.yml)录制策略输出、真实终端正向对照及范围外抓取拒绝。独立 Linux 套件拥有实际套接字/浏览器隔离证据。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [范围服务定义](../network-scope/README.zh.md) — 可替换的提供者与消费者 API。
- [Linux 课程运行时](../../../course/scope-runtime/README.zh.md) — 策略、部署与信任假设。
- [工具子系统](../../../docs/subsystems/tools.zh.md) — 原生与 PTC 分发。

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到的内容

[生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-network-scope-guard)定义精确的 `scope_status` schema。本包不添加隐藏系统提示词或自动策略指令。

#### Token 影响

消费者挂载期间存在一个固定工具 schema。环境审计记录不增加模型 token。

#### KV Cache 影响

schema 在一次挂载期间保持稳定。添加或移除此消费者会改变工具头，并可能使该位置之后的复用失效。

### 状态和拒绝结果

#### 模型看到的内容

`scope_status` 返回包含网关实例、策略哈希、边界和教师策略的 JSON。预检失败返回带决策码或预检不可用说明的工具错误；策略与错误结果使用正常的已记录工具结果表面。已运行程序内部的网络拒绝仍属于该程序输出，而非追溯性的工具裁判裁决。分发错误使用 `Network scope denied tool dispatch (${code}); inspect scope_status or ask the instructor to restore the boundary.`，其中 `${code}` 表示失败决策。预检缺失使用 `Network scope preflight did not complete; tool dispatch is blocked.`；降级状态使用 `Network scope is unavailable; tool dispatch is blocked.`。工具运行时添加其正常错误前缀。

#### Token 影响

状态大小取决于策略。拒绝增加简短工具结果文本。两者都追加到保留的对话历史；仅供日志的网络流不会。

#### KV Cache 影响

结果以仅追加方式增长上下文，并保留先前可复用的前缀。策略变化需要新的环境身份与教师控制的重新加载，而不是替换先前消息。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **部署才是安全边界** — 智能体拥有的代码可以卸载消费者，但不能关闭教师拥有的外部防火墙。绝不能把插件检查本身视为隔离约束。
- **部分参数检查** — 只有配置的顶层 HTTP 目标字段接受分发前目标检查。重定向、任意代码、浏览器后台流量和原始 IP 流量在工具之下执行约束；网络审计无法可靠地把它们归于单个调用或 Session。
- **共享且有界的审计** — 所有活动 Session 共享环境流。洪泛可以覆盖网关的 1024 条事件环并有意停止后续工具分发。教师的网关 stdout 仍是独立审计来源。

<a id="dev-note"></a>
### 开发备注

无。
