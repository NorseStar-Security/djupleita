---
description: "为受保护课程环境添加可选的第一方侦察页面。本包仍为实验性功能，依赖网络范围。每次操作的侦察设置固定不变；发现资产不会授予授权。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-recon-bundle

[English](README.md) | 中文

## 概述

为受保护课程环境添加可选的第一方侦察页面。本包仍为实验性功能，依赖网络范围。每次操作的侦察设置固定不变；发现资产不会授予授权。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制及延后工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在插件中启用网络范围及侦察，然后打开侦察页面。配置被动来源、端口、速率、并发、深度、截止时间和结果上限。高级设置包含可执行文件、代理、解析器及终止设置。通过共享本机控制器保存并应用。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

侦察补丁插入 course-recon-ui；其主机注册选择侦察组合，浏览器注册负责配置页面。本机运行环境负责激活，并拒绝在受保护研究运行期间禁用或移除。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Linux 课程运行环境](../../../course/scope-runtime/README.zh.md)
- [实验性包](../README.zh.md)

<a id="model-experience"></a>
## 模型体验

无：配置及运行环境控制不会添加模型提示、工具或会话事件。

#### KV 缓存影响

无直接影响；研究提供程序及工具负责其模型可见行为。

## 已知限制及延后工作

<a id="known-limitations-and-deferred-work"></a>

- 支持一份共享策略及一个受保护的 ARM Colima 环境。会话及工作区卷保留在原后端。切换不会迁移会话或停止后台工作。应用失败后研究保持停止，用户必须审核后重新应用。其他被动来源需要明确审核的基础设施权限。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
