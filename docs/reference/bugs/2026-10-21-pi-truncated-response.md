# pi 报 "Response was truncated before completion." — bug 报告

日期：2026-10-21
现象归属：pi 客户端 ↔ buddy-proxy 网关（Anthropic 方言）
状态：根因已定位；网关侧已加可观测性；客户端侧是否改动待定

---

## 1. 现象

pi 的 TUI 里，模型回答后面出现一行红字：

```
Response was truncated before completion.
```

不是偶发的模型能力问题，而是**偶发**的：同一段会话里，大部分轮次正常（`stop=toolUse`），个别轮次报这一句。

## 2. 证据

### 2.1 pi 的会话日志

文件：`~/.pi/agent/sessions/--home-sample-projects-sample--/2026-10-18T12-47-27-927Z_01a20000-0000-7000-8000-000000000002.jsonl`

整份会话里 `"stopReason":"length"` 只有两条，都在 `provider: tokenrhythm` 上：

| 行号 | provider | stopReason | output | input | reasoning | content |
|---|---|---|---|---|---|---|
| 4056 | tokenrhythm | length | **1** | 314324 | 1 | thinking "Now" |
| 4065 | tokenrhythm | length | **1** | 301795 | — | 空 |

**output 恰好是 1** —— 模型刚开口就被切断。input 是 31 万量级。

两条都紧跟在上下文变化之后：

```
4053  message  assistant  tokenrhythm  stop=toolUse  out=1122  in=538655
4054  message  toolResult
4055  custom
4056  message  assistant  tokenrhythm  stop=length   out=1     in=314324   ← 失败
4057  custom
4058  custom
4059  context_edit
...
4064  compaction
4065  message  assistant  tokenrhythm  stop=length   out=1     in=301795   ← 失败
```

对照同一会话里正常轮次：

```
4041  assistant  token-rhythm（旧直连）  stop=toolUse  out=770
4044  assistant  tokenrhythm             stop=toolUse  out=3119
4045  assistant  tokenrhythm             stop=toolUse  out=967
4050  assistant  tokenrhythm             stop=toolUse  out=276
4053  assistant  tokenrhythm             stop=toolUse  out=1122
```

### 2.2 网关侧复现

用一条和 pi 探针同形的请求直接打网关：

```
POST /tokenrhythm/v1/messages
{"model":"deepseek-v4.1-flash-1017","max_tokens":1,"stream":true,
 "thinking":{"type":"enabled","budget_tokens":1024},
 "messages":[{"role":"user","content":"hi"}]}
```

响应：

```
event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"max_tokens",...},
       "usage":{"input_tokens":31,"output_tokens":1,"output_tokens_details":{"thinking_tokens":1}}}
```

`output_tokens: 1` + `stop_reason: max_tokens` —— 与 pi 会话日志里的失败条目完全一致。

---

## 3. 根因链路

七步。每一步都能在源码里对上。

### 第 1 步：pi 发了一个"只要 1 个 token"的请求

pi 有一个**提示词缓存预热器**。上下文变化后（压缩、编辑、模型切换），它会发一条请求去让上游把当前前缀缓存起来 —— 而这条请求**故意只要 1 个 token**，因为它的目的只是触发缓存，不是拿回答。

源码：`@earendil-works/pi-coding-agent/dist/core/cache-warmer.js:235-245`

```js
const message = await this.models
    .streamSimple(run.model, run.context, {
    ...run.options,
    maxTokens: 1,          // ← 就是这里
    maxRetries: 0,
    signal: run.controller.signal,
})
    .result();
```

注意 `maxTokens: 1` 是**无条件覆盖**在调用方选项之上的 —— 不管调用方要多少。

### 第 2 步：思考预算被压成 0

同一个客户端里有一个"思考预算要能装进输出上限"的调整函数。

源码：`@earendil-works/pi-ai/dist/api/simple-options.js:43-72`

```js
/** Tokens always left for the answer when a thinking budget shares the response ceiling. */
export const MIN_ANSWER_TOKENS = 1024;

export function clampThinkingBudgetToAnswerRoom(thinkingBudget, ceiling) {
    return Math.min(thinkingBudget, Math.max(0, ceiling - MIN_ANSWER_TOKENS));
}

export function adjustMaxTokensForThinking(
    baseMaxTokens, modelMaxTokens, reasoningLevel, customBudgets) {
    let thinkingBudget = thinkingBudgetForLevel(reasoningLevel, customBudgets);
    const maxTokens = baseMaxTokens === undefined ? modelMaxTokens
        : Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);
    if (maxTokens <= thinkingBudget) {
        thinkingBudget = clampThinkingBudgetToAnswerRoom(thinkingBudget, maxTokens);
    }
    return { maxTokens, thinkingBudget };
}
```

代入第 1 步的 `maxTokens = 1`：

- `maxTokens (1) <= thinkingBudget` → 进 `clampThinkingBudgetToAnswerRoom`
- `Math.max(0, 1 - 1024)` = `Math.max(0, -1023)` = **0**
- `Math.min(thinkingBudget, 0)` = **0**

于是思考预算变成 0。

### 第 3 步：0 被 `|| 1024` 兜回 1024

客户端把思考参数写进请求体。

源码：`@earendil-works/pi-ai/dist/api/anthropic-messages.js:773-780`

```js
const adjusted = adjustMaxTokensForThinking(base.maxTokens, model.maxTokens, options.reasoning, options.thinkingBudgets);
const maxTokens = clampMaxTokensToContext(model, context, adjusted.maxTokens);
return stream(model, context, {
    ...base,
    maxTokens,
    thinkingEnabled: true,
    thinkingBudgetTokens: Math.min(adjusted.thinkingBudget, Math.max(0, maxTokens - 1024)),
});
```

注意这里又算了一次 `Math.max(0, maxTokens - 1024)` —— `1 - 1024 = -1023` → 0 → `Math.min(0, 0)` = 0 → **`thinkingBudgetTokens = 0`**。

再往下，构造 `params.thinking` 的地方：

源码：`@earendil-works/pi-ai/dist/api/anthropic-messages.js:1005-1010`

```js
// Budget-based thinking for older models
params.thinking = {
    type: "enabled",
    budget_tokens: options.thinkingBudgetTokens || 1024,   // ← 0 是假值，被兜成 1024
    display,
};
```

`0 || 1024` → **1024**。第 2 步辛苦压成 0 的预算，在这里又被兜回 1024。

于是最终请求是：

源码：`@earendil-works/pi-ai/dist/api/anthropic-messages.js:925-927`

```js
const params = {
    model: model.id,
    messages: ...,
    max_tokens: options?.maxTokens ?? model.maxTokens,   // ← 1
    stream: true,
    ...
};
```

即 `max_tokens: 1` + `thinking: {type: "enabled", budget_tokens: 1024}` —— 预算比上限还大，本身就不是一个合法的 Anthropic 请求。

实测抓到的 pi 原始请求（指向本地记录器抓包）证实了这一点：

```
=== POST /v1/messages?beta=true
max_tokens: 384000 | thinking: {"type":"enabled","budget_tokens":8192,"display":"summarized"} | stream: true
```

（那是普通轮次；探针轮次是 `max_tokens: 1` + `budget_tokens: 1024`。）

### 第 4 步：网关如实转发

网关把 Anthropic 方言转成上游的 OpenAI 方言。

源码：`lib/dialect/request.ts:42-46`

```ts
export function anthropicToOpenAI(body: Json): Json {
  const out: Json = {};
  if (body.model) out.model = body.model;
  if (typeof body.max_tokens === "number") out.max_tokens = body.max_tokens;   // ← 1 原样带走
```

源码：`lib/dialect/request.ts:118-119`

```ts
  if (body.thinking?.type === "enabled") {
    out.reasoning_effort = effortFromBudget(body.thinking.budget_tokens);
  }
```

源码：`lib/dialect/request.ts:125-131`

```ts
/** Anthropic thinking budget → OpenAI reasoning effort. */
export function effortFromBudget(budget: unknown): string {
  const n = typeof budget === "number" ? budget : 0;
  if (n <= 1024) return "low";
  if (n <= 8192) return "medium";
  return "high";
}
```

`budget_tokens = 1024` → `effortFromBudget(1024)` → **"low"**（`n <= 1024` 命中）。

所以上游收到的是：

```json
{"model":"deepseek-v4.1-flash-1017","max_tokens":1,"reasoning_effort":"low", ...}
```

**网关没有做错任何事**：客户端说"给我 1 个 token"，网关就转达了"给我 1 个 token"。

### 第 5 步：上游给 1 个 token，并说"我到这里停了"

中转站（DeepSeek V4.1 Flash）的行为是正确的：输出上限 1 个 token，它就输出 1 个 token，然后 `finish_reason: "length"`。

这是 OpenAI 方言里"撞到 max_tokens 了"的标准说法。

### 第 6 步：网关如实翻译回 Anthropic 方言

源码：`lib/dialect/stream.ts:148`

```ts
const stopReason = choice.finish_reason === "length" ? "max_tokens"
  : choice.finish_reason === "tool_calls" ? "tool_use"
  : "end_turn";
```

`"length"` → **`"max_tokens"`**。这正是 Anthropic 方言里对应"因为输出上限而停止"的说法。

网关同样没有说谎：客户端要 1 个 token，拿到 1 个 token，停止原因是"达到上限"。

### 第 7 步：pi 把它当成正式回答，并渲染成错误

pi 的 Anthropic 客户端把 `stop_reason` 映射成自己的 `stopReason`。

源码：`@earendil-works/pi-ai/dist/api/anthropic-messages.js:1332-1340`

```js
function mapStopReason(reason, stopDetails) {
    switch (reason) {
        case "end_turn":
            return { stopReason: "stop" };
        case "max_tokens":
            return { stopReason: "length" };     // ← 这里
        case "tool_use":
            return { stopReason: "toolUse" };
        ...
```

再由 TUI 渲染。

源码：`@earendil-works/pi-coding-agent/dist/modes/interactive/components/assistant-message.js:138-141`

```js
if (message.stopReason === "length") {
    this.contentContainer.addChild(new Spacer(1));
    this.contentContainer.addChild(
        new Text(theme.fg("error", "Response was truncated before completion."), this.outputPad, 0),
    );
}
```

**这就是那句红字的出处。**

### 链路总览

| # | 位置 | 发生了什么 | 是谁的问题 |
|---|---|---|---|
| 1 | pi `cache-warmer.js:241` | 发 `maxTokens: 1` 的探针 | pi（设计如此） |
| 2 | pi `simple-options.js:60-70` | 思考预算被压成 0 | pi |
| 3 | pi `anthropic-messages.js:780,1008` | 0 被 `\|\| 1024` 兜成 1024 | pi |
| 4 | 网关 `lib/dialect/request.ts:45,119` | 如实转发 `max_tokens=1` | 网关（正确） |
| 5 | 上游 | 给 1 个 token，`finish_reason=length` | 上游（正确） |
| 6 | 网关 `lib/dialect/stream.ts:148` | 如实翻译成 `stop_reason=max_tokens` | 网关（正确） |
| 7 | pi `anthropic-messages.js:1336` + `assistant-message.js:140` | 认成 `length`，TUI 显示红字 | pi |

**责任在 pi 一侧**：探针请求被当成正式回答记录进会话，并按"回答被截断"渲染。网关的行为从头到尾是忠实的。

---

## 4. 为什么旧的直连配置不触发

旧配置（直连中转站）是 `api: "openai-completions"`，而 pi **自带的 DeepSeek 条目**也是这么配的：

源码：`@earendil-works/pi-ai/dist/providers/data/deepseek.json`

```json
"chat:deepseek-flash": {
  "id": "deepseek-flash", "name": "DeepSeek V4.1 Flash",
  "api": "openai-completions", "baseUrl": "https://api.deepseek.com",
  "reasoning": true,
  "thinkingLevelMap": {"minimal":null,"low":"low","medium":null,"high":"high","max":"max"},
  "contextWindow": 1000000, "maxTokens": 384000,
  "compat": {"supportsStore":false,"supportsDeveloperRole":false,"maxTokensField":"max_tokens",
             "requiresReasoningContentOnAssistantMessages":true,"thinkingFormat":"deepseek","supportsStrictMode":true}
}
```

关键差别在 pi 的 Anthropic 客户端会给消息打**缓存标记**：

源码：`@earendil-works/pi-ai/dist/api/anthropic-messages.js:921`

```js
const converted = convertMessages(conversationMessages, isOAuthToken, cacheControl, ...);
```

抓到的真实请求里能看到：

```
messages: user:[{"type":"text","text":"...","cache_control":{"type":"ephemeral"}}]
```

有了 `cache_control`，pi 认为这个 provider 支持提示词缓存、缓存经济学成立，于是**跑缓存预热**；预热探针的截断就露出来了。

走 `openai-completions` 时 pi 不打这个标记，warmer 的经济判断不成立，探针不会跑（或者跑不出来），因此看不到这个报错。

---

## 5. 网关侧做了什么

### 5.1 可观测性（已部署）

这次定位靠翻 pi 的会话日志 + 读 pi 源码，网关自己的日志里什么都没有。按 AGENTS.md 的要求（"排查问题优先查日志定位原因"、"解决问题后要复盘这个问题能不能通过提前加日志解决"），网关现在会把这件事记下来。

`lib/router/upstreams.ts`：

```ts
function noteTruncation(body: Record<string, any>, model: string, tenant: number): void {
  const asked = typeof body.max_tokens === "number" ? body.max_tokens : null;
  console.log(
    `[TRUNCATED] model=${model} tenant=${tenant} asked_for=${asked ?? "unset"} tokens — ` +
      `the upstream stopped at the limit the client set`,
  );
}
```

`lib/router/deliver.ts` 新增 `watchFinish()`，在解析上游分片时把 `finish_reason` 透出来：

```ts
async function* watchFinish(
  chunks: AsyncIterable<Record<string, any>>,
  onFinish?: (reason: string) => void,
): AsyncGenerator<Record<string, any>> {
  for await (const chunk of chunks) {
    const reason = chunk?.choices?.[0]?.finish_reason;
    if (reason && onFinish) onFinish(String(reason));
    yield chunk;
  }
}
```

两条路都覆盖了（OpenAI 方言透传与 Anthropic 方言转换）。

实测输出：

```
[TRUNCATED] model=deepseek-v4.1-flash-1017 tenant=2 asked_for=1 tokens — the upstream stopped at the limit the client set
```

下次再遇到，网关日志一行就能说明"是客户端只要 1 个 token"，不必再去翻客户端的会话文件。

### 5.2 没有改语义（刻意）

网关**没有**把这个 `stop_reason` 改成 `end_turn`，也没有把 `max_tokens=1` 拦下来。理由：

- 客户端明确要了 1 个 token，上游确实只给了 1 个 token，如实转述是正确的；
- 把它伪装成"正常结束"会让客户端以为拿到了完整回答，是更糟的失败；
- 拦下来（自己造一个 1 token 的回答）会让上游的缓存预热失效 —— 预热的目的正是让上游缓存住这个前缀。

---

## 6. 待定：客户端侧

可选做法：把 TokenRhythm 在 pi 里改回 `openai-completions`（与 pi 自带 DeepSeek 条目一致），thinking 靠 `compat` 那套：

```json
"compat": {
  "maxTokensField": "max_tokens",
  "requiresReasoningContentOnAssistantMessages": true,
  "thinkingFormat": "deepseek"
}
```

- 好处：pi 不打 `cache_control` → warmer 不触发 → 报错消失
- 代价：思考的呈现要靠 `compat`（`reasoning_content`），而不是 Anthropic 的 thinking 块；网关的 `restoreReasoningContent` 已经会补 `reasoning_content`，所以往返是通的

另一条路：等 pi 修 `|| 1024` 与 `maxTokens: 1` 的交互（预算为 0 时不该兜成 1024；探针不该被当作正式回答记入会话）。

---

## 7. 附：涉及的全部源码位置

**pi**（`~/.pi/agent/install/releases/1.3.0/node_modules/@earendil-works/`）

| 文件 | 行 | 作用 |
|---|---|---|
| `pi-coding-agent/dist/core/cache-warmer.js` | 235-245 | 缓存预热器，`maxTokens: 1` |
| `pi-ai/dist/api/simple-options.js` | 43-72 | `adjustMaxTokensForThinking` / `clampThinkingBudgetToAnswerRoom` |
| `pi-ai/dist/api/anthropic-messages.js` | 773-780 | 预算与上限的第二次夹取 |
| `pi-ai/dist/api/anthropic-messages.js` | 925-927 | 请求体的 `max_tokens` |
| `pi-ai/dist/api/anthropic-messages.js` | 1005-1010 | `budget_tokens: ... \|\| 1024` |
| `pi-ai/dist/api/anthropic-messages.js` | 921 | 消息上的 `cache_control` |
| `pi-ai/dist/api/anthropic-messages.js` | 1332-1340 | `stop_reason` → `stopReason` |
| `pi-coding-agent/dist/modes/interactive/components/assistant-message.js` | 138-141 | 红字渲染 |
| `pi-ai/dist/providers/data/deepseek.json` | — | pi 自带 DeepSeek 条目（OpenAI 方言 + deepseek compat） |

**网关**（本仓库）

| 文件 | 行 | 作用 |
|---|---|---|
| `lib/dialect/request.ts` | 42-46 | `anthropicToOpenAI` 带走 `max_tokens` |
| `lib/dialect/request.ts` | 118-119 | 思考预算 → `reasoning_effort` |
| `lib/dialect/request.ts` | 125-131 | `effortFromBudget` |
| `lib/dialect/stream.ts` | 148 | `finish_reason` → Anthropic `stop_reason` |
| `lib/router/deliver.ts` | — | `watchFinish`（新增） |
| `lib/router/upstreams.ts` | — | `noteTruncation`（新增） |
