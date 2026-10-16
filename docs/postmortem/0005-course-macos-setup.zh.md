# 事故复盘 0005：普通聊天通过，但课程配置尚未完成

[English](0005-course-macos-setup.md) | 中文

状态：首次 2026-10-15 部署的历史记录。[PR #10](https://github.com/5stars217/deepseek-harness/pull/10) 随后增加受保护功能导入及轨迹收集；所链接配置指南描述当前行为。首次验证时 Python 3.14 测试 CA 问题尚未解决。

## 执行摘要

2026-10-15 的 Apple Silicon 安装最初构建了此分支并通过在线 OpenRouter 请求，但启动的是普通 Web 配置档，缺少轨迹、自定义范围与侦察配置，以及已部署的受保护工作区。完成课程部署时，还发现 Docker CLI 插件缺失，以及启动覆盖层将受保护配置档的模型提供商替换为 OpenAI。覆盖层已修正，并新增组合回归测试。配置验收现在包含所需 GUI 功能和在线受保护请求，而非仅确认聊天成功。

## 概要

本报告记录安装修改及其证据，以便准备配置相关拉取请求。[可复用配置指南](../user/guide/course-macos.zh.md)是当前用户操作路径；[运行环境](../../course/scope-runtime/README.zh.md)和[收集器](../../course/trajectory-collector/README.zh.md)参考定义其详细行为。拟议 PR 中不得包含 API 密钥、浏览器登录令牌、私有证书、原始会话记录或收集器数据库。

## 观察到的环境

| 组件 | 观察值或操作 |
|---|---|
| 主机 | Apple Silicon，macOS 15.7.3。 |
| 源代码 | 私有课程分支，版本 `0.2.1-alpha.3`；使用源代码检出，而非仅安装 npm 包。 |
| Git / GitHub CLI | 已具备 Git 2.52.0 和 gh 2.86.0；现有 gh 身份能够读取私有仓库。 |
| Node / 编译器 | 已具备 Node.js 25.4.0 和 Xcode Command Line Tools；Apple clang 17.0.0。 |
| pnpm | 现有 pnpm 11.25.0 完成本机冻结安装；后续本机构建命令使用工作区的 pnpm 11.28.5。Linux 镜像使用 11.28.5。 |
| Python | 系统 Python 3.14.6；选择现有 uv 管理的 Python 3.11.15 运行本机课程控制器及通过的网关测试。 |
| Docker / Colima | 已具备 Docker 29.6.1 和 Colima 0.10.3。保留原有无关 VM 配置档。 |
| 新安装依赖 | Homebrew `docker-buildx` 0.38.0 和 `docker-compose` 5.6.0，均注册到用户 Docker CLI 插件目录。 |
| 课程 VM | 新建 `dsh-course` ARM 配置档：VZ、4 CPU、8 GiB 内存、60 GiB 磁盘、Docker 运行时，不切换当前上下文。 |

## 时间线与故障

| 观察 | 已确认原因 | 操作与结果 |
|---|---|---|
| 匿名获取仓库返回 404。 | 请求的分支仓库是私有的。 | 使用现有已认证 gh CLI 读取并克隆；无需修改账号或仓库权限。 |
| 首次源代码安装打印依赖重试和缺少已构建 CLI 链接的警告。 | 源代码产物尚不存在；下载随后重试成功。 | 保留冻结锁文件并运行完整构建。未修改依赖版本或锁文件条目。 |
| 本机 headless OpenRouter 请求成功，但缺少所需课程功能。 | 清单只包含 base + Web；普通启动器未挂载轨迹覆盖层，且尚未部署课程 VM。 | 增加范围与侦察 bundle 选择，将 Web 启动器切换到收集器预检，并创建独立运行环境。 |
| 通过嵌入式浏览器添加工作区时未出现可用的原生选择器。 | 原生交互不适合此嵌入式浏览器配置；未单独诊断其底层故障。 | 在此 Web 配置档中保存已有文档中的页内选择器组合。未修改原生选择器源代码。 |
| 从根目录调用 Python 测试时，缺少 `control`、`manage` 等模块。 | 这些标准库测试相对 `course/scope-runtime` 导入模块。 | 在该目录运行测试。另一个新增 Node 测试也从正确的仓库根目录重新运行。这些是调用修正，不是产品修复。 |
| Python 3.14 网关测试报错 `CA cert does not include key usage extension`。 | 生成的测试 CA 不满足该解释器更严格的验证要求。 | Python 3.11 通过全部 32 个网关单元测试。未修改 CA 生成代码或 TLS 验证标志。 |
| 首次研究镜像构建因架构为空而失败。 | Docker 旧构建路径未填充自动 `TARGETARCH`，且缺少 Buildx。 | 安装并注册 Buildx，再通过本机控制器重建。安装器收到 `arm64` 并验证固定版本侦察归档。 |
| 首次容器验证无法运行 `docker compose -p ...`。 | 缺少独立 Compose CLI 插件。 | 安装并注册 Compose，再成功运行两个隔离容器检查。仅删除失败运行的临时配置卷和失败构建容器。 |
| 受保护配置会将所选 OpenRouter 提供商替换为 OpenAI。 | `Manager.configuration()` 在后续输出只包含 OpenAI 的 `llm-pi-ai` 行；CLI 覆盖层优先于配置档。 | 在已构建 CLI 的组合配置中复现提供商丢失，删除该行，并通过新增回归测试。 |
| 直接访问 localhost URL 最初收到需要认证的响应。 | 新浏览器尚未使用进程启动令牌换取 cookie。 | 使用当前服务器打印的新私有登录 URL。保留认证，而非关闭认证。 |

## 根因与产品修复

初始验收条件只测试通用源代码构建和一次模型请求，没有检查课程专用配置档、侧栏、插件开关、运行环境选择器或隔离工作区。此分支有意让收集和受保护研究保持可选，因此默认启动成功并不能说明这些功能已配置。

独立的提供商缺陷来自配置优先级。生成的受保护覆盖层在研究配置档之后包含以下行：

```json
{"id":"llm-pi-ai","config":{"providers":{"openai":{"apiKeyEnv":"OPENAI_API_KEY"}}}}
```

本地修复从 `course/scope-runtime/manage.py` 删除此行。PR #10 随后将无条件覆盖替换为条件回退，仅在明确转发 OpenAI 主机密钥且未提供本机模型补丁时使用，并增加所选模型及凭据导入。配置 PR 保留该新版实现。网关仍执行目标策略。可配置提供商编辑器的覆盖冲突检查说明了为何编辑被覆盖的提供商也会被拒绝；回归测试直接验证组合配置，而非交互式模型保存。

新增[模型配置档测试](../../course/scope-runtime/tests/model-profile.test.mjs)在模拟 Docker 调用的情况下生成真实管理覆盖层，将其与私有 OpenRouter Web 配置档组合，再运行已构建的 `dsh web --dump-config`。删除前测试失败，删除后通过。它不请求模型，也不使用真实凭据或 Docker 守护进程。

## 完整修改清单

| 位置 | 安装期间的修改 | PR 处理方式 |
|---|---|---|
| `course/scope-runtime/manage.py` | 安装期间删除强制 OpenAI 提供商行。 | 历史本地修复；PR #10 已提供新版条件回退和功能导入。此配置 PR 不修改管理器。 |
| `course/scope-runtime/tests/model-profile.test.mjs` | 新增上述生成覆盖层与已构建 CLI 的回归测试。 | 为保留的行为提供回归覆盖。 |
| 运行环境 README 双语文件及配对记录 | 说明受保护模型提供商的配置归属及所需端点授权。 | PR #10 定义更新后的导入行为；此配置 PR 将机器特定状态路径替换为 `$DSH_HOME/course-runtime`。 |
| `~/.dsh/profiles/web/package.json` | 保留 base/Web 并增加网络范围和侦察 bundle；先备份原清单。 | 记录选择项，不提交操作员的整个主目录配置档。 |
| 本机 Web 配置档补丁 | 通过 `OPENROUTER_API_KEY` 配置 OpenRouter，选择 `deepseek/deepseek-v4.1-flash`，关闭 DeepSeek 会话日志上传，选择页内选择器，并设置教师端运行环境的源代码、状态及 Python 路径。 | 可复用示例属于指南；私有绝对路径和欢迎通知确认保留在本机。 |
| 本机 headless 配置档补丁 | 配置相同提供商和模型，并为 CLI 检查关闭 DeepSeek 会话日志上传。 | 仅属本地配置；headless 与 Web 仍是独立配置档。 |
| `~/.dsh/.env` | 仅保存此次配置提供的 OpenRouter 凭据，文件权限 0600，所属主目录权限 0700。 | 不包含文件、值、密钥服务响应或登录令牌。此操作员预置密钥未使用 GUI 托管凭据存储。 |
| Web 启动环境 | 设置 `DSH_HOME`、`DSH_COURSE_SOURCE` 和 `DSH_TELEMETRY_DISABLED=1`，使用 umask 077。 | 记录可重现启动说明；未修改全局 shell 启动文件。 |
| 收集器环境 | 在 `~/.local/share/dsh-course-observation` 下的独立仅所有者可访问目录设置收集和投影数据库路径，并设置本地安装、学生、批次标签。 | 记录路径和标签含义。数据库、原始记录及本地身份展开值保持私有。 |
| Web 进程 | 正常地用 `course/trajectory-collector/native.mjs` 替换普通启动器，保留原有配置档、会话、工作区和 3080 端口回环绑定。 | 源代码预检和覆盖层已存在，无需修改收集器实现。 |
| Docker CLI 插件目录 | 增加 Buildx 和 Compose 符号链接，指向 Homebrew 安装的可执行文件。 | 记录发现方式及插件缺失故障，不提交用户 Docker 配置或仓库凭据。 |
| Colima | 创建独立 `dsh-course` VM，只挂载空只读主机目录，并使用 `--activate=false`。 | 记录前置条件和已有创建命令。当前 Docker 上下文保持 `colima`。 |
| 课程镜像 | 构建 `dsh-course-gateway:local` 和 `dsh-course-research:local`；验证固定校验和的 Subfinder 2.17.0、URLfinder 0.0.3、DNSx 1.3.1、HTTPx 1.12.0、Naabu 2.6.1 和 Katana 1.8.0。 | 镜像和构建缓存保留本机；版本由已有清单管理。 |
| 本机课程草稿与应用版本 | 仅新增 `openrouter.ai` 在 `/api/v1/models` 和 `/api/v1/chat/completions` 上的 GET/POST 基础设施访问；保存并应用版本 1。保留示例目标域名。 | 包含脱敏授权示例；未增加真实评估目标。 |
| 受保护主目录卷 | 通过操作员控制的禁网容器，预置独立 OpenRouter Web/headless 配置和权限 0600 的密钥文件。只复制提供的提供商密钥，不复制 Mac 主目录或其环境。 | 属于操作员自动化；普通指南通过两个运行环境各自的设置 → 模型完成。不提交或分发预置主目录卷。 |
| 受保护工作区与 UI | 启动网关和研究服务，添加并选择 `/workspace`，确认受保护访问模式以及已启用的范围和侦察控制。 | 说明这是命名 Linux 卷，而非挂载的 Mac 工作区。 |
| 共享创作工作区 | 将源代码安装到 `$VAULT/Agents/Tools/deepseek-harness`；创建规范 `$VAULT/Agents/Tools/dsh.sh` 和 `~/.local/bin/dsh` 符号链接。恢复 `.claude/{skills,tools}` 和 `.codex/{skills,tools}` 到共享 `Agents/` 目录的链接。 | 属于此仓库之外的知识库集成，不移入上游补丁。 |
| 共享知识库记录 | 更新 `AGENTS-TOOLS.md`，为源代码和构建目录增加 3,431 个继承颜色的 Iconize 条目，排除依赖和缓存内部目录。 | 属于此仓库之外的知识库记录；未修改课程讲义或实验内容。 |
| 私有诊断 | 本地服务器和构建日志、配置备份、PID 记录及配置截图保存在检出之外。 | 日志可能包含启动凭据；PR 仅使用脱敏摘要。 |

<a id="verification-evidence"></a>
## 验证证据

以下结果在此次安装中实际观察到，不代表生产学生注册或远程遥测部署。除明确切换目录外，以下命令从仓库根目录运行。

| 检查 | 观察结果 |
|---|---|
| `node node_modules/pnpm/bin/pnpm.cjs run build` | 9 个检查通过，包括原生产物、主机和客户端编译及聚合检查，以及 Web 构建。 |
| `pnpm exec vitest run packages/guard/scope-judge/tests packages/experimental/course-runtime/tests packages/experimental/recon-projectdiscovery/tests` | 12 个文件、260 个测试通过。 |
| 在 `course/scope-runtime` 使用 Python 3.11 运行网关标准库测试 | 32 个测试通过；Python 3.14 CA 故障已在上文记录，不计为通过。 |
| `node --test course/trajectory-collector/tests/native-profile.test.mjs` | 4 个测试通过，包括源记录保留、认证检查、重启后回放和启动器预检拒绝。 |
| `node --test course/scope-runtime/tests/model-profile.test.mjs` | 对强制提供商覆盖层测试失败，删除后通过。 |
| 可复用指南配置 | 临时无密钥主目录初始化 Web 配置档，组合文档中的 bundle/YAML/选择器示例，并通过实际 Loader 求值源代码/状态/Python 表达式，未启动监听器。 |
| `pnpm run test:docs` | 21 个检查通过。 |
| `pnpm run doc-sync` | 43 个检查通过。 |
| `pnpm run lint` | 通过，只有无关翻译插件中一个预先存在的无用禁用注释警告。 |
| `git diff --check` | 通过。 |
| 本机在线模型请求 | 返回精确无工具控制响应 `DSH_OPENROUTER_OK`，退出码 0。 |
| 受保护在线模型请求 | 经范围网关返回精确无工具控制响应 `DSH_PROTECTED_OPENROUTER_OK`，退出码 0。 |
| 本地收集器 API 与 GUI | 首次验证收集 31 条记录，投影出 5 个轨迹和 31 个跨度；收集器与投影游标一致，未配置远程导出目标。 |
| 受保护运行环境 API 与 GUI | 运行中、网关健康、保存和应用版本均为 1、两个自定义插件开关已启用，并显示受保护工作区和模型。 |
| 研究容器检查 | UID 1000、删除全部能力、no-new-privileges、只读配置与公开挂载、命名主目录和工作区卷，无 Mac 主目录或 Docker 套接字。 |

网关单元测试调用如下：

```sh
cd course/scope-runtime
PYTHONDONTWRITEBYTECODE=1 python3.11 -m unittest discover -s tests -p 'test_*.py'
cd ../..
```

隔离的已构建镜像及网络检查如下：

```sh
PYTHONDONTWRITEBYTECODE=1 python3.11 course/scope-runtime/verify.py --context colima-dsh-course --prebuilt
PYTHONDONTWRITEBYTECODE=1 python3.11 course/scope-runtime/tests/image_smoke.py --context colima-dsh-course --image dsh-course-research:local --gateway-image dsh-course-gateway:local
```

两者均通过，并删除各自临时项目和卷。网络套件验证允许的对照，以及代理、原始 TCP/UDP、IPv4/IPv6、DNS、重定向、Host 覆盖、Chromium、WebSockets 和 nmap 中禁止的请求、连接和数据报计数均为零。故意破坏测试防火墙规则后，目标计数上升，说明零计数具有实际意义。监督进程丢失后仍保持拒绝，监控故障则使作为 PID 1 的监督进程退出。镜像回放独立验证真实课程组合和已保存的范围外侦察拒绝，无需模型密钥。

## 新增防护与剩余限制

- 配置指南将可见轨迹、已启用范围与侦察、运行环境选择器、健康的受保护启动以及独立在线提供商检查作为验收步骤。
- 组合回归防止本机管理器将研究配置档的模型提供商替换为部署端默认值。
- 首次镜像构建或容器启动前，依赖发现检查分别验证 Docker、Buildx 和 Compose。
- Python 3.14 CA 兼容问题仍需后续处理。此工作既未修复证书扩展，也未削弱验证。
- 首次本机收集器仅读取本机会话。PR #10 随后增加有界且经过认证的受保护会话记录接收，并使用独立安装身份。不复制附件二进制内容，也不启用远程导出、学生 SSO 或学生上传器。
- 目标域名保持 `example.test` 和 `*.lab.test`，目标 IP 授权为空。OpenRouter 基础设施例外用于运行模型，不是评估授权。
- 共享知识库启动包装器、图标、凭据、数据库、VM 状态、生成镜像、日志和截图属于安装产物，不是上游源代码修改。

## 拉取请求范围

配置 PR 面向 PR #10 合并后的代码，新增已构建 CLI 提供商回归测试、当前 macOS 指南、运行状态文档修正、导航链接及此历史安装记录。英中双语文档及其一致性记录一同提交。原有一行修复在此记录，不会重新应用到新版管理器。此配置 PR 不修改依赖固定版本、锁文件、沙箱规则、网关策略引擎、凭据协议、收集器实现或全局默认配置档。当前验证记录在 PR 描述中；上方证据表保留为首次安装记录。
