# WorkBuddy 的上游：踩过的坑与查出来的东西

这里记的是「上游到底怎么做事」——查出来的事实，和它是怎么查出来的。
记下来是为了两件事：以后别再花一遍时间查；这些结论要能被别人复核。

## 渠道校验（业务码 11128）

上游 WorkBuddy 有一道渠道校验：请求看起来不是它自己的官方客户端发来的，它就拒。

- HTTP **400**，正文里的业务码 **11128**；
- 英文：`Illegal API invocation from an unapproved channel`；
- 中文提示「请求被拦截，请重新发送」；
- tips：「这次调用没通过渠道校验，可能不是官方客户端发出的。请用官方版本重新发送。」

那次答复录下来了：[`test/fixtures/workbuddy-channel-check-11128.json`](../../test/fixtures/workbuddy-channel-check-11128.json)，
回归在 [`test/workbuddy-check.ts`](../../test/workbuddy-check.ts) 里。

### 它认的是系统提示词开头那句自报家门

请求头是模拟端写死的，不是判据。判据是**系统提示词第一行那句自我介绍**。

对真的 WorkBuddy 上游打的几次请求，结论是：

| 改动 | 上游的反应 |
|---|---|
| 首行大小写不同 | 一样放行 |
| 首行前面有空格 | 一样放行 |
| 这句话不在开头（前面有别的字） | 拦 |
| 这句话出现在 user 消息里 | 拦 |
| 首行换成别的客户端的（Cursor / Codex / OpenCode / pi / Kimi / Qwen……） | 一样放行 |

也就是说：**只要开头那句是 WorkBuddy 认得的那一句，就算数**；它并不校验别的指纹。

### 模拟端自己那一句是什么

不能猜 —— 模拟端的指纹要跟官方客户端逐字一致。

查的是装在这台机器上的官方客户端（WorkBuddy 4.24.5），三个地方都写着同一句：

- `cli/product.json` 里 `prompts` 数组中名为 `cli-agent-prompt` 的那条，模板开头就是
  `You are CodeBuddy Code.`；
- 上游自己发的产品配置（客户端数据目录下的 `cache/acc-product-config-v3-*.json`）里同名的那一条；
- 客户端自己的日志里也是这一句。

注意它没被换成 WorkBuddy：品牌替换（`replaceBrandName`）只作用在「随包的技能」上，
产品配置里的提示词模板是上游原样下发的。

所以模拟端的默认开场白就是 `You are CodeBuddy Code.`（见 `lib/workbuddy/identity.ts`）。
别的客户端的开场白在开头那句被换成这一句，**剩下的提示词（工具约定、行为规则、上下文）原样送出去**，
一句不改。

### 11128 是「请求本身的问题」，不是账号的问题

它跟用哪个账号无关（换账号还是这个码），也不降级、不冷却：降了级也是白降，
下一个账号一样被拦。分类在 `lib/router/provider-selection.ts` 的 `REQUEST_CODES` 里。

## 缓存命中数：两个字段都报，一个常常是 0

上游的用量里，命中缓存的输入有两个地方：

- `prompt_tokens_details.cached_tokens` —— 常常是 **0**；
- `prompt_cache_hit_tokens` —— 真的那个数。

所以取的是**第一个非零的**，不是第一个存在的：用 `??` 会拿到那个 0，缓存率看着像全 miss，
其实命中了 99.8%。口径在 `lib/dialect/cache.ts`。

两种方言的算法本身也不一样：OpenAI 的 `prompt_tokens` 是**全部**输入；Anthropic 的
`input_tokens` 只算**没命中缓存**的余量，命中读到的（`cache_read_input_tokens`）与
写进去的（`cache_creation_input_tokens`）要另外加起来才是全部输入。来回转换时，
「写进去的那部分」也不能丢 —— 丢一次就从「写进去」变成「没命中」。
