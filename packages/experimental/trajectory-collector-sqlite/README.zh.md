---
description: "持久化的本地 SQLite 轨迹存储，提供可信身份、重放保护、二进制证据和确认后的保留管理。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-trajectory-collector-sqlite

[English](README.md) | 中文

## 概述

在教师拥有的本地磁盘上存储完整的课程轨迹和二进制证据。完全相同的重放返回原始回执；内容或身份冲突会失败，不会替换证据。SQLite 提交可在重启后保留序号、撤销状态和导出进度。身份验证和学生注册需要单独的提供方，本包不提供这些功能。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在教师拥有的进程中挂载本服务提供方，并配合[归档接收](../trajectory-collector-archive/README.zh.md)或[经过身份验证的 HTTP 接收](../trajectory-collector-http/README.zh.md)。数据库路径必须是绝对路径。其专用目录和已有数据库必须属于进程所有者，在 POSIX 系统上不得具有组或其他用户权限。将此目录放在研究智能体可写工作区之外。使用本地文件系统，以及支持 `node:sqlite` 的 Node.js 运行时。

```yaml
- name: '@deepseek-ai/dsh-experimental-trajectory-collector-sqlite'
  config:
    path: /var/lib/dsh-trajectories/collector.sqlite
```

[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-trajectory-collector-sqlite)列出了配额、读取预算和默认值。大小配额涵盖完整的提交记录信封、活动记录内容、二进制对象和保守的数据库写入预留量。检查在明确的条目和序列化页面字节预算内返回完整记录。无法放入预算的记录会明确失败；内容绝不会被静默截断。

可信的接收消费方独立于上传内容提供安装、学生和班级身份。HTTP 接收需要授权提供方；归档接收使用教师配置的身份。首次写入会将安装永久绑定到该身份。撤销会拒绝未来的写入，包括重放，但不会删除证据。本存储提供方不接收凭据、不注册学生，也不授予网络访问权限。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者细节——点击展开</summary>

[提供方](src/index.ts)使用 WAL 模式、`synchronous=FULL`、参数化查询和同步事务。成功回执发生在提交之后。原生存储故障会停止接收，直到重新加载，并在 `COLLECTOR_STORAGE` 中保留原始原因。配额、输入、冲突和撤销故障会拒绝该操作，不会替换已提交内容。[真实 Loader 测试](tests/collector.spec.ts)覆盖重启恢复、锁故障、精确筛选、配额、撤销、产物和保留的重放保护。

会话需要先写入序号为 `-1` 的完整 `session/header` 记录，然后写入连续的原始事件序号。解析后的 JSON 必须与信封中的会话标识符、序号、类型和时间戳匹配。原始 JSON 字节以及完整的可信身份和信封决定重放是否相同。二进制对象需要匹配的 SHA-256 摘要，并按安装保留其字节和显示名称。

一个主要导出目标绑定一个不可变的确认游标。确认不能后退，也不能超过最新的已提交记录。清理仅清除已确认且足够旧的前缀中的事件内容。头部、记录身份、摘要、安装绑定和序号高水位仍会保留，因此重放不能覆盖已清理的证据或重用序号。二进制对象不会被清理。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [收集器服务](../trajectory-collector/README.zh.md)——存储和授权契约。
- [OTLP 导出器](../trajectory-export-otlp/README.zh.md)——完整记录的已确认远程副本。
- [教师部署](../../../course/trajectory-collector/README.zh.md)——进程隔离和部署假设。

<a id="model-experience"></a>
## 模型体验

无，因为本提供方存储和读取证据，不添加模型请求、提示词、工具或会话事件。

#### KV 缓存影响

请求 token 和请求前缀均不改变。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

- 存储不是来源证明，也不是加密。备份、文件系统访问、磁盘监控和加密需要单独管理。备份时绝不能仅复制活动 SQLite 主文件；其 WAL 可能包含已提交的证据。
- 清理是逻辑保留管理，不是安全擦除。保留的头部和去重墓碑仍计入记录配额。容量管理必须保留这些身份；删除它们会移除重放保护。清理会为整个数据库保守地预留 WAL 空间，并可能在存储已经紧张时拒绝执行；它不运行 `VACUUM`，也不保证文件变小。
- SQLite 工作时，事务会阻塞进程。检查可能先加载配置的记录数量上限，再实施序列化页面字节预算。二进制对象使用有界缓冲区，而非流式处理。
- 仅支持一个主要导出目标。本包未实现目标重置、schema 迁移、产物删除、学生注册、生产授权提供方或自动学生上传器。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
