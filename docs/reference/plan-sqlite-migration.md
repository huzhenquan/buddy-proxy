# 把凭据搬进 SQLite，health 走缓存

2026-10-22

## 目标

1. 网关自己的凭据不再散成 JSON 文件，全部收进一个 SQLite 库。
2. `/health` 不再实时打上游，答案走缓存。
3. **迁移过程中一个都不用重新登录。**

## 现状

NAS 上的数据卷 `/vol1/<vol>/services/buddy-proxy/data/`：

| 文件 | 是什么 | 谁写 |
|---|---|---|
| `minimax-session.json` | MiniMax Code 的 OAuth 会话 | `lib/minimax/oauth.ts` |
| `qoder-session.global.json` | Qoder 全球区会话 | `lib/qoder/auth.ts` |
| `qoder-session.cn.json` | Qoder 中国区会话 | `lib/qoder/auth.ts` |
| `workbuddy-session.cn.json` | WorkBuddy 中国区会话 | `lib/workbuddy/auth.ts` |
| `tokenrhythm-session.{1,2,3}.json` | 三个中转站账号的 cookie 会话 | `lib/tokenrhythm/accounts.ts` |
| `api-keys.json` | 给客户端用的 API key | `lib/api-keys.ts` |
| `identity.salt` | 设备指纹的 salt | `lib/device-identity.ts` |
| `auth.log` | 凭据事件日志 | `lib/credential.ts` |
| `*.lock` | 刷新时的单写者锁 | `lib/session.ts` |

`.env` 里还有：`TOKEN_RHYTHM_N_ACCOUNT/PASSWORD`、`TOKEN_RHYTHM_N_API_KEY`、
`MINIMAX_TOKEN_PLAN_KEY`。

`/health` 现在每次都打上游：Qoder 两个区各查账号状态和额度、MiniMax 查余额和
token plan、WorkBuddy 查积分、TokenRhythm 查三个租户的余额 —— 一次大概十几次
上游调用，几秒钟。

## 设计

### 一个库

`lib/store.ts`，用 Node 24 自带的 `node:sqlite`（稳定版，不需要编译原生模块）。

```sql
CREATE TABLE IF NOT EXISTS secrets (
  id         TEXT PRIMARY KEY,   -- session:minimax / session:qoder:cn / key:tokenrhythm:1 ...
  kind       TEXT NOT NULL,      -- session | key | account | salt
  data       TEXT NOT NULL,      -- JSON
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS locks (
  id     TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cache (
  id   TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  at   INTEGER NOT NULL
);
```

- `secrets` 放所有凭据 —— 会话、客户端 API key、设备 salt、中转站的账号密码和
  推理 key、MiniMax 的 token plan key。
- `locks` 取代现在的 `.lock` 文件（同样是一把单写者锁，但不再多一个文件）。
- `cache` 放 `/health` 的快照。

库文件：`$BUDDY_DB_PATH`，默认 `<dataDir>/buddy.db`，权限 0600。
WAL 模式，`busy_timeout = 5s`。

### 读写都走库

`lib/session.ts` 的 `readSession` / `writeSession` / `withSessionLock` 换成按 id
读写库。各客户端的 `sessionPath()` 换成 `sessionId()`（`session:qoder:cn` 这样的
字符串），其余逻辑一行不动。

### 迁移：先导入，验证过再删文件

分六步，每一步都能单独回退：

1. **写好库和导入逻辑**，但不动现在的读写路径 —— 这一版不部署。
2. **在 NAS 上跑一次迁移脚本**：把数据卷上的旧文件逐个读进 `secrets` 表。
   **旧文件原地不动**，脚本只写库。
3. **核对**：把库里每一行和原文件逐字节比对（JSON 解析后比对象），数量、字段、
   值都要一样。refresh token 也要一样。
4. **部署新镜像**：它启动时发现库里已经有凭据，直接用；旧文件还在，但已经不
   再被读。
5. **端到端验证**：四个上游各发一次真实请求，确认凭据有效。
6. **删旧文件**：`api-keys.json`、五个会话文件、`identity.salt` 全部删掉。
   删完再验证一次，确认没有任何东西依赖文件了。

回退路径：第 6 步之前，旧文件一直都在，随时可以退回旧镜像。第 6 步之后如果
出问题，从 `secrets` 表把内容导回文件即可（迁移脚本反过来跑一遍），不需要重新
登录。

### 刷新时锁的语义不变

`withSessionLock` 现在拿锁失败时，会读一次会话看对方是不是已经刷好了。新版本
一样：锁拿不到就读库里的会话，对方刷好了就直接用。

**关键点：refresh token 每次刷新都会轮换**，所以任何时刻只能有一个持有者在刷。
库不改变这一点，只是把锁从文件挪到了表。

### /health 走缓存

- 本地部分（开关、模型数量、凭据状态）照旧实时算 —— 这些不碰上游，很便宜。
- 上游部分（账号状态、额度、余额）进 `cache` 表，键是 `health:upstreams`。
- 读 `/health` 时：把缓存里的快照贴上去；缓存空或过期就在后台起一次刷新，
  **不阻塞响应**。
- 刷新间隔：`HEALTH_CACHE_MS`，默认 5 分钟。
- 第一次跑（缓存空）时，响应里的上游部分是空的，并提示"正在刷新"。

### .env 里的密钥

`.env` 目前同时是"开关"和"密钥"两样东西。计划：

- 启动时把 `.env` 里的 `TOKEN_RHYTHM_N_ACCOUNT/PASSWORD/API_KEY`、
  `MINIMAX_TOKEN_PLAN_KEY` 导入库（导入后以库为准）。
- 导入完成后 `.env` 只剩开关，可以清空密钥那几行。**这一步由维护者手动做**，
  我不改维护者的 `.env`。

## 改动清单

| 文件 | 改动 |
|---|---|
| `lib/store.ts` | 新增：SQLite 的封装、secrets/locks/cache 三个表 |
| `lib/session.ts` | 读写会话改成走库；锁改成库里的锁；保留旧文件的读法作为迁移期的兜底 |
| `lib/qoder/auth.ts`、`lib/workbuddy/auth.ts`、`lib/minimax/oauth.ts`、`lib/tokenrhythm/accounts.ts` | `sessionPath()` → `sessionId()` |
| `lib/api-keys.ts` | `api-keys.json` → 库 |
| `lib/device-identity.ts` | `identity.salt` → 库 |
| `lib/tokenrhythm/accounts.ts` | 账号密码从 `.env` 改成库里（`.env` 只是导入源） |
| `router-proxy.ts` | `/health` 走缓存 |
| `lib/health-cache.ts` | 新增：快照的存取与后台刷新 |
| `tools/migrate-credentials.ts` | 新增：迁移脚本（本地工具，不进仓库） |

## 风险

| 风险 | 怎么办 |
|---|---|
| 迁移时把 refresh token 弄坏 | 第 3 步逐字节核对；旧文件一直保留 |
| 新库写不进去（权限、挂载） | 启动时检测：库打不开就报错退出，而不是静默丢凭据 |
| 两个进程同时刷新 | 库里的锁和现在一样是单写者 |
| 部署后凭据没了 | 第 4、5 步验证通过之前不删文件 |
| 回退到旧镜像后需要重新登录 | 第 6 步之前不会发生；之后可以反向导出 |

## 不做

- 不做数据库加密（库文件本身 0600，和现在的会话文件一个级别）。
- 不把 `/health` 的本地部分也缓存（本地部分本来就便宜）。
- 不动 `auth.log`（它是日志，不是凭据）。
