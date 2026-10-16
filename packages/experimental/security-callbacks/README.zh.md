---
description: "为授权安全测试创建临时 HTTP 回调 URL，并按会话读取有界证据。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-security-callbacks

[English](README.md) | 中文

## 概述

为授权安全测试创建独立回调 URL，并读取收到的请求。URL 自动过期，一个会话无法读取或撤销另一个会话的回调。首次分配时，接收器启动专用的回环 HTTP 监听器和公共隧道。回调流量无法到达 Harness UI。

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

在接收器旁挂载[隧道提供器](../security-callbacks-ngrok/README.zh.md)和[回调工具](../security-callbacks-tools/README.zh.md)。ngrok 包提供 ngrok 和运维人员管理的反向代理的可选配置覆盖。默认配置不会打开公共端点。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `listenHost` | `127.0.0.1` | 回环地址，也接受 `::1` |
| `listenPort` | `0` | 专用监听端口，零表示分配空闲端口 |
| `ttlMs` | `600000` | 每个回调 URL 的绝对有效期 |
| `maxCallbacks` | `32` | 所有会话的存活 URL 总数 |
| `maxEvents` | `32` | 每个 URL 保留的请求数 |
| `maxRequestBytes` | `16384` | 分别限制正文和请求头字节数 |
| `maxEvidenceBytes` | `131072` | 每个 URL 的完整序列化证据预算 |
| `requestTimeoutMs` | `10000` | HTTP 请求和空闲连接期限 |
| `maxConnections` | `32` | 同时接受的连接数 |

调用 `security_callback_create`，在获批测试中使用返回的 URL，通过 `security_callback_read` 读取证据，再通过 `security_callback_close` 撤销。每个句柄包含 `id`、`url` 和 `expiresAt`。接收器接受精确关联路径及其子路径，记录方法、路径、请求头、时间和 base64 正文，并返回空 HTTP 204。未知、已撤销或已过期的路径返回 404。超大正文返回 413；证据或事件预算耗尽时返回 429 并增加 `dropped`。读取返回独立快照，不消耗证据。

请求头、路径和正文均为不可信证据。收到回调不代表存在漏洞，未收到回调也不代表安全。创建回调不会访问扫描目标或扩大网络范围。请求头和正文可能含有敏感值；工具结果保存在普通会话记录中。只有内存中的活动证据会因过期或关闭而删除。

### 在插件 DSL 中使用自定义提供器

接收器注入 `callbackTunnel`。在本地 Cordis 插件中实现导出的 `CallbackTunnel` 服务，并在 YAML 中选择该模块来替换 ngrok 模块。其 `open(localUrl, signal)` 方法返回 `{ url, close }`：`url` 必须是转发到指定接收器的 HTTPS 源，`close()` 必须等待提供器所创建资源的清理。发布失败时必须清理资源或报告远程结果未知。[自定义提供器](../security-callbacks-ngrok/examples/custom-tunnel.mjs)和[自定义覆盖](../security-callbacks-ngrok/examples/custom.patch.yml)演示预配置反向代理。代理需要固定上游时，设置固定 `listenPort`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[接收器](src/index.ts)管理关联句柄、过期、有界证据和监听器清理。导出的隧道服务使 ngrok 凭据和 API 细节独立于捕获及工具执行。并发分配共享初始化；发布失败后需修正配置并重新加载接收器。即使远程清理失败，卸载也会关闭本地连接。

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

通过回调工具间接呈现分配的 URL、证据和失败。

#### 令牌影响

此包不直接增加令牌。工具结果的大小受捕获预算限制。

#### KV 缓存影响

不直接添加提示词或工具模式。工具结果追加到会话历史。

## 已知限制和待办工作

<a id="known-limitations-and-deferred-work"></a>

- **协议** — 仅支持 HTTP(S) 回调，不提供权威 DNS、SMTP、任意 TCP、目标扫描或漏洞利用执行。
- **保留** — 未读取证据只在内存中保存；过期、撤销、重启和卸载都会删除证据。即使全部关联 URL 过期，共享监听器和隧道仍保留到插件卸载。
- **解读** — 捕获不验证目标身份，也不区分扫描器流量、机器人或真实目标回调。

<a id="dev-note"></a>
### 开发备注

无。
