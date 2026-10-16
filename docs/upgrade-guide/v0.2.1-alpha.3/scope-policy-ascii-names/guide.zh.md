---
kind: upgrade-guide
description: "课程范围策略现在拒绝 Unicode DNS 规则，要求使用显式 ASCII/Punycode 名称。"
---

# 范围策略要求显式 ASCII/Punycode 名称

[English](guide.md) | 中文

## 变更

课程网关原先接受 Unicode DNS 规则，并使用 Python 的 IDNA 编解码器转换。recon 提供方使用不同的主机名规范化方式。因此，某些 Unicode 名称可能在两处检查中指向不同主机，混淆研究授权与操作例外。

网关现在拒绝 `domains`、`exclude_domains`、`infrastructure` 和 `domain_addresses` 中的非 ASCII 名称。recon 提供方也拒绝目标授权及排除规则中的非 ASCII 名称。使用 Unicode 名称的教师须更新策略。ASCII/Punycode 策略无需更改。Unicode recon 工具输入仍可根据显式 Punycode 授权检查；请求主机名的规范化方式不变。

## 迁移

1. 编辑 `course/scope-runtime/scope.json` 前，先停止课程环境：

   ```sh
   docker compose -f course/scope-runtime/compose.yml down
   ```

2. 检查 `domains` 和 `exclude_domains` 中每个非 ASCII 条目，以及 `infrastructure` 和 `domain_addresses` 中每个非 ASCII 键。将其替换为预期的 DNS A-label。例如，`faß.test` 应使用 `xn--fa-hia.test`，而不是另一个名称 `fass.test`。转换通配后缀时保留现有 `*.` 前缀。核实预期主机名，不要自动接受编解码器的结果；不要添加备用主机或扩大权限。

3. 运行 `docker compose -f course/scope-runtime/compose.yml build` 重新构建，再运行 `docker compose -f course/scope-runtime/compose.yml up -d --wait gateway` 重启。无效名称会阻止启动。通过 `scope_status` 检查不可变策略，确认授权、排除项与操作例外均符合预期 ASCII 名称，再恢复研究。策略字段和边界验证见[运行时参考](../../../../course/scope-runtime/README.zh.md#policy-reference)。
