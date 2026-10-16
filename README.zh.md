# DeepSeek Harness

[English](README.md) | 中文

DeepSeek Harness（`dsh`）是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness（智能体框架）。

它构建于**一切皆插件**的架构之上，由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512)。

文档：[https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## 开发者预览

DeepSeek Harness 处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

运行本项目前，请阅读[安全说明](SAFETY.zh.md)。

## 本分支的安全研究功能

本分支增加了受范围限制的红队研究、侦察、可选的安全回调和轨迹查看功能。**Network Scope**（网络范围）与 **Reconnaissance**（侦察）是 **Plugins → Configure** 中的第一方条目，仍处于实验阶段。上方的上游文档介绍基础框架；下方指南介绍本分支的扩展。

### Local 与 Protected 工作区

工作区浏览器上方的 **Research runtime** 选择器会重新连接整个客户端，包括会话、插件、终端、文件和数据流。

| | Local | Protected |
|---|---|---|
| 执行位置 | Mac 原生后端及其文件系统 | 专用 ARM `dsh-course` Colima 虚拟机中的独立 Linux 后端 |
| 网络限制 | 课程网关不限制 Mac 进程 | 网关与 Linux 防火墙执行域名/IP 策略 |
| 文件与会话 | 原生后端的存储 | 命名的 home/workspace 卷；不挂载 Mac 工作区或 Docker socket |
| 模型配置 | Local 的 **Settings → Models** | 应用时导入 Local 已保存的模型路由及 API 密钥；可在 Protected 的 **Settings → Models** 中覆盖 |

切换会重新连接同一个浏览器标签页，分别保留会话选择和浏览器状态，后台任务继续运行。会话与文件不会迁移。Protected 后端不可用时显示恢复控件，不会悄悄改用 Local 执行任务。无论选择哪一端，Scope 和 Recon 管理始终位于原生宿主机。

一个受保护环境中的所有会话共享一份策略。研究进程以 UID 1000 运行，移除 capabilities，系统与配置挂载为只读。部署方式、执行机制与限制见[运行时指南](course/scope-runtime/README.zh.md)。

### 红队插件

| 功能 | 用途与配置 |
|---|---|
| Network Scope | 授权目标域名/IP、排除项与有限的基础设施请求；查看已应用策略和网关状态。打开 **Plugins → Network Scope → Configure**；[策略参考](course/scope-runtime/README.zh.md#policy-reference)。 |
| Reconnaissance | 通过 Subfinder/URLfinder 被动发现；显式执行 DNSx、HTTPx、Naabu 与 Katana 操作。打开 **Plugins → Reconnaissance → Configure**；[数据源与执行限制](packages/experimental/recon-projectdiscovery/README.zh.md)。 |
| Scope judge | 在显式组合的 profile 中，执行前检查经审核的工具参数。这是[仅检查参数的防护](packages/guard/scope-judge/README.zh.md)；任意浏览器/终端流量需要 Protected 的网络限制。 |
| 安全回调 | 分配会过期的 HTTP(S) 回调 URL、读取有界证据并撤销 URL。显式启用 profile overlay，配合已认证的 ngrok agent 或自定义隧道；[回调配置](packages/experimental/security-callbacks-ngrok/README.zh.md)。默认 profile 不发布公网端点。 |
| 轨迹 | 查看采集的会话和 trace；可选导出已批准的记录。参见[原生采集器配置](course/trajectory-collector/README.zh.md)。配置本机采集后，本机控制器还会将 Protected 会话记录读取到归档，使用独立的安装标识。 |

回调命中和发现的资产是证据，不是授权。发现操作永远不会扩大范围。默认被动数据源 crt.sh 和 Wayback 无需 API 密钥；随附/重置策略包含其有限网络权限。已保存的策略保留各自显式授权。需要凭据的被动数据源尚无受支持的密钥输入流程；参见 [Recon 认证限制](packages/experimental/recon-projectdiscovery/README.zh.md#use-this-package)。

### 开始受保护的练习

1. 使用本分支的源码 checkout。按照 [Mac 运行时配置](course/scope-runtime/README.zh.md#run-an-exercise) 创建独立 Colima profile 并构建 ARM 镜像；该流程显式指定课程 Docker context。
2. 在 Plugins 中启用 **Network Scope** 和 **Reconnaissance**。配置已授权目标、排除项、基础设施权限和侦察预算。域名授权不授权直接扫描 IP；需单独授权对应 IP/CIDR。
3. **Save** 保存待应用修订版；**Apply** 激活它。环境运行时需选择 **Stop and apply**，此操作会中断研究进程。应用失败后研究保持停止，会话、卷和已保存草稿保留。离开页面会丢弃未保存的编辑。停用/移除任一 bundle 前必须停止运行时。
4. 应用运行环境，然后选择 **Protected**。它会继承 Local 已保存的模型路由及产品存储的 API 密钥；可在 Protected 的 **Settings → Models** 中覆盖。还需在 Network Scope 中授权模型端点：密钥不会授予网络访问权限。转发宿主机 `OPENAI_API_KEY` 需显式选择；不会复制整个宿主机环境或凭据存储。遥测保持关闭。
5. 研究前，让 agent 检查 `scope_status` 和 `recon_catalog`。仅对已授权目标使用 `recon_run`；主动操作还需显式 `allowActive` 同意。选择后续目标前，检查覆盖标记与拒绝结果。运行时指南也提供无密钥检查，可在配置模型之前测试。

Web 提示需要认证时，重新打开 `dsh web` 打印的登录 URL。不要把登录 token 或模型凭据写入仓库文件或会话记录。

<a id="run"></a>

## 运行

### 通过 `npm` 运行

如需使用上游基础框架，安装 `Node.js` 后运行以下命令。此操作不会安装本分支的研究扩展：

```sh
npx @deepseek-ai/dsh web
```

该命令默认会在 `http://127.0.0.1:3080` 启动 Web UI，本机启动时还会用默认浏览器打开页面。通过 SSH 启动时只打印宿主机 URL，因为本地转发地址由 SSH 客户端或编辑器持有。传入 `--no-open` 可仅运行服务器而不打开浏览器。详见 [Web UI 指南](docs/user/guide/index.zh.md)。

<a id="run-from-source"></a>

### 从源码运行

如需从仓库源码运行：

```sh
git clone https://github.com/5stars217/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` 会准备仓库产物。`pnpm dsh web` 会直接使用这些已构建产物，不会重新构建。

如需完整的 Apple Silicon 部署流程，请参阅 [macOS 课程环境设置](docs/user/guide/course-macos.zh.md)。

## 社区与支持

- 通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 提交反馈或 bug 报告。
- 为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现。
- 欢迎加入 DeepSeek Harness 企微群！扫描下方二维码填写入群问卷，小助手会定期发送入群邀请。

<table>
  <thead>
    <tr>
      <th align="center">入群问卷</th>
      <th align="center">微信公众号</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-survey.png" alt="DeepSeek Harness 入群问卷二维码" width="180" height="180"></a></td>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wechat-official-account.png" alt="DeepSeek Harness 团队微信公众号二维码" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.zh.md)。

## 开发

请先阅读[开发指南](docs/development.zh.md)与[架构文档](docs/architecture.zh.md)。

`pnpm run dev:web` 会在一个终端里完成构建、启动，并在源码修改时重建 client bundle；`make help` 列出 Web 与 Desktop 对应的 Make target。完整表格见开发指南的「应用命令」一节。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 引用

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
