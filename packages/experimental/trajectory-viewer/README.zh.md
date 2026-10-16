---
description: "在 Web 界面中查看本地收集的 Agent 轨迹，支持有界查询、执行树、时间线及完整源记录。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-trajectory-viewer

[English](README.md) | 中文

## 概述

从 Web 侧栏打开 **Trajectories（轨迹）**，无需加载整段对话即可检查研究会话。按安装、学生、班级、会话、状态或轨迹文本筛选，再查看执行树及带时间的跨度。可暂停实时跟随、替换分页，并以纯文本打开完整源记录。连接故障与索引延迟始终可见。查看器使用现有 Web 连接认证，不提供研究或上传能力。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在已有认证的 Web 应用、[收集器](../trajectory-collector-sqlite/README.zh.md)和[轨迹投影](../trajectory-projection/README.zh.md)旁挂载本插件。

### 何时选择本包

适用于本地课程观察及源记录检查。远程 Logfire 查询和跨机器监控需另加 [OTLP 导出](../trajectory-export-otlp/README.zh.md)。教师 Web 认证、归档身份配置及数据库必须放在研究 Agent 的可写区域之外。

Course Runtime 使用 `/native-management` 导出在 Protected 中挂载纯浏览器组件；它公布本机 API 路径，不在研究环境中挂载归档服务。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-experimental-trajectory-viewer'
```

本包不是可安装的配置包。[课程叠加配置](../../../course/trajectory-collector/README.zh.md)会组合其依赖，不替换现有持久化或 Web 认证。浏览器客户端通过插件声明的 `dsh.client` 入口加载。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiBasePath` | `api/trajectory-viewer/` | 同源后端路径；`/api/trajectory-viewer/` 在 Protected 中选择本机管理 |
| `pollIntervalMs` | `1500` | 已完成实时读取之间的延迟，范围为 1000 至 60000 毫秒 |

只读 `/api/trajectory-viewer/status`、`/traces`、`/detail`、`/records` 路由均要求现有连接凭据。查询最多接收 100 行，拒绝未知或重复参数，完整响应上限为 2 MiB。源记录读取另有 1 MiB 请求限制。记录过大时明确失败，不会截断。插件不增加上传或控制路由。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

Host 在访问收集器或投影前逐次认证并限制读取。最多同时接收八个读取，十秒后返回超时，但仍负责尚未结束的提供方读取。销毁时停止接收并等待这些操作完成。HTTP 错误不暴露提供方诊断信息。

浏览器注册框架资源提供方；组件不直接发送请求或订阅。持有的实时资源按配置间隔轮询，释放时取消请求和计时器。暂停页只读取一次；刷新产生新的资源请求。失败保留上次值并标记过期。分页替换行，不无限扩展 DOM。父子会话导航保留所选安装身份。

执行树和时间线描述当前页的索引跨度，并不保证所有子节点都已加载。源检查读取完整收集器 JSON，仅按文本渲染，不解释为 HTML。搜索只检查可见记录页，不改写任何源 Session。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 路由注册与生命周期 |
| [`src/http.ts`](src/http.ts) | 认证、查询限制与读取结算 |
| [`src/wire.ts`](src/wire.ts) | 浏览器响应验证 |
| [`src/client/resources.ts`](src/client/resources.ts) | 轮询与取消 |
| [`src/client/viewer.tsx`](src/client/viewer.tsx) | 有界执行树、时间线、筛选与源记录展示 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [课程收集器部署](../../../course/trajectory-collector/README.zh.md) — 本地启动及认证假设。
- [轨迹投影](../trajectory-projection/README.zh.md) — 时间、状态与子会话证据。
- [本地归档](../trajectory-collector-archive/README.zh.md) — 完整持久化记录收集。
- [SQLite 收集器](../trajectory-collector-sqlite/README.zh.md) — 持久存储与保留策略。
- [OTLP 导出](../trajectory-export-otlp/README.zh.md) — 可选远程日志与轨迹。

<a id="model-experience"></a>
## 模型体验

无；本包向人展示已收集记录，不增加模型请求、工具、提示词或 Session 事件。

#### KV 缓存影响

查看器不改变模型上下文及其可复用前缀。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

查看器是有界本地检查器，不是实时数据包观察器或学生注册服务。

- 实时跟随观察已持久化的收集器及投影状态，受收集和索引延迟影响；不展示未持久化的 token 分块。
- 轨迹文本搜索覆盖索引摘要，原始 JSON 搜索仅覆盖已加载源记录页。父节点位于其他页时，执行树可能显示页内根节点。
- 大页或单个大记录可能超出响应预算，需要较小 API 分页或单独导出；不会静默截断数据。
- 此 Web 连接的所有已认证用户均可检查挂载的收集器。这里未实现学生级远程授权或课程 SSO。
- 时间线精度受记录时间戳限制。投影文档说明缺失时间及共享环境作用域归属。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
