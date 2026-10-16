---
kind: upgrade-guide
description: "应用 Protected 现在会导入所选本机功能及已保存的模型 API 密钥，而不是启动最小独立 profile。"
---

# Protected 继承本机已配置功能

[English](guide.md) | 中文

## 变更

Course Runtime 应用现在会将本机已启用的 bundle、模型路由及其引用的产品存储 API 密钥导入 Protected 私有主目录。此前 Protected 启动最小 profile，需要单独输入密钥。后续导入更新继承值，同时保留 Protected 覆盖设置。账户授权及无关主机凭据不在导入范围内；账户登录需要在 Protected 单独认证。显式转发主机 `OPENAI_API_KEY` 仍为可选项。

配置本机轨迹采集后，Protected 加载现有查看器，本机控制器将其持久化会话记录复制到本机归档，并使用独立安装标识。附件二进制及远程导出仍需分别选择。本机认证及归档写入凭据始终位于研究环境之外。

## 迁移

1. 按[运行时指南](../../../../course/scope-runtime/README.zh.md)重新构建 ARM 研究镜像及当前本机产物。
2. 查看活动研究，然后在 Network Scope 中选择**停止并应用**。此操作复用已保存的网络策略；导入模型不会授权新端点。
3. 选择 Protected 并验证 **Settings → Models**、已启用插件及轨迹。Protected 会话及文件仍独立于 Local。在 Protected 编辑模型覆盖设置；后续应用会保留它们。
