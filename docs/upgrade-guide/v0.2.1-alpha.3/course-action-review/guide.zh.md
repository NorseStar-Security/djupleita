---
kind: upgrade-guide
description: "课程运行时应用现在要求配置操作审核、经中介的操作策略及活动本地轨迹收集。"
---

# 应用前配置强制课程操作审核

[English](guide.md) | 中文

## 变更

缺少 `actionReview`、HTTP 操作限制或本地轨迹的课程草稿不能再应用。现有范围不会静默获得审核器或更广目标权限。每次课程工具分发现在需要持久审核收据；权限预设不能绕过。强制审核服务缺失或卸载会拒绝执行。

## 迁移

1. 在插件 → Network Scope 停止研究。更新检出后重新构建运行时镜像；已有运行镜像不会被改写。
2. 参照 [review.json](../../../../course/scope-runtime/review.json) 暂存 `actionReview`。选择显式 `evaluators[].model`、HTTPS `endpoint` 和 `credentialRef`，并在本机配置该凭据。TypeSafe 使用 `kind: "jev"` 和其 System One 端点。保留 `destructive` 与 `insufficient_context` 维度；按需添加其他风险维度。不要在 JSON 中放入字面密钥。
3. 从 [scope.json](../../../../course/scope-runtime/scope.json) 添加 `policy.operations`，审阅拒绝路径和预算，并保留 `requireMediatedHttp: true`。删除原始 `ips` 授权：它们可绕过 HTTP 检查。域名地址固定仍可访问获准私有 HTTP 夹具。保持基础设施方法/路径权限狭窄；即使主机也位于 `domains`，这些限制现在仍生效。
4. 加载本地轨迹收集器和投影，配置归档身份，然后保存并应用新版本。本机接收成功前网关不放行工具。审核密钥及 SQLite 收据留在仅网关可见卷。
5. 确认保存/应用版本一致、操作审核及收集就绪已观测到，并检查隔离轨迹查看器。测试受控允许操作和禁止操作。缺少模型、凭据、收集或收据存储时必须拒绝，而非回退宿主研究。限制、保留与扩展见[运行时参考](../../../../course/scope-runtime/README.zh.md#action-review)。
