---
description: "在可替换发现提供方之间使用限定范围的侦察服务。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-recon

[English](README.md) | 中文

## 概述

请求获准的侦察操作，并获得明确区分观察结果与目标权限的资产清单。请挂载具体提供方和消费方；此抽象服务不会执行工具或修改教师策略。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用此包

挂载 [ProjectDiscovery 侦察](../recon-projectdiscovery/README.zh.md)与[侦察工具](../recon-tools/README.zh.md)。抽象服务没有配置。

提供方实现 `catalog()` 和 `run(request, signal)`。调用方须明确提供目标、主动操作同意及已解析的文件策略。提供方必须检查每个目标的授权、限制执行和输出，并在子进程终止后才结算取消。清单条目仅为观察结果，绝不构成范围授权。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

[服务](src/index.ts)注册 `ctx.recon`；[类型](src/types.ts)将模型 schema、会话和 CLI 参数排除在提供方无关 API 之外。消费方负责渲染及持久化工具事件。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Linux 课程运行时](../../../course/scope-runtime/README.zh.md) — 强制执行与部署。
- [工具子系统](../../../docs/subsystems/tools.zh.md) — 执行与事件。
- [测试策略](../../../docs/testing.zh.md) — 组合与回放证据。

<a id="model-experience"></a>
## 模型体验

间接影响，通过渲染目录、清单与操作失败的 recon-tools 消费方。

#### KV Cache 影响

不直接贡献提示词或 schema。消费方负责追加工具结果及对可复用前缀的影响。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **外部强制执行**——服务授权无法限制任意代码或嵌套网络流量；仍需课程网关。
- **清单范围**——没有持久化资产数据库、所有权推断、调度器或自动的发现到扫描流水线。

<a id="dev-note"></a>
### 开发备注

无。
