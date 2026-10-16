---
description: "教师侧将已存储的课程轨迹导出至 Logfire，采用私有凭据，支持恢复，并明确学生注册发布要求。"
---

# 课程轨迹收集器

[English](README.md) | 中文

## 概述

将教师可访问的 DSH 归档收集到持久化本地数据库，并提供经过身份验证的只读检查，或直接导出至 Logfire。专用教师组合运行于研究环境之外；可选覆盖配置将收集整合到现有可信本地 Web 应用。独立课程授权提供方存在之前，学生接收路由拒绝上传。课程 SSO、注册、凭据续期及学生自动传输仍是占位项；[部署假设](../../.agents/notes/proposed/architecture/2026-10-15-course-telemetry-enrollment.zh.md)仍是要求。

## 目录

- [教师部署](#instructor-deployment)
- [本地收集及检查](#local-collection-and-inspection)
- [整合本地 Web 应用](#integrated-local-web-app)
- [观测与恢复](#observe-and-recover)
- [学生镜像发布要求](#student-image-release-requirement)
- [验证](#verification)

<a id="instructor-deployment"></a>
## 教师部署

仅在教师宿主上运行，并使用获准完整内容导出的归档。提供现有会话根目录、唯一的来源命名空间，以及仅包含 Logfire 写入 token 的私有文件。绝不得将此文件放入仓库、镜像构建上下文、学生镜像或研究工作区。收集器 UID 1000 必须能够读取归档和 token；Compose 文件秘密可能保留宿主权限。归档以只读方式挂载，检查点存储保持私有，不暴露监听端口。

从仓库根目录设置以下非秘密值及 token 的路径，而非其值：

```sh
export COURSE_SESSION_ROOT=/srv/course/incoming/installation-001/sessions
export COURSE_TRAJECTORY_SOURCE_ID=cohort-a-installation-001
export COURSE_OTLP_LOGS_ENDPOINT=https://logfire-us.pydantic.dev/v1/logs
export LOGFIRE_TOKEN_FILE=/srv/course/secrets/logfire-write-token
export COURSE_BUILD_COMMIT=$(git rev-parse --short=12 HEAD)
docker compose -f course/trajectory-collector/compose.yml config --quiet
docker compose -f course/trajectory-collector/compose.yml build
docker compose -f course/trajectory-collector/compose.yml run --rm collector --dump-config
docker compose -f course/trajectory-collector/compose.yml up -d --wait
```

根据 [Logfire 收集器配置](https://pydantic.dev/docs/logfire/migrate/overview/)，EU 项目使用 `logfire-eu.pydantic.dev`。压缩默认采用 `zstd`，与基础 harness 配置一致；未压缩归档应在启动前设置 `COURSE_SESSION_COMPRESSION=none`。不要创建空源目录后就假定学生数据正在到达：此部署不从学生 VM 传输文件。每个来源命名空间及目标使用一个私有状态卷；不得合并具有相同会话 ID 的归档。

Dockerfile 构建 harness 运行时，并且只启动 `dsh --profile course-trajectories`。配置挂载控制台日志、JSONL 提供方及 [trajectory-export-otlp](../../packages/experimental/trajectory-export-otlp/README.zh.md)，不含模型适配器、工具、浏览器或反馈导出器。不得挂载学生整个主目录、Docker socket 或研究凭据。使此收集器位于研究网络命名空间之外；不要将 Logfire 加入目标范围。

<a id="local-collection-and-inspection"></a>
## 本地收集及检查

独立的[本地配置](profile-local/cordis.patch.yml)挂载 SQLite 存储、只读归档消费方及使用 harness 现有教师浏览器认证的 HTTP 检查。它没有模型或工具。监听器仅绑定 `127.0.0.1:4319`；启动日志提供新的本地登录 URL。经认证的教师可检查 `/trajectory`、查询 `/api/trajectory/records` 和 `/api/trajectory/status`，并通过受限附件 API 下载二进制数据。仪表板是只读 JSON 页面，不是 trace span 瀑布图。不得将本地 HTTP 监听器暴露到公共网络。

[本地 Compose 文件](compose.local.yml)面向采用宿主网络的专用 Linux 教师宿主。设置相同的现有归档及构建元数据变量，以及教师分配的 `COURSE_INSTALLATION_ID`、`COURSE_STUDENT_ID` 和 `COURSE_COHORT_ID`。这些是本地归档标签，不是经验证的 SSO 声明。命名接收卷保留已提交记录、重放保护、撤销及远程确认游标。临时浏览器凭据存储在容器重建时重置。健康检查验证经过认证的监听器，而非收集完整性；还须检查工作进程错误及持久化计数器。镜像构建及部署验收由课程宿主运维人员负责。

本地组合默认不向远程发送内容，且无需 Logfire token。[Logfire 覆盖配置](compose.local-logfire.yml)与本地 Compose 文件共同使用时，显式启用完整收集器日志和已完成的 OTLP trace，并挂载教师 token 文件。提供上文已有的日志端点、来源命名空间、token 路径及本地标签，并提供同一项目的 HTTPS `/v1/traces` 端点：

```sh
export COURSE_OTLP_TRACES_ENDPOINT=https://logfire-us.pydantic.dev/v1/traces
docker compose -f course/trajectory-collector/compose.local.yml -f course/trajectory-collector/compose.local-logfire.yml config --quiet
```

覆盖配置要求同时提供两个端点变量。配置档仅在 trace 端点存在时挂载私有[投影](../../packages/experimental/trajectory-projection/README.zh.md)。完整日志继续使用 `/var/lib/trajectory/export` 检查点；可选 `/traces` 消费方使用 `/var/lib/trajectory/export-traces`，绝不确认日志游标。投影数据库单独位于 `/var/lib/trajectory/projection` 下。不得共享、删除或交换这些状态。远程覆盖配置的健康检查要求经过认证的本地监听器，以及两个导出器的新鲜健康状态；它不能证明收集完整性。[导出器](../../packages/experimental/trajectory-export-otlp/README.zh.md#add-completed-traces)负责嵌套、选定元数据、确认、重放及故障语义。

本地二进制归档需要明确的 `copyAttachments` 同意、匹配的附件提供方及只读对象归档；此配置未启用，也不向 Logfire 发送二进制字节。相关限制见[归档消费方参考](../../packages/experimental/trajectory-collector-archive/README.zh.md)。此覆盖配置不增加学生注册、上传器或生产 SSO 授权方。

没有 `TrajectoryUploadAuth` 时，学生 POST 路由返回不可用；教师 cookie 不能授权接收。不得配置镜像共享 token 来绕过此限制。[HTTP 插件](../../packages/experimental/trajectory-collector-http/README.zh.md)定义受限路由、身份分离、撤销及超时结果未知时的重放行为。[存储提供方](../../packages/experimental/trajectory-collector-sqlite/README.zh.md)负责配额及保留保证；绝不通过删除去重元数据来释放空间。

<a id="integrated-local-web-app"></a>
## 整合本地 Web 应用

构建当前工件后，为现有受支持的 Web 配置档使用[预检启动器](native.mjs)：

```sh
node course/trajectory-collector/native.mjs --profile web
```

启动器在以[覆盖配置](native.overlay.yml)启动普通已构建 CLI 之前，验证必需的本地标签及归档位置。它保留继承设置及转发的 CLI 参数、转发关闭信号，并等待子进程退出。覆盖配置插入本地 SQLite 收集、只读归档消费方、轨迹投影、Trajectories 查看器及 HTTP 检查。它复用应用的持久化提供方、当前会话根目录及同源教师认证；不会替换研究配置或启动另一个监听器。应与当前应用负责人协调重启，而非在其端口启动第二个进程。

此覆盖配置读取所挂载应用的归档。同时启用 [Course Runtime](../../packages/experimental/course-runtime/README.zh.md) 时，应用 Protected 会在其中挂载相同的查看器客户端，本机控制器将经过认证且受限的持久化会话记录分页拉取到此收集器中。Protected 使用独立安装标识，因此相同会话 ID 不会与 Local 冲突。此流程复制记录内容，不复制附件二进制，也不启用远程导出。研究容器不会收到收集器数据库、Docker socket、本机 cookie 或归档写入凭据。

启动前设置以下继承部署值；它们都不是 API 秘密：

| 变量 | 含义 |
|---|---|
| `DSH_HOME` | 现有应用主目录及配置档设置的显式绝对路径 |
| `COURSE_COLLECTOR_DB` | 收集器 SQLite 绝对路径，位于研究可写主目录之外的专用仅所有者可访问目录 |
| `COURSE_PROJECTION_DB` | 投影 SQLite 绝对路径，位于单独的仅所有者可访问目录 |
| `COURSE_INSTALLATION_ID` | 教师分配的本地安装标签 |
| `COURSE_STUDENT_ID` | 教师分配的本地学生标签，不是经过认证的声明 |
| `COURSE_COHORT_ID` | 教师分配的本地班级标签 |

保留现有 `DSH_HOME`、配置档设置及回环监听器。启动器拒绝缺少的标签、相对路径、位于 `DSH_HOME` 内的归档，以及收集器和投影共用目录；存储提供方还强制仅所有者可访问的真实文件及目录。直接使用原始覆盖配置会绕过此预检：通用 Loader 可能让失败插件保持未激活，而其他应用服务继续运行。应检查归档及投影进度，而非仅检查监听器是否可用。

完整记录保留在收集器，投影提供派生轨迹视图；投影及查看器限制由对应包参考说明。此覆盖配置不挂载学生上传授权方或远程导出器，并保持二进制复制关闭。本地标签不能确立 SSO 身份。可信本地应用内整合不构成与该应用的进程隔离；研究进程不可信时，应采用专用教师部署。

<a id="observe-and-recover"></a>
## 观测与恢复

检查收集器日志及确认状态：

```sh
docker compose -f course/trajectory-collector/compose.yml logs --tail 100 collector
docker compose -f course/trajectory-collector/compose.yml exec collector node --eval "process.stdout.write(require('fs').readFileSync('/var/lib/trajectory/health.json'))"
```

[导出器参考](../../packages/experimental/trajectory-export-otlp/README.zh.md#delivery-and-recovery)负责说明交付保证、重试、检查点、分片及故障。在 Logfire 中按 `dsh.source.id` 和 `dsh.session.id` 筛选，再按 `dsh.event.seq` 排序日志。保留全部分片，并按记录及分片标识去重以便重建。独立归档部署仅导出完整 OTLP 日志；本地 Logfire 覆盖配置还导出真实的已完成 trace span。trace 是选定的已记录元数据，不能替代源日志，也不是上传的截图或文件二进制内容。供应商项目限制及保留策略仍然适用。

本地 Logfire 覆盖配置应同时检查 `/var/lib/trajectory/export/health.json` 和 `/var/lib/trajectory/export-traces/health.json`。日志导出器健康不表示 trace 已交付，反之亦然。还应检查归档及投影进度；空闲接收端不能证明每条源记录都已收集。

健康检查将失败、停止、陈旧或正在重试的导出标记为不健康。保留源及检查点卷；修复凭据、网络或存储，并在终止性故障后重启。插件每次请求重新读取 token 路径，但替换 Compose 绑定挂载秘密的 inode 时可能需要重建容器。不要通过删除检查点来修复目标不匹配：先审查回放及重复影响。普通 Compose 关闭保留命名状态卷；不要使用 `down -v`。

崩溃或强制终止后，容器 PID 复用可能使陈旧所有者锁阻止重新启动。先停止使用该状态卷的全部收集器，确认此前的所有者已停止，再通过教师维护容器仅移除 `/var/lib/trajectory/owner.lock`。保留目标元数据及事件检查点。并发容器不得共享此状态卷；请参阅导出器的锁限制。

本地 Logfire 覆盖配置改用两个独立的导出器锁：`/var/lib/trajectory/export/owner.lock` 和 `/var/lib/trajectory/export-traces/owner.lock`。移除任一陈旧锁前，同样必须确认所有者已经停止。保留收集器及投影数据库完整。

<a id="student-image-release-requirement"></a>
## 学生镜像发布要求

要求是一次性课程 SSO 注册、安装实例专属且自动短期续期和可撤销的凭据，以及服务器分配的学生和班级身份。学生不创建或粘贴 API 秘密；只有教师服务持有 Logfire 项目 token。代理、身份提供方及服务主机名、镜像连接 UI 和安装凭据提供方仍是占位项。持久化接收及其授权接口已存在，但未挂载生产学生验证器或上传器。在[注册验收标准](../../.agents/notes/proposed/architecture/2026-10-15-course-telemetry-enrollment.zh.md#acceptance-criteria)通过之前，不得分发声称具有自动远程副本的镜像。

<a id="verification"></a>
## 验证

无需密钥的 [Loader 测试](../../packages/experimental/trajectory-export-otlp/tests/export.spec.ts)使用真实持久化提供方及独立进行 protobuf 解码的回环接收端。测试回放已记录的范围轨迹，并在无需供应商 token 的情况下将完整远程事件与源进行比较。不连接真实 Logfire 项目。部署前应在课程宿主上验证专用 Linux 镜像并执行真实 Logfire 验收；Compose 校验及原生构建不能证明这些结果。

[已构建远程配置档测试](../../packages/experimental/trajectory-export-otlp/tests/built-remote-profile.e2e.ts)在私有主目录启动准确的本地配置档，仅针对分配的回环接收端启用两个导出器、比较完整日志事件、解码真实 trace protobuf，并验证独立检查点及排空关闭。配套的纯本地测试清空两个端点变量，并验证不发生远程导出。两个测试均不激活现有应用，也不联系 Logfire。

构建当前 CLI 及插件工件后，运行 `node --test course/trajectory-collector/tests/native-profile.test.mjs`。此隔离的已构建配置档检查使用私有源日志及分配的回环端口，验证预检拒绝、经过认证的收集器和查看器路由、已提交的 trace/span 视图、精确源字节、重启后的去重回放及稳定投影身份，以及优雅进程释放。它不会激活现有应用、操作浏览器 UI、联系模型或上传到 Logfire。
