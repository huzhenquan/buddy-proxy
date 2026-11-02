// test/tokenrhythm-check.ts — TokenRhythm 的账号选择与余额不足时的回退。
//
//   node --experimental-strip-types test/tokenrhythm-check.ts
//
// 覆盖三件事：
//   1. 租户按「先到期的赠金先用」排序；
//   2. 没钱、没 key、查询出错的租户被排除；
//   3. 上游说「余额不足」时换下一个租户，而不是把错误原样抛出去。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokenrhythm-check-"));
process.env.BUDDY_DATA_DIR = tmp;

const {
  markAccountOutOfMoney,
  orderedAccounts,
  pickAccount,
  usableAccounts,
} = await import("../lib/tokenrhythm/wallet.ts");
const { TokenRhythmNoBalanceError } = await import("../lib/tokenrhythm/transport.ts");

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

/** 一个账号的样子。 */
function tenant(
  index: number,
  available: number,
  gift: number,
  nextExpiryAt: string | null,
  extra: Partial<Record<string, unknown>> = {},
): any {
  return {
    accountId: `tokenrhythm-${index}`,
    account: `190***${index}`,
    name: `账号 ${index}`,
    hasKey: true,
    wallet: { availableCny: available, giftAvailableCny: gift },
    credits: nextExpiryAt ? { summary: { nextExpiryAt } } : null,
    error: null,
    ...extra,
  };
}

console.log("");
console.log("选账号");

const soon = "2026-11-19T04:28:10.883Z";
const later = "2026-11-20T04:28:10.883Z";
const never = "2099-12-31T15:59:59.000Z";

const statuses = [
  tenant(1, 100, 0, never), // 赠金是永久的 → 最后用
  tenant(2, 18, 18, soon), // 最先到期 → 先用
  tenant(3, 18, 18, later),
];

check("先到期的那批赠金先用", pickAccount(statuses)?.accountId === "tokenrhythm-2", String(pickAccount(statuses)?.accountId));
// 有赠金的先用，赠金是永久的那个排最后 —— 它是最后的备选。
check("有赠金的先上", orderedAccounts(statuses).length === 3, String(orderedAccounts(statuses).length));
check(
  "永久赠金的那个排最后",
  orderedAccounts(statuses)[orderedAccounts(statuses).length - 1]?.accountId === "tokenrhythm-1",
);

console.log("");
console.log("没用的账号");

const mixed = [
  tenant(1, 0, 0, soon), // 没钱
  tenant(2, 18, 18, soon, { hasKey: false }), // 没有 key
  // 查询出错：余额读不到（wallet 为空），那是「不知道」不是「没钱」——
  // usableAccounts 照样让它接，orderedAccounts 把它排到最后（lib/tokenrhythm/wallet.ts）。
  tenant(3, 0, 0, null, { error: "登录过期", wallet: null }),
  tenant(4, 5, 5, later), // 能用
  tenant(5, 30, 0, never), // 只有充值的本金，也能用
];
check("没钱、没 key 的排除，余额读不到的留着", usableAccounts(mixed).length === 3, String(usableAccounts(mixed).length));
check("余额读不到的排最后", orderedAccounts(mixed).at(-1)?.accountId === "tokenrhythm-3", String(orderedAccounts(mixed).at(-1)?.accountId));
check("排第一的是有赠金的那个", orderedAccounts(mixed)[0]?.accountId === "tokenrhythm-4", String(orderedAccounts(mixed)[0]?.accountId));
// 都没有赠金的时候，充值的本金才上场。
const noGift = [tenant(1, 30, 0, never), tenant(2, 40, 0, never)];
check("没有赠金就用充值的本金", usableAccounts(noGift).length === 2, String(usableAccounts(noGift).length));

console.log("");
console.log("没钱了就换一个");

markAccountOutOfMoney("tokenrhythm-4");
const after = usableAccounts(mixed);
check(
  "被标记的账号被排除",
  !after.some((t: any) => t.accountId === "tokenrhythm-4"),
  JSON.stringify(after.map((t: any) => t.accountId)),
);
check("其它账号不受影响", after.length === 2, String(after.length));
check("剩下的是本金那个和读不到余额那个", after.map((t: any) => t.accountId).join(",") === "tokenrhythm-3,tokenrhythm-5", after.map((t: any) => t.accountId).join(","));

console.log("");
console.log("余额不足的错误");

const err = new TokenRhythmNoBalanceError("账户余额不足，请充值后重试", "trace_123");
check("是 402", err.status === 402, String(err.status));
check("带着 traceId", err.traceId === "trace_123");
check("是它自己的类型", err instanceof TokenRhythmNoBalanceError);
check("是 Error", err instanceof Error);

// Close the database before removing its directory: on Windows an open
// file cannot be deleted (EPERM), so the handle has to go first.
const { closeStore } = await import("../lib/store.ts");
closeStore();
fs.rmSync(tmp, { recursive: true, force: true });

console.log("");
console.log(`${pass} 项过了，${fail} 项没过`);
process.exit(fail === 0 ? 0 : 1);
