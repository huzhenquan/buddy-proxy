# 2026-10-22 — Koa 迁移后所有流式响应返回 HTTP 404（opencode session 中断的直接原因）

## 现象

opencode 在本仓库工作时 turn 频繁被杀，常见于 build 过程中，界面上没有明显报错。
opencode.db 里每次中断都记着 idle 事件 outcome=failed：

  provider.invalid-request — Provider request failed with HTTP 404: event: message_start\ndata: {...}

时间点全部落在 10-22 10:25:50-10:27:40（三连失败），与今日 10:25 部署到 NAS 的新容器完全重合；
切到 minimax-tokenplan（直连官方 API，不经过 router）后不再出现。

## 根因

不是上游问题——MiniMax / TokenRhythm 都正常。是 a4e4838（Koa 迁移）的回归：

- Koa 3.2.1 handleRequest() 对每个请求初始化 res.statusCode = 404
  （node_modules/koa/lib/application.js:200）。
- router 的流式路径（deliverAnthropicStream / deliverOpenAIStream / deliverOpenAIChunks，
  lib/router/deliver.ts）走 takeOver(ctx)（ctx.respond = false）+ sseHead(ctx)，
  而 sseHead 只 setHeader + flushHeaders()，从不设 ctx.status。
- 头部在 flush 时刻就以 404 发出去了，随后 SSE 帧照常写入。客户端看到「404 + 完整流」，
  opencode 的 SDK 校验状态码直接抛错，turn 终止——错误体里还夹着正常的 message_start 流文本。

最小复现（Koa 3.2.1 + respond=false + flushHeaders）：HTTP/1.1 404 + text/event-stream。
curl 实测 NAS 上 /minimax/v1/messages 与 /tokenrhythm/v1/chat/completions 流式请求均为 404，
SSE 内容完整正常。test/e2e.sh 的注释 "a good body under a wrong status is a failure that a
body-only check misses" 正是防这个，但部署后没有跑过流式状态检查。

## 修复方向

在 lib/router/deliver.ts 的 sseHead() 里补 ctx.status = 200（覆盖全部三个 deliver* 路径），
部署后跑 test/e2e.sh 验证流式响应状态为 2xx。

## 该 session 更早的其他中断原因（opencode.log "Failed to drain Session"，10-13~10-21）

| 原因 | 次数 | 天 |
|---|---|---|
| OpenCode free tier 拒绝 | ~300 | 10-13~10-18 |
| rpm exhausted / Rate limit exceeded | ~44 | 10-18~10-20 |
| ModelUnavailableError（provider 改名后模型失配） | ~24 | 10-18~10-21 |
| HTTP 502 / ConnectionRefused / ECONNRESET | ~20 | 10-19~10-21 |
| quota exceeded / Token Plan 用量上限 | ~8 | 10-18~10-19 |
| HTTP 404 | 7 | 10-19、10-22 |

