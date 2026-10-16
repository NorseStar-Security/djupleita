---
description: "通过可配置的 ngrok 代理发布专用安全回调接收器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-security-callbacks-ngrok

[English](README.md) | 中文

## 概述

使用运行中的 ngrok 代理和账户已分配的 HTTPS 源发布临时回调 URL。在 Cordis YAML 中选择代理 API 地址和 API 预算。提供器为接收器创建一个专用端点，并仅在清理时删除该端点。运维人员负责 ngrok 安装、认证和网络访问。

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

启动已认证的 ngrok 代理，启用回环 Agent API，确保所选公共源没有其他端点占用。在 Harness 启动环境中将 `DSH_CALLBACK_PUBLIC_URL` 设置为账户已分配的 HTTPS 源，再通过普通配置的 `--patch` 选项应用 [examples/ngrok.patch.yml](examples/ngrok.patch.yml)。工作区覆盖引用构建后的相邻包。已安装的组合可以改用三个包名挂载。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `agentApi` | `http://127.0.0.1:4040/api` | 回环 ngrok Agent API 根路径 |
| `publicUrl` | 必填 | ngrok 账户已分配的 HTTPS 源 |
| `timeoutMs` | `10000` | 每次 API 请求（包括删除）的期限 |
| `maxApiBytes` | `65536` | API 响应最大字节数 |

适配器使用 [ngrok Agent 端点 API](https://ngrok.com/docs/gateway/agent/api)，采用随机端点名称，将专用本地接收器设为上游，并关闭流量检查和池化。它不会暴露 Harness UI、启动 ngrok 进程或把认证令牌放入工具参数。发布失败时按生成的名称尝试删除端点；清理失败会报告远程端点可能仍然存在，需要检查代理。

使用其他服务时，将隧道行替换为自己的插件。[自定义覆盖](examples/custom.patch.yml)和[提供器模块](examples/custom-tunnel.mjs)使用外部管理的反向代理，将配置的 HTTPS 源转发至 `http://127.0.0.1:8787`。该提供器验证上游地址且不创建远程资源。清理不会停止运维人员的代理；接收器仍会撤销路径并停止本地监听器。扩展 `CallbackTunnel.open` 即可集成其他管理 API，无需修改回调工具。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[提供器](src/index.ts)实现回调隧道服务，限制 Agent API 响应，并在创建失败后尝试补偿删除。拒绝 Agent API 重定向。清理只针对生成的端点名称，不涉及全部端点或代理全局捕获流量。

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

不直接添加提示词、模型工具或会话内容。接收器和工具使用已发布的源。

#### 令牌影响

此包不直接增加令牌。工具结果的大小受捕获预算限制。

#### KV 缓存影响

不直接影响令牌或 KV 缓存。更换提供器可能改变后续工具结果中的回调 URL。

## 已知限制和待办工作

<a id="known-limitations-and-deferred-work"></a>

- **部署** — 需要在接收器的网络命名空间中单独运行已认证且支持端点 API 的 ngrok 代理。ngrok 在发布时检查账户权限和端点可用性。
- **执行限制** — 课程运行时必须显式允许 ngrok 运维出口；回调配置不会添加目标授权或绕过课程网关。
- **验证** — 本地 Agent API 测试覆盖组合和清理。无密钥测试不验证真实 ngrok 账户或公共回调投递。

<a id="dev-note"></a>
### 开发备注

无。
