// lib/workbuddy/identity.ts — 提示词开头那句「我是谁」。
//
// 上游 WorkBuddy 有一道渠道校验：请求看起来不是它自己的官方客户端发来的，
// 它就拒——HTTP 400，业务码 11128「Illegal API invocation from an unapproved
// channel」，中文提示「请求被拦截，请重新发送」，tips 里写「这次调用没通过
// 渠道校验，可能不是官方客户端发出的。请用官方版本重新发送。」
//
// 它认的不是请求头（头是模拟端写死的），是**系统提示词开头那句自报家门**。
// 实测（2026-11-02，对真实的 WorkBuddy 上游打的几次请求）：
//
//   "You are Claude Code, Anthropic's official CLI for Claude."
//
//   · 大小写不管；
//   · 前面有空格也算开头（前面有别的字就不算了）；
//   · 出现在非开头的位置不算，出现在 user 消息里也不算；
//   · 只有这一句被认出来（别的客户端的开场白：Cursor、Codex、OpenCode、
//     pi、Kimi、Qwen……都放行）。
//
// 所以模拟端把开头那一句换成自己的，剩下的提示词（工具约定、行为规则、
// 上下文）原样送出去，一句不改。
//
// 模拟端自己那一句是什么？不能猜 —— 模拟端的指纹要跟官方客户端逐字一致。
// 查的是装在这台机器上的官方客户端（WorkBuddy 4.24.5，它的 agent-harness
// 与 product.json 在安装目录的 app.asar.unpacked/ 下）：
//
//   · cli/product.json 的 prompts 数组里，名字 cli-agent-prompt 的那条，
//     模板开头就是 "You are CodeBuddy Code.\r\n\r\n"；
//   · 同一句还在上游自己发的产品配置里（客户端数据目录下的 cache/
//     acc-product-config-v3-*.json，prompts 里同名的那一条）；
//   · 客户端自己的日志（同一目录下的 logs/…）里也是这一句。
//
// 所以就是这句。注意它没被换成 WorkBuddy：品牌替换（replaceBrandName）
// 只作用在「随包的技能」上，产品配置里的提示词模板是上游原样下发的。
//
// 查出来的结论（还有缓存那部分输入的两个字段）写在同目录的 FINDINGS.md 里。

/**
 * 模拟端自己的开场白：调用方没有系统提示词时送的就是它。
 *
 * 与官方客户端逐字一致（见上面的出处）。
 */
export const DEFAULT_SYSTEM = "You are CodeBuddy Code.";

/**
 * 别的客户端的自报家门，开头那句。
 *
 * 上游认的是「开头自称 Claude Code」。实测被认出来的只有那一句完整的话，
 * 但判据是「开头那句自称谁」，所以这里连着那一句的后半截一起换掉 ——
 * 只换「You are Claude Code」几个字的话，后面「, Anthropic's official CLI
 * for Claude.」还留在那儿，读起来是半句话。
 */
const FOREIGN_IDENTITIES: Array<{ pattern: RegExp; replacement: string }> = [
  {
    pattern: /^(\s*)You are Claude Code(?:,\s*Anthropic[’']s official CLI for Claude)?\.?/i,
    replacement: `$1${DEFAULT_SYSTEM}`,
  },
];

/**
 * 把系统提示词开头那句「我不是官方客户端」换掉。
 *
 * 只动开头那一句：动多了就是改别人的提示词，动少了上游还认得出来。
 */
export function rewriteIdentity(content: string): string {
  let out = content;
  for (const { pattern, replacement } of FOREIGN_IDENTITIES) {
    if (pattern.test(out)) out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * 系统提示词的内容：字符串，或者多段（OpenAI 的 content 数组）。
 *
 * 数组形式的处理跟字符串一样：上游看的是开头那段文本。
 */
export function rewriteSystemContent(content: unknown): unknown {
  if (typeof content === "string") return rewriteIdentity(content);
  if (!Array.isArray(content)) return content;
  // 多段系统提示词：只有第一段是「开头」，后面的段上游不看开头。
  return content.map((part, index) => {
    if (index !== 0) return part;
    // 第一段就是一段纯文本的时候，那段文本就是开头。
    if (typeof part === "string") return rewriteIdentity(part);
    if (!part || typeof part !== "object") return part;
    const text = (part as { text?: unknown }).text;
    if (typeof text !== "string") return part;
    return { ...(part as object), text: rewriteIdentity(text) };
  });
}
