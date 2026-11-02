// test/deliver-backpressure-check.ts — 客户端读得慢时，流不能被砍断。
//
//   node --experimental-strip-types test/deliver-backpressure-check.ts
//
// 离线：起一个本地的假上游和一个真的 HTTP 服务，不连任何真平台。
//
// 那个 bug（2026-11-02）：`res.write()` 返回 false 的意思是「发送缓冲区满了，
// 该等 drain 了」，**不是**「客户端走了」。网关把 false 当成「客户端没了」，
// 直接 break 掉写帧的循环 —— 客户端只是读得慢，长答复就在中间被砍断：
// HTTP 200，收到部分正文，没有收尾帧（message_delta / message_stop）。
// 代理那侧记成 output_estimated=1，Claude Code 那侧记成 stream_truncated。
//
// 覆盖：
//   1. 客户端连上以后先不读（把缓冲区填满），再读 → 整条流一个不少；
//   2. 收尾帧（message_delta + message_stop）一定在；
//   3. 客户端真的走了 → 网关不报错、不挂住，上游的流被取消（还在计费呢）；
//   4. 客户端连着但不读 → 网关等一会儿就断开，不把这条请求永远吊着。
//
// 断言看的是**网关那一侧**：处理器什么时候返回、写了多少帧、上游有没有被
// 取消。客户端那一侧不可靠 —— 一个不读的 socket 连服务器关了它都察觉不到
// （要等它自己读）。

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deliver-backpressure-"));
process.env.BUDDY_DATA_DIR = tmp;

const { deliverOpenAIStream, deliverAnthropicStream } = await import("../lib/router/deliver.ts");

let pass = 0;
let fail = 0;

// 整个测试的总时限：挂了就退出，别把 `mise run test` 一起吊住。
const WATCHDOG_MS = 60_000;
const watchdog = setTimeout(() => {
  console.error(`\n[FAIL] 整个测试超过 ${WATCHDOG_MS / 1000}s 没跑完（网关可能挂住了）`);
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref?.();

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * 一个假的上游：它一帧一帧地吐，每帧都不小。
 *
 * 帧要够大、够多，客户端不读的时候才会把网关的发送缓冲区填满（Node 的
 * highWaterMark 是 16KB）。
 *
 * `intervalMs`：帧与帧之间隔多久。上游是慢慢想、慢慢说的，不是哗一下全倒
 * 出来 —— 客户端要走的那条路也只有在上游还在说的时候才走得到。
 *
 * 这一点对「上游的流被取消了」那条断言是关键的：上游要是先把话说完就断了，
 * 那条流是**正常结束**的，压根不会有人去取消它，断言就成了在问「一个已经
 * 结束的流会被取消吗」。要看的是「上游还在说的时候客户端走了，它得停下来」。
 *
 * `frameBytes`：一帧多大。「客户端一直不读」那一条要靠它把 socket 的发送
 * 缓冲区撑满：Linux 上那个缓冲区能自动涨到几 MB，800KB 会被整个吸进去，
 * 于是每一帧都「写成功了」，看门狗根本没机会上膛 —— 那条断言就变成了在
 * 猜操作系统的缓冲区多大（2026-11-02，作者复查发现）。
 *
 * `onCancel`：上游的流被取消时叫它（客户端走了，上游就不该接着算）。
 */
function fakeUpstream(
  frames: number,
  opts: { intervalMs?: number; frameBytes?: number; onCancel?: () => void } = {},
): ReadableStream<Uint8Array> {
  let sent = 0;
  const size = opts.frameBytes ?? 2000;
  const frame = () =>
    Buffer.from(
      `data: ${JSON.stringify({
        id: "c1",
        object: "chat.completion.chunk",
        model: "fake-model",
        choices: [{ index: 0, delta: { content: "x".repeat(size) }, finish_reason: null }],
      })}\n\n`,
    );
  return new ReadableStream<Uint8Array>({
    // 一帧一帧地给，帧与帧之间隔 intervalMs：上游是慢慢想、慢慢说的，不是
    // 哗一下全倒出来 —— 客户端要走的那条路也只有在上游还在说的时候才走得到。
    async pull(controller) {
      if (opts.intervalMs) await sleep(opts.intervalMs);
      if (sent >= frames) {
        controller.enqueue(Buffer.from("data: [DONE]\n\n"));
        controller.close();
        return;
      }
      sent++;
      controller.enqueue(frame());
    },
    cancel() {
      opts.onCancel?.();
    },
  });
}

/** 等一会儿。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 一个最小的 Koa 上下文：只用到 res。 */
function fakeCtx(res: http.ServerResponse): any {
  return { res, status: 200, respond: false } as any;
}

interface ServeResult {
  /** 客户端收到的帧。 */
  received: string[];
  /** 网关那个处理器什么时候回来的（ms，从起服务算起）。 */
  handlerMs: number;
  /** 网关有没有抛出来。 */
  handlerError: string | null;
  /** 网关写了多少帧（写进 socket 的，不一定是客户端读到的）。 */
  written: number;
  /** 上游的流有没有被取消（客户端走了就不该接着算）。 */
  upstreamCancelled: boolean;
  /** 网关报给调用方的失败（如果有）。 */
  failure: unknown;
}

/**
 * 起一个服务，把假上游的流交给网关转发；客户端按给定的节奏读。
 *
 * `stallMs`：客户端在这之前不读（读得慢）。
 * `neverRead`：客户端一直不读（连接还开着，人没了）。
 * `leaveAfterMs`：客户端在这之后直接断开（真的走了）。
 */
async function serve(opts: {
  frames: number;
  stallMs: number;
  neverRead?: boolean;
  leaveAfterMs?: number;
  intervalMs?: number;
  frameBytes?: number;
  pingMs?: number;
  /** 客户端说的方言：上游的答复要转成它。 */
  dialect?: "openai" | "anthropic";
}): Promise<ServeResult> {
  const started = Date.now();
  let written = 0;
  let handlerError: string | null = null;
  let upstreamCancelled = false;
  let failure: unknown = null;
  let handlerDone: () => void = () => {};
  const handlerFinished = new Promise<void>((resolve) => {
    handlerDone = resolve;
  });

  const server = http.createServer(async (req, res) => {
    const ctx = fakeCtx(res);
    const originalWrite = res.write.bind(res);
    res.write = ((chunk: any, ...rest: any[]) => {
      written++;
      return (originalWrite as any)(chunk, ...rest);
    }) as any;
    const upstream = fakeUpstream(opts.frames, {
      intervalMs: opts.intervalMs,
      frameBytes: opts.frameBytes,
      onCancel: () => {
        upstreamCancelled = true;
      },
    });
    try {
      if (opts.pingMs !== undefined) {
        // Anthropic 方言那条路：ping 是它自己发的（MiniMax Code 那条上游）。
        await deliverAnthropicStream(ctx, upstream, "anthropic", "fake-model", opts.pingMs, undefined, (e) => {
          failure = e;
        });
      } else {
        await deliverOpenAIStream(ctx, upstream, opts.dialect ?? "anthropic", "fake-model", undefined, undefined, (e) => {
          failure = e;
        });
      }
    } catch (e) {
      handlerError = (e as Error)?.message ?? String(e);
    } finally {
      handlerDone();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;

  const received: string[] = [];
  const clientDone = new Promise<void>((resolve) => {
    const req = http.request(
      { port, host: "127.0.0.1", path: "/v1/messages", method: "POST" },
      (r) => {
        let buf = "";
        r.pause();
        if (opts.neverRead) {
          // 一直不读：连接还开着，人没了。
        } else if (opts.stallMs > 0) {
          // 先不读：让网关的发送缓冲区满掉。
          setTimeout(() => r.resume(), opts.stallMs);
        } else {
          r.resume();
        }
        r.on("data", (c) => {
          buf += c.toString();
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            received.push(buf.slice(0, i));
            buf = buf.slice(i + 2);
          }
        });
        r.on("end", resolve);
        r.on("close", resolve);
        r.on("error", resolve);
      },
    );
    req.on("error", resolve);
    req.end("{}");
    if (opts.leaveAfterMs !== undefined) {
      // 客户端真的走了。
      setTimeout(() => {
        req.destroy();
        resolve();
      }, opts.leaveAfterMs);
    }
  });

  // 网关那一侧先完事：这是断言要看的东西。
  await Promise.race([
    handlerFinished,
    new Promise<void>((resolve) => setTimeout(resolve, 30_000)),
  ]);
  const handlerMs = Date.now() - started;

  // 客户端那边：它可能一直不结束（不读的 socket 察觉不到服务器关了它），
  // 所以给它一个上限，然后放掉。
  await Promise.race([
    clientDone,
    new Promise<void>((resolve) => setTimeout(resolve, 1000)),
  ]);

  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return { received, handlerMs, handlerError, written, upstreamCancelled, failure };
}

console.log("");
console.log("客户端读得慢");

// 400 帧 × 2KB ≈ 800KB：客户端不读的话，缓冲区一定会满。
const stalled = await serve({ frames: 400, stallMs: 300 });
const text = stalled.received.join("\n");
check("每一帧都送到了", stalled.received.length >= 400, `${stalled.received.length} 帧`);
check("有收尾的 message_delta", text.includes('"message_delta"'), "");
check("有收尾的 message_stop", text.includes('"message_stop"'), "");
check("网关没有抛错", stalled.handlerError === null, stalled.handlerError ?? "");

console.log("");
console.log("客户端一直读");

const normal = await serve({ frames: 400, stallMs: 0 });
const normalText = normal.received.join("\n");
check("每一帧都送到了", normal.received.length >= 400, `${normal.received.length} 帧`);
check("有收尾的 message_delta", normalText.includes('"message_delta"'), "");
check("有收尾的 message_stop", normalText.includes('"message_stop"'), "");

console.log("");
console.log("客户端真的走了");

// 上游还在慢慢说的时候客户端断开：这条路上 writeFrame 会返回 false。
// 网关不该报错、不该挂住 —— 客户端走了就是走了。
const left = await serve({ frames: 400, stallMs: 0, leaveAfterMs: 100, intervalMs: 20 });
check("网关没有抛错", left.handlerError === null, left.handlerError ?? "");
check("网关很快就收工了", left.handlerMs < 5_000, `用了 ${left.handlerMs}ms`);
// 客户端不要了，上游就别接着算：那条流还在吐字就是在计费。
check("上游的流被取消了", left.upstreamCancelled, "上游还在算");
// 这一条不算成功：客户端没拿到完整的答复。
check("网关报了失败", left.failure !== null, String(left.failure));
check(
  "那个失败是「客户端走了」",
  (left.failure as any)?.name === "ClientGoneError",
  String((left.failure as any)?.name),
);

console.log("");
console.log("客户端连着但不读");

// 连接还开着，却永远不读：网关等一会儿就该断开，不该把这条请求吊死。
//
// 断开的判据是**时间**，不是「写了多少帧」：socket 的缓冲区有多大是操作系统
// 说了算的（Linux 上能自动涨到几 MB），拿帧数当判据在这个平台上会飘。
// 真正的判据是：网关在上限之内自己收了工。
//
// 帧要够大（256KB × 200 ≈ 50MB）：发送缓冲区吸不下这么多，写回调就迟迟
// 不来，看门狗才上得了膛。800KB 在 Linux 上会被整个吸进去 —— 那时每一帧都
// 「写成功了」，这条断言就变成在猜操作系统的缓冲区多大。
process.env.BUDDY_DRAIN_TIMEOUT_MS = "300";
const stuck = await serve({
  frames: 200,
  stallMs: 0,
  neverRead: true,
  frameBytes: 256 * 1024,
});
delete process.env.BUDDY_DRAIN_TIMEOUT_MS;
check("网关等了一会儿就断了", stuck.handlerMs < 10_000, `用了 ${stuck.handlerMs}ms`);
check("网关没有抛错", stuck.handlerError === null, stuck.handlerError ?? "");
// 客户端不读时它收不到任何东西 —— 这条断言说明的是「没收工就没有帧」，
// 不是「缓冲区有多大」。
check("客户端一帧也没收到", stuck.received.length === 0, `${stuck.received.length} 帧`);
// 同样地，上游不该接着算。
check("上游的流被取消了", stuck.upstreamCancelled, "上游还在算");

console.log("");
console.log("上游在想的时候，客户端不该被踢掉");

// 上游安静了一阵（推理模型在想）——那不是「客户端不读了」。看门狗量的是
// 「一帧在发送缓冲区里等了多久」，不是「帧与帧之间隔了多久」。
// 2026-11-02，作者复查发现：量错了的话，一个 thinking 的上游安静 45 秒就会
// 把好好一个客户端踢掉，答复也断了。
process.env.BUDDY_DRAIN_TIMEOUT_MS = "300";
const thinking = await serve({ frames: 6, stallMs: 0, intervalMs: 400 });
delete process.env.BUDDY_DRAIN_TIMEOUT_MS;
check("客户端一直在读", thinking.received.length >= 6, `${thinking.received.length} 帧`);
check("答复完整", thinking.received.join("\n").includes('"message_stop"'), "");
check("网关没有抛错", thinking.handlerError === null, thinking.handlerError ?? "");

console.log("");
console.log("ping 不该把看门狗顶掉");

// Anthropic 方言那条路会自己发 ping（MiniMax Code 那条上游）。ping 是定时发
// 的，不等前面那帧发出去 —— 所以它不能把「最早那一帧等了多久」的期限往后推。
// 2026-11-02，作者复查发现：推一次就永远推不到那个上限，看门狗等于没有，
// 客户端不读了也没人管，上游一直算下去。
process.env.BUDDY_DRAIN_TIMEOUT_MS = "300";
const pinged = await serve({
  frames: 100,
  stallMs: 0,
  neverRead: true,
  frameBytes: 256 * 1024,
  // 上游得还在说：这条路上 tee 把源流复制成两半，其中一半没人读，源流照样
  // 能一口气把话说完 —— 说完就是正常结束，没人去取消它，「上游被取消了」
  // 那条断言就问了个没意义的问题。隔 20ms 一帧，300ms 的时候它还在说。
  intervalMs: 20,
  pingMs: 100,
});
delete process.env.BUDDY_DRAIN_TIMEOUT_MS;
check("网关还是断了", pinged.handlerMs < 10_000, `用了 ${pinged.handlerMs}ms`);
check("上游的流被取消了", pinged.upstreamCancelled, "上游还在算");
check(
  "网关报了失败",
  (pinged.failure as any)?.name === "ClientGoneError",
  String((pinged.failure as any)?.name),
);

console.log("");
console.log("客户端在上游的第一帧之前就走了");

// 推理模型的第一帧可能要等几十秒。客户端在这之前按了取消：网关得马上知道，
// 把上游停掉 —— 不然上游接着算（还在计费），账号照付这几十秒，客户端一个字
// 没拿到（2026-11-03，作者复查发现）。
process.env.BUDDY_DRAIN_TIMEOUT_MS = "300";
const beforeFirst = await serve({
  frames: 5,
  stallMs: 0,
  leaveAfterMs: 100,
  intervalMs: 1500,
});
delete process.env.BUDDY_DRAIN_TIMEOUT_MS;
check("网关很快就收工了", beforeFirst.handlerMs < 1_200, `用了 ${beforeFirst.handlerMs}ms`);
check("上游的流被取消了", beforeFirst.upstreamCancelled, "上游还在算");
check(
  "网关报了失败",
  (beforeFirst.failure as any)?.name === "ClientGoneError",
  String((beforeFirst.failure as any)?.name),
);

console.log("");
console.log("上游安静的时候客户端走了");

// 上游说了一句，然后在想（安静）。客户端在这期间断开：这条请求**不算成功**
// —— 客户端一个字都没拿到。记成成功的话，日志与事实相反：用量走的是估算，
// 账号的冷却还被清掉了（2026-11-03，作者复查发现）。
const quiet = await serve({
  frames: 5,
  stallMs: 0,
  leaveAfterMs: 2_000,
  intervalMs: 1_500,
  dialect: "openai",
});
check("上游的流被取消了", quiet.upstreamCancelled, "上游还在算");
check(
  "网关报了「客户端走了」",
  (quiet.failure as any)?.name === "ClientGoneError",
  String((quiet.failure as any)?.name),
);

// 同一条事，tee 那条路（Anthropic 方言，ping 是自己发的）：上游被复制成两
// 支，其中一支没人读。客户端走了，两支都得停下来。
const quietTee = await serve({
  frames: 5,
  stallMs: 0,
  leaveAfterMs: 2_000,
  intervalMs: 1_500,
  pingMs: 500,
});
check("上游的流被取消了", quietTee.upstreamCancelled, "上游还在算");
check(
  "网关报了「客户端走了」",
  (quietTee.failure as any)?.name === "ClientGoneError",
  String((quietTee.failure as any)?.name),
);

console.log("");
console.log(`pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
