# 研究课程的域名范围

[English](scope-judge.md) | 中文

范围裁判会在工具函数体执行前阻止对教师定义范围之外域名的工具调用。本指南适用于源码检出和 `headless` 配置档。[插件参考](../../../packages/guard/scope-judge/README.zh.md)定义匹配、适配器、命令及执行限制。

对于浏览器、任意脚本、终端及 IP/CIDR 扫描，请使用 [Linux 课程运行时](../../../course/scope-runtime/README.zh.md)。它保留可用能力，并在工具分发之下约束网络目标。本指南描述另一个仅检查参数的裁判，适用于受限的结构化工具部署。

## 1. 准备检出

在仓库根目录安装依赖并构建产物：

```sh
pnpm install
pnpm run build
```

构建需要可用的原生编译器。如果 macOS 提示尚未接受 Xcode 许可，且已安装 Command Line Tools，可为此次构建选择该编译器：

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm run build
```

## 2. 设置练习范围

编辑 [scope-judge.patch.yml](../../../apps/cli/config/examples/scope-judge.patch.yml)。将 `domains` 中的保留示例域名替换为练习授权的 DNS 名称。精确名称不包含子域；显式 `*.lab.test` 规则包含后代，但不包含 `lab.test` 本身。若根域也获授权，须单独列出。补丁启用已审核的 `web_fetch` 和字面 Bash 适配器；所有未分类工具均被拒绝。

将补丁、插件、执行环境及工具实现保存在 agent 不可写入的实验文件之外。全局挂载裁判；仅在一个 agent 预设内挂载的 guard 不会约束其他 agent。更改范围前停止当前工作，因为裁判检查每次新分发，而不终止现有进程。

## 3. 检查并启动

不调用模型即可检查组合配置：

```sh
pnpm dsh --profile headless --patch apps/cli/config/examples/scope-judge.patch.yml --dump-config
```

确认 `scope-judge` 行包含预期域名，且工具使用 `mode: native`。按照 [headless 参考](../../../packages/bundle/headless/README.zh.md)配置模型凭据，然后启动练习：

```sh
pnpm dsh --profile headless --patch apps/cli/config/examples/scope-judge.patch.yml 'Inspect the HTTP headers of https://example.test with curl -q -I. Stay within the configured scope.'
```

将示例 URL 替换为第 2 步中配置的同一授权实验名称。模型驱动的练习需要有效模型凭据和实验连接；以下自动化验证无需密钥，也不发送研究流量。

## 4. 验证拒绝

运行裁判的定向测试：

```sh
pnpm exec vitest run packages/guard/scope-judge/tests
pnpm run test:snapshot -t scope-judge
```

测试断言范围内调用会执行，范围外或混合目标调用不会进入其函数体，强制允许策略无法覆盖拒绝，且 Loader 会激活插件。录制的 headless 场景在 Session 历史记录中保留范围拒绝结果。拒绝以 `Error: scope judge denied` 开头，指出工具和原因，并报告允许的域名。

对于其他研究工具，请遵循[结构化适配器要求](../../../packages/guard/scope-judge/README.zh.md#structured-tools)。在工具及其所有次级请求具备执行约束责任方前，始终拒绝未知目标。对超出工具参数的流量保留实验出口控制。
