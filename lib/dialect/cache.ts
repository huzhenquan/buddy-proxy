// lib/dialect/cache.ts — 缓存那部分输入，两种方言的算法不一样。
//
// OpenAI：prompt_tokens 是**全部**输入，命中缓存的那部分是它的一部分
//   （prompt_tokens_details.cached_tokens）。
//
// Anthropic：input_tokens 只算**没命中缓存的**，命中读到的（cache_read）与
//   写进去的（cache_creation）另外两个字段，要加起来才是全部输入。
//
// 少了这一步转换，一个 3487 令牌、其中 3328 命中缓存的请求，Anthropic 那边
// 看到的是 input_tokens 3487 加 cache_read 3328 —— 缓存率算出来只有一半，
// 而且记账层（lib/usage.ts 的 usageTotals）按 Anthropic 的算法再加起来，
// 记成 6815 个输入令牌。记账层早就是按 Anthropic 的算法写的，所以这里按它
// 的算法改。

import type { Json } from "../json.ts";

/** 一个数，不是数就当 0。 */
function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * 上游报了多少命中缓存的输入。
 *
 * 三种报法都认：OpenAI 的 prompt_tokens_details.cached_tokens、平台自己那套
 * prompt_cache_hit_tokens（WorkBuddy 两个都报）、以及 Anthropic 的
 * cache_read_input_tokens。
 */
export function cachedInputOfOpenAI(usage: any): number {
  const value =
    usage?.prompt_tokens_details?.cached_tokens ??
    usage?.prompt_cache_hit_tokens ??
    usage?.cache_read_input_tokens;
  return num(value);
}

/**
 * OpenAI 的 usage → Anthropic 的 usage。
 *
 * input_tokens 是没命中缓存的那部分（Anthropic 的算法）。
 */
export function anthropicUsageOf(openaiUsage: any, outputTokens: number): Json {
  const prompt = num(openaiUsage?.prompt_tokens);
  const cached = cachedInputOfOpenAI(openaiUsage);
  return {
    input_tokens: Math.max(0, prompt - cached),
    output_tokens: outputTokens,
    ...(cached ? { cache_read_input_tokens: cached } : {}),
  };
}

/**
 * Anthropic 的 usage → OpenAI 的 usage。
 *
 * prompt_tokens 是全部输入（命中缓存的那部分算在里面），命中了多少放在
 * prompt_tokens_details.cached_tokens 里。
 */
export function openAIUsageOf(anthropicUsage: any): Json {
  const input = num(anthropicUsage?.input_tokens);
  const read = num(anthropicUsage?.cache_read_input_tokens);
  const write = num(anthropicUsage?.cache_creation_input_tokens);
  const prompt = input + read + write;
  const output = num(anthropicUsage?.output_tokens);
  return {
    prompt_tokens: prompt,
    completion_tokens: output,
    total_tokens: prompt + output,
    ...(read ? { prompt_tokens_details: { cached_tokens: read } } : {}),
    ...(read ? { prompt_cache_hit_tokens: read } : {}),
  };
}
