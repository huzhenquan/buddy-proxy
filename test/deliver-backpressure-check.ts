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
//   3. 客户端真的走了 → 网关不报错、不挂住。

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deliver-backpressure-"));
process.env.BUDDY_DATA_DIR = tmp;

const { deliverOpenAIStream } = await import("../lib/router/deliver.ts");

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

/**
 * 一个假的上游：它发很多帧，每帧都不小。
 *
 * 帧要够大、够多，客户端不读的时候才会把网关的发送缓冲区填满（Node 的
 * highWaterMark 是 16KB）。
 */
function fakeUpstream(frames: number): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < frames; i++) {
        controller.enqueue(
          Buffer.from(
            `data: ${JSON.stringify({
              id: "c1",
              object: "chat.completion.chunk",
              model: "fake-model",
              choices: [{ index: 0, delta: { content: "x".repeat(2000) }, finish_reason: null }],
            })}\n\n`,
          ),
        );
      }
      controller.enqueue(Buffer.from("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

/** 一个最小的 Koa 上下文：只用到 res。 */
function fakeCtx(res: http.ServerResponse): any {
  return { res, status: 200, respond: false } as any;
}

/**
 * 起一个服务，把假上游的流交给网关转发；客户端按给定的节奏读。
 */
async function serve(opts: { frames: number; stallMs: number; readAll: boolean }) {
  const server = http.createServer(async (req, res) => {
    const ctx = fakeCtx(res);
    await deliverOpenAIStream(ctx, fakeUpstream(opts.frames), "anthropic", "fake-model");
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;

  const received: string[] = [];
  await new Promise<void>((resolve) => {
    const req = http.request(
      { port, host: "127.0.0.1", path: "/v1/messages", method: "POST" },
      (r) => {
        let buf = "";
        r.pause();
        if (opts.stallMs > 0) {
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
      },
    );
    req.end("{}");
  });

  await new Promise<void>((resolve) => server.close(() => resolve()));
  return received;
}

console.log("");
console.log("客户端读得慢");

// 400 帧 × 2KB ≈ 800KB：客户端不读的话，缓冲区一定会满。
const stalled = await serve({ frames: 400, stallMs: 300, readAll: false });
const text = stalled.join("\n");
check("每一帧都送到了", stalled.length >= 400, `${stalled.length} 帧`);
check("有收尾的 message_delta", text.includes('"message_delta"'), "");
check("有收尾的 message_stop", text.includes('"message_stop"'), "");

console.log("");
console.log("客户端一直读");

const normal = await serve({ frames: 400, stallMs: 0, readAll: true });
const normalText = normal.join("\n");
check("每一帧都送到了", normal.length >= 400, `${normal.length} 帧`);
check("有收尾的 message_delta", normalText.includes('"message_delta"'), "");
check("有收尾的 message_stop", normalText.includes('"message_stop"'), "");

console.log("");
console.log(`pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
