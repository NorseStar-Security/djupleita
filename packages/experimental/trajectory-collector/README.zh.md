---
description: "持久化课程轨迹接收、二进制证据、检查及可替换的学生上传授权。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-trajectory-collector

[English](README.md) | 中文

## 概述

在本地保留完整课程轨迹，并独立于研究代理检查内容。完全相同的重放返回原收据；冲突记录会失败，而不是覆盖证据。可信的安装、学生及班级身份与上传内容分离。学生上传需要授权提供方；此处不提供镜像共享秘密或匿名回退。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用此包

挂载具体提供方，而不是此抽象服务。使用 [SQLite 存储](../trajectory-collector-sqlite/README.zh.md)、[可信归档接收](../trajectory-collector-archive/README.zh.md)，并可选用[经过身份验证的 HTTP 检查及接收](../trajectory-collector-http/README.zh.md)。此定义没有配置。它不添加研究工具或网络授权。

存储仅在完整记录提交后确认。会话从序号 `-1`、类型 `session/header` 及包含 `{header,inheritedEventCount}` 的 JSON 开始；后续事件保留原始序号、类型、时间戳及完整 JSON 字节。二进制对象使用经过校验的 SHA-256 标识。检查按明确的条目及字节预算返回完整记录，绝不静默裁剪内容。

授权及注册必须位于研究进程之外。`TrajectoryUploadAuth` 验证课程签发的凭据，并提供可信的安装、学生及班级身份；缺失时拒绝 HTTP 上传。`TrajectoryCredentials` 定义安装侧获取当前短期凭据的方式，但尚无生产提供方或上传器。课程 SSO、服务主机名、注册、续期及发送方约束凭据仍是部署占位项，不是可用认证。本地归档身份来自教师配置，并非经验证的学生身份。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者细节 — 点击展开</summary>

[服务定义](src/index.ts)保持存储、上传授权及安装凭据可替换。消费方不能从事件属性推导可信身份。[值类型](src/types.ts)区分原始记录、持久化收据、受限检查页及二进制数据。一个主要导出目的地拥有持久化确认游标；保留策略仅能删除已确认的旧前缀，并保留重放保护。撤销拒绝后续写入，不删除证据。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [OTLP 导出器](../trajectory-export-otlp/README.zh.md) — 经过确认的远程记录副本。
- [课程收集器](../../../course/trajectory-collector/README.zh.md) — 教师部署及凭据。
- [会话持久化](../../session/session-persistence/README.zh.md) — 原始归档只读句柄。

<a id="model-experience"></a>
## 模型体验

无，因为收集及检查不添加模型请求、提示词、工具或会话事件。

#### KV Cache 影响

不改变请求 token 或请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 尚未实现注册及学生自动上传；身份提供方及服务主机名仍是占位项。不得分发声称能自动远程收集的镜像。
- 收集不是可信证明。控制 VM 或虚拟机监控程序的学生可以抑制或伪造源数据；从未持久化的事件无法恢复。
- 完整二进制对象采用受限缓冲区。不提供大文件流式传输、二进制远程导出或多个独立确认的远程目的地。

<a id="dev-note"></a>
### 开发备注

无。
