// test/dialect-cache-check.ts — 缓存那部分输入，两种方言的算法不一样。
//
//   node --experimental-strip-types test/dialect-cache-check.ts
//
// 离线：只测转换器里的纯函数，不起网关，不连任何上游。
//
// OpenAI 的 prompt_tokens 是**全部**输入，命中缓存的那部分是它的一部分；
// Anthropic 的 input_tokens 只算**没命中缓存**的，命中读到的另外报。
//
// 少了这一步转换，一个 3487 令牌、其中 3328 命中缓存的请求，Anthropic 那边
// 看到的是 input_tokens 3487 加 cache_read_input_tokens 3328：缓存率算出来
// 只有一半，记账层（usageTotals 按 Anthropic 的算法加）还会记成 6815 个输入
// 令牌。2026-11-02，WorkBuddy 的上游其实命中 99.8%，面板上看着像没缓存。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dialect-cache-"));
process.env.BUDDY_DATA_DIR = tmp;

const { openaiToAnthropicResponse, anthropicToOpenAIResponse } = await import("../lib/dialect/response.ts");
const { openaiStreamToAnthropic, anthropicStreamToOpenAI } = await import("../lib/dialect/stream.ts");

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** 把一组帧喂给转换器，返回它吐出来的每一帧。 */
async function frames(chunks: unknown[]): Promise<string> {
  const out: string[] = [];
  for await (const frame of openaiStreamToAnthropic(
    (async function* () {
      for (const chunk of chunks) yield chunk;
    })(),
    "test-model",
  )) {
    out.push(String(frame));
  }
  return out.join("");
}

console.log("");
console.log("OpenAI 的 usage → Anthropic 的 usage");

const fromOpenAI = openaiToAnthropicResponse(
  {
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 3487,
      completion_tokens: 13,
      prompt_tokens_details: { cached_tokens: 3328 },
    },
  },
  "test-model",
);
check("input_tokens 是没命中缓存的那部分", fromOpenAI.usage?.input_tokens === 159, JSON.stringify(fromOpenAI.usage));
check("命中缓存的另报一个字段", fromOpenAI.usage?.cache_read_input_tokens === 3328, JSON.stringify(fromOpenAI.usage));
check("输出 token 照旧", fromOpenAI.usage?.output_tokens === 13, JSON.stringify(fromOpenAI.usage));

// WorkBuddy 上游两种报法都报：prompt_tokens_details.cached_tokens 与
// prompt_cache_hit_tokens。
const fromWorkBuddy = openaiToAnthropicResponse(
  {
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 88645, completion_tokens: 20, prompt_cache_hit_tokens: 88448 },
  },
  "test-model",
);
check("平台自己那套报法也认", fromWorkBuddy.usage?.input_tokens === 197, JSON.stringify(fromWorkBuddy.usage));
check("平台报了多少命中就是多少", fromWorkBuddy.usage?.cache_read_input_tokens === 88448, JSON.stringify(fromWorkBuddy.usage));

// WorkBuddy 有时两个字段都报，其中 prompt_tokens_details.cached_tokens 是 0，
// 真的命中数在 prompt_cache_hit_tokens 里。用「第一个存在的」去取会拿到那个
// 0 —— 缓存率看着像全 miss，其实命中了 99.8%（2026-11-02，作者复查发现）。
const fromWorkBuddyBoth = openaiToAnthropicResponse(
  {
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 88645,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 0 },
      prompt_cache_hit_tokens: 88448,
    },
  },
  "test-model",
);
check("两个字段都报时取那个非零的", fromWorkBuddyBoth.usage?.input_tokens === 197, JSON.stringify(fromWorkBuddyBoth.usage));
check(
  "两个字段都报时命中数也没被那个 0 盖掉",
  fromWorkBuddyBoth.usage?.cache_read_input_tokens === 88448,
  JSON.stringify(fromWorkBuddyBoth.usage),
);

const noCache = openaiToAnthropicResponse(
  {
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 5 },
  },
  "test-model",
);
check("没有缓存时 input_tokens 就是全部输入", noCache.usage?.input_tokens === 100, JSON.stringify(noCache.usage));
check("没有缓存时不报 cache_read", !("cache_read_input_tokens" in (noCache.usage ?? {})), JSON.stringify(noCache.usage));

console.log("");
console.log("Anthropic 的 usage → OpenAI 的 usage");

const toOpenAI = anthropicToOpenAIResponse(
  {
    role: "assistant",
    content: [{ type: "text", text: "hi" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 159, output_tokens: 13, cache_read_input_tokens: 3328 },
  },
  "test-model",
);
check("prompt_tokens 是全部输入", toOpenAI.usage?.prompt_tokens === 3487, JSON.stringify(toOpenAI.usage));
check("命中缓存的算在里面", toOpenAI.usage?.prompt_tokens_details?.cached_tokens === 3328, JSON.stringify(toOpenAI.usage));
check("total_tokens 加上输出", toOpenAI.usage?.total_tokens === 3500, JSON.stringify(toOpenAI.usage));

// 写进缓存的那部分（cache_creation）不该被丢掉：转成 OpenAI 再转回来，
// 它还是「写进去」，不能变成「没命中」。
const withCreation = anthropicToOpenAIResponse(
  {
    role: "assistant",
    content: [{ type: "text", text: "hi" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 200, cache_creation_input_tokens: 300 },
  },
  "test-model",
);
check("写进缓存的算在 prompt_tokens 里", withCreation.usage?.prompt_tokens === 600, JSON.stringify(withCreation.usage));
check("写进缓存的有自己的字段", withCreation.usage?.cache_creation_input_tokens === 300, JSON.stringify(withCreation.usage));

const backToAnthropic = openaiToAnthropicResponse(
  {
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 600,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 200 },
      cache_creation_input_tokens: 300,
    },
  },
  "test-model",
);
check("转回来时写进去的还是写进去", backToAnthropic.usage?.cache_creation_input_tokens === 300, JSON.stringify(backToAnthropic.usage));
check("转回来时没命中的只有 100", backToAnthropic.usage?.input_tokens === 100, JSON.stringify(backToAnthropic.usage));

console.log("");
console.log("流式");

const streamFrame = await frames([
  { choices: [{ delta: { content: "hi" } }] },
  {
    choices: [],
    usage: { prompt_tokens: 3487, completion_tokens: 13, prompt_tokens_details: { cached_tokens: 3328 } },
  },
]);
check("流里的 input_tokens 也是没命中缓存的那部分", streamFrame.includes('"input_tokens":159'), streamFrame.slice(-400));
check("流里的 cache_read_input_tokens 也在", streamFrame.includes('"cache_read_input_tokens":3328'), streamFrame.slice(-400));

// Anthropic 的流 → OpenAI 的流
function sseBody(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) controller.enqueue(encoder.encode(e));
      controller.close();
    },
  });
}

const anthropicFrames: string[] = [];
for await (const frame of anthropicStreamToOpenAI(
  sseBody([
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", usage: { input_tokens: 159, output_tokens: 0, cache_read_input_tokens: 3328 } } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ]),
  "test-model",
)) {
  anthropicFrames.push(String(frame));
}
const anthropicStream = anthropicFrames.join("");
check("Anthropic 的流转成 OpenAI 时 prompt_tokens 是全部输入", anthropicStream.includes('"prompt_tokens":3487'), anthropicStream.slice(-400));
check("命中缓存的也在 prompt_tokens_details 里", anthropicStream.includes('"cached_tokens":3328'), anthropicStream.slice(-400));

console.log("");
console.log(`pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
