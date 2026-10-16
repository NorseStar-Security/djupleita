---
description: "在 Linux 域名/IP 范围边界内运行课程浏览器、终端、脚本和 TCP 连接扫描器。配置目标、检查拒绝记录并验证隔离运行时。"
---

# 强制执行范围的 Linux 课程运行时

[English](README.md) | 中文

## 概述

在目标约束和强制操作审核之后保留浏览器、终端、代码和 MCP 能力。课程 UI 默认使用隔离 Linux 研究，而非宿主机工具执行。在专用 Linux 虚拟机中使用 Docker Compose v2 运行。非特权研究容器不能修改网关策略、审核凭据或权威审核账本。它不会修改宿主机防火墙或证书存储。这是课程原型，而非生产安全认证。

本地轨迹收集是课程研究的强制条件。远程复制仍由教师侧可选的[收集器部署](../trajectory-collector/README.zh.md)提供；学生镜像注册和经过认证的接收仍是发布前提，尚非已完成的身份基础设施。

## 目录

- [运行练习](#run-an-exercise)
- [策略参考](#policy-reference)
- [操作审核](#action-review)
- [执行约束与信任](#enforcement-and-trust)
- [验证边界](#verify-the-boundary)
- [限制](#limitations)
- [开发备注](#dev-note)

<a id="run-an-exercise"></a>
## 运行练习

教师在仓库根目录编辑 [scope.json](scope.json)。将保留示例名称替换为已获授权的目标；逐项审慎加入所需依赖。将此检出、Docker 访问权、网关和策略保存在 agent（智能体）可写工作区之外。

研究容器内可通过 `/run/course-public/policy.json` 和模型的 `scope_status` 工具读取不可变的活动策略。请在练习说明中要求检查策略，让 agent 在操作前确认获准目标。

在 Apple Silicon Mac 上创建独立的原生配置档，不切换当前 Docker 上下文：

```sh
mkdir -p /private/tmp/dsh-course-empty-mount
colima start --profile dsh-course --arch aarch64 --vm-type vz --cpus 4 --memory 8 --disk 60 --runtime docker --activate=false --mount /private/tmp/dsh-course-empty-mount:ro
```

在插件中启用**网络范围**和**侦察**。配置页暂存编辑；保存会创建待应用版本，应用会启动该版本。运行中的环境需要选择**停止并应用**。使用课程 bundle 的默认配置时，本机控制器将草稿、不可变快照和操作日志保存在 `$DSH_HOME/course-runtime`，显式使用 `colima-dsh-course`，并使用命名的主目录和工作区卷；研究环境不包含 Mac 工作区或 Docker 套接字。策略通过网关的 Python 实现验证。应用失败会保持研究停止，并保留草稿与数据。

**研究运行环境**选择器区分**主机管理**与**隔离 Linux**。宿主工具默认拒绝；可信部署选项 `allowHostResearch: true` 是教师显式逃生口，而非浏览器偏好。只有保存与应用版本一致，并已观测到网关、审核和收集就绪时，根页面才选择隔离研究。否则打开设置，绝不回退到宿主研究。会话选择独立，切换不迁移会话。应用继承启用的 bundle 和引用的保存模型凭据，同时保留隔离模型覆盖。必须加载本地收集器与投影；隔离查看器使用其现有 UI。本机归档写凭据及审核密钥不进入研究容器。高级选项仅在明确选择后将 `OPENAI_API_KEY` 转发给研究模型；遥测保持关闭。

本机控制器需要此源代码检出、Python 3.11+、Docker 及专用 Colima 上下文。研究进程使用 `127.0.0.1` 网关解析器；若网关配置中没有外部解析器，其上游默认使用 `1.1.1.1`。原生库缓存使用命名主目录卷，系统保持只读，临时挂载保留原有限制。

应用前，在 Network Scope 中配置 [review.json](review.json)、显式审核模型和凭据引用、操作规则及本地收集器。空审核模型刻意不是可运行默认值。保存只暂存设置，不改变活动研究。现有安装须执行[审核迁移](../../docs/upgrade-guide/v0.2.1-alpha.3/course-action-review/guide.zh.md)。

静态 Compose 文件是网络诊断夹具，不能替代本机收集所有者。它可构建镜像并输出组合后的 headless 配置：

```sh
DSH_CLIENT_COMMIT_HASH=$(git rev-parse HEAD) docker compose -f course/scope-runtime/compose.yml build
docker compose -f course/scope-runtime/compose.yml up -d --wait gateway
docker compose -f course/scope-runtime/compose.yml run --rm research node /opt/dsh/apps/cli/lib/bin.js --profile headless --patch /opt/course/profile.patch.yml --dump-config
```

[配置档补丁](profile.patch.yml)挂载[范围提供者](../../packages/experimental/network-scope-linux/README.zh.md)、[范围守卫](../../packages/experimental/network-scope-guard/README.zh.md)、[操作审核提供者](../../packages/experimental/action-review-linux/README.zh.md)、[强制审核守卫](../../packages/experimental/action-review-guard/README.zh.md)及本地 Playwright MCP 浏览器工具。缺失审核服务会拒绝工具分发，也适用于此 headless 配置。容器内文件系统策略为 `danger-full-access`；容器权限和网络边界仍生效。通用上游 headless 配置不会被改写为课程部署。

通过配置完成的隔离运行时进行模型驱动课程练习。研究模型端点需要独立显式的基础设施权限；审核流量来自可信网关，并使用单独配置的端点。不要使用生产凭据或浏览器会话。

镜像还安装固定校验和的 ProjectDiscovery 工具，并挂载[侦察插件](../../packages/experimental/recon-projectdiscovery/README.zh.md)。目录遵循被动优先原则；主动运行需要明确同意及教师目标授权。随附策略和 Network Scope 的重置默认值包含侦察参考所述的有限被动数据源 API 权限。现有已保存策略保留其明确授权；侦察绝不会在发现资产时扩大策略。普通工具事件为轨迹收集器保留清单与拒绝记录。支持的组件、数据源设置及限制以侦察参考为准。

更改范围或重启网关前先停止环境：

```sh
docker compose -f course/scope-runtime/compose.yml down
```

下次启动会读取新的不可变策略快照并生成新的课程 CA。命名工作区/主目录卷保留课程工作和 Session 数据；`down` 不会删除它们。公共 CA 仅导入研究容器。CA 私钥留在仅网关可访问的临时存储中。使用 `docker compose -f course/scope-runtime/compose.yml logs gateway` 查看网关决策。

<a id="policy-reference"></a>
## 策略参考

策略只接受下列字段。无效策略阻止启动。排除优先于授权；精确域名不包含子域。仅网络诊断策略可授权原始 IP/CIDR 流量，但课程应用要求 `operations.requireMediatedHttp: true` 并拒绝原始 IP 授权，否则直接 TLS 可绕过操作检查。域名地址固定仍可使用，无需原始 IP 授权。

在 `domains`、`exclude_domains`、`infrastructure` 和 `domain_addresses` 中使用显式 ASCII/Punycode DNS 名称，通配后缀也不例外。Unicode 策略名称会被拒绝，避免产生映射歧义；Unicode recon 工具输入仍可根据显式 Punycode 授权检查。含 Unicode 名称的现有策略须执行[策略迁移](../../docs/upgrade-guide/v0.2.1-alpha.3/scope-policy-ascii-names/guide.zh.md)。

| 字段 | 含义 |
|---|---|
| `domains` | 精确 DNS 名称和显式仅后代 `*.lab.test` 规则；根域须单独列出。 |
| `ips` | 用于直接连接和扫描的显式 IPv4/IPv6 地址或规范 CIDR。 |
| `exclude_domains` | 精确或通配主机名排除规则。 |
| `exclude_ips` | 地址/CIDR 排除规则，也适用于允许域名解析出的地址。 |
| `domain_addresses` | 可选的精确主机 IP 数组，用于私有实验夹具；固定地址仅授权代理域名请求，不授权原始 IP 访问。 |
| `infrastructure` | 精确主机 → `methods` 和精确 `paths` 数组，用于运行服务，不构成目标授权。 |
| `ports` | 网关可选的 `http` 和 `https` 端口数组；默认分别为 `[80]` 和 `[443]`。 |
| `operations` | 课程应用必需：`requireMediatedHttp`、`deny` 规则，以及包含 `maxRequests`、`windowSeconds`、`maxConcurrent` 的共享 `budget`。 |

目标域名与原始 IP 范围是独立授权。授权 `acme.test` 不会授权 `widgets.test`、`sub.acme.test`，也不会授权扫描 Acme DNS 返回的全部 IP。共享 CDN 地址绝不自动转为内核允许规则。原始 IP/CIDR 授权仅适用于网络诊断策略，不适用于安全课程应用；其他协议需要单独审查的中介边界。排除主机名无法撤销另行授权的原始 IP：原始流量没有可靠的公司身份。

示例通过 `infrastructure` 允许有限的模型及被动数据源 API 操作。它允许请求这些路径，而非任意浏览该主机。它不验证请求体，也不阻止滥用获准 API。仅在审核目标与操作权限后才添加注册源、搜索提供方、认证主机或远程 MCP 服务；它们不会自动豁免。镜像构建在研究边界之外下载依赖，必须使用可信来源且不得携带练习秘密。

操作拒绝规则包含唯一 `id`、`methods`（`["*"]` 表示所有方法）、精确 `paths` 和路径树 `prefixes`。拒绝始终优先，包括基础设施主机；同一主机同时为目标时，基础设施授权仍保持精确。路径解码一次，并在匹配前检查歧义编码、分隔符和点段。默认对所有方法阻止 `/quitquitquit` 及后代。这只是拒绝示例，并非通用管理端点清单。共享预算跨目标主机和 HTTP/TLS 连接生效；速率拒绝不排队重试。WebSocket 升级消耗准入，但不逐帧检查或计数。

<a id="action-review"></a>
## 操作审核

每次 ToolRuntime 分发，包括 PTC 外层和嵌套调用、原生工具、浏览器/MCP 工具及子 agent 调用，都经过独立的[操作审核服务](../../packages/experimental/action-review/README.zh.md)。请求绑定精确序列化输入、Session/调用标识、工具 schema、网络策略和审核配置哈希。无 agent 或未知 schema 调用、部署变化、服务不可用、审核取消、无效结果及存储失败均不能放行。通用权限预设不能覆盖守卫，模型批准也不能覆盖确定性范围或操作拒绝。卸载强制审核守卫/提供者会关闭准入，直到进程重启。

教师在 [review.json](review.json) 中配置 `rulesOfEngagement`、风险 `rubrics` 和一个或多个强制 `evaluators`。`destructive` 与 `insufficient_context` 为必需维度；可增加 `reckless`、隐私等维度而无需修改 agent loop。风险达到或超过 `maxProbability` 即拒绝。`llm` 提供者使用 OpenAI 兼容 HTTPS chat 端点，要求严格 JSON 风险分数。`jev` 使用 TypeSafe [System One API](https://docs.typesafe.ai/introduction/quickstart)、类型化 `noul` 问题及教师显式选择的模型。提供者不拥有最终权限。所有配置的评估器必须成功完成；没有宽松回退或一键批准绕过。

可信网关模块通过 `register(registry)` 和 `registry.add(kind, evaluator)` 扩展注册表；`plugins` 指定安装在教师控制镜像中的模块。评估器收到不可变策略、脱敏调用及维度，返回 `(actualModel, risks)`。可选评估器 `options` 保存插件自有 JSON 设置。凭据仅在本机解析显式 `credentialRef`，并写入仅网关可见卷。配置密钥或凭据字段被脱敏时会拒绝上下文，而非截断后放行。其他秘密无法可靠检测：向远程评估器发送参数需要合适的课程数据策略。

网关调用评估器前提交拒绝/待定收据，确认准入前提交最终决策，保存于 `review-audit:/var/lib/course-review/decisions.sqlite3`。崩溃留下的待定审核绝不授权。受限账本保留输入哈希、脱敏操作、策略/模型版本、分数及结果，不保存隐藏模型推理。SQLite 提交失败或容量耗尽会关闭审核；教师须审慎归档/轮换网关卷，而非在研究期间删除。原生收集器接收 Session 决策/结果记录，供轨迹查看器及可选远程导出；允许收据表示准入，不证明执行或目标效果成功。

原生收集器仅在持久接收后续租网关私有租约。首次续租前不放行。`archiveLeaseSeconds` 限制本机消失后新准入的存活时间；`startupGraceSeconds` 允许工作进程启动健康检查，但绝不授权工具。接收失败会停止研究，评估期间租约过期则拒绝。完整轨迹来自工作进程，不是防篡改证明；权威准入收据在其外部。HTTPS 评估器回复及输入受配置字节/截止时间限制，无重定向或自动重试。此基线未实现人工例外批准和身份注册。

<a id="enforcement-and-trust"></a>
## 执行约束与信任

网关拥有一个与研究容器共享的私有网络命名空间。其 nftables OUTPUT 规则过滤研究 UID 1000 拥有的套接字，不受工具名称、编程语言、代理环境或子进程层级影响。研究容器丢弃所有 Linux capability，包括 bounding set，并设置 `no-new-privileges`。它没有 Docker socket、宿主机网络、发布端口或宿主机工作区挂载。私有命名空间回环仍可用于本地浏览器控制和网关服务；它并非宿主机回环。

HTTP(S) 流量使用范围网关。HTTPS CONNECT 在临时课程 CA 处终止，而非打开不透明隧道。网关比较请求 URL、Host 头与 CONNECT authority，验证全部 DNS 答案，并连接固定地址，同时验证上游 TLS 主机名。重定向、frame、脚本、service worker、弹窗和 WebSocket 使用同一网络边界；浏览器路由钩子不是执行约束机制。忽略代理的程序仍受内核 IP 规则约束。IPv4 与 IPv6 均被覆盖。DNS 请求使用范围解析器；研究进程无法使用 Docker 内置 DNS 捷径。

网关网络日志包含决策时间、策略哈希、传输、主机名/IP 和适用端口/方法/原因，不含路径、查询、凭据或载荷。独立审核账本包含脱敏操作，需要更严格保留。NFLOG 监控内核拒绝。监控失败终止网关；研究仍持有命名空间时内核规则保留。HTTP 拒绝通常返回 `403`；已上传的超大 TLS 请求体可能导致拒绝响应不完整或缺失。直接拒绝表现为套接字错误/超时。环境决策仍为 `plugin:network-scope-guard/network` Session 记录，与分发前操作收据不同。

[服务定义](../../packages/experimental/network-scope/README.zh.md)、Linux 提供者和裁判/审计消费者均为 Cordis 插件；无需修改 agent loop。提供者通过只读卷读取 root 拥有的 `/run/course-public/control.sock`。该接口暴露不可变策略、实时健康状态、结构化目标决策和 1024 条事件的带序号审计环，不提供策略修改或防火墙控制。裁判检查每次分发，并在执行前拒绝映射的范围外 HTTP 目标。未映射能力仍在网络约束之后开放。审计游标丢失或身份变化会停止分发，直到教师调查并重新加载；临时传输故障可以在成功检查后恢复。

可信计算基包括 Linux 内核、Docker daemon、网关进程及其依赖、教师策略、解析器和 CA。使用课程专用虚拟机。不要授予研究者 root、Docker 访问、额外 capability、宿主机 socket、其他网络接口或外部执行器：这些都会改变边界。[设计依据](../../.agents/notes/implemented/architecture/2026-10-14-course-network-scope.zh.md)记录相关取舍。

<a id="verify-the-boundary"></a>
## 验证边界

使用 Python 3.11+ 和 OpenSSL 运行标准库单元测试，再使用运行中的 Docker engine 执行 Linux 集成套件：

```sh
cd course/scope-runtime
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p 'test_*.py' -v
cd ../..
python3 course/scope-runtime/verify.py
```

套件创建唯一的临时 Compose 项目。受控 `acme.test` 和 `widgets.test` 端点代表不同公司；不会连接真实 Acme 或 Widgets 端点。允许的对照必须成功，而范围外域名、被排除的 IPv4/IPv6 和代理绕过尝试必须使禁止端点的 HTTP 请求数、已接受 TCP 连接数及已接收 UDP 数据报数保持为零。Chromium 启用 service worker，且不拦截请求。套件还检查只读策略决策与审计序号连续性、内核/代理记录、故意引入的仅测试防火墙回归，以及监督进程丢失后保留的内核过滤。清理仅删除该测试项目的容器、网络和临时卷；构建镜像仍保留在缓存中。

[Loader 集成测试](../../packages/experimental/network-scope-guard/tests/loader.spec.ts)验证真实提供者/消费者组合及其卸载行为。[无密钥 CLI Session](../../snapshots/session/network-scope/session.v4.jsonl)针对确定性策略提供者录制 `scope_status`、允许的终端对照及分发前 `widgets.test` 抓取拒绝。构建验证和在线模型练习独立于夹具回放。

原生 ARM 配置可运行 `python3 course/scope-runtime/verify.py --context colima-dsh-course --prebuilt` 和 `python3 course/scope-runtime/tests/image_smoke.py --context colima-dsh-course --image dsh-course-research:local --gateway-image dsh-course-gateway:local`。它们使用一次性命名配置卷，不绑定挂载 Mac 目录。

要单独检查构建后的镜像，运行 [image_smoke.py](tests/image_smoke.py)，并通过 `--image` 和 `--gateway-image` 指定已构建的 harness 与网关镜像。它创建一次性离线命名空间，在真实课程插件中使用确定性模型回放，检查组合后的配置档，以及持久化的 `widgets.test` recon 拒绝和已完成轮次。它不需要模型凭据，仅删除自己的项目和卷。此回放并非在线模型或真实数据源检查。

使用 `python3 course/scope-runtime/tests/browser_operations.py --context colima-dsh-course --image dsh-course-research:local` 执行真实浏览器操作检查。一次性、只读、离线容器使用镜像中的 Chromium 和网关，并信任夹具 CA，而不是绕过 TLS 验证。普通 GET/POST 请求必须成功；覆盖 13 种关闭路径变体的 52 个 HTTP/HTTPS 请求必须保持上游 TCP 和 HTTP 计数不变。仅移除夹具的关闭规则后，对照请求必须能够到达上游。只拦截自动 favicon 请求，不改写被测操作。清理仅删除该次运行的容器。

<a id="limitations"></a>
## 限制

- 原始/SYN 扫描和抓包需要此拓扑有意不授予的权限。请使用 TCP 连接扫描（`nmap -sT`）；不要添加 `NET_RAW` 来绕过限制。特权扫描器需要单独审核的路由式虚拟机边界。
- 仅域名范围支持经中介的 HTTP(S)/WebSocket，而非所有不透明协议。证书固定客户端、HTTP/3/QUIC、任意协议 CONNECT 隧道及不支持的 HTTP 分帧可能以拒绝方式失败。原始 IP 授权与安全课程应用不兼容；其他协议需要单独审查的中介边界。网关请求的 I/O 超时为 30 秒，请求体上限为 8 MiB，并发连接上限为 32；长时间空闲 WebSocket 和大文件上传可能失败。
- LLM/JEV 风险评分可能出错，不证明安全或公司归属。方法/路径规则不理解应用特有的请求体/查询/头部覆盖、WebSocket 帧命令、所有路由器规范化、服务端 SSRF 或后续跳转。速率限制约束网关准入，而非全部目标端效果。远程执行器需要自己的等效约束。
- 此运行时不提供针对恶意容器逃逸的保证、入站网络隔离策略或逐 Session 归因。所有课程进程共享同一策略和工作区。TLS 检查向可信网关暴露明文；请妥善保留日志并仅使用实验凭据。

<a id="dev-note"></a>
## 开发备注

无。
