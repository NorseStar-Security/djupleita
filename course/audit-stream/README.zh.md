---
description: "将每条实验客户端会话记录（包括模型推理）实时发送至 Cloudflare 接收端，由其校验、存储并广播。"
---

# 课程审计流

[English](README.md) | 中文

## 概述

为教师提供每个实验客户端代理推理与行为的实时、可校验副本。每个席位在研究进程之外运行未经修改的[轨迹导出器](../../packages/experimental/trajectory-export-otlp/README.zh.md)。Cloudflare Worker 验证席位身份，校验每条记录的摘要，将原始字节存入 R2，按会话串联回执，并将摘要推送到实时看板。[实验客户端补丁](lab-client.patch.yml)开启模型推理，使会话日志包含可导出的推理内容。

## 目录

- [组件](#components)
- [开启推理](#turn-on-reasoning)
- [部署接收端](#deploy-the-receiver)
- [签发 token](#issue-tokens)
- [发送席位数据](#stream-a-seat)
- [观看与检查](#watch-and-inspect)
- [接收端行为](#receiver-behavior)
- [验证](#verification)
- [已知限制](#known-limitations)

<a id="components"></a>
## 组件

| 路径 | 作用 |
|---|---|
| [lab-client.patch.yml](lab-client.patch.yml) | Web 配置补丁：声明推理等级的课程网关路由，以及默认模型 |
| [worker/src/](worker/src/index.ts) | 接收端：`index.ts` 路由，`ledger.ts` 席位提交，`room.ts` 实时看板分发，`otlp.ts` OTLP 解码，`token.ts` token |
| [worker/scripts/token.ts](worker/scripts/token.ts) | 生成签名密钥，以及席位、看板和管理员 token |
| [worker/scripts/smoke.ts](worker/scripts/smoke.ts) | 向已部署的接收端重放导出器固定数据 |
| [worker/tests/](worker/tests/ledger.test.ts) | Node 测试运行器测试集，以及由导出器编码的固定数据 |

<a id="turn-on-reasoning"></a>
## 开启推理

课程网关仅在请求携带 `reasoning_effort` 时返回推理内容。`llm-pi-ai` 仅为声明了推理等级的模型发送该字段，而手动声明的模型没有推理等级，因此通过 Models 页面配置的席位不会记录推理。将 [lab-client.patch.yml](lab-client.patch.yml) 写入为 `$DSH_HOME/profiles/web/cordis.patch.yml`，在服务环境中设置 `SEC590_LLM_BASE_URL`，或将网关 URL 写入该副本，并在 `$DSH_HOME/.credentials.yaml` 中将网关密钥存为 `SEC590_LLM_API_KEY` 引用：

```yaml
refs:
  SEC590_LLM_API_KEY: '<gateway key>'
```

headless 套件禁用托管凭据存储，因此 headless 运行从环境变量读取 `SEC590_LLM_API_KEY`。先用 `dsh --profile web --dump-config` 检查组合结果，再确认新会话的 `assistant/message` 内容中包含 `reasoning` 块。推理 token 计入输出上限，并增加延迟。

<a id="deploy-the-receiver"></a>
## 部署接收端

在 `worker/` 目录下使用已登录的 `wrangler` 运行以下命令。配置只命名绑定，不含账户或资源 ID。

```sh
npm install
npx wrangler r2 bucket create ns-audit-raw
node scripts/token.ts key > /instructor/secrets/token-key
tr -d '\n' < /instructor/secrets/token-key | npx wrangler secret put AUDIT_TOKEN_KEY
npx wrangler deploy
npx wrangler r2 bucket lock add ns-audit-raw raw-30d raw/ --retention-days 30
```

签名密钥保存在教师宿主上。存储桶锁定在保留期内禁止删除或覆盖已存储的记录；保留期应采用课程保留策略批准的时长。

<a id="issue-tokens"></a>
## 签发 token

为每个安装实例签发一个席位 token。其安装实例标签必须等于导出器的 `sourceId`。

```sh
node scripts/token.ts seat --key-file /instructor/secrets/token-key --cohort pilot --student seat-01 --installation webtop-01 --days 30
node scripts/token.ts board --key-file /instructor/secrets/token-key --cohort pilot --days 7
node scripts/token.ts admin --key-file /instructor/secrets/token-key --days 1
```

席位 token 用于上传记录并读取自身席位。看板 token 读取一个班级，使用 `--cohort '*'` 时读取全部班级。管理员 token 用于吊销席位。标签为 1 至 64 个 `[A-Za-z0-9._-]` 字符。每个席位 token 只能存放在其导出器可读的位置，绝不能放在席位的主目录或任何研究进程可写的路径中。

<a id="stream-a-seat"></a>
## 发送席位数据

每个席位从教师拥有的检出副本运行一个[轨迹收集器](../trajectory-collector/README.zh.md)，并以只读方式挂载该席位的会话根目录。收集器的端点和 token 变量适用于任何 OTLP 日志接收端：

```sh
export COURSE_SESSION_ROOT=/srv/seats/webtop-01/config/.dsh/sessions
export COURSE_TRAJECTORY_SOURCE_ID=webtop-01
export COURSE_OTLP_LOGS_ENDPOINT=https://ns-audit.example.workers.dev/v1/logs
export LOGFIRE_TOKEN_FILE=/instructor/secrets/webtop-01.token
export COURSE_BUILD_COMMIT=$(git rev-parse --short=12 HEAD)
docker compose -p audit-webtop-01 -f course/trajectory-collector/compose.yml up -d --build --wait
```

JSONL 后端将每个追加批次写为一个已 fsync、带校验和的帧，读取方会丢弃不完整的末尾帧，因此收集器可以在席位写入的同时跟随实时会话。默认每秒扫描一次，并按会话顺序发送记录。token 文件和检查点卷须置于席位容器之外：能读取 token 的代码可以冒充该席位上传，能访问收集器的代码可以停止它。

<a id="watch-and-inspect"></a>
## 观看与检查

打开 `https://<receiver host>/board?cohort=<cohort>#token=<board token>`。浏览器不会将片段发送给服务器；页面连接 `/ws`，显示每个会话的汇总（记录数、推理字符数、工具调用、工具错误、范围拒绝），以及带推理预览的实时动态。使用席位 token 打开同一页面时，只显示该席位。

| 路由 | Token | 返回内容 |
|---|---|---|
| `GET /api/cohort?cohort=C` | 看板 | 该班级的席位和近期活动 |
| `GET /api/seat?installation=I` | 该席位所属班级的看板 token，或该席位自身 | 席位身份、带链头的会话汇总，以及已记录的问题 |
| `GET /api/records?installation=I&session=S&after=N&limit=L` | 该席位所属班级的看板 token，或该席位自身 | 按序号排列的已索引记录 |
| `GET /api/raw?installation=I&session=S&seq=N` | 该席位所属班级的看板 token，或该席位自身 | 该序号记录的原始字节 |
| `POST /api/revoke?installation=I&reason=R` | 管理员 | 吊销该席位；之后的上传返回 403 |

<a id="receiver-behavior"></a>
## 接收端行为

- **先认证。** `POST /v1/logs` 需要席位 token，身份只来自 token。`dsh.source.id` 与 token 安装实例不一致的记录返回 403。席位绑定首次上传时的班级和学员；不同的组合返回 409。
- **先校验后存储。** 单段记录的哈希必须等于 `dsh.record.sha256`。分片以解码后的字节存储，只有重组后的记录匹配时才接受最后一个分片；否则请求返回 422。
- **先提交后确认。** 席位的 Durable Object 在响应前将每个分段写入 R2，并在其 SQLite 存储中建立索引。存储和 Durable Object 故障返回带 `Retry-After` 的 503，导出器会重试。重放按记录 ID 和分段确认为重复。
- **回执链。** 每条完整记录以 `sha256(previous, seq, record digest)` 延长其会话链，链起点是安装实例与会话 ID 的摘要。序号不是下一个预期值时，记录为 `SEQUENCE_GAP` 或 `SEQUENCE_REPEAT`。
- **不可变对象。** 键格式为 `raw/<cohort>/<student>/<installation>/<session>/<position>-p<part>of<parts>-<record id prefix>`。账本从不覆盖已有键，因此存储桶锁定保护每个已存储的分段。
- **实时分发。** 提交后，接收端为每条完整记录向该班级的 Durable Object 传递一条摘要，后者保留最近 300 条并推送给已连接的看板。看板投递尽力而为；R2 对象和席位索引才是权威记录。

状态码：200 表示已接受，响应体为空的 `application/x-protobuf`；400 表示 OTLP 或属性格式错误；401 表示 token 缺失或无效；403 表示 token 类型错误、来源不匹配或席位已吊销；409 表示身份冲突；413 表示请求体超过 `MAX_REQUEST_BYTES`；415 表示不支持的媒体类型或内容编码；422 表示摘要或 UTF-8 校验失败；503 表示可重试的存储故障。

<a id="verification"></a>
## 验证

```sh
cd course/audit-stream/worker
npm test
npm run typecheck
NS_AUDIT_URL=https://ns-audit.example.workers.dev NS_AUDIT_SEAT_TOKEN=<seat token for seat-fixture> NS_AUDIT_BOARD_TOKEN=<board token> node scripts/smoke.ts
```

测试覆盖 OTLP 解码、token、基于 `node:sqlite` 的账本提交以及看板摘要。其固定数据来自随附的导出器编码器和已录制会话；执行 `pnpm install` 后，在仓库根目录用 `node --import tsx/esm course/audit-stream/worker/tests/fixtures/generate.ts` 重新生成。`scripts/smoke.ts` 应指向专用的冒烟测试班级，因为锁定期内已存储的记录无法删除。

<a id="known-limitations"></a>
## 已知限制

- 席位通过部署时签发的 token 识别。通过课程 SSO 进行的笔记本注册仍属于[注册提案](../../.agents/notes/proposed/architecture/2026-10-15-course-telemetry-enrollment.zh.md)。
- 对席位会话文件有写权限的代码，可以在收集器读取之前修改记录。回执链记录接收端提交了什么以及提交顺序，但不证明执行过程。
- 接收端只接受会话记录。网关网络日志、操作审查回执和靶场账本提交需要各自的发送方。
- 除 `MAX_REQUEST_BYTES` 和 Cloudflare 平台限制外，没有按席位的速率限制。
- 看板摘要覆盖课程使用的记录类型；其他类型只显示类型名称。
