---
description: "在 Apple Silicon macOS 上配置此分支的课程功能：必需的轨迹与操作审核、范围与侦察插件、隔离 Colima 工作区及导入的 OpenRouter 设置。"
---

# 在 macOS 上配置课程分支

[English](course-macos.md) | 中文

## 概要

使用此源代码检出运行课程 Web 应用，启用本地轨迹、操作审核、网络范围、侦察和隔离 Linux 工作区。课程主机默认仅用于管理；研究需要已配置且就绪的隔离运行环境。普通 Web 配置档不会启用所有这些功能。本指南适用于 Apple Silicon 部署；[安装报告](../../postmortem/0005-course-macos-setup.zh.md)保留了其历史安装证据。

## 目录

- [构建分支](#build-the-fork)
- [配置私有 Web 配置档](#configure-the-private-web-profile)
- [准备 Docker 和 Colima](#prepare-docker-and-colima)
- [启用本地轨迹并启动](#launch-with-local-trajectories)
- [启动隔离研究环境并配置 OpenRouter](#start-protected-and-configure-openrouter)
- [验证与恢复](#verify-and-recover)

<a id="build-the-fork"></a>
## 构建分支

准备 Git、此仓库的访问权限、满足 `package.json` 要求的 Node.js、pnpm 和可用的 Xcode Command Line Tools。仓库声明的 pnpm 版本为 11.28.5。在 PATH 中提供 Python 3.11，供本机控制器和网关测试使用；安装报告说明了尚未解决的 Python 3.14 测试 CA 兼容问题。[根目录源代码说明](../../../README.zh.md#run-from-source)定义构建流程。

本指南使用的课程分支：

```sh
gh repo clone 5stars217/deepseek-harness
cd deepseek-harness
pnpm install --frozen-lockfile
node node_modules/pnpm/bin/pnpm.cjs run build
```

最后一条命令使用工作区安装的 pnpm 版本。私有仓库需要已认证且具有读取权限的账号。运行已发布的 npm 包不会安装此检出中尚未发布的课程修改。首次构建前出现的依赖重试和缺少 `lib/bin.js` 的链接警告，并不能说明应用构建失败；请检查命令完成后的退出状态。

<a id="configure-the-private-web-profile"></a>
## 配置私有 Web 配置档

配置和凭据应保存在检出和共享知识库之外。在启动应用的 shell 或启动器中保留以下环境变量：

```sh
export DSH_HOME="$HOME/.dsh"
export DSH_COURSE_SOURCE="$PWD"
export DSH_COURSE_PYTHON="$(command -v python3.11)"
export DSH_TELEMETRY_DISABLED=1
umask 077
mkdir -p "$DSH_HOME"
pnpm dsh web --dump-config > /dev/null
```

配置转储会初始化 Web 配置档，但不会启动监听器或调用模型。在 `$DSH_HOME/profiles/web/package.json` 中保留现有依赖和 bundle，并按顺序包含以下四个 bundle：

```json
[
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "@deepseek-ai/dsh-experimental-network-scope-bundle",
  "@deepseek-ai/dsh-experimental-recon-bundle"
]
```

此数组是清单中的 `dsh.profile.bundles` 值，不是整个清单的替代内容。在已经运行的应用中，也可以通过插件页面启用相同的范围和侦察 bundle。将以下配置加入 `$DSH_HOME/profiles/web/cordis.patch.yml` 时保留现有配置行；一行的 `config` 会替换该行的完整配置，因此必须保留已经配置的其他提供商：

```yaml
- id: llm-pi-ai
  config:
    providers:
      openrouter:
        displayName: OpenRouter
        apiKeyEnv: OPENROUTER_API_KEY
- id: agent-default-model
  config:
    provider: openrouter
    model: deepseek/deepseek-v4.1-flash
- id: session-log-deepseek
  config:
    enabled: false
- id: course-runtime
  config:
    role: instructor
    sourceRoot: !!js process.env.DSH_COURSE_SOURCE
    stateRoot: !!js dshHomePath('course-runtime')
    python: !!js process.env.DSH_COURSE_PYTHON
```

此 YAML 中不应包含 API 密钥。启动后，通过[设置 → 模型](providers.zh.md)配置凭据。OTel 开关和 DeepSeek 会话日志开关控制不同的上传路径；此本地部署关闭两者。

对于嵌入式浏览器，已有的[页内选择器覆盖层](../../../apps/web/tests/pin-browse-picker.overlay.yml)可避免原生 OS 选择器。若要在 Web 配置档中保留此交互，将其禁用和插入配置行追加到配置档补丁。其他配置档仍可使用原生 OS 选择器。

<a id="prepare-docker-and-colima"></a>
## 准备 Docker 和 Colima

准备 Docker 和 Colima，再安装缺少的独立 Homebrew CLI 插件：

```sh
brew install docker-buildx docker-compose
mkdir -p "$HOME/.docker/cli-plugins"
```

将已安装的可执行文件注册为 `$HOME/.docker/cli-plugins/docker-buildx` 和 `$HOME/.docker/cli-plugins/docker-compose`。在此 Homebrew 布局中，它们分别指向 `$(brew --prefix docker-buildx)/bin/docker-buildx` 和 `$(brew --prefix docker-compose)/bin/docker-compose`。保留现有注册。构建镜像前确认 Docker 能发现插件：

```sh
docker buildx version
docker compose version
```

只有 Docker 并不足够：旧构建器没有填充 Dockerfile 的自动 `TARGETARCH` 参数，侦察安装器因架构为空而拒绝安装。缺少 Compose 则导致容器无法启动。[课程运行环境说明](../../../course/scope-runtime/README.zh.md#run-an-exercise)提供独立 Colima 的创建命令。使用其 `dsh-course` 配置档和 `--activate=false`；应用显式使用 `colima-dsh-course`，不改变当前 Docker 上下文。

<a id="launch-with-local-trajectories"></a>
## 启用本地轨迹并启动

收集器需要位于 `DSH_HOME` 之外、仅所有者可访问且彼此独立的数据库目录，并需要明确的本地归档标签。以下示例标签是本地操作员元数据，不是课程注册或 SSO 身份声明：

```sh
export COURSE_COLLECTOR_DB="$HOME/.local/share/dsh-course-observation/collector/trajectories.sqlite"
export COURSE_PROJECTION_DB="$HOME/.local/share/dsh-course-observation/projection/traces.sqlite"
export COURSE_INSTALLATION_ID="sans-local-${USER}"
export COURSE_STUDENT_ID="local-instructor"
export COURSE_COHORT_ID="local-development"
mkdir -p "$(dirname "$COURSE_COLLECTOR_DB")" "$(dirname "$COURSE_PROJECTION_DB")"
chmod 700 "$(dirname "$COURSE_COLLECTOR_DB")" "$(dirname "$COURSE_PROJECTION_DB")"
node course/trajectory-collector/native.mjs web --host 127.0.0.1 --port 3080 --no-open
```

使用进程打印的新登录 URL；认证前直接访问 localhost 基础 URL 会收到需要认证的响应。妥善保管启动 URL 和令牌。替换监听器前，应正常停止现有所有者，不要在同一端口启动第二个进程。[收集器参考](../../../course/trajectory-collector/README.zh.md#integrated-local-web-app)定义预检、归档位置和收集限制。

确认主机中出现**轨迹**页面并已有索引记录。确认插件中的**网络范围**和**侦察**已启用，且**研究运行环境**选择器区分**主机管理**与**隔离 Linux**。设置不完整时打开网络范围，而不是退回主机研究。普通聊天可用并不能验证课程配置是否完整。

<a id="start-protected-and-configure-openrouter"></a>
## 启动隔离研究环境并配置 OpenRouter

打开**插件 → 网络范围 → 配置**。构建 ARM 运行环境，再配置获授权的练习策略。在提供实际实验目标前，保留保留域名示例。对于 OpenRouter，在现有基础设施 JSON 中添加以下条目，不要删除其他必要条目：

```json
{
  "openrouter.ai": {
    "methods": ["GET", "POST"],
    "paths": ["/api/v1/models", "/api/v1/chat/completions"]
  }
}
```

应用前，按照[操作审核说明](../../../course/scope-runtime/README.zh.md#action-review)在**操作审核配置（JSON）**中明确配置审核模型及凭据引用。在可信主机上配置其引用的凭据。审核密钥仅进入网关，不进入研究容器。审核模型为空、缺少凭据或本地收集不可用时，研究无法启动。[审核迁移指南](../../upgrade-guide/v0.2.1-alpha.3/course-action-review/guide.zh.md)说明已有安装的迁移步骤。

保存待应用配置并应用。运行中的环境需要选择**停止并应用**。应用会将已启用的本机 bundle、研究模型设置及其引用的产品存储 API 密钥导入独立的隔离主目录。后续应用会刷新继承值，同时保留明确修改的隔离模型设置和无关凭据。仅存在于环境变量中的研究密钥及账号登录需要单独配置；可选主机密钥转发仅覆盖 `OPENAI_API_KEY`。等待状态显示 **running**、网关强制执行正常、操作审核与收集就绪，且保存与应用版本一致。选择**研究运行环境 → 隔离 Linux**，在**设置 → 模型**中验证提供商和模型；若凭据未导入，则在该页面输入隔离研究环境的凭据。

在隔离工作区选择器中添加并选择 `/workspace`。这是命名 Docker 卷，不是 Mac 目录。切换运行环境不会迁移主机工作区或会话。本地收集是必需的：本机控制器将经过认证且有界的隔离会话记录分页拉取到收集器，并使用独立安装身份。隔离研究环境获得查看器，但不会获得本机 cookie 或收集器写入凭据。不复制附件二进制内容；按照收集器参考检查归档错误及收集/投影进度。本指南不安装远程导出器或学生上传器。

<a id="verify-and-recover"></a>
## 验证与恢复

参见[运行环境验证](../../../course/scope-runtime/README.zh.md#verify-the-boundary)、[本机收集器检查](../../../course/trajectory-collector/README.zh.md#verification)和[安装证据](../../postmortem/0005-course-macos-setup.zh.md#verification-evidence)。受保护提供商回归测试从仓库根目录运行：

```sh
node --test course/scope-runtime/tests/model-profile.test.mjs
```

分别在两个运行环境发送简短且不使用工具的测试提示，以独立于无密钥回放验证在线模型访问。实际评估前验证真正的范围控制。安装报告区分这些检查及其结果。

若镜像构建失败，查看 `$DSH_HOME/course-runtime/build.log`，修复依赖或配置错误，再选择**构建 ARM 运行环境**。保留命名主目录和工作区卷。若模型请求失败，同时检查所选运行环境的凭据及策略对提供商端点的授权。不要为绕过 Python 测试 CA 问题而关闭 TLS 验证。

## 开发说明

无。
