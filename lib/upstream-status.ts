// lib/upstream-status.ts — what the upstream itself said.
//
// The gateway wraps an upstream's failure in its own error, and the wrapper's
// status is what the client sees. The upstream's own answer is what the
// router needs: the status says whether the request was wrong, and the
// platform's own code says which account cannot serve it.
//
// The transports keep those two on the error, so the routing layer can tell
// "this account is out of credit" from "this request is wrong" without
// knowing anything about the platform's error table.

/** An error that carries the status the upstream sent. */
export interface UpstreamStatus {
  /** The status the upstream sent (or the one that means the same). */
  upstreamStatus?: number;
}

/** An error that carries the platform's own code. */
export interface UpstreamBusinessCode {
  /** The platform's code: a number (MiniMax) or a word (Discovery). */
  businessCode?: number | string;
}

/**
 * An error that carries the moment the account is free again.
 *
 * The upstream says it in two ways: a `retry-after` header, or a time in the
 * body ("您的限额将在 2026-10-30 07:55:44 重置"). The transport puts the moment
 * on the error, so the routing layer does not have to know how each platform
 * says it.
 */
export interface UpstreamCooldown {
  /** The moment the account may serve a request again (ms since the epoch). */
  cooldownUntil?: number;
}

/** Keep the upstream's own status on an error. */
export function withUpstreamStatus<T extends object>(error: T, status: number): T {
  (error as T & UpstreamStatus).upstreamStatus = status;
  return error;
}

/** Keep the platform's own code on an error. */
export function withBusinessCode<T extends object>(error: T, code: number | string): T {
  (error as T & UpstreamBusinessCode).businessCode = code;
  return error;
}

/** The status the upstream sent, if the error carries one. */
export function upstreamStatusOf(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const err = error as UpstreamStatus & { status?: unknown };
  for (const value of [err.upstreamStatus, err.status]) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/**
 * The platform's own code, if the error carries one.
 *
 * A zero code means "no code": the platforms answer 0 on success, and a body
 * that carries 0 is not saying anything about a failure.
 */
export function businessCodeOf(error: unknown): number | string | null {
  if (!error || typeof error !== "object") return null;
  const err = error as UpstreamBusinessCode & { code?: unknown };
  const value = err.businessCode ?? err.code;
  if (typeof value === "number") return Number.isFinite(value) && value !== 0 ? value : null;
  if (typeof value === "string") {
    const text = value.trim();
    return text && text !== "0" ? text : null;
  }
  return null;
}

/**
 * 平台自己的码，从上游的正文里读（如果那里有）。
 *
 * 状态码说的是「这个请求被拒了」，业务码说的是「为什么」：风控（WorkBuddy
 * 的 11128）与参数不认都是 400，换一个账号的结果却不一样，所以码要带上。
 *
 * 正文里码的位置不统一：有的在顶层 `code`，有的在 `error.code`。两个都看，
 * 取第一个有值的。
 *
 * 0 不算码：有的平台成功时也回 `code: 0`，把它当成「没有码」。
 */
export function businessCodeOfBody(text: string): number | string | null {
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
  return businessCodeOfPayload(parsed);
}

/**
 * 平台自己的码，从**已经解析出来的**正文里读。
 *
 * 正文可能带着 `data:` 前缀（SSE 的一帧），直接 parse 整个正文会失败 ——
 * 所以这里接的是解析好的那个 payload。
 *
 * `error.code` 先看，顶层的 `code` 后看：`error` 里那个是**这个错误**的码，
 * 顶层那个有时是整个响应的码（成功时是 0）。两个都看，谁有值算谁。
 */
export function businessCodeOfPayload(payload: any): number | string | null {
  for (const value of [payload?.error?.code, payload?.code]) {
    if (typeof value === "string") {
      const text = value.trim();
      // "0" 与 0 一样：没有码。
      if (text && text !== "0") return text;
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value) && value !== 0) return value;
  }
  return null;
}

/**
 * 这个正文是不是上游的「错误信封」：只有业务码，没有答复。
 *
 * 上游有时用 200 回一个错 —— WorkBuddy 的渠道校验就是（业务码 11128）。当成
 * 正常的帧的话，客户端收到一个空的 200 答复，看着像模型答了个空，理由也没
 * 有（2026-11-03，作者复查发现：非流式那条路上没认这种信封）。
 *
 * 有答复的正文（`choices` / `object` / `data`）不算：那是正常的帧。
 */
export function isBusinessErrorEnvelope(payload: any): boolean {
  if (!payload || typeof payload !== "object") return false;
  if (payload.choices || payload.object || payload.data !== undefined) return false;
  return businessCodeOfPayload(payload) !== null;
}

/** Keep the moment the account is free again on an error. */
export function withCooldownUntil<T extends object>(error: T, untilMs: number): T {
  (error as T & UpstreamCooldown).cooldownUntil = untilMs;
  return error;
}

/** The moment the account is free again, if the error carries one. */
export function cooldownUntilOf(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const value = (error as UpstreamCooldown).cooldownUntil;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * How long the upstream says to wait, in milliseconds.
 *
 * `retry-after` is either a number of seconds or an HTTP date. Both are read.
 * `null` means the upstream did not say.
 */
export function retryAfterMs(response: Response): number | null {
  const raw = response?.headers?.get?.("retry-after");
  if (!raw) return null;
  const text = String(raw).trim();
  if (!text) return null;
  const seconds = Number(text);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const at = Date.parse(text);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return null;
}
