---
description: "通过 HTTP 提供受限轨迹上传及经过身份验证的教师只读检查。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-trajectory-collector-http

[English](README.md) | 中文

## 概述

在本地浏览器或受限 JSON 页面中检查完整课程轨迹。将二进制证据作为附件下载，而不呈现上传内容。仅当独立的课程授权提供方给出可信身份时接受学生上传。请求具有明确的字节、并发及时间限制；上传成功响应表示存储已确认完整记录。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用此包

将此插件与持久化存储及 HTTP 监听器一起挂载。教师检查使用现有 Harness 浏览器身份验证；学生接收使用另一项授权服务。

### 最小配置

此专用本地组合启用检查，不启用学生接收。在教师拥有的目录中设置绝对路径。除非另行配置部署认证、TLS 及可信主机地址，否则将监听器保留在回环地址。

```yaml
- name: '@deepseek-ai/dsh-host-webserver'
  config: { host: '127.0.0.1', port: 3081 }
- name: '@deepseek-ai/dsh-credentials-local'
  config: { path: '/var/lib/dsh-course/credentials.yaml', watch: false }
- name: '@deepseek-ai/dsh-client-connection'
- name: '@deepseek-ai/dsh-experimental-trajectory-collector-sqlite'
  config: { path: '/var/lib/dsh-course/archive/collector.sqlite' }
- name: '@deepseek-ai/dsh-experimental-trajectory-collector-http'
  config: { serveRoot: true }
```

打开激活时打印一次的教师登录 URL。现有根路径 token 交换创建浏览器 cookie，从 URL 移除 token，并将已认证的根请求重定向到 `/trajectory`。将此本地启动 URL 视为凭据；它不是学生上传 token。当现有 Harness Web 应用拥有 `/` 时，保留 `serveRoot: false`，先通过该应用的登录 URL 认证。缺失教师认证服务时返回 `503`；缺失或无效浏览器认证返回 `401`，不可信的 Host 或 Origin 返回 `403`。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `path` | `/api/trajectory` | 不带尾部斜线的 API 前缀。 |
| `dashboardPath` | `/trajectory` | 转义后的只读 HTML 页面。 |
| `serveRoot` | `false` | 为现有本地教师登录拥有 `/`。 |
| `maxRecordBytes` | `1048576` | 完整记录请求预算。 |
| `maxArtifactBytes` | `16777216` | 完整二进制上传及下载预算。 |
| `maxConcurrent` | `16` | 活跃请求，包括仍在结算的写入。 |
| `timeoutMs` | `30000` | 整个请求的毫秒截止时间。 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-trajectory-collector-http)列出所有可接受的限制。

### 上传与检查

`POST /api/trajectory/records` 接受 `application/json`，仅包含 `sessionId`、`sequence`、`type`、`timestamp` 及完整 JSON `content`。`POST /api/trajectory/artifacts` 接受 `application/octet-stream`、小写十六进制 `X-Trajectory-Sha256`，以及 `X-Trajectory-Name` 中按百分号编码的显示文件名。额外身份字段或 `X-Trajectory-*` 请求头会被拒绝。两条路由都将 Authorization 头传给 `trajectoryUploadAuth`；仅其结果提供安装、学生及班级身份。已撤销的安装不能上传。

经过身份验证的教师可以读取 `GET /api/trajectory/records`、`/api/trajectory/status` 及 `/trajectory`。记录页面接受 `after`、`limit`、`maxBytes`，以及精确的 `installationId`、`studentId`、`cohortId` 或 `sessionId` 过滤条件。使用 `nextCursor` 获取下一页。未知或重复参数会失败，而不是扩大查询。`GET /api/trajectory/artifacts?installationId=…&id=…` 下载完整二进制附件并禁止内容嗅探。响应禁用缓存；HTML 转义上传内容且不包含脚本。

ACK 在存储 promise 完成后发出，而不是收到 HTTP 请求体时发出。超时、断开或存储失败会使已开始写入的结果未知。重试完全相同的载荷：存储去重返回原收据，而冲突内容返回 `409`。超出预算的输入或输出返回 `413`，不裁剪内容；应请求更小的页面。卸载移除路由，取消请求及认证工作，并等待已开始的存储操作结算。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者细节 — 点击展开</summary>

[入口](src/index.ts)负责路由注册及清理。[HTTP 所有者](src/http.ts)在持久化操作结算前保留请求容量，即使响应截止时间已过。[线路解析器](src/parsing.ts)在存储接收前验证不可信请求体及精确选择器。存储及两项认证服务保持独立可替换；此消费方不注册安装，也不授予研究目标范围。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [收集器定义](../trajectory-collector/README.zh.md) — 身份及完整记录语义。
- [SQLite 存储](../trajectory-collector-sqlite/README.zh.md) — 持久性、配额及撤销。
- [Host 认证](../../client/connection/README.zh.md) — 现有浏览器及请求信任。
- [课程收集器](../../../course/trajectory-collector/README.zh.md) — 部署及注册要求。

<a id="model-experience"></a>
## 模型体验

无，因为 HTTP 接收及教师检查不添加模型请求、提示词、工具或会话事件。

#### KV Cache 影响

不改变请求 token 或请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 不包含生产上传授权提供方、课程 SSO、注册、主机名或学生自动上传器。缺失 `trajectoryUploadAuth` 返回 `503`，绝不启用匿名写入。
- 教师访问使用现有本地所有者 cookie，而非课程教师角色。根路径登录必须显式启用，且不能与另一所有者共享 `/`。
- 请求体、完整页面及二进制证据使用受限缓冲区。不提供流式传输或丰富的时间线可视化。
- 授权提供方必须响应取消；存储操作必须最终结算。不配合的依赖会保留请求容量，并可能延迟卸载。

<a id="dev-note"></a>
### 开发备注

无。
