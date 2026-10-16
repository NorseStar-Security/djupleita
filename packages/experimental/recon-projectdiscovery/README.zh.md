---
description: "在教师强制执行的域名与 IP 范围内运行 ProjectDiscovery 侦察工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-recon-projectdiscovery

[English](README.md) | 中文

## 概述

发现子域名与历史 URL，然后明确选择获准目标进行 DNS 解析、HTTP 探测、TCP 端口扫描或爬取。插件使用 ProjectDiscovery 可执行文件，并非重新实现 Neo。所有发现仅为观察结果；进程成功绝不扩大范围。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用此包

使用专用 [Linux 课程运行时](../../../course/scope-runtime/README.zh.md)。镜像从 [recon-versions.json](../../../course/scope-runtime/recon-versions.json) 安装固定校验和的发布版本，配置档挂载此提供方及工具消费方。其他显式组合可使用：

```yaml
- name: '@deepseek-ai/dsh-experimental-recon-projectdiscovery'
  config:
    proxy: http://127.0.0.1:3128
    resolver: 127.0.0.1
- name: '@deepseek-ai/dsh-experimental-recon-tools'
```

先挂载 `networkScope`、本地 `subprocess` 提供方、`tools` 和 `sandboxPolicy`。所有研究进程须以 UID 1000 在网关命名空间中运行且不持有 capabilities。远程子进程提供方会被拒绝；此插件无法证明内核与 UID 部署正确。比 `danger-full-access` 更窄的文件策略需要完整强制执行的沙箱提供方，且绝不会被扩大。

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-recon-projectdiscovery)是全部字段和默认值的真源。教师可控制可执行文件路径、被动数据源、代理/解析器、端口、速率、worker、爬取深度、截止时间及字节/记录限制。每个提供方同一时间只能运行一个操作。CLI 自动更新检查已禁用。

默认被动数据源为 Subfinder 的 `crtsh` 与 URLfinder 的 `waybackarchive`。随附课程策略和 Network Scope 的重置默认值为固定版本授予网关 `infrastructure` 访问：对 `crt.sh` 的 `/` 执行 HTTPS GET，以及对 `web.archive.org` 的 `/cdx/search/cdx` 执行 HTTP GET。现有已保存策略须先包含这些授权，才能执行被动发现。Subfinder 先尝试 PostgreSQL，再回退到 HTTPS；须继续拒绝直接访问端口 5432。数据源 API 属于运行例外，绝非研究目标。发现过程绝不会添加数据源 API 权限；其他数据源需要明确授权。

默认的 crt.sh 和 Wayback 数据源无需 API 密钥。此适配器尚未提供需要凭据的数据源的密钥输入流程：每次操作使用独立 HOME 和空的 `providers.yaml`，因此不会继承宿主机常规的 Subfinder/URLfinder 提供方文件。选择其他数据源不会配置其凭据，也不会授予网络访问权限。**Settings → Models** 配置模型凭据，不配置侦察数据源凭据。

空输出并不证明没有资产。固定版本的被动工具遇到 API 错误后，可能以零退出码返回空 stdout 和 stderr；`diagnosticsPresent: false` 并不证明数据源健康。结果带有 `coverage: best-effort`。不会转发提供方 stderr，因为其中可能含凭据或响应内容。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

[Neo Recon Agent 描述](https://docs.neo.projectdiscovery.io/platform/agents/discovery/recon-agent)启发了被动优先发现与结构化清单。[Subfinder](https://github.com/projectdiscovery/subfinder) 和 [URLfinder](https://github.com/projectdiscovery/urlfinder)提供被动发现。显式主动操作使用 [DNSx](https://github.com/projectdiscovery/dnsx)、[HTTPx](https://github.com/projectdiscovery/httpx)、[Naabu](https://github.com/projectdiscovery/naabu) 和 [Katana](https://github.com/projectdiscovery/katana)；这些主动扩展与 Neo 文档中的被动工作流不同。

[适配器](src/components.ts)在不使用 shell 的情况下构建固定 argv。目标不能提供参数、文件名、任意查询或命令。Naabu 使用 TCP CONNECT，输入须为单个 IP，并有独立的 IP/CIDR 授权。Katana 使用精确主机爬取范围、禁用重定向，且不启用 headless 模式、自动表单填写或凭据验证。网关仍控制重定向、嵌入流量与 DNS；工具参数不是防火墙。

[策略验证](src/scope.ts)接受仅域名或仅 IP 的策略；未提供的授权类别不允许任何目标。CIDR 必须使用不含主机位的网络地址。格式错误的 CIDR 和 IPv4 映射 IPv6 授权会以拒绝方式失败，与网关一致。

教师须在 `domains`、`exclude_domains`、`infrastructure` 和 `domain_addresses` 中使用显式 ASCII/Punycode DNS 名称。工具输入仍支持 Unicode，并根据对应的 Punycode 授权检查。见[策略迁移指南](../../../docs/upgrade-guide/v0.2.1-alpha.3/scope-policy-ascii-names/guide.zh.md)；此要求避免提供方与网关之间的 Unicode 映射歧义。

[执行器](src/index.ts)在解析可执行文件前检查目标授权与排除项，在执行后验证网关健康状态和身份，使用私有临时 HOME/配置/缓存，并在取消或卸载时等待托管子进程范围完全停稳。子进程提供方清除环境中凭据类变量。此适配器不添加任何凭据。JSONL 格式错误、进程失败、流字节丢失、记录超限或完整序列化结果过大都会明确失败，不返回部分清单。规范化仅保留所选资产/状态/标题/技术字段，不保留原始响应正文。终止后删除临时文件。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Linux 课程运行时](../../../course/scope-runtime/README.zh.md) — 强制执行与部署。
- [工具子系统](../../../docs/subsystems/tools.zh.md) — 执行与事件。
- [测试策略](../../../docs/testing.zh.md) — 组合与回放证据。

<a id="model-experience"></a>
## 模型体验

间接影响，通过渲染提供方清单和失败的 recon-tools 消费方。

#### KV Cache 影响

不直接更改提示词或 schema。消费方追加受限结果；安装二进制文件或更改提供方预算本身不会替换模型前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **并非完整复现 Neo**——未实现专有 PDCP 丰富化和泄露凭据查询。Uncover、ASNmap、云资产清单、TLS 丰富化及 Nuclei 漏洞测试需要单独审查的适配器；发现的网络不得变为授权。
- **尽力覆盖**——上游 API 可能限速、静默失败或返回过时数据。插件没有完整性证明或持久化资产图；诊断只表明 stderr 是否存在，并非脱敏的上游错误报告。
- **部署证据**——测试夹具不能证明防火墙强制执行或完整课程镜像可用。课程运行时参考负责说明这些验证限制。

<a id="dev-note"></a>
### 开发备注

在仓库根目录运行独立 CLI 检查，可在无特权且禁用外部网络的容器中，通过回环测试夹具验证固定参数和主动操作的 JSONL，以及被动数据源路由、JSONL、上游错误和取消。这些检查不连接真实被动 API，也不证明网关生效。完整镜像和网络限制的验证由[运行时参考](../../../course/scope-runtime/README.zh.md#verify-the-boundary)说明。

```sh
docker build --target recon-tools -t dsh-course-recon-tools -f course/scope-runtime/Dockerfile.research .
node --import tsx/esm course/scope-runtime/tests/recon_cli_cases.mjs | docker run --rm -i --network none --cap-drop ALL --user 1000:1000 -v "$PWD/course/scope-runtime/tests:/checks:ro" --entrypoint python3 dsh-course-recon-tools /checks/recon_cli_smoke.py
node --import tsx/esm course/scope-runtime/tests/passive_cli_smoke.mjs
```
