// lib/log-scrub.ts — 把正文里的敏感值抹掉，只留能读懂这句话的部分。
//
// 上游的正文不能丢（只看状态码分不出「风控」「参数不认」「模型没有」），但
// 正文里也可能带着账号标识、邮箱、令牌这样的东西。stdout 是容器日志：它会被
// 复制、归档、发到别处 —— 那里不该有这些。所以打出去之前先抹一遍。
//
// 抹的是「值」，不是「字段名」：字段名留着（`token` 这个字段还在，只是值没了），
// 这样读日志的人还看得懂那句话在说什么。

/**
 * 名字里带着这些词的字段，值不留。
 *
 * 字段名先按驼峰拆开再对这张表：`accessToken` 拆成 `access_Token`、
 * `userId` 拆成 `user_Id` —— 不拆的话驼峰写法一个都匹配不上（2026-11-03，
 * 作者复查发现：`accessToken` 这种 32 位的令牌既没有 `sk-` 前缀、也不够
 * 40 个字符，按文本里的规则也接不住）。
 *
 * 复数与连字符也算：`tokens` / `accessTokens` / `user-id` 一样要抹。
 */
const SENSITIVE_FIELD =
  /(^|_)(tokens?|secrets?|passwords?|passwds?|cookies?|credentials?|mails?|emails?|uids?|ids?|keys?|user_?ids?|account_?ids?|session_?ids?|api_?keys?|access_?keys?|private_?keys?)(_|$)/i;

/** 抹掉的值。 */
const REDACTED = "[已抹去]";

/**
 * 名字里带 `id`、但**不是**账号标识的那些。
 *
 * `id` 该抹（最常见的账号标识就是它），但请求 id、追踪 id 抹了就没法跟
 * 上游的日志对上了 —— 排查时那正是要找的东西。
 *
 * 录到的真实上游正文里，这些名字装的是**每请求随机**的值（`requestId` 是
 * 随机 hex，`request_id` 是随机 UUID），账号标识用的是别的名字（`user_id`、
 * `uid`、`enterpriseId`、`account_id`）—— 那些不在白名单里，照样被抹。
 */
const SAFE_ID_FIELDS = new Set([
  "request_id",
  "req_id",
  "trace_id",
  "log_id",
  "x_request_id",
  "x_trace_id",
]);

/**
 * 驼峰拆成下划线：`accessToken` → `access_Token`。
 *
 * 拆了才能拿 `token` / `id` / `key` 这些词根去对表 —— 不拆的话驼峰写法
 * 一个都匹配不上（`accessToken` 里 `Token` 前面是字母，不是分隔符）。
 * 连字符也当分隔符：上游爱写 `user-id`。
 */
function normalizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();
}

/** 这个字段的值要不要抹掉。 */
function isSensitiveField(key: string): boolean {
  const name = normalizeKey(key);
  if (SAFE_ID_FIELDS.has(name)) return false;
  return SENSITIVE_FIELD.test(name);
}

/**
 * 把一段正文里的敏感字段去掉，只留能读懂这句话的部分。
 *
 * 去掉的是：邮箱、令牌样的长串（JWT 那种带点的也算）、以及名字里带着
 * token / secret / key / cookie / uid / id 的字段的值。正文是 JSON 就按 JSON
 * 拆，拆不动就按文本里的模式换。
 *
 * SSE 帧（`data: {...}`）是**一帧一帧**地拆。流式上游的正文就是多帧，整段
 * 当一坨去 parse 一定失败 —— 那整条「按字段抹」的规则对流式上游就一点用没有
 * （2026-11-03，作者复查发现）。
 *
 * `maxLength`：留多长。凭据日志留 200（那里要的是「上游说了什么」），控制台
 * 留 500（那里要的是「出了什么事」）。
 */
export function scrubForLog(text: string, maxLength = 200): string {
  const original = (text || "").trim();
  if (!original) return "";
  const frames = framesOf(original);
  let out: string;
  if (frames) {
    // 一帧一帧地抹。
    out = frames.map((frame) => scrubFrame(frame)).join(" ");
  } else {
    // 不是 SSE：整段当 JSON 拆（拆不动就当文本）。
    const parsed = parseMaybeJson(original);
    out =
      parsed && typeof parsed === "object"
        ? JSON.stringify(scrubValue(parsed))
        : original.replace(/\s+/g, " ").trim();
  }
  // 最后一遍按形态抹（邮箱、令牌样的长串、JWT）：JSON 里那些装在字符串值里的
  // 也要抹 —— 按字段名抹不到它们。
  return scrubPatterns(out).slice(0, maxLength);
}

/**
 * 抹一帧。
 *
 * 帧是 JSON 就按字段走；不是（比如 `data: [DONE]`）就当文本。
 */
function scrubFrame(frame: string): string {
  const parsed = parseMaybeJson(frame);
  if (parsed && typeof parsed === "object") {
    return JSON.stringify(scrubValue(parsed));
  }
  return frame.replace(/\s+/g, " ").trim();
}

/** 按字段名把值抹掉。 */
function scrubValue(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => scrubValue(item));
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      isSensitiveField(k) ? REDACTED : scrubValue(v, k),
    ]);
    return Object.fromEntries(entries);
  }
  if (typeof value === "string" && isSensitiveField(key)) return REDACTED;
  return value;
}

/**
 * 这一段正文是不是 SSE（一帧或多帧）：是的话把每一帧拆出来。
 *
 * 不是 SSE 就返回 undefined（走整段 JSON 那条路）。
 */
function framesOf(raw: string): string[] | undefined {
  if (!raw.includes("\n") && !raw.trimStart().startsWith("data:")) return undefined;
  const frames: string[] = [];
  let current: string[] = [];
  let sawData = false;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("data:")) {
      sawData = true;
      if (current.length) {
        frames.push(current.join("\n"));
        current = [];
      }
      current.push(trimmed.slice(5).trim());
      continue;
    }
    if (!trimmed) {
      if (current.length) {
        frames.push(current.join("\n"));
        current = [];
      }
      continue;
    }
    if (current.length) current.push(line);
  }
  if (current.length) frames.push(current.join("\n"));
  if (!sawData) return undefined;
  return frames.length ? frames : undefined;
}

/**
 * 这段正文是不是 JSON：能当 JSON 拆就拆，不能就返回 undefined。
 *
 * SSE 帧的 `data: ` 前缀先剥掉 —— 那是传输层的壳，不是内容。
 */
function parseMaybeJson(raw: string): any {
  let candidate = raw.trim();
  if (candidate.startsWith("data:")) candidate = candidate.slice(5).trim();
  if (!candidate.startsWith("{") && !candidate.startsWith("[")) return undefined;
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

/**
 * 文本里那些「不靠字段名」的形态：邮箱、令牌样的长串、JWT。
 */
function scrubPatterns(text: string): string {
  let out = text;
  out = out.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, REDACTED);
  out = out.replace(/\b(?:gh[pousr]_|sk-|bearer\s+)[A-Za-z0-9._-]{8,}/gi, REDACTED);
  // JWT：两段点分的长串（头.体.签名）。
  out = out.replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED);
  // 引号里的长串（不带点的那种）。
  out = out.replace(/"[A-Za-z0-9_-]{40,}"/g, REDACTED);
  return out;
}
