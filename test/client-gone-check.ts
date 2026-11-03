// test/client-gone-check.ts — 客户端走了：上游要停，账号不该背锅，也不该换目标。
//
//   node --experimental-strip-types test/client-gone-check.ts
//
// 离线：假上游是本机的 http 服务，一个真请求都不发出去，不花任何额度。
//
// 客户端走了（连接断了、它按了取消）不是上游的错。三件事必须对：
//
//   1. 上游要停：上游还在算就是在计费，账号还占着。
//   2. 账号不背锅：不记冷却（那一分钟冷却是「超时」那一类失败才记的，客户端
//      走了却记上一次，账号就白等一分钟）。
//   3. 不换目标：根路由的降级是「换一个上游也许能答出来」—— 客户端都走了，
//      换一个也一样没人要；而且那个上游白花钱。
//
// 这三件事在非流式那条路上最容易坏：答复要等整个上游的答复读完才发出去，客户端
// 正好在这中间走。Qoder 的新协议非流式就是这么消费的（await upstream.json()）；
// WorkBuddy 补的是另一个窗口 —— 上游连答复的头都还没发、workbuddyChat 还挂在
// cliFetch 上的时候（2026-11-03，作者第三轮点名）。

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startGateway as startHarness, type Gateway as HarnessGateway } from "./harness.ts";

const SERVICE = "/buddy.admin.v1.AdminService";

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* ------------------------------------------------------------------ *
 * 假上游
 * ------------------------------------------------------------------ */

/** 上游「在想」：收到请求之后很久才答。 */
const THINK_MS = 8_000;

/** 假上游收到 Qoder 那个请求了没有（客户端要走，就等这个）。 */
let qoderGotIt: () => void = () => {};
const qoderGot = new Promise<void>((resolve) => {
  qoderGotIt = resolve;
});

/** Qoder 那个请求被掐断了没有（客户端走了，网关把上游停了）。 */
let qoderAborted = false;

/** Qoder 的 chat 端点被打了几次：客户端走了之后，谁都不该再打第二次。 */
let qoderHits = 0;

/** 假上游收到 WorkBuddy 那个请求了没有（客户端要走，就等这个）。 */
let workbuddyGotIt: () => void = () => {};
const workbuddyGot = new Promise<void>((resolve) => {
  workbuddyGotIt = resolve;
});

/** WorkBuddy 那个请求被掐断了没有（客户端走了，网关把上游停了）。 */
let workbuddyAborted = false;

/** WorkBuddy 的 chat 端点被打了几次：客户端走了之后，谁都不该再打第二次。 */
let workbuddyHits = 0;

const upstream = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const url = req.url ?? "";
    const json = (status: number, payload: unknown) => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (url.includes("/model/v1/chat/completions")) {
      // Qoder：上游在想。客户端在这个窗口里走掉。
      qoderHits++;
      qoderGotIt();
      const timer = setTimeout(() => {
        json(200, {
          id: "chatcmpl-fake",
          object: "chat.completion",
          model: "fake",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }, THINK_MS);
      res.on("close", () => {
        // 答复还没写出来连接就断了：网关把上游掐掉了。
        if (!res.writableEnded) qoderAborted = true;
        clearTimeout(timer);
      });
      return;
    }
    if (url.includes("/v2/chat/completions")) {
      // WorkBuddy：上游在想 —— 连答复的头都还没发。客户端在这个窗口里走掉
      // （workbuddyChat 还在等 cliFetch，这是作者第三轮指名要补的那条）。
      workbuddyHits++;
      workbuddyGotIt();
      const timer = setTimeout(() => {
        if (res.writableEnded || res.destroyed) return;
        // 上游永远先回一条流（非流式也是流聚合出来的），答什么都行：客户端早走了。
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          'data: {"id":"chatcmpl-fake","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n' +
            "data: [DONE]\n\n",
        );
      }, THINK_MS);
      res.on("close", () => {
        // 答复还没写出来连接就断了：网关把上游掐掉了。
        if (!res.writableEnded) workbuddyAborted = true;
        clearTimeout(timer);
      });
      return;
    }
    json(404, { error: { message: "not a route the test uses" } });
  });
});

await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamBase = `http://127.0.0.1:${(upstream.address() as any).port}`;

/* ------------------------------------------------------------------ *
 * 网关
 * ------------------------------------------------------------------ */

interface Gateway extends HarnessGateway {
  token: string;
  qoderId: string;
  workbuddyId: string;
}

async function startGateway(): Promise<Gateway> {
  const gw = await startHarness({
    keepDataDir: true,
    env: {
      QODER_GLOBAL_INFER_BASE: upstreamBase,
      QODER_GLOBAL_OPENAPI_BASE: upstreamBase,
      QODER_MAX_ATTEMPTS: "1",
      WORKBUDDY_CHAT_BASE: upstreamBase,
      // 认证与刷新走的是 ENDPOINTS 的基址，不是 chat 的：也指到假上游，
      // 这样这条用例无论走到哪一步都一个真请求都不会发出去。
      WORKBUDDY_CN_BASE: upstreamBase,
    },
  });
  const tokenFile = path.join(gw.dataDir, "admin-token");
  const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() : "";

  const seed = new DatabaseSync(path.join(gw.dataDir, "buddy.db"));
  seed.exec("PRAGMA busy_timeout = 5000");
  const insertSecret = seed.prepare(
    "INSERT INTO secrets (id, kind, data, updated_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
  );
  const now = Date.now();

  const local: Gateway = { ...gw, token, qoderId: "", workbuddyId: "" };
  const qoder = await call(local, "AddAccount", { platform: "qoder", alias: "Qoder" });
  const qoderId = String(qoder.body?.id ?? "");
  insertSecret.run(
    `session:provider:${qoderId}`,
    "session",
    JSON.stringify({
      schemaVersion: 1,
      region: "global",
      clientId: "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb", // privacy:allow — 编造的样例（Qoder 客户端 id，已在仓库里）
      accessToken: "dt-test-token",
      refreshToken: "drt-test-token",
      userId: "test-user",
      expiresAtMs: now + 365 * 24 * 3600 * 1000,
      refreshExpiresAtMs: now + 365 * 24 * 3600 * 1000,
      machineId: "test-machine",
      machineToken: "test-machine-token",
      machineType: "test",
      generation: 1,
      loginAtMs: now,
      refreshedAtMs: now,
    }),
    now,
  );
  // WorkBuddy 的账号与会话：会话形状与 test/fake-sessions.ts 那份一致。
  const workbuddy = await call(local, "AddAccount", { platform: "workbuddy-cn", alias: "WorkBuddy" });
  const workbuddyId = String(workbuddy.body?.id ?? "");
  insertSecret.run(
    `session:provider:${workbuddyId}`,
    "session",
    JSON.stringify({
      accessToken: "test-access-token",
      refreshToken: "test-refresh-token",
      uid: "test-uid",
      nickname: "test",
      domain: "www.workbuddy.cn",
      region: "cn",
      generation: 1,
      expiresAtMs: now + 365 * 24 * 3600 * 1000,
      refreshExpiresAtMs: now + 365 * 24 * 3600 * 1000,
      loginAtMs: now,
      refreshedAtMs: now,
    }),
    now,
  );
  // 账号 id 要在：空的话下面的冷却断言会空转（WHERE provider_id = '' 什么也匹配不到）。
  check("Qoder：账号 id 拿到了", qoderId !== "", qoderId);
  check("WorkBuddy：账号 id 拿到了", workbuddyId !== "", workbuddyId);
  seed.close();
  return { ...gw, token, qoderId, workbuddyId };
}

async function call(gw: Gateway, method: string, body: unknown = {}): Promise<any> {
  const res = await fetch(`${gw.base}${SERVICE}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${gw.token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

/**
 * 发一个请求，然后走掉。
 *
 * 走掉的时机是「上游已经在算了」—— 那正是要测的窗口。
 */
function askAndLeave(gw: Gateway, routePath: string, model: string, got: Promise<void>): Promise<void> {
  const body = JSON.stringify({
    model,
    max_tokens: 32,
    stream: false,
    messages: [{ role: "user", content: "say ok" }],
  });
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: gw.port,
        path: routePath,
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer public",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        // 客户端掐断了连接，答复多半到不了这里；到得了也读一下就走。
        res.resume();
        res.on("end", () => resolve());
      },
    );
    // 客户端自己掐断了连接：这个错是预期的。
    req.on("error", () => resolve());
    req.end(body);
    void (async () => {
      await got;
      await sleep(100);
      req.destroy();
    })();
  });
}

/* ------------------------------------------------------------------ *
 * 场景
 * ------------------------------------------------------------------ */

console.log("");
console.log("客户端走了：上游停、账号不背锅、不换目标");

{
  const gw = await startGateway();
  try {
    // 只有一个 Qoder 账号、一个目标。客户端走了不该记冷却，也不该换目标。
    // （只有一个目标，所以「不换目标」是「没有第二个可换」—— 但关键是别记冷却。）
    await askAndLeave(gw, "/qoder/v1/chat/completions", "glm-5.3", qoderGot);
    // 给网关一点时间收尾（上游被掐断、账记完）。
    await sleep(1_500);

    check("上游被掐断了（它还在算就是在计费）", qoderAborted, "上游还在算");
    check("上游只被打了一次（客户端走了就不该再打）", qoderHits === 1, String(qoderHits));

    const db = new DatabaseSync(path.join(gw.dataDir, "buddy.db"));
    const cooldowns = db
      .prepare("SELECT provider_id FROM cooldown WHERE provider_id = ?")
      .all(gw.qoderId) as unknown[];
    check("账号没有记冷却（客户端走了不是账号的错）", cooldowns.length === 0, JSON.stringify(cooldowns));

    db.close();
  } finally {
    gw.stop();
    await gw.stopAndWait();
    fs.rmSync(gw.dataDir, { recursive: true, force: true });
  }
}

{
  // WorkBuddy 走的同一条断言：上游在等答复的头的时候客户端走了。这是
  // workbuddyChat 还挂在 cliFetch 上的窗口 —— 作者第三轮点名的那条。
  const gw = await startGateway();
  try {
    await askAndLeave(gw, "/workbuddy-cn/v1/chat/completions", "hy3", workbuddyGot);
    await sleep(1_500);

    check("WorkBuddy：上游被掐断了（它还在算就是在计费）", workbuddyAborted, "上游还在算");
    check("WorkBuddy：上游只被打了一次（客户端走了就不该再打）", workbuddyHits === 1, String(workbuddyHits));

    const db = new DatabaseSync(path.join(gw.dataDir, "buddy.db"));
    const cooldowns = db
      .prepare("SELECT provider_id FROM cooldown WHERE provider_id = ?")
      .all(gw.workbuddyId) as unknown[];
    check("WorkBuddy：账号没有记冷却（客户端走了不是账号的错）", cooldowns.length === 0, JSON.stringify(cooldowns));

    db.close();
  } finally {
    gw.stop();
    await gw.stopAndWait();
    fs.rmSync(gw.dataDir, { recursive: true, force: true });
  }
}

console.log("");
console.log(`${pass} ok, ${fail} failed`);
upstream.close();
if (fail) process.exit(1);
