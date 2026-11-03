// test/workbuddy-check.ts — the parts of the WorkBuddy client that were
// changed to match the official one.
//
//   node --experimental-strip-types test/workbuddy-check.ts
//
// Each check is one behaviour the official client has and the proxy did not.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The store opens its file the first time it is asked for it, so the data
// directory has to point at a temporary one before anything imports it.
// The test never wants the real database: it reads no credential.
process.env.BUDDY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-check-"));

const { buildChatBody, conversationIdFor } = await import("../lib/workbuddy/transport.ts");
const { clampEffort } = await import("../lib/workbuddy/models.ts");
const { chatHeaders } = await import("../lib/workbuddy/auth.ts");
const { uuidv7Hex } = await import("../lib/ids.ts");
const { cliFetch } = await import("../lib/http.ts");

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const model = {
  id: "hy3",
  display_name: "Hy3",
  credits: 0,
  context: 1000000,
  maxOutput: 32000,
  vision: false,
  tools: true,
  reasoning: true,
  onlyReasoning: false,
  efforts: ["low", "high", "max"],
  temperature: 0.9,
  topP: 1,
};

const noTools = { ...model, id: "no-tools", tools: false, efforts: [] as string[] };

console.log("");
console.log("the thinking level");

check("a level the model supports is kept", clampEffort("high", ["low", "high", "max"]) === "high");
check("a level above the supported ones steps down", clampEffort("medium", ["low", "high", "max"]) === "low");
check("the level below the asked one is used", clampEffort("xhigh", ["low", "high", "max"]) === "high");
check("a level that is not a level falls back to the smallest", clampEffort("wild", ["low", "high"]) === "low");
check("max becomes high when the model lists no levels", clampEffort("max", []) === "high");
check("xhigh becomes high when the model lists no levels", clampEffort("xhigh", []) === "high");
check("low stays low when the model lists no levels", clampEffort("low", []) === "low");

console.log("");
console.log("the request body");

const body = buildChatBody(
  { model: "hy3", messages: [{ role: "user", content: "hi" }], reasoning_effort: "medium", temperature: 0.1 },
  model,
);
check("the thinking level is clamped", body.reasoning_effort === "low", String(body.reasoning_effort));
check("the caller's temperature is kept", body.temperature === 0.1);
check("the model carries no field the client does not send", !("cache_retention" in body));
check("the stream is asked for", body.stream === true);
check("the usage is asked for", body.stream_options?.include_usage === true);

const withTools = buildChatBody(
  { model: "no-tools", messages: [{ role: "user", content: "hi" }], tools: [{ type: "function" }] },
  noTools,
);
check("a model without tools is sent no tools", !("tools" in withTools));

const defaults = buildChatBody({ model: "hy3", messages: [{ role: "user", content: "hi" }] }, model);
check("the model's own temperature is sent when the caller has none", defaults.temperature === 0.9);
check("the model's own top_p is sent when the caller has none", defaults.top_p === 1);

console.log("");
console.log("the identity of the caller");

// The upstream's channel check reads the opening line of the system prompt and
// refuses the request when it names a client that is not theirs (code 11128).
const foreign = "You are Claude Code, Anthropic's official CLI for Claude.";
const systemOf = (b: any): string => String(b.messages[0]?.content ?? "");

// The simulated client's own opening line has to be the official client's,
// byte for byte (AGENTS.md: 模拟端的指纹要跟上游的封闭客户端对齐).
// The official one is "You are CodeBuddy Code." — the first line of the
// cli-agent-prompt template in the client's product.json and in the product
// config the upstream itself serves.
const { DEFAULT_SYSTEM } = await import("../lib/workbuddy/identity.ts");
check("the simulated client's line is the official one", DEFAULT_SYSTEM === "You are CodeBuddy Code.", DEFAULT_SYSTEM);

const rewritten = buildChatBody(
  { model: "hy3", messages: [{ role: "system", content: `${foreign}\n\nThe rest of the prompt.` }, { role: "user", content: "hi" }] },
  model,
);
check("the foreign opening line is gone", !systemOf(rewritten).startsWith(foreign), systemOf(rewritten).slice(0, 80));
check("no half sentence is left behind", !systemOf(rewritten).includes("Anthropic's official CLI"), systemOf(rewritten).slice(0, 80));
check("the rest of the prompt is kept", systemOf(rewritten).includes("The rest of the prompt."));
check("the simulated client's own line is used", systemOf(rewritten).startsWith(DEFAULT_SYSTEM), systemOf(rewritten).slice(0, 40));

const lowercase = buildChatBody(
  { model: "hy3", messages: [{ role: "system", content: foreign.toLowerCase() }, { role: "user", content: "hi" }] },
  model,
);
check("the check does not care about the case", !systemOf(lowercase).toLowerCase().includes("claude code"), systemOf(lowercase));

// The upstream counts leading spaces as the opening too (measured).
const spaced = buildChatBody(
  { model: "hy3", messages: [{ role: "system", content: `  ${foreign}` }, { role: "user", content: "hi" }] },
  model,
);
check("leading spaces do not hide the opening", !systemOf(spaced).toLowerCase().includes("claude code"), systemOf(spaced));

const inside = buildChatBody(
  { model: "hy3", messages: [{ role: "system", content: `${DEFAULT_SYSTEM}\n${foreign}` }, { role: "user", content: "hi" }] },
  model,
);
check("a line that is not the opening one is left alone", systemOf(inside).includes(foreign), systemOf(inside));

const plain = buildChatBody(
  { model: "hy3", messages: [{ role: "system", content: DEFAULT_SYSTEM }, { role: "user", content: "hi" }] },
  model,
);
check("an ordinary system prompt is untouched", systemOf(plain) === DEFAULT_SYSTEM, systemOf(plain));

const inUser = buildChatBody(
  { model: "hy3", messages: [{ role: "user", content: foreign }] },
  model,
);
check("the line in a user message is left alone", String(inUser.messages[1]?.content) === foreign);

// The system prompt in parts (the OpenAI dialect's content array): the opening
// is the first part.
const inParts = buildChatBody(
  { model: "hy3", messages: [{ role: "system", content: [{ type: "text", text: foreign }, { type: "text", text: "more" }] }, { role: "user", content: "hi" }] },
  model,
);
const parts = inParts.messages[0]?.content as Array<{ text?: string }>;
check("the first part of a system prompt in parts is rewritten", !String(parts?.[0]?.text ?? "").toLowerCase().includes("claude code"), String(parts?.[0]?.text));
check("the other parts are kept", String(parts?.[1]?.text ?? "") === "more", String(parts?.[1]?.text));

// 多段系统提示词里，第一段就是一段纯文本的时候，那段文本就是开头。
{
  const plainParts = buildChatBody(
    { model: "hy3", messages: [{ role: "system", content: [foreign, "more"] }, { role: "user", content: "hi" }] },
    model,
  );
  const first = (plainParts.messages[0]?.content as unknown[])?.[0];
  check("a plain first part is rewritten too", !String(first ?? "").toLowerCase().includes("claude code"), String(first));
  check("the rest is kept", String((plainParts.messages[0]?.content as unknown[])?.[1]) === "more");
}

// The caller's body must not be touched: the same body goes to the other
// upstreams of a published model, one after the other.
const shared = { model: "hy3", messages: [{ role: "system", content: foreign }, { role: "user", content: "hi" }] };
buildChatBody(shared, model);
check("the caller's body is not rewritten", String((shared.messages[0] as any).content) === foreign, String((shared.messages[0] as any).content));

console.log("");
console.log("the two recorded channel checks");

// 同一句请求，只差系统提示词开头那句自报家门 —— 一次放行，一次被拦。两次
// 都对着真的 WorkBuddy 上游打的，答复都录下来了（fixtures 里）。
//
// 这两条对照是「渠道校验认的是开头那句」这件事的凭据。两个 fixture 都记着
// 当时发出去的**整个请求体**：把被拦那次的开头那句换成放行那次的那句，两个
// 请求体就完全相等 —— 别的（模型、参数、user 那句话）一个字都没差。
//
// 用「整个请求体」而不是手抄几个字段：抄错一个字符没有人会发现。
{
  const { readFixture } = await import("./fixture-name.ts");
  const { businessCodeOfBody } = await import("../lib/upstream-status.ts");
  const { DEFAULT_SYSTEM, rewriteSystemContent } = await import("../lib/workbuddy/identity.ts");
  const { aggregateStream } = await import("../lib/workbuddy/transport.ts");
  const { cachedInputOfOpenAI } = await import("../lib/dialect/cache.ts");

  const accepted = readFixture("workbuddy-channel-check-accepted.json");
  const rejected = readFixture("workbuddy-channel-check-11128.json");

  check("放行的那次录下来了", Boolean(accepted), "fixture missing");
  check("被拦的那次录下来了", Boolean(rejected), "fixture missing");
  check("它们打的是同一个上游", accepted?.upstream === rejected?.upstream, `${accepted?.upstream} / ${rejected?.upstream}`);

  // 两次的请求体：把开头那句换掉，两个请求体应当完全相等。
  const acceptedBody = accepted?.requestBody as any;
  const rejectedBody = rejected?.requestBody as any;
  const systemOf = (body: any): string => String(body?.messages?.[0]?.content ?? "");
  const firstLineOf = (body: any): string => systemOf(body).split("\n")[0];

  check("放行那次录下了请求体", Boolean(acceptedBody), "no request body");
  check("被拦那次录下了请求体", Boolean(rejectedBody), "no request body");
  check("两次的请求头一样", JSON.stringify([...(accepted?.requestHeaderNames ?? [])].sort()) === JSON.stringify([...(rejected?.requestHeaderNames ?? [])].sort()), `${accepted?.requestHeaderNames?.length} / ${rejected?.requestHeaderNames?.length}`);

  // 把被拦那次的开头那句换成放行那次的那句 —— 两个请求体应当完全相等。
  // 这一条把「别的都一样」变成机械的比对。
  const rewritten = JSON.parse(JSON.stringify(rejectedBody));
  rewritten.messages[0].content = systemOf(rejectedBody).replace(
    firstLineOf(rejectedBody),
    firstLineOf(acceptedBody),
  );
  check("换掉开头那句之后，两个请求体完全相等", JSON.stringify(rewritten) === JSON.stringify(acceptedBody), JSON.stringify(rewritten));
  check("开头那句本来不一样", firstLineOf(acceptedBody) !== firstLineOf(rejectedBody), `${firstLineOf(acceptedBody)} / ${firstLineOf(rejectedBody)}`);

  // 放行的那次：200，流式答复，里面有正常的帧。
  check("放行的那次是 200", accepted?.status === 200, String(accepted?.status));
  check("放行的那次是流", String(accepted?.headers?.["content-type"] ?? "").includes("event-stream"), String(accepted?.headers?.["content-type"]));
  check("放行的那次有收尾帧", (accepted?.body ?? "").includes("data: [DONE]"), (accepted?.body ?? "").slice(-120));

  // 「不是错误信封」用生产解析器证明：aggregateStream 见到信封会抛错，跑通
  // 本身就是它不是信封的证据，同时说明整条流能被解析成一次答复。
  let aggregated: any = null;
  let aggregateError: unknown = null;
  try {
    aggregated = await aggregateStream(
      new Response(accepted?.body ?? "", { headers: { "content-type": "text/event-stream" } }),
      "hy3",
    );
  } catch (e) {
    aggregateError = e;
  }
  check("放行那次能解析成一次答复", aggregateError === null, String(aggregateError));
  check("放行那次答了话", aggregated?.choices?.[0]?.message?.content === "ok", String(aggregated?.choices?.[0]?.message?.content));
  check("放行那次报了用量", Boolean(aggregated?.usage), JSON.stringify(aggregated?.usage ?? {}));

  // 缓存命中数在上游的 usage 里报了两次：prompt_tokens_details.cached_tokens
  // 与 prompt_cache_hit_tokens。这份样本两个都是 0（问的是「say ok」，没什么
  // 可缓存的），所以这里只断「两个字段都在」；「取第一个非零」那条口径由
  // test/dialect-cache-check.ts 用真数字断。
  check("缓存命中数报了两次", aggregated?.usage?.prompt_tokens_details?.cached_tokens !== undefined && aggregated?.usage?.prompt_cache_hit_tokens !== undefined, JSON.stringify(aggregated?.usage ?? {}));
  // 少了 `?.` 是故意的：usage 不在的时候这句要炸（空过不算过），而不是
  // 悄悄当成 0。
  check("取出来的是 0（这份样本没命中）", aggregated?.usage ? cachedInputOfOpenAI(aggregated.usage) === 0 : false, String(cachedInputOfOpenAI(aggregated?.usage)));

  // 被拦的那次：400，业务码 11128，正文说的是渠道校验。
  check("被拦的那次是 400", rejected?.status === 400, String(rejected?.status));
  check("被拦的那次业务码是 11128", businessCodeOfBody(rejected?.body ?? "") === 11128, String(businessCodeOfBody(rejected?.body ?? "")));
  check("被拦那次正文里说的是渠道校验", (rejected?.body ?? "").includes("unapproved channel"), (rejected?.body ?? "").slice(0, 120));
  check("被拦那次正文里没有账号标识", !(rejected?.body ?? "").includes("@") && !(rejected?.body ?? "").includes("user_id"), (rejected?.body ?? "").slice(0, 120));

  // 录下来的时候各自用的开头那句。
  check("放行那次开头是官方那句", firstLineOf(acceptedBody) === DEFAULT_SYSTEM, firstLineOf(acceptedBody));
  check("被拦那次开头是 Claude Code 那句", firstLineOf(rejectedBody).startsWith("You are Claude Code"), firstLineOf(rejectedBody));

  // 关键的那一条：把被拦那次用的开头那句改写掉，得到的就是放行那次用的那句。
  // 模拟端做的正是这件事（rewriteSystemContent）。
  check(
    "改写被拦那次的那句，得到的是放行那次的那句",
    rewriteSystemContent(firstLineOf(rejectedBody)) === firstLineOf(acceptedBody),
    String(rewriteSystemContent(firstLineOf(rejectedBody))),
  );
}

console.log("");
console.log("the channel check inside a 200");

// 上游有时用 200 回一个错。正文是 JSON 信封（业务码 + 说明），不是 SSE。
// 非流式那条路要认出它 —— 当成正常的帧的话，客户端收到一个空的 200 答复，
// 看着像模型答了个空，理由也没有（2026-11-03，作者复查发现）。
{
  const { aggregateStream } = await import("../lib/workbuddy/transport.ts");
  const envelope = JSON.stringify({
    code: 11128,
    msg: "Illegal API invocation from an unapproved channel",
    requestId: "00000000-0000-4000-8000-000000000000",
  });
  const response = new Response(`data: ${envelope}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  let caught: any = null;
  try {
    await aggregateStream(response, "hy3");
  } catch (e) {
    caught = e;
  }
  check("它报错了", caught !== null, String(caught));
  check("报的是上游拒了", String(caught?.message ?? "").includes("rejected"), String(caught?.message));
  const { businessCodeOf } = await import("../lib/upstream-status.ts");
  check("业务码是 11128", businessCodeOf(caught) === 11128, String(businessCodeOf(caught)));
  check("理由留给客户端看", String(caught?.hint ?? "").includes("unapproved channel"), String(caught?.hint));
}

console.log("");
console.log("the credential log");

// 凭据被拒时，正文进凭据日志（数据卷里的 auth.log），不进 stdout。
// 正文里可能有账号标识、令牌、邮箱，进文件之前先按字段抹一遍。
{
  const { scrubForLog } = await import("../lib/log-scrub.ts");
  const scrubbed = scrubForLog(
    JSON.stringify({
      code: 401,
      msg: "token invalid",
      access_token: "abcdef0123456789abcdef0123456789",
      email: "someone@example.com",
      user_id: "00000000-0000-4000-8000-00000000cafe",
      requestId: "00000000-0000-4000-8000-000000000000",
    }),
  );
  check("令牌被抹掉", !scrubbed.includes("abcdef0123456789"), scrubbed);
  check("邮箱被抹掉", !scrubbed.includes("someone@example.com"), scrubbed);
  check("账号 id 被抹掉", !scrubbed.includes("00000000-0000-4000-8000-00000000cafe"), scrubbed);
  check("能看懂的那部分留着", scrubbed.includes("token invalid"), scrubbed);
  check("正文够短", scrubbed.length <= 200, String(scrubbed.length));

  const plain = scrubForLog("upstream said no");
  check("没有 JSON 也不出错", plain === "upstream said no", plain);
  check("空正文还是空的", scrubForLog("") === "");

  // JWT 那种带点的长串：不在敏感字段名下面，也会漏出去。
  const jwt = scrubForLog(
    JSON.stringify({ msg: "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk rejected" }), // privacy:allow — 编造的样例（RFC 7515 里的那个例子 JWT）
  );
  check("JWT 被抹掉", !jwt.includes("eyJhbGciOiJIUzI1NiJ9"), jwt);
  check("JWT 后面那句话留着", jwt.includes("rejected"), jwt);

  // 正文不是 JSON 时，邮箱照样得抹掉。
  const free = scrubForLog("the account someone@example.com is not allowed");
  check("不是 JSON 时的邮箱也被抹掉", !free.includes("someone@example.com"), free);
  check("不是 JSON 时那句话还读得懂", free.includes("not allowed"), free);

  // 驼峰写法的字段名：accessToken 这种 32 位的令牌既没有 sk- 前缀、也不
  // 够 40 个字符，按文本里的规则接不住 —— 得按字段名抹（2026-11-03）。
  const camel = scrubForLog(
    JSON.stringify({
      accessToken: "0123456789abcdef0123456789abcdef",
      refreshToken: "fedcba9876543210fedcba9876543210",
      userId: "acct-8837",
      id: "acct-4242",
      msg: "the token is stale",
    }),
  );
  check("驼峰的 accessToken 被抹掉", !camel.includes("0123456789abcdef"), camel);
  check("驼峰的 refreshToken 被抹掉", !camel.includes("fedcba9876543210"), camel);
  check("驼峰的 userId 被抹掉", !camel.includes("acct-8837"), camel);
  check("光秃秃的 id 被抹掉", !camel.includes("acct-4242"), camel);
  check("那句话还读得懂", camel.includes("the token is stale"), camel);

  // 流式上游的正文是 SSE 帧：前面有 `data: `，不剥掉那层壳就当不成 JSON，
  // 「按字段抹」的规则整条失效（2026-11-03）。
  const sse = scrubForLog(
    'data: {"code":401,"msg":"token invalid","accessToken":"0123456789abcdef0123456789abcdef"}\n\n',
  );
  check("SSE 帧里的令牌被抹掉", !sse.includes("0123456789abcdef"), sse);
  check("SSE 帧里那句话留着", sse.includes("token invalid"), sse);

  // 请求 id 抹了就没法跟上游的日志对上了：那几个不是账号标识，留着。
  const trace = scrubForLog(JSON.stringify({ requestId: "req-123456", traceId: "trace-9", userId: "acct-1" }));
  check("请求 id 留着", trace.includes("req-123456"), trace);
  check("追踪 id 留着", trace.includes("trace-9"), trace);
  check("账号 id 还是被抹掉", !trace.includes("acct-1"), trace);

  // 流式上游的正文是**多帧**。整段当一坨去 parse 一定失败 —— 那样「按字段
  // 抹」的规则对流式上游一点用都没有（2026-11-03，作者复查发现）。
  const multi = scrubForLog(
    'data: {"id":"c1","accessToken":"0123456789abcdef0123456789abcdef"}\n\ndata: [DONE]\n\n',
  );
  check("多帧里的令牌被抹掉", !multi.includes("0123456789abcdef"), multi);
  check("多帧里的那个 id 也被抹掉", !multi.includes('"id":"c1"'), multi);

  // 复数与连字符的字段名：一样要抹。
  const plural = scrubForLog(
    JSON.stringify({ tokens: "0123456789abcdef0123456789abcdef", "user-id": "acct-77", accessTokens: "aaaabbbbccccddddeeeeffff00001111" }),
  );
  check("复数的 tokens 被抹掉", !plural.includes("0123456789abcdef"), plural);
  check("连字符的 user-id 被抹掉", !plural.includes("acct-77"), plural);
  check("复数的 accessTokens 被抹掉", !plural.includes("aaaabbbbccccddddeeeeffff00001111"), plural);
}

console.log("");
console.log("the conversation id");

const messages = [
  { role: "system", content: "You are CodeBuddy Code." },
  { role: "user", content: "the first question" },
];
const first = conversationIdFor(messages);
const grown = conversationIdFor([...messages, { role: "assistant", content: "an answer" }, { role: "user", content: "another" }]);
check("the id is the same for the same conversation", first === grown);
check("a different conversation gets a different id", first !== conversationIdFor([{ role: "user", content: "other" }]));
check("the id looks like a uuid", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(first), first);
check("a client that brings its own id keeps it", conversationIdFor(messages, "client-id") === "client-id");

console.log("");
console.log("the thinking summary");

check("a model that thinks is asked for a summary", defaults.reasoning_summary === "auto", String(defaults.reasoning_summary));
check("a model that thinks is asked for a verbose answer", defaults.verbosity === "high", String(defaults.verbosity));

const noThinking = buildChatBody({ model: "plain", messages: [{ role: "user", content: "hi" }] }, {
  ...model,
  id: "plain",
  reasoning: false,
});
check("a model that does not think is asked for no summary", !("reasoning_summary" in noThinking));
check("a model that does not think is asked for no verbosity", !("verbosity" in noThinking));

console.log("");
console.log("the identity");

// The headers a request the official client actually made carried.
const session = {
  uid: "9efe1321-da5f-47e8-8077-455cec3c7009",
  domain: "www.workbuddy.cn",
  accessToken: "token",
  refreshToken: "refresh",
} as any;
const headers = chatHeaders(session, { conversationId: "01a161f0-e17f-7e62-b596-761457a59e80" });

// 桌面端的头集合（docs/workbuddy/FINDINGS.md §1.1 的 DESK 表），逐字逐项。
// 名字的大小写也是规格的一部分：服务器看到的字符串就是这个。
const EXACT = [
  "X-User-Id",
  "X-Domain",
  "X-Product",
  "X-IDE-Type",
  "X-IDE-Name",
  "X-IDE-Version",
  "X-Private-Data",
  "User-Agent",
  "Accept",
  "Content-Type",
  "x-requested-with",
  "X-Conversation-ID",
  "X-Conversation-Request-ID",
  "acp-connection-id",
  "X-Conversation-Message-ID",
  "X-Request-ID",
  "X-Agent-Intent",
  "X-Agent-Purpose",
  "x-codebuddy-request",
  "traceparent",
  "b3",
  "X-B3-TraceId",
  "X-B3-ParentSpanId",
  "X-B3-SpanId",
  "X-B3-Sampled",
  "X-Trace-ID",
  "Accept-Encoding",
  "Authorization",
];

const got = Object.keys(headers);
const extra = got.filter((k) => !EXACT.includes(k));
const missing = EXACT.filter((k) => !got.includes(k));
check("没有多余的头", extra.length === 0, extra.join(","));
check("没有缺的头", missing.length === 0, missing.join(","));
check("头的顺序也一致", got.join(",") === EXACT.join(","), got.join(","));

check("身份是桌面端，不是 CLI", headers["X-IDE-Type"] === "WorkBuddy" && headers["X-IDE-Name"] === "WorkBuddy", `${headers["X-IDE-Type"]}/${headers["X-IDE-Name"]}`);
check(
  "User-Agent 是桌面端版本两遍",
  /^WorkBuddy\/\d+\.\d+\.\d+ WorkBuddy\/\d+\.\d+\.\d+$/.test(headers["User-Agent"]),
  headers["User-Agent"],
);
check("X-IDE-Version 与 UA 里的版本一致", headers["User-Agent"].split("/")[1].split(" ")[0] === headers["X-IDE-Version"], headers["X-IDE-Version"]);
check("压缩只在 DESK 这一层关掉", headers["Accept-Encoding"] === "identity", headers["Accept-Encoding"]);
check("私有数据标记", headers["X-Private-Data"] === "true", headers["X-Private-Data"]);
check("小写的 x-requested-with", "x-requested-with" in headers, Object.keys(headers).join(","));
check("小写的 x-codebuddy-request", "x-codebuddy-request" in headers, Object.keys(headers).join(","));
check("小写的 acp-connection-id", "acp-connection-id" in headers, Object.keys(headers).join(","));
check("账号名", headers["X-User-Id"] === session.uid, headers["X-User-Id"]);
check("域名", headers["X-Domain"] === "www.workbuddy.cn", headers["X-Domain"]);

// 头的值：两种 id 形状、两种生命周期。
const UUID_V4_DASHED = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V7_HEX = /^[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/;
check(
  "会话 id 是带横线的 uuid",
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(headers["X-Conversation-ID"]),
  headers["X-Conversation-ID"],
);
check("会话 id 用的是传进来的那个", headers["X-Conversation-ID"] === "01a161f0-e17f-7e62-b596-761457a59e80", headers["X-Conversation-ID"]);
check("每轮的 request id 是 uuid v7 hex（客户端自己会校验这个形状）", UUID_V7_HEX.test(headers["X-Conversation-Request-ID"]), headers["X-Conversation-Request-ID"]);
check("message id 是带横线的 uuid v4", UUID_V4_DASHED.test(headers["X-Conversation-Message-ID"]), headers["X-Conversation-Message-ID"]);
check("X-Request-ID 也是带横线的 uuid v4", UUID_V4_DASHED.test(headers["X-Request-ID"]), headers["X-Request-ID"]);
check("两者不是同一个 id", headers["X-Request-ID"] !== headers["X-Conversation-Message-ID"], headers["X-Request-ID"]);
check("acp-connection-id 是带横线的 uuid", UUID_V4_DASHED.test(headers["acp-connection-id"]) || /^[0-9a-f-]{36}$/.test(headers["acp-connection-id"]), headers["acp-connection-id"]);

// 同一个会话：连接 id 固定；不同会话：不同。
{
  const again = chatHeaders(session, { conversationId: "01a161f0-e17f-7e62-b596-761457a59e80" });
  check("同一会话的 acp-connection-id 固定", again["acp-connection-id"] === headers["acp-connection-id"], `${again["acp-connection-id"]} vs ${headers["acp-connection-id"]}`);
  check("同一会话的 X-Conversation-ID 固定", again["X-Conversation-ID"] === headers["X-Conversation-ID"]);
  check("同一会话里每轮的 request id 是新的", again["X-Conversation-Request-ID"] !== headers["X-Conversation-Request-ID"]);
  const other = chatHeaders(session, { conversationId: "01a161f0-0000-7abc-9def-0123456789ab" });
  check("不同会话的 acp-connection-id 不同", other["acp-connection-id"] !== headers["acp-connection-id"]);
}

check("没有 X-Agent-Type", !("X-Agent-Type" in headers));
check("没有 X-Root-Request-ID", !("X-Root-Request-ID" in headers));
check("没有 X-Device-Id", !("X-Device-Id" in headers));
check("没有 X-Agent-Runtime", !("X-Agent-Runtime" in headers));
check("没有 x-stainless-*", Object.keys(headers).filter((k) => k.toLowerCase().startsWith("x-stainless-")).length === 0);
check("trace 是 32 位十六进制的 trace id", /^[0-9a-f]{32}$/.test(headers["X-Trace-ID"]), headers["X-Trace-ID"]);
check("traceparent 引用了同一个 trace id", headers["traceparent"].includes(headers["X-Trace-ID"]), headers["traceparent"]);

console.log("");
console.log("the request itself");

// A request that goes out the way the official client's does: none of the
// headers a browser's fetch adds.
const seen: Record<string, string | undefined> = {};
const server = http.createServer((req, res) => {
  seen["sec-fetch-mode"] = req.headers["sec-fetch-mode"] as any;
  seen["accept-language"] = req.headers["accept-language"] as any;
  seen["x-custom"] = req.headers["x-custom"] as any;
  res.end("ok");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as any).port;
await cliFetch(`http://127.0.0.1:${port}/`, { headers: { "x-custom": "kept" } });
server.close();

check("the request carries no browser mode", seen["sec-fetch-mode"] === undefined, String(seen["sec-fetch-mode"]));
check("the request carries no browser language", seen["accept-language"] === undefined, String(seen["accept-language"]));
check("the request keeps the headers it was given", seen["x-custom"] === "kept", String(seen["x-custom"]));

console.log("");
console.log("the identifiers");

const hex = uuidv7Hex();
check("the id is 32 hexadecimal characters", /^[0-9a-f]{32}$/.test(hex), hex);
check(
  "the id has the shape the client checks",
  /^[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/.test(hex),
  hex,
);
check("two ids are not the same", uuidv7Hex() !== hex);

console.log("");
console.log("the regions");
{
  const { ENDPOINTS } = await import("../lib/workbuddy/auth.ts");
  const { platformOf } = await import("../lib/platforms.ts");
  const { kindOf } = await import("../lib/provider-kinds.ts");

  check("the China endpoints did not move", ENDPOINTS.cn.base === "https://www.workbuddy.cn" && ENDPOINTS.cn.origin === "https://www.codebuddy.cn");
  check(
    "the international endpoints are the ones the client uses",
    ENDPOINTS.global.base === "https://www.workbuddy.ai" && ENDPOINTS.global.origin === "https://www.codebuddy.ai",
    JSON.stringify(ENDPOINTS.global),
  );
  check("the international platform is a row of its own", platformOf("workbuddy-global")?.region === "global", JSON.stringify(platformOf("workbuddy-global")));
  check("the China platform is still China", platformOf("workbuddy-cn")?.region === "cn", JSON.stringify(platformOf("workbuddy-cn")));

  // The base URL follows the account row, not a constant.
  const kind = kindOf("workbuddy");
  const asGlobal = kind?.baseUrl({ id: "workbuddy-global", region: "global" } as any);
  const asCn = kind?.baseUrl({ id: "workbuddy-cn", region: "cn" } as any);
  check("the base URL follows the row: international", asGlobal === "https://www.workbuddy.ai", String(asGlobal));
  check("the base URL follows the row: China", asCn === "https://www.workbuddy.cn", String(asCn));
}

console.log("");
console.log("the credit ledger");

// The platform's own answers, recorded once. No network here: the parsing
// is a pure function, so the recorded JSON is enough.
const SUMMARY = {
  TotalCredits: "1867.97000068",
  SubscriptionPackageName: "体验版",
  IsPaidUser: false,
  CreditGroups: [
    { Kind: "plan_base", Name: "套餐基础积分", CycleTotalCapacity: "500", CycleRemainCapacity: "0", CycleUsedCapacity: "500", TotalCount: 1 },
    { Kind: "plan_bonus", Name: "套餐赠送积分", CycleTotalCapacity: "0", CycleRemainCapacity: "0", CycleUsedCapacity: "0", TotalCount: 0 },
    { Kind: "addon", Name: "购买积分", CycleTotalCapacity: "0", CycleRemainCapacity: "0", CycleUsedCapacity: "0", TotalCount: 0 },
    { Kind: "benefit", Name: "平台奖励积分", CycleTotalCapacity: "3522", CycleRemainCapacity: "1867.97000068", CycleUsedCapacity: "1654.02999932", TotalCount: 27 },
  ],
  Packages: [{ PackageCode: "TCACA_code_007_nzdH5h4Nl0", CycleTotalCapacity: "1972", CycleRemainCapacity: "1817.97000068", TotalCount: 25 }],
};

const PACKAGES = {
  TotalCount: 28,
  Accounts: [
    {
      ResourceId: "codebuddy-k8b012gcvqr17rj",
      PackageName: "CodeBuddy个人版拉新权益包",
      CapacityUnit: "credits",
      CapacityType: 1,
      CycleCapacitySize: 1500,
      CycleCapacityRemain: 0,
      CycleCapacityUsed: 1500,
      ExpiredTime: "2026-10-28 14:31:15",
      CycleEndTime: "2026-11-21 09:21:57",
      Status: 3,
      CreateTime: 1792545719000,
    },
    {
      ResourceId: "codebuddy-aa11bb22cc33dd44",
      PackageName: "CodeBuddy个人版加购包",
      CapacityUnit: "credits",
      CapacityType: 1,
      CycleCapacitySize: 200,
      CycleCapacityRemain: 200,
      CycleCapacityUsed: 0,
      ExpiredTime: "2026-12-31 23:59:59",
      CycleEndTime: "2026-12-31 23:59:59",
      Status: 0,
      CreateTime: 1792545719000,
    },
  ],
};

{
  const { parseWorkBuddyResources, fetchWorkBuddyResourcesWith } = await import("../lib/workbuddy/resources.ts");
  const ledger = parseWorkBuddyResources(SUMMARY, PACKAGES);

  check("四个分组都在", ledger.groups.length === 4, String(ledger.groups.length));
  const base = ledger.groups[0];
  check("分组的名字是平台给的", base?.name === "套餐基础积分", String(base?.name));
  check("分组的种类是平台的 kind", base?.kind === "plan_base", String(base?.kind));
  check("分组的总量", base?.total === 500, String(base?.total));
  check("分组剩下的", base?.remaining === 0, String(base?.remaining));
  check("分组用掉的", base?.used === 500, String(base?.used));
  const benefit = ledger.groups[3];
  check("奖励积分剩下的不是取整的", benefit?.remaining === 1867.97000068, String(benefit?.remaining));
  check("奖励积分用掉的", benefit?.used === 1654.02999932, String(benefit?.used));
  check("总量就是平台给的 TotalCredits", ledger.total === Number("1867.97000068"), String(ledger.total));
  check("套餐名", ledger.plan === "体验版", ledger.plan);
  check("付费标记", ledger.paid === false, String(ledger.paid));

  check("批次都进来了", ledger.lots.length === 2, String(ledger.lots.length));
  const lot = ledger.lots[0];
  check("批次的 id 是 ResourceId", lot?.id === "codebuddy-k8b012gcvqr17rj", String(lot?.id));
  check("批次的名字是 PackageName", lot?.name === "CodeBuddy个人版拉新权益包", String(lot?.name));
  check("批次剩下的是 CycleCapacityRemain", lot?.remaining === 0, String(lot?.remaining));
  check("批次的大小是 CycleCapacitySize", lot?.size === 1500, String(lot?.size));
  check(
    "到期时间是东八区本地时间解析出来的",
    lot?.expiresAt === Date.parse("2026-10-28T14:31:15+08:00"),
    String(lot?.expiresAt),
  );
  check(
    "周期结束时间也是本地时间",
    lot?.cycleEndsAt === Date.parse("2026-11-21T09:21:57+08:00"),
    String(lot?.cycleEndsAt),
  );
  check("Status 3 是失效的", lot?.active === false, String(lot?.active));
  check("Status 0 是有效的", ledger.lots[1]?.active === true, String(ledger.lots[1]?.active));

  // 明细没到：总数照给，批次是空的。
  const noLots = parseWorkBuddyResources(SUMMARY, null);
  check("明细缺失时批次是空的", noLots.lots.length === 0, String(noLots.lots.length));
  check("明细缺失时总量照给", noLots.total === Number("1867.97000068"), String(noLots.total));

  // 明细那一问失败：同样不影响总数。
  const failedLots = await fetchWorkBuddyResourcesWith(async (path) => {
    if (path.includes("summary")) return { status: 200, body: { data: SUMMARY } };
    return { status: 500, body: { msg: "boom" } };
  });
  check("明细失败时总量还在", failedLots?.total === Number("1867.97000068"), String(failedLots?.total));
  check("明细失败时批次是空的", failedLots?.lots.length === 0, String(failedLots?.lots.length));

  // 总览那一问失败：不知道，不是没有。
  const failedSummary = await fetchWorkBuddyResourcesWith(async () => ({ status: 503, body: { msg: "nope" } }));
  check("总览失败时是 null", failedSummary === null, String(failedSummary));

  const answered = await fetchWorkBuddyResourcesWith(async (path) => {
    if (path.includes("summary")) return { status: 200, body: { data: SUMMARY } };
    return { status: 200, body: { data: PACKAGES } };
  });
  check("两问都到时批次齐了", answered?.lots.length === 2, String(answered?.lots.length));
  check("两问都到时总量是平台的", answered?.total === Number("1867.97000068"), String(answered?.total));
}

console.log("");
console.log("the panel's numbers");
{
  const { kindOf } = await import("../lib/provider-kinds.ts");
  const kind = kindOf("workbuddy");
  const row = { id: "workbuddy-cn", kind: "workbuddy", region: "cn", enabled: true } as any;

  // 账本读不到：面板上就没有额度，不许编一条签到批次出来。
  const without = kind?.quotas?.(row, { workbuddy: { "workbuddy-cn": { credits: { daily: 100, streakDays: 3 } } } } as any) ?? [];
  check("账本读不到时是空的", without.length === 0, JSON.stringify(without));

  const { parseWorkBuddyResources } = await import("../lib/workbuddy/resources.ts");
  const resources = parseWorkBuddyResources(SUMMARY, PACKAGES);
  const with_ = kind?.quotas?.(row, { workbuddy: { "workbuddy-cn": { credits: null, resources } } } as any) ?? [];
  check("账本在时有一条额度", with_.length === 1, String(with_.length));
  const credits = with_[0]?.credits;
  check("剩余是平台的总积分", credits?.remaining === Number("1867.97000068"), String(credits?.remaining));
  check("总量原样给", credits?.total === Number("1867.97000068"), String(credits?.total));
  check("用掉的是各分组的和", credits?.used === 500 + 1654.02999932, String(credits?.used));
  check("批次是平台的那些", credits?.lots?.length === 2, String(credits?.lots?.length));
  check(
    "批次的来源是平台给的名字",
    credits?.lots?.[0]?.sourceLabel === "CodeBuddy个人版拉新权益包",
    String(credits?.lots?.[0]?.sourceLabel),
  );
  check(
    "批次的状态是有效还是已失效",
    credits?.lots?.[0]?.status === "已失效" && credits?.lots?.[1]?.status === "有效",
    `${credits?.lots?.[0]?.status}/${credits?.lots?.[1]?.status}`,
  );
  check(
    "摘要里有套餐名和各组",
    String(credits?.note).startsWith("套餐：体验版") && String(credits?.note).includes("套餐基础积分"),
    String(credits?.note),
  );
  console.log(`  note: ${credits?.note}`);
}

console.log("");
console.log(`pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
