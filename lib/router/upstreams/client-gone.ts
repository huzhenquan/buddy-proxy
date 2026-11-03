// lib/router/upstreams/client-gone.ts — 客户端走了的时候，怎么把上游停掉。
//
// 客户端走了（连接断了、它按了取消）：上游还在算就是在计费，账号还占着。所以
// 要把上游停掉 —— 停掉靠的是一个信号，fetch 与读流都听它的。
//
// 这一层只管「盯」与「翻译」两件事：
//   · 盯：连接断了就中断那个信号；
//   · 翻译：被我们掐断的上游抛的是 AbortError，而那个名字在别处被当成
//     「超时」（可以降级、换一个账号再试）。客户端都走了还降级，就是再打一个
//     白花钱的上游，还给账号记一次不该记的冷却。

import type Koa from "koa";
import { ClientGoneError } from "../deliver.ts";

/** 盯着「客户端走了」这件事。 */
export interface ClientGoneWatch {
  /** 客户端走了就中断的信号：交给上游的 fetch 与读流的那个循环。 */
  readonly signal: AbortSignal;
  /** 客户端已经走了吗。 */
  gone(): boolean;
  /** 不再盯了（答复已经送出去，或者上游的失败另有原因）。 */
  stop(): void;
}

/**
 * 盯住「客户端走了」这件事。
 *
 * 监听器挂在响应上：响应断了就是客户端走了。
 *
 * 连接可能在我们挂上监听器**之前**就断了 —— 那个事件已经发过了，谁也没听见。
 * 那就当它已经走了（不然这一段没人管：上游接着算到超时，账号照付这笔钱）。
 */
export function watchClientGone(out: Koa.Context): ClientGoneWatch {
  const abort = new AbortController();
  const onClose = () => {
    if (!abort.signal.aborted) abort.abort();
  };
  out.res.once("close", onClose);
  if (out.res.destroyed) onClose();
  return {
    signal: abort.signal,
    gone: () => abort.signal.aborted,
    stop: () => out.res.off("close", onClose),
  };
}

/**
 * 这个失败是「客户端走了」吗。
 *
 * 上游的 fetch 是被我们的信号掐掉的，所以它抛的是 AbortError。那个名字在
 * `lib/router/provider-selection.ts` 里被算成「超时」—— 是「可以降级、换一个
 * 账号再试」的错。那样一来：客户端都走了，却给账号记一分钟冷却，还要再打一
 * 个上游（那个上游白花钱，而且客户端已经不要了）。
 *
 * 所以这里把它换成 ClientGoneError：它的意思就是「不是上游的错，别降级」。
 *
 * 已经是它的，原样留着；不是掐断造成的（上游自己回的 400 之类），也原样留着
 * —— 那种时候账号的账还是要照记。
 */
export function asClientGone(error: unknown, watch: ClientGoneWatch): unknown {
  if (error instanceof ClientGoneError) return error;
  if (!watch.gone()) return error;
  if (!isAbortError(error)) return error;
  return new ClientGoneError();
}

/**
 * 这个错是「被掐断了」吗。
 *
 * 只认 AbortError：超时也是掐断，但那个是上游的错（上游太久没回），该记冷却
 * 就记冷却 —— 换了账号也许能答得更快。
 */
function isAbortError(error: unknown): boolean {
  const e = error as { name?: unknown; message?: unknown; cause?: unknown } | null;
  if (!e) return false;
  if (e.name === "AbortError") return true;
  if (e.name === "TimeoutError") return false;
  if (typeof e.message === "string" && /abort/i.test(e.message)) return true;
  const cause = e.cause as { name?: unknown } | undefined;
  return cause?.name === "AbortError";
}
