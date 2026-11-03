# 契约要补的洞（前端 agent 报上来的）

前端 agent 列了 13 条。我判一下：**现在补**还是**下一轮**。

## 现在补（加字段/加注释，向后兼容，不破坏后端已写的代码）

| # | 改什么 | 为什么 |
|---|---|---|
| 1 | `BalanceSummary` 加 `upstream_id` | 前端最要紧的一条：多上游时说不清余额是谁的 |
| 2 | `ListUsageEventsRequest` 加 `before_id` | 明细页现在只能拉一段再在客户端切页 |
| 3 | `GetUsageSummaryRequest.window` 改成 enum | 注释写「按天/按小时」但没定义取值，前端在猜 |
| 4 | `UsageEvent` 加 `client` | 设计文档 5.2 说用量事件要带「模拟的是哪个桌面客户端」，契约里只有 dialect |
| 5 | `Account` 加 `balance` | 设计文档 4.4 写的是「账号列表（凭据数量、余额摘要）」 |
| 6 | `Upstream` 加 `base_url` + `region` | 「上游」页现在改地址得跳到配置页 |
| 7 | `ListCredentialsRequest.account_id` 写清语义 | 空串 = 全部（现在前端必须先选账号） |
| 8 | `ConfigItem.fallback` 写清语义 | 是这个键的默认值，不是上一个来源的值 |
| 9 | `PublishedTarget.requests/failed` 标注只读 | 保存时会被忽略，前端保存只能写 0 |
| 10 | `SavePublishedModelRequest.model.id` 写清语义 | 空 = 新建，非空 = 改 |

## 下一轮（不是加字段能解决的）

| # | 什么 | 为什么现在不做 |
|---|---|---|
| 11 | 账号/凭据的增删改（6 个方法） | 面板现在只能看、试、刷新。增删改要牵动存储层，下一轮 |
| 12 | SSE 事件流（`GET /admin/events`） | 用量和余额现在是打开页面拉一次，不实时。做 SSE 要先定事件形状 |
| 13 | 重启中的状态 | 容器重启那几秒面板本来就连不上，轮询能覆盖 |
| 14 | 账号/凭据的数据迁移 | 账号先从现有的 secrets 派生视图出来 |

## 应用顺序

1. 等后端 agent 交卷（它在按旧契约写代码）
2. 改 `proto/buddy/admin/v1/admin.proto`
3. `mise run proto` 重新生成（`lib/gen/`）
4. `mise run proto:lint`
5. 派一个前端 agent 的后续：按新契约适配
6. 后端 agent 的后续：把新字段填上
