# 管理面板：这一轮怎么落地

2026-10-22。这一轮的目标是**先搞一套出来看看**，不是把文档里的全做完。

## 分工

| 谁 | 做什么 | 边界 |
|---|---|---|
| 契约（我写） | `proto/buddy/admin/v1/admin.proto` | 前后端唯一的接缝，谁都不许单方面改 |
| 后端 agent | Connect handler、面板鉴权、20 个方法的实现、静态托管 | 只碰 `lib/admin/`、`router-proxy.ts`、根 `package.json` |
| 前端 agent | `web/` 下的面板 | 只碰 `web/` |
| 前端评审 agent | 看前端的代码，挑毛病 | 只出报告，不改代码 |
| 测试 agent | 端到端跑一遍 | 只出报告 |
| 集成（我做） | Dockerfile 多阶段、前后端接上、部署 | 等你说 |

## 契约

`proto/buddy/admin/v1/admin.proto`，20 个方法，protobuf 定义、Connect 传输。

- 生成物在 `lib/gen/`（**前后端共用一份** ✓），已提交进仓库 ✓ —— 容器里没有构建步骤 ✓
- 改契约：`mise run proto`（重新生成）✓ → `mise run proto:lint` ✓ → `mise run proto:breaking` ✓
- **鉴权不在 schema 里** ✓ —— 它是 `Authorization: Bearer <token>` ✓，令牌在 `/data/admin-token` ✓
- `/health` 保持公开 ✓（外部在调 ✓），面板的接口全部要令牌 ✓

## 工具

`mise` 统一管 ✓ —— 工具版本（node / pnpm / buf）✓、常用命令（build ✓ / test ✓ / deploy ✓ / proto ✓）✓ 全在根 `mise.toml` ✓。

```
mise run serve            起网关
mise run test             离线自测（mock 上游，不花 token）
mise run web:dev          起面板
mise run web:build        构建面板
mise run build            面板 + 镜像
mise run deploy           送到 NAS 并重载
mise run proto            改契约后重新生成
```

## 这一轮不做的

- **用量事件落库** ✓ —— `usage_event` 表没有 ✓，明细先从 `aggregate_usage` 聚合 ✓
- **账号/凭据的数据迁移** ✓ —— 账号先从现有的 secrets 派生视图出来 ✓
- **配置热生效** ✓ —— 改设置要重启 ✓（面板要提示 ✓）
- **面板改数据目录** ✓ —— 留 env ✓
- **`/health` 收口** ✓ —— 保持公开 ✓

## 面板令牌（2026-10-22 维护者定）

- **面板上永远不显示令牌** ✓
- **第一次启动**：读不到 `/data/admin-token` ✓ → 生成一个 ✓ → 落文件（0600 ✓）✓ → **把完整令牌打进日志** ✓ ✓
- **之后的启动**：文件在 ✓ → 不打日志 ✓ ✓
- 用户自己去文件里扒 ✓ ✓

所以令牌只在服务第一次起来时露一次面 ✓，之后只有文件里有 ✓ ✓。

## 待决

- 面板的鉴权能不能不要令牌 ✓ —— 单用户自用的话，IP 限制更省事 ✓
