// test/log-scrub-check.ts — 日志里留下的东西：够读懂，够不到账号。
//
//   node --experimental-strip-types test/log-scrub-check.ts
//
// stdout 是容器日志：它会被复制、归档、发到别处。那里不该有账号标识、邮箱、
// 令牌。所以正文打出去之前先抹一遍。
//
// 抹的规矩有三条：
//   · 凭据（令牌、密码、cookie）—— 字段名与形态两头都接；
//   · 账号标识 —— 字段名里带 token / secret / key / cookie / uid / id 的那些，
//     以及 UUID 形状的（字段名不认它的时候兜底）；
//   · 留下的：请求 id（跟上游的日志对得上）、用量里的那些数（排查时要看的就是
//     它们）、模型 id。

import { scrubForLog } from "../lib/log-scrub.ts";

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

/** 一个编造的 UUID：形状是真的，内容是假的。 */
const FAKE_UUID = "01a158db-ad50-775e-8c08-6ff8df765b64";

console.log("");
console.log("UUID 形状的账号标识");

{
  // 纯文本：没有字段名可看，UUID 一律抹掉。
  const plain = scrubForLog(`acct ${FAKE_UUID} denied`);
  check("纯文本里的 UUID 被抹掉", !plain.includes(FAKE_UUID), plain);
  check("纯文本里那句话还读得懂", plain.includes("denied"), plain);
}

{
  // JSON：字段名不在表里的那些，值是 UUID 就抹掉（字段名换了也要接得住）。
  // 注意 requestUuid / request_uuid 不在这里 —— 它们是请求 id，留着（见下面）。
  const json = scrubForLog(
    JSON.stringify({
      account: FAKE_UUID,
      sub: FAKE_UUID,
      openId: FAKE_UUID,
      enterpriseUuid: FAKE_UUID,
      msg: `the account ${FAKE_UUID} is not allowed`,
    }),
  );
  check("account 里的 UUID 被抹掉", !json.includes(`"account":"${FAKE_UUID}"`), json);
  check("sub 里的 UUID 被抹掉", !json.includes(`"sub":"${FAKE_UUID}"`), json);
  check("openId 里的 UUID 被抹掉", !json.includes(`"openId":"${FAKE_UUID}"`), json);
  check("enterpriseUuid 里的 UUID 被抹掉", !json.includes(`"enterpriseUuid":"${FAKE_UUID}"`), json);
  check("字符串里夹着的 UUID 也被抹掉", !json.includes(FAKE_UUID), json);
  check("那句话还读得懂", json.includes("is not allowed"), json);
}

{
  // 请求 id 是每请求随机的值：抹了就没法跟上游的日志对上了 —— 留着。
  const trace = scrubForLog(
    JSON.stringify({ request_id: FAKE_UUID, trace_id: FAKE_UUID, requestId: FAKE_UUID, user_id: FAKE_UUID }),
  );
  check("请求 id 留着", trace.includes(`"request_id":"${FAKE_UUID}"`), trace);
  check("追踪 id 留着", trace.includes(`"trace_id":"${FAKE_UUID}"`), trace);
  check("驼峰的 requestId 留着", trace.includes(`"requestId":"${FAKE_UUID}"`), trace);
  check("账号 id 还是被抹掉", !trace.includes(`"user_id":"${FAKE_UUID}"`), trace);
}

console.log("");
console.log("用量里的那些数");

{
  // token 数不是凭据。上游的正文里最要紧的就是这些数：答了 200 却没内容的
  // 时候，警告就是靠它们判断的 —— 抹掉等于把日志里最要读的那部分抹了。
  const usage = scrubForLog(
    JSON.stringify({
      usage: {
        prompt_tokens: 1234,
        completion_tokens: 56,
        total_tokens: 1290,
        prompt_tokens_details: { cached_tokens: 1200 },
        prompt_cache_hit_tokens: 1200,
        prompt_cache_miss_tokens: 34,
        cache_read_input_tokens: 1200,
        cache_creation_input_tokens: 0,
      },
      model_id: "hy3",
    }),
    // 留长一点：这一段要看的数多，别让截断把它们切掉（真的日志留 300–500）。
    500,
  );
  check("prompt_tokens 留着", usage.includes('"prompt_tokens":1234'), usage);
  check("completion_tokens 留着", usage.includes('"completion_tokens":56'), usage);
  check("total_tokens 留着", usage.includes('"total_tokens":1290'), usage);
  check("cached_tokens 留着", usage.includes('"cached_tokens":1200'), usage);
  check("缓存命中的那几个数都留着", usage.includes('"prompt_cache_hit_tokens":1200'), usage);
  check("model_id 留着", usage.includes('"model_id":"hy3"'), usage);

  // 单数写法（驼峰的 promptToken / completionToken / totalToken）也要留着 ——
  // 上游两样都有，只列复数会漏掉单数那一份（2026-11-03）。
  const singular = scrubForLog(
    JSON.stringify({ promptToken: 100, completionToken: 20, totalToken: 120 }),
  );
  check("驼峰单数的 promptToken 留着", singular.includes('"promptToken":100'), singular);
  check("驼峰单数的 completionToken 留着", singular.includes('"completionToken":20'), singular);
  check("驼峰单数的 totalToken 留着", singular.includes('"totalToken":120'), singular);

  // request_uuid / requestUuid：字段名说了它是请求 id（带 uuid 的那种），留着。
  const rid = scrubForLog(
    JSON.stringify({ request_uuid: FAKE_UUID, requestUuid: FAKE_UUID, account: FAKE_UUID }),
  );
  check("request_uuid 留着", rid.includes(`"request_uuid":"${FAKE_UUID}"`), rid);
  check("驼峰 requestUuid 留着", rid.includes(`"requestUuid":"${FAKE_UUID}"`), rid);
  check("account 还是抹掉", !rid.includes(`"account":"${FAKE_UUID}"`), rid);
}

console.log("");
console.log("凭据还是要抹掉");

{
  const secret = scrubForLog(
    JSON.stringify({
      access_token: "0123456789abcdef0123456789abcdef",
      refreshToken: "fedcba9876543210fedcba9876543210",
      password: "hunter2hunter2",
      cookie: "session=abcdef0123456789",
      user_id: "acct-8837",
      id: "acct-4242",
      msg: "the token is stale",
    }),
  );
  check("access_token 被抹掉", !secret.includes("0123456789abcdef"), secret);
  check("refreshToken 被抹掉", !secret.includes("fedcba9876543210"), secret);
  check("password 被抹掉", !secret.includes("hunter2"), secret);
  check("cookie 被抹掉", !secret.includes("session=abcdef"), secret);
  check("user_id 被抹掉", !secret.includes("acct-8837"), secret);
  check("id 被抹掉", !secret.includes("acct-4242"), secret);
  check("那句话还读得懂", secret.includes("the token is stale"), secret);
}

console.log("");
console.log("邮箱、令牌样的长串、JWT");

{
  const free = scrubForLog("the account someone@example.com is not allowed");
  check("邮箱被抹掉", !free.includes("someone@example.com"), free);

  const jwt = scrubForLog(
    "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk rejected", // privacy:allow — 编造的样例（头/体是 HS256 与 sub=12345；签名取自 RFC 7515 附录 A.1 的公开示例）
  );
  check("JWT 被抹掉", !jwt.includes("eyJhbGciOiJIUzI1NiJ9"), jwt);
  check("JWT 后面那句话留着", jwt.includes("rejected"), jwt);
}

console.log("");
console.log(`${pass} ok, ${fail} failed`);
if (fail) process.exit(1);
