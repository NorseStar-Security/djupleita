---
description: "为课程研究工具配置域名范围，了解执行前拒绝、目标适配器及其限制。"
kind: "package-reference"
---

# @deepseek-ai/dsh-scope-judge

[English](README.md) | 中文

## 概述

使用范围裁判，将研究工具调用限制在教师定义的域名范围内。裁判会在执行前阻止范围外的目标，并返回可供 agent（智能体）采取行动的原因。结构化工具声明其目标字段；可选的 Bash 适配器检查字面的 `curl`、`nmap` 和 `dig` 命令。未知工具及无法确定的目标均被拒绝。这项策略检查工具参数；提供方和实验网络还必须约束重定向、次级请求及参数未描述的流量。

## 目录

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

全局挂载裁判，使其策略适用于使用共享工具执行器的每个 agent，包括之后注册的工具。

当任意浏览器、代码、终端或 IP 扫描能力需要基于目标的约束时，请改用 [Linux 课程运行时](../../../course/scope-runtime/README.zh.md)。本包仍是仅检查参数且配有已审核适配器的 guard，而非网络边界。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-scope-judge'
  config:
    domains: [example.test, '*.lab.test']
    shellTools: [bash]
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `domains` | 必填 | 精确 DNS 名称或 `*.domain` 后代规则的非空列表 |
| `targetTools` | `[{ name: web_fetch, paths: [/url] }]` | 已审核的工具名称及所有必需的目标 JSON 指针；提供此列表会替换默认值 |
| `shellTools` | `[]` | 使用 `command` 参数、经过审核的一次性 Bash 工具 |
| `localTools` | `[]` | 对已审核且不具备网络或任意执行能力的工具给予显式豁免 |

[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-scope-judge)列出解析器层面的配置。空范围、格式错误的规则或指针、重复工具名及冲突分类都会使加载失败。[课程指南](../../../docs/user/guide/scope-judge.zh.md)提供显式启用的配置档补丁。

### 域名匹配

`example.test` 仅授权该名称。`*.example.test` 授权任意层级的后代，但不包含根域；若两者均获授权，需同时列出。匹配会将大小写、一个末尾 DNS 点及国际化 DNS 名称规范化为 ASCII，然后比较完整 DNS 标签。`example.test.evil.test`、`evilexample.test` 及未列出的子域仍在范围之外。IP 字面量、旧式数字 IP 写法、凭据、不支持的 URL 协议、格式错误的端口及歧义目标均被拒绝。DNS 解析不会授予额外范围。

<a id="structured-tools"></a>
### 结构化工具

每个 `paths` 项都是指向必需目标字符串的 JSON 指针。`*` 段选择非空数组的每个成员；`~1` 和 `~0` 分别转义属性名中的 `/` 和 `~`。所有选中的字符串必须是 DNS 主机、带数字端口的主机或 HTTP(S) URL，且每个主机名均须获得授权。路径缺失、空数组、字符串与非字符串混合值，或一个范围外目标都会拒绝整个调用。

```yaml
targetTools:
  - name: web_fetch
    paths: [/url]
  - name: mcp_lab_probe
    paths: [/requests/*/target, /callback/host]
```

仅在审核工具实现后映射工具：列出的字段必须描述所有目标，其他字段不得执行代码、选择代理、覆盖主机或引入额外请求。看似获准的参数无法证明任意第三方工具实际连接的位置。未知 MCP 工具在审核前保持拒绝。

### Bash 命令

可选适配器接受带普通引号的单条字面命令，例如：

```sh
curl -q -I https://example.test
curl -q --max-time 5 https://example.test https://api.lab.test
nmap -sV -Pn -p 80,443 example.test
dig -r example.test A +short
```

`curl` 要求首个参数为 `-q` 或 `--disable`，以禁用其配置文件。它接受 HTTP(S) 目标、基本显示／协议选项、请求方法、字面数据和超时。跟随重定向、代理、主机／连接覆盖、配置文件及输出文件选项均被拒绝。`nmap` 接受字面 DNS 目标、[适配器](src/shell.ts)中列出的扫描／探测选项、数字端口、时序模板、常用端口数量及重试限制；脚本、输入文件、IP、范围及其他选项均被拒绝。`dig` 要求使用 `-r` 禁用其配置文件，并接受一个 DNS 名称、常用记录类型及基本输出选项；自定义解析器、跟踪及批量／反向查询均被拒绝。

Shell 操作符、命令替换、变量展开、转义、控制字符、未加引号的通配、包装程序及不支持的选项均被拒绝。只使用可信的一次性 Bash 提供方，并控制其启动文件、环境、PATH 和二进制文件。持久终端和任意运行时无法从单个命令参数确定目标，因此保持未分类。普通审批授权无法覆盖范围拒绝。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现内部——点击展开</summary>

插件编译配置的私有副本，然后注册同步的 `ctx.tools.guard`。工具执行器在执行前策略和审批之后、分发之前调用这项单调检查。首个拒绝会阻止工具函数体及环绕分发监听器运行。现有工具结果和 Session 历史记录承载拒绝原因；裁判不发起辅助模型请求，也不增加持久化格式。Cordis 在插件 fiber 卸载时移除 guard。多个裁判的权限取交集。

| 文件 | 职责 |
|---|---|
| [index.ts](src/index.ts) | Loader 配置与 effect 注册 |
| [judge.ts](src/judge.ts) | 工具分类、必需目标提取及拒绝 |
| [domain.ts](src/domain.ts) | DNS 规范化与范围比较 |
| [shell.ts](src/shell.ts) | 有限的字面命令适配器 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

阅读以下页面，了解组合与执行器详情。

- [课程设置](../../../docs/user/guide/scope-judge.zh.md)——使用教师持有的范围激活裁判。
- [工具执行流水线](../../../docs/tool-execution-pipeline.zh.md)——策略、审批和分发的顺序。
- [Tools 包](../../core/tools/README.zh.md)——单调 guard 语义与最终结果。
- [Guard 家族](../README.zh.md)——相邻策略。

-----

<a id="model-experience"></a>
## 模型体验

### 被拒绝的工具结果

#### 模型看到的内容

被拒绝的调用返回 `Error: scope judge denied "<tool>": <reason>. Allowed domains: <rules>`。范围外原因是 `target domain "<domain>" is outside scope`。其他原因描述目标缺失、不支持的命令或未分类工具。获准调用保留工具的普通结果。裁判不改变工具 schema 或系统提示。

#### Token 影响

无辅助推理或固定提示开销。每次拒绝增加一个普通工具结果，其长度取决于配置规则和工具名。

#### KV Cache 影响

拒绝结果追加到工具历史，不替换之前的请求 token。更改配置会改变后续拒绝文本；现有提供方缓存的可用性不受本插件控制。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

裁判执行已审核的工具参数策略，部署须满足以下要求。

- 配置、适配器、插件代码、shell 环境和二进制文件均为可信的教师资产。不要允许 agent 修改或卸载它们；`localTools` 豁免会绕过该工具的目标检查。
- 域名身份不会约束 DNS 应答、CNAME、重定向、浏览器子资源、后台任务或提供方内部的次级请求。使用内置 fetch 提供方的同源重定向约束和实验网络出口控制。本插件不是网络防火墙。
- 未分类的搜索、浏览器交互、代码执行（`run_code`）、终端输入、外部子 agent 和插件管理工具均被拒绝。课程补丁使用原生工具模式。启用这些能力之前，必须审核自定义结构化适配器。
- 配置更改会裁判后续分发；卸载或缩小范围不会终止已运行的调用。更改练习范围前须停止活动工作。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
