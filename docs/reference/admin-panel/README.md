# 管理面板：需求、调研与目标架构

调研日期：2026-10-22。第二轮修订同日。后端正在重构，重构完再复核一轮。本文档不进版本库，只在本机。

## 一、需求与决策

### 第一轮（框架与形态）

| 项 | 结论 |
|---|---|
| 前端栈 | shadcn/ui + Vite + React + TypeScript + TanStack（Query / Table / Router），自建 SPA |
| 面板定位 | 观测 + 凭据管理：登录凭据管理、用量观测、余额观测 |
| 托管方式 | 由 `router-proxy.ts` 在 `/admin` 下静态托管 |
| 部署形态 | 一个镜像、一个 tar、一个端口。Dockerfile 多阶段：builder 构建 SPA，runtime 拷 `dist` |

### 第二轮（架构形态）

| 项 | 结论 |
|---|---|
| 配置存储 | 配置落 SQLite——**唯一来源**，env 不再读业务配置 |
| 配置生效 | **不热生效**：面板写库 → 标记「待重启」→ 重启后生效 |
| 迁移 | 现有部署用一次性导入命令把 env 里的业务配置搬进库，之后删掉 env 里的业务键 |
| 账号模型 | 以「单账号管多个登录凭据」为主，不排除以后多账号 |
| 接口形态 | **protobuf + Connect**（`.proto` 定义契约，Connect 传输），不是 REST |
| 传输 | Connect unary（`POST /buddy.admin.v1.AdminService/<Method>`）+ `GET /admin/events` SSE 事件流 |
| 部署实例 | 运行时只有一个：NAS 上那个容器。本机只是开发代码副本 |
| 当前状态 | 只调研与设计，暂不动手 |

## 二、事实核对（写设计前必须先钉死的）

### 网关本身

| 项 | 事实 | 怎么验的 |
|---|---|---|
| Web 框架 | **Koa 3**（`@koa/router` + `koa-bodyparser`），不是 Express | `router-proxy.ts:20-22,165` |
| 运行时 | Node 24.21，TS 原生类型剥离，容器内无构建步骤 | `node -v` |
| SQLite | `node:sqlite` 内置可用（`DatabaseSync`），零原生依赖 | 本机实测通过 |
| 用量数据 | 方言层**已经解析好了**（`lib/dialect/response.ts` 出 input/output/cached/reasoning，`stream.ts` 在流末 chunk 给 usage），只差落库 | 读代码 |
| 会话与凭据 | `lib/session.ts` 管会话文件：0600、原子写、锁文件防重复轮换；`lib/minimax/file-store.ts` 是桌面端 store 的**只读**视图，不能搬 | 读代码 |
| 配置读取面 | `readEnv*` 共 **72 处调用、17 个文件**；模块级常量在 import 时求值 | `grep` |
| `/health` | `router.get("/health")` 上没挂 `requireKey` 中间件 → **公开**，返回余额、凭据状态、赠金、账号可用性 | 读代码 |
| 前门 | `.env` 里没有 `REQUIRE_API_KEY` → 默认公开模式；`KEYS_FILE=/data/api-keys.json`（可写卷） | 读代码 + `.env` |
| 依赖声明 | koa 那套齐了，没有多余的 express（lock 里只有 `@types/express` 作为传递依赖） | `ls node_modules` + lock |

### 部署形态

| 项 | 事实 | 怎么验的 |
|---|---|---|
| NAS 上留什么 | 只有 `docker-compose.yml` + `./data`；代码在镜像里 | `tools/deploy-nas.sh` |
| 数据卷 | `./data:/data`，注释写明「OAuth 会话是凭据不是配置，必须活过重建，refresh token 每次刷新都轮换，文件丢了就得重登」 | compose |
| 数据目录 | `MINIMAX_DATA_DIR` / `QODER_DATA_DIR` / `WORKBUDDY_DATA_DIR` / `TOKENRHYTHM_DATA_DIR` / `KEYS_FILE` 全指 `/data` | compose |
| 重启策略 | `restart: unless-stopped` | compose |
| 配置来源 | 上游开关（`MINIMAX_CODE` / `QODER_GLOBAL` / `QODER_CN` / `WORKBUDDY_CN` / `TOKENRHYTHM`）与 `BENEFITS_INTERVAL_MS` 写在 compose 的 `environment` 里；TokenRhythm 账号与密钥、MiniMax plan key 在 `env_file: .env` | compose |
| 开发态 | `test/mock-server.ts` + `test/fixtures/` 已录 12 个 fixture，前端可对 mock 开发 | 读目录 |

由此得到两条部署性质：

- **`./data` 里的东西活过镜像重建和容器重建**（对比容器日志会随重建消失）。SQLite 放这里才安全。
- **`restart: unless-stopped` 意味着进程退出即被拉起** → 「改完重启生效」可以做成面板上的一个动作（优雅退出，前端提示重连），不必人工上 NAS敲命令。

## 三、框架选型

### 选定：shadcn/ui + Vite + TanStack

组件源码直接拷进仓库（MIT），自己拼页面。`satnaing/shadcn-admin` 是 MIT 现成骨架（React 19.2 / Vite 8 / TanStack Router + Table + Query / Tailwind v4）。多数页面是自定义表格和一张到期时间轴图，框架抽象用不上。注意 `shadcn-admin`（MIT 免费仓）和 `shadcn-admin.com`（付费模板产品）不是一回事。

### 被排除的选项

| 方案 | 为什么排除 |
|---|---|
| Refine | dataProvider 是 REST 形状的，套 Connect 要自己写适配层；CRUD 脚手架在本项目只值 1 页（API 密钥） |
| React-Admin | 强绑 MUI；收藏、批量操作、偏好存储对单用户控制台是负担 |
| AdminJS | 面向 ORM 资源，我们是文件和运行中进程；生产要 `@adminjs/bundler` 预打包（`ADMIN_JS_SKIP_BUNDLE="true"`），否则启动现打 bundle 吃 200~500MB 内存 |
| Vue 3 + Vben Admin 5 | 团队若用 Vue 是对应解，但 monorepo 对 8 个页面偏重，权限体系为多用户后台设计 |
| Directus / NocoBase / Payload | 要数据库 = 把「文件 + 运行中进程」的状态搬进 SQL。Directus v12 起换 MSCL（不再是 OSI 开源），NocoBase 2026-02 从 AGPL-3.0 改成 Apache-2.0 + 自定义补充条款 |
| Appsmith / Budibase | 自带容器 + 数据库，定制「赠金批次到期」视图更难写 |

### Connect 对前端的影响

客户端是 **codegen 出来的**，不用手写薄客户端：`@connectrpc/connect-web` 的 `createClient(AdminService, transport)` 直接给出类型化方法，TanStack Query 再包一层 hook。Koa 侧加 `koa-static`（MIT）或手写流式 + SPA fallback。

## 四、目标架构

### 4.1 SQLite 作为配置与凭据的落点

- 位置：`/data/buddy.sqlite`（`dataDirFor`），0600 —— 与 OAuth 会话同卷，活过重建
- 驱动：`node:sqlite` 的 `DatabaseSync`（Node 24 内置，实测可用，无原生依赖，镜像不涨）
- 日志模式：默认 `journal_mode=TRUNCATE`。**不开 WAL**——WAL 依赖共享内存，NAS 上若该目录经 NFS 导出给别的机器就不成立；宁可慢一点也不踩这个坑

表结构草案：

```sql
config(key TEXT PK, value TEXT, updated_at INT)

upstream(id TEXT PK, kind TEXT, label TEXT, enabled INT,
         base_url TEXT, region TEXT, params TEXT, updated_at INT)

account(id TEXT PK, upstream_id TEXT, label TEXT, status TEXT,
        meta TEXT, created_at INT, updated_at INT)

credential(id TEXT PK, account_id TEXT, kind TEXT, label TEXT,
            secret TEXT, status TEXT, generation INT, expires_at INT,
            last_ok_at INT, last_error TEXT, meta TEXT, updated_at INT)

usage_event(id INTEGER PK AUTOINCREMENT, ts INT, upstream TEXT, account_id TEXT,
            credential_id TEXT, model TEXT, agent_model TEXT, dialect TEXT,
            client TEXT, tokens_in INT, tokens_out INT, tokens_cached INT,
            tokens_reasoning INT, latency_ms INT, status TEXT, error TEXT)

usage_daily(day TEXT, upstream TEXT, model TEXT, dialect TEXT,
            requests INT, tokens_in INT, tokens_out INT, errors INT, PRIMARY KEY(...))

balance_snapshot(id INTEGER PK, ts INT, account_id TEXT, balance REAL,
                 currency TEXT, credits TEXT)

credit_lot(id TEXT PK, account_id TEXT, kind TEXT, amount REAL,
           expires_at INT, permanent INT, source TEXT, note TEXT, updated_at INT)
```

### 4.2 配置的唯一来源是 SQLite

**没有播种，没有 env 回退，没有「这个值从哪来」的标记。** 配置只有两个状态：库里写着，或没写。

**先有鸡还是先有蛋**：库里空的时候服务必须**照常起来**（否则网页端配置这条路走不通）。所以：

- 库为空 → 服务以「未配置」状态启动，代理端点返回明确错误（不是崩溃），面板可访问，由网页端完成首次配置
- 面板自己的鉴权**不能依赖 DB**：用 `/data/admin-token`（启动时生成，0600，复用 `api-keys.json` 的生成模式），面板 Bearer 提交一次存 localStorage

**三类配置要分清**：

| 类别 | 例子 | 放哪 |
|---|---|---|
| 业务配置（面板要能改） | 上游开关、上游地址与区域、TokenRhythm 账号与密钥、MiniMax plan key、benefit 间隔、隐藏模型列表、LOG_ROUTE | **SQLite** |
| 实现细节旋钮（没人会在面板上改） | 缓存毫秒数、warn 窗口、重试次数、锁超时（`SESSION_LOCK_STALE_MS` 等） | 留 env |
| 基础设施 | 端口、数据目录、时区、鉴权开关与令牌 | 留 env |

如果把「env 不读」理解成「72 个键全进库」，会把实现细节也搬进 DB，配置界面会被旋钮淹没。三类分开，上面只有第一类进库。

**模块级常量保持不动**：`const ENABLED_MINIMAX = readEnvFlag(...)` 在 import 时求值这件事，正好和「不热生效」一致 —— 启动时从 SQLite 取一份快照塞进这些常量即可，72 处 `readEnv*` 只需要改指向 `lib/config.ts` 的快照，不改成实时读。

**迁移现有部署**：一次性命令，把 compose `environment` 与 `.env` 白名单里的业务键写进库：

```
docker compose run --rm router node scripts/import-env-config.ts
```

脚本随镜像进 NAS（不能放 `tools/`，那份不进仓库也不进镜像）。导入后把 compose 的业务 env 与 `.env` 里的业务键**删掉**，避免两处都有、不知道谁生效。

**重启怎么做**：`restart: unless-stopped` 意味着进程退出即被拉起。所以面板可以给一个「应用并重启」动作：写库 → 优雅退出 → 容器重启 → 新进程读新配置。前端要提示「正在重启，稍后重连」。

### 4.3 账号 → 多凭据

| 上游 | account | credentials |
|---|---|---|
| TokenRhythm | 平台账号一条 | `login`（账号+密码）、`api_key` × N（`sk_tr_…`）、`session`（cookie，派生） |
| MiniMax | 账号一条 | `refresh_token`（每次轮换，带 generation）、`access_token`（1 小时）、`plan_key`；桌面端 store 保持**文件只读源** |
| Qoder | 按区一条 | `device_token`、设备身份（machine_id / machine_token，按 UID 派生） |
| WorkBuddy | 账号一条 | `device_token` / session |

最大的直接收益：**加 TokenRhythm 账号不再要改 NAS 上的 `.env`**（今天只能来自 `TOKEN_RHYTHM_n_ACCOUNT/PASSWORD/API_KEY`）。

凭据是**数据**不是配置：增删改立刻生效（每次请求都会去读），不受 4.2 的「重启才生效」限制。这条区分要在面板上体现清楚。

敏感字段：secret 只写不读。列表返回掩码 + 指纹（复用 `lib/credential.ts` 的 `tokenFingerprint`）。

### 4.4 管理接口的传输层：protobuf + Connect（2026-10-22 定案）

**决策**：契约用 `.proto` 定义，传输用 **Connect**。**不再用 JSON-RPC 2.0 信封。**

> 这一条是跨语言约束（后端 Go/TS，前端 TS/Dart/Swift/Kotlin）下的唯一可行解：`.proto` 的 `service` 块天然是 RPC 方法表，`buf generate` 一次产出台服务端桩 + 五个语言的客户端。理由与被排除项见 4.5。

- 端点：Connect 标准路径，形如 `POST /buddy.admin.v1.AdminService/ListAccounts`；Connect 的 unary 用 HTTP/1.1 + JSON 编码即可，浏览器不必上 HTTP/2
- 鉴权：`Authorization: Bearer <admin token>`，来自 `/data/admin-token`（启动时生成，0600），独立于 agent 侧的 `REQUIRE_API_KEY`（面板管的是凭据，不能沿用公开模式）。**鉴权是 header，不是消息字段，不进 schema**
- 错误：Connect 用 google.rpc.Status 语义（`code` + `message` + `details`），对应到面板要区分的四类失败：凭据过期 / 上游不可用 / 配置非法 / 冲突
- 事件流：`GET /admin/events`（SSE），**照旧独立于 Connect** —— Connect 的服务端流没有 EventSource 语义（`Last-Event-ID`、代理兼容性都缺）。帧**刻意**沿用 JSON-RPC notification 形状 `{"jsonrpc":"2.0","method":"usage.updated","params":{...}}`：这是手写的 SSE 帧，不是 JSON-RPC 传输的残留，只因为这个形状最易读、浏览器调试友好。断线重连 + `Last-Event-ID` 补发从 `usage_event` 查

方法清单（草案）：

```
system.status          总体状态：各上游、模型数、开关、版本、待重启标志
system.restart         优雅退出，让容器重启以应用配置
upstream.list          上游列表
upstream.setEnabled    开/关上游（重启后生效）
config.list            全部配置项与当前生效值
config.set             改配置（标待重启）
account.list           账号列表（凭据数量、余额摘要）
account.create         建账号
account.update / account.delete
credential.list        凭据列表（掩码 + 指纹 + 状态）
credential.create      新增凭据（登录凭据、API key）
credential.update / credential.delete
credential.test        试一个凭据还能不能用
credential.refresh     强制刷新
balance.get            当前余额
balance.history        余额时间序列
credit.lots            赠金批次（永久/到期标记、到期倒计时）
usage.summary          按窗口/上游/模型聚合
usage.events           明细
usage.timeline         时间序列
benefit.status / benefit.runNow
catalog.models         模型目录 + agent id ↔ 客户端 id 映射
log.tail               auth.log 检索
```

**映射到 proto**（方法名与语义不变，只是从 JSON-RPC 的点号名变成 service + rpc）：

```protobuf
package buddy.admin.v1;

service AdminService {
  rpc GetSystemStatus(GetSystemStatusRequest) returns (GetSystemStatusResponse);
  rpc RestartSystem(RestartSystemRequest) returns (RestartSystemResponse);
  rpc ListUpstreams(ListUpstreamsRequest) returns (ListUpstreamsResponse);
  rpc SetUpstreamEnabled(SetUpstreamEnabledRequest) returns (SetUpstreamEnabledResponse);
  rpc ListConfig(ListConfigRequest) returns (ListConfigResponse);
  rpc SetConfig(SetConfigRequest) returns (SetConfigResponse);
  rpc ListAccounts(ListAccountsRequest) returns (ListAccountsResponse);
  rpc CreateAccount(CreateAccountRequest) returns (CreateAccountResponse);
  rpc UpdateAccount(UpdateAccountRequest) returns (UpdateAccountResponse);
  rpc DeleteAccount(DeleteAccountRequest) returns (DeleteAccountResponse);
  rpc ListCredentials(ListCredentialsRequest) returns (ListCredentialsResponse);
  rpc CreateCredential(CreateCredentialRequest) returns (CreateCredentialResponse);
  rpc UpdateCredential(UpdateCredentialRequest) returns (UpdateCredentialResponse);
  rpc DeleteCredential(DeleteCredentialRequest) returns (DeleteCredentialResponse);
  rpc TestCredential(TestCredentialRequest) returns (TestCredentialResponse);
  rpc RefreshCredential(RefreshCredentialRequest) returns (RefreshCredentialResponse);
  rpc GetBalance(GetBalanceRequest) returns (GetBalanceResponse);
  rpc BalanceHistory(BalanceHistoryRequest) returns (BalanceHistoryResponse);
  rpc ListCreditLots(ListCreditLotsRequest) returns (ListCreditLotsResponse);
  rpc UsageSummary(UsageSummaryRequest) returns (UsageSummaryResponse);
  rpc UsageEvents(UsageEventsRequest) returns (UsageEventsResponse);
  rpc UsageTimeline(UsageTimelineRequest) returns (UsageTimelineResponse);
  rpc GetBenefitStatus(GetBenefitStatusRequest) returns (GetBenefitStatusResponse);
  rpc RunBenefitNow(RunBenefitNowRequest) returns (RunBenefitNowResponse);
  rpc ListModels(ListModelsRequest) returns (ListModelsResponse);
  rpc TailLog(TailLogRequest) returns (TailLogResponse);
}
```

- 契约单一来源：`proto/buddy/admin/v1/admin.proto`。`buf generate` 出各语言代码；`buf breaking --against '.git#branch=main'` 守演进
- 自描述能力由 protobuf 提供（descriptor + reflection），不再需要 `shared/contract.ts` 这类手工契约文件
- **不要**为「支持批量」或 notification 加 RPC：Connect 已有自己的批量与流语义，混进来只会让 schema 变形

### 4.5 契约与代码生成：跨语言 DSL 方案

**约束（2026-10-22 追加）**：后端可能是 Go 或 TS，前端可能是 TS / Dart / Swift / Kotlin。

**这一条推翻了「TS 泛型零 codegen」方案** —— TS 泛型跨不了语言。契约必须是语言中立的 schema + 多语言 codegen。

#### 候选方案

| 方案 | DSL 形态 | 五语言 codegen | 服务端 codegen | 传输 | 结论 |
|---|---|---|---|---|---|
| **Protobuf + buf** | `.proto` | ✅ 全覆盖 | connect-go / connect-node | Connect | **推荐** |
| OpenAPI + openapi-generator | `openapi.yaml` | ✅（Kotlin/Swift 模板较啰嗦） | ogen (Go) / 手写 (TS) | HTTP REST | 最轻，但丢了 RPC 语义 |
| GraphQL SDL | `.graphqls` | ⚠️ TS/Go 好；Dart 走文档式 codegen；Kotlin/Swift 走 Apollo | gqlgen (Go) / yoga (TS) | HTTP POST + WS | 范式与 JSON-RPC 差最远 |
| OpenRPC | `openrpc.json` | ❌ Dart/Swift/Kotlin 基本没有 | 无 | JSON-RPC 2.0 | 单语言才成立 |
| ts-rest / tRPC | TS + zod | ❌ 只覆盖 TS | TS | HTTP | 跨语言条件下出局 |

#### 已验证的生态事实（2026-10）

- **buf v2**：`buf.gen.yaml` v2（`clean: true`、`managed:` 模式）、BSR 远程插件（版本锁定，免装本地 protoc 插件）、**generated SDKs** 覆盖 npm / Maven / Gradle / go / pip / NuGet / SwiftPM / CocoaPods / Cargo / 归档包；`buf lint` / `buf breaking --against` / `buf format` 三件套管 schema 演进；核心 CLI 不需要 BSR 账号
- **ProtoJSON** 是有规范的跨语言映射：Go `protojson`、Dart `dart-lang/protobuf`（`writeToJsonMap` / `readFromJsonMap`）、Swift `SwiftProtobuf`（`serializeJSON()` / `init(json:)`）、TS `@bufbuild/protobuf`、Kotlin `protobuf-kotlin` / `kotlinx.serialization`
- **Connect-ES v2**：把 `protoc-gen-connect-es` 合并进 `protoc-gen-es` v2 —— service 描述烤进 `*_pb.ts`，客户端用 `createClient(Service, transport)` 运行时构造
- **Connect 官方 SDK 强在 Go / TS**；Dart / Swift / Kotlin 是 BSR 上的社区实现（这三家的**官方**强项是 gRPC 系：grpc-dart / grpc-swift / grpc-kotlin）
- **gqlgen**（Go schema-first codegen：modelgen / resolvergen / federation 三个内置插件）、**graphql-yoga**（runtime-agnostic HTTP handler）、**Apollo iOS / Apollo Kotlin**（schema 式类型化客户端，移动端最强故事）

**推荐落法（已定案）**：protobuf 作为 schema，Connect 作为传输

`.proto` 里的 `service` 块天然就是「RPC 方法表」，`buf generate` 一次产出台服务端桩 + 五个语言的客户端 —— 这正是「写 DSL，生成前后两段」的字面实现。

```protobuf
service AdminService {
  rpc ListAccounts(ListAccountsRequest) returns (ListAccountsResponse);
  rpc CreateCredential(CreateCredentialRequest) returns (CreateCredentialResponse);
  rpc UsageSeries(UsageSeriesRequest) returns (UsageSeriesResponse);
}
```

- **Go 后端**：`connect-go`，生成 handler 接口，实现即可
- **TS 后端**：`@connectrpc/connect-node`；Koa 没有官方适配器，但 connect-node 的 handler 是裸 http handler，用 `ctx.req` / `ctx.res` 包一层约 30 行即可
- **TS 面板**：`@connectrpc/connect-web` + TanStack Query 自己包一层 hook
- **Dart / Swift / Kotlin**：Connect 社区 SDK（或 grpc-dart / grpc-swift / grpc-kotlin，但浏览器侧要 gRPC-Web，不如 Connect 统一）

**代价**：Connect 是自己的协议，**JSON-RPC 2.0 那层信封已放弃**（2026-10-22 决定）。如果将来要恢复，两条路：

| | 保 JSON-RPC 2.0 | 放弃（走 Connect，已选） |
|---|---|---|
| 消息类型 | ProtoJSON 承载 | protobuf 承载 |
| 客户端 | 每语言手写约 40 行分发器 | codegen 生成，五语言全覆盖 |
| 生态 | 无标准工具 | buf + BSR 全套 |
| 适用 | 需要 MCP 式兼容 / 同一信封复用到 agent 侧 API | 面板 + 原生客户端 |

#### 一个几乎照抄的先例

Glyphoxa 的 ADR-0039 / ADR-0015 就是这个形状：buf + connect-go + protoc-gen-es v2，浏览器走 Connect-JSON「让 network tab 保持人类可读」，事件流单独用 SSE 划出去。它同样把 Directus / GraphQL 以类似理由否掉。

#### SSE 事件流照旧划出去

Connect 的服务端流没有 EventSource 语义（`Last-Event-ID`、代理兼容性都缺），所以事件流仍走独立的 `GET /admin/events`（SSE），帧用 JSON-RPC notification 形状。与 4.2 的决定一致。

#### 工程约束

- **生成物要提交进仓库**（容器内没有构建步骤）。TS 侧的 `_pb.ts` + service 描述进版本库，Go 侧在 `go generate` 时产出或也提交
- **CI 挂 `buf breaking --against '.git#branch=main'`**，schema 演进有守卫（这比 JSON-RPC 裸手写强得多）
- **`.proto` 比 zod 啰嗦**：字段编号不能复用、`reserved` 要写、`oneof`/`map` 的表达比 zod 费劲。`buf format` + `buf lint` 能兜住大半
- **admin-token 之类不进 schema**：鉴权是 header，不是消息字段

### 4.6 用量观测

- 数据已在方言层产出，**只差落库**：在「方言层最终结果出口」挂 `recordUsage()`，一次请求一条 `usage_event`
- 字段要点：`model` 记上游真实 id、`agent_model` 记 agent 写的 id、`client` 记模拟的是哪个桌面客户端、`dialect` 记来话方言、`status`/`error` 记失败
- 聚合：`usage_daily` 长期保留，原始 `usage_event` 保留 N 天（可配，默认 30 天）
- 量级：一条约 200 字节，1 万请求/天 ≈ 2MB/天，SQLite 毫无压力

### 4.7 余额观测

- `balance_snapshot`：账户、时点、余额、币种 → 历史曲线
- `credit_lot`：赠金批次（类型、金额、到期、永久标记、来源）→ 到期倒计时和「花哪批」
- 采集：面板动作触发 + 定时（`lib/benefits.ts` 的 runner 顺带做）
- 已知坑（2026-10-21 实测）：平台的 `summary.expiringBalanceCny` 把永久赠额也算成会过期，金额要按批次自己算；平台用 `2099-12-31` 标记「永不过期」；选账号用 `summary.nextExpiryAt`

### 4.8 前端模板：套哪个的结构和 CSS

三个 shadcn 系模板都 clone 下来实际看过（MIT，可商用可改）：

| 模板 | 栈 | 与本项目选型的契合 | CSS 体量 | 结论 |
|---|---|---|---|---|
| **satnaing/shadcn-admin** | React 19.2 + Vite 8 + TS 6 + Tailwind v4.2 + **TanStack Router/Query/Table** + RHF + zod 4 + recharts + zustand | **完全对齐**（TanStack 三件套齐全） | `index.css` 87 行 + `theme.css` 102 行 | **主选** |
| shadcndashboard/shadcndashboard | React 19.2 + Vite 8 + Tailwind v4.2 + **Base UI** + TanStack Table + **react-router 7** + **SWR** + TipTap + msw | Query/Router 都不是 TanStack 系 | `globals.css` 346 + `style-lyra.css` 1344 | 备选 |
| shadcnstore/shadcn-dashboard-landing-template | React + Vite + Base UI + TanStack Table + react-router-dom + tweakcn 主题定制器 | 同上 | 中等 | 只取它的主题定制器思路 |

非 shadcn 系（对照后排除）：`react-admin`（MIT，MUI 强绑定，重写皮肤成本高）、`ant-design-pro`（MIT，antd 全家桶）、`tabler`（MIT，`@tabler/core` 1.7.0 —— 但**没有 `@tabler/react`**，只有静态 HTML 模板，套不到 React 面板上）。

#### 主选 satnaing/shadcn-admin 的具体取法

**目录骨架**（237 个源文件，`features/<domain>/` 切分方式与三个页面吻合）

```
src/
  features/<domain>/        凭据管理 / 用量 / 余额 各一个
    components/             表格、列定义、行操作、对话框
    data/                   schema.ts + 数据源
  routes/                   TanStack Router 文件路由
    _authenticated/         带鉴权的路由组
  components/
    layout/                 app-sidebar / header / nav-group / nav-user / team-switcher / top-nav
    data-table/             toolbar / column-header / faceted-filter / bulk-actions / pagination / view-options
    ui/                     30 个 shadcn 组件
  styles/                   index.css + theme.css
  hooks/                    use-table-url-state.ts 等
```

**CSS 怎么套**：`theme.css` 就是标准 shadcn token，只是写成 **oklch** 并补了 sidebar token 组（`--sidebar`、`--sidebar-primary`、`--sidebar-accent`…），直接抄；`index.css` 的 base layer 抄（`@custom-variant dark`、`border-border outline-ring/50`、滚动条、`@utility no-scrollbar`）。

**组件不要抄文件，用 shadcn CLI 重生成**：`components.json` 可直接参考（`style: new-york`、`baseColor: slate`、`cssVariables: true`、`css: src/styles/index.css`、alias 指向 `@/components`）。`src/components/ui/` 里那 30 个是 shadcn 官方源码，`npx shadcn@latest add <name>` 更稳，避免版本漂移。sidebar 是 shadcn 的 block，同样用 CLI 拿。

**要摘掉的部分**

- `@clerk/react` 依赖 + `src/routes/clerk/` 整个目录 —— 我们用 Bearer token，不用 Clerk
- `src/features/{tasks,chats,dashboard,settings,auth,errors}` 基本是 demo，删
- `src/features/users/data/schema.ts` 的 zod schema **不要抄** —— 那就是「手工契约」，我们已经有 protobuf 生成的类型了
- faker mock（`data/users.ts`，500 行固定种子）换成 Connect 客户端调用

**最值钱的一个零件**：`hooks/use-table-url-state.ts` —— 把分页、每页条数、列筛选、全局搜索同步到 URL（TanStack Router 的 search 参数）。「用量明细 + 分页 + 按上游/模型筛选」这类页面直接白拿，刷新和分享链接都保状态。

**次值钱**：测试基建（vitest 4 + playwright 浏览器模式 + vitest-browser-react），面板交互能写测试。

## 五、重构落地后的复核与接缝

### 5.1 计划对内部结构的依赖

| 计划项 | 依赖重构后的内部结构吗 |
|---|---|
| P0 SQLite 骨架 + config 表 | 否 |
| P1 account/credential 表与数据迁移 | 表结构否；写入点（各 auth 模块）是 —— 见 5.2 的边界 1 |
| P2 用量与余额记录 | 挂载点会移动 —— 见 5.2 的边界 3 |
| P3 契约层（proto + Connect） | 否（纯新增） |
| P4 面板前端 | 否（只看生成的客户端） |
| P5 `/health` 收口 | 弱依赖（`/health` 的形状可能变） |

### 5.2 三条接口边界（重构与计划之间的缝）

1. **凭据存储边界**：`credentialStore.get(accountId, kind)` / `.put(...)` / `.list(...)`。auth 模块不再直接碰文件或数据库，只认这个接口。P1 的迁移与重构可以各自推进。
2. **配置边界**：`config.get(key)`，启动时读一次。模块不再自己调 `readEnv*`，由 `lib/config.ts` 在启动时把 SQLite + env 合并成一份快照。
3. **用量事件出口**：响应完成后产出 `{model, agentModel, dialect, client, tokens{in,out,cached,reasoning}, latencyMs, status, error}`。无论重构把方言层改成什么样，P2 只依赖这个形状。

### 5.3 重构完成后要重新核对的清单

从第二节的事实表派生，逐条重验：

- [ ] 网关框架是否还是 Koa、路由是否还是 `@koa/router`、静态托管（SPA fallback）怎么做
- [ ] 凭据现在落在哪（文件？数据库？），会话是否还是 0600 文件 + 锁文件
- [ ] `readEnv*` 调用点还剩多少、哪些键在启动时读
- [ ] 用量在哪个出口产出（`response.ts` / `stream.ts` 是否还在、形状是否变）
- [ ] `/health` 的形状与是否挂鉴权
- [ ] 部署形态是否仍是单容器 + `./data:/data` + `restart: unless-stopped`
- [ ] `.env` 的播种规则是否还成立（哪些键是白名单）
- [ ] 是否引入了新的配置来源（会与 SQLite 播种打架）

## 六、落地顺序

**不与重构并行：先重构落地，再规划前端管理。**

| 阶段 | 内容 | 产出 |
|---|---|---|
| R | 等重构落地 | — |
| R1 | 复核：按 5.3 清单逐条重验事实表，更新本文档 | 事实表对得上新代码 |
| R2 | 配置与凭据的新家：SQLite 表 + 三类配置分层 + `credentialStore` 边界 + 一次性导入脚本 | 后端配置只有一处来源 |
| R3 | 契约与面板后端：`proto/` 定义 + `buf generate` + Connect handler（TS/Go 任选）+ SSE 事件流 + 面板鉴权 | 前后端有类型化契约 |
| R4 | 面板前端：shadcn 骨架 + 凭据管理 / 用量 / 余额 三页 | 能用 |
| R5 | 收口 `/health` 到面板鉴权下 | 补上公开敞口 |

- 若重构本身已经做了配置抽象，R2 只剩「凭据入库」和「面板要写的那部分配置」
- R2 之后 R3 与 R4 可并行：R3 纯新增路由，R4 只看契约，都不依赖 R2 的表结构细节
- 顺序理由：面板要的是数据，数据要 SQLite 模型。先写 UI 只会得到一堆 mock 屏

## 七、风险与待定

1. **空配置状态要自圆其说**：库为空时服务要起来、代理端点要明确说「还没配置」（不是 500、不是静默回退），这个状态是网页端配置的前提
2. **导入脚本要幂等**：一次性导入命令可能被重复跑，必须能重跑且不产生重复行；导入后 env 里的业务键要清掉，免得以后有人改 env 以为生效
3. **迁移期双轨**：会话文件与 SQLite 同时存在时，「一边刷新一边迁移」会分裂。迁移要停写、导出、导入、校验、再切换，旧文件留只读备份
4. **密钥集中**：现在凭据散在各文件里，0600；进 SQLite 后集中在一个文件。建议文件 0600 + 可选用 `identity.salt` 派生密钥加密 `secret` 列
5. **真多写风险只有一个**：NAS 上的代理与本机的 MiniMax Code 桌面端持有同一账号的 refresh token，两边都刷新会互相踢下线（2026-10-21 事故）。SQLite 的事务锁能解决同机多进程，解决不了跨机器
6. **优雅退出的副作用**：`system.restart` 走进程退出 → 容器重启 → 面板在重启窗口内不可达。要有明确的前端提示与重连逻辑
7. **Koa 静态托管与 SPA fallback**：`koa-static`（MIT）或手写流式
8. **`/health` 公开**：R5 收口
9. **生成物要进仓库**：容器内无构建步骤，`proto/` 生成的各种语言代码必须提交；CI 用 `buf breaking` 守住 schema 演进
10. **`.proto` 的表达力比 zod 弱**：字段编号不可复用、`reserved` 要写、`oneof`/`map` 更费劲。`buf format` + `buf lint` 兜住大半，但不能靠类型系统兜住全部
11. **Dart / Swift / Kotlin 的 Connect SDK 是社区实现**：官方强项在 gRPC 系。哪天社区实现跟不上，备选是 grpc-dart / grpc-swift / grpc-kotlin，但浏览器侧要换 gRPC-Web，两套客户端并存
12. **Connect 放弃了 JSON-RPC 2.0 信封**（已接受）。若将来 agent 侧 API 也要复用同一套信封，得重新评估——那时 protobuf 消息 + 手写 JSON-RPC 分发器是备选

## 八、参考

- Refine 官方对比与 v5 文档：<https://refine.dev/core/docs/further-readings/comparison/>
- AdminJS 插件与生产预打包：<https://docs.adminjs.co/installation/plugins/express>
- Vue Vben Admin 文档（5.0 当前版本）：<https://doc.vben.pro/guide/introduction/vben.html>
- shadcn-admin（MIT 骨架）：<https://github.com/satnaing/shadcn-admin>
- Directus 许可证变更公告：<https://directus.com/resources/directus-v12-license-change>
- NocoBase 仓库 LICENSE：<https://github.com/nocobase/nocobase/blob/main/LICENSE.txt>
