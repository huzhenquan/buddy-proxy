// lib/workbuddy/upstream-log.ts — 上游说的话，记进日志。
//
// 上游的正文不能丢：只看状态码分不出「风控」（渠道校验 11128）、「参数不
// 认」（11133）、「模型没有」——都是 400，正文里才分得清。AGENTS.md 也是这
// 么写的：上游的响应正文要一起记进日志。
//
// 分寸：
//
//   * 正文只截一段（500 字符）——上游有时把整个 HTML 错误页吐回来。
//   * 凭据相关的正文不进 stdout：那是容器日志，容器一换就没了。正文里有
//     账号标识的，走凭据日志（数据卷里的 auth.log），而且先按字段抹一遍
//     （令牌、邮箱、账号 id 这类不留）。
//   * 调试开关默认关：它记的是**用户的完整对话**。

import fs from "node:fs";
import path from "node:path";
import type { Json } from "../json.ts";
import { authLog } from "../credential.ts";
import { scrubForLog } from "../log-scrub.ts";
import { dataDir } from "../paths.ts";

/**
 * 上游把正文也记进日志。
 *
 * 正文里可能有账号标识（上游有时把它塞在错误里），所以先抹一遍敏感字段再
 * 打出去：stdout 是容器日志，容器一换就没了，但它会被复制、归档、发到别处
 * —— 那里不该有账号标识。
 */
export function logUpstreamBody(status: number, detail: string): void {
  const text = scrubForLog(detail, 500);
  console.log(`[WORKBUDDY] upstream HTTP ${status}: ${text || "(空正文)"}`);
}

/**
 * 上游把凭据拒了：正文里可能有账号标识，不进 stdout（那是容器日志），走
 * 凭据日志（数据卷里的 auth.log）。
 *
 * 账号与正文都带上：容器重建以后 stdout 里的日志早没了，auth.log 是唯一
 * 还在的地方。「某个 WorkBuddy 账号被拒了」这种话答不了任何问题 —— 是哪个
 * 账号、上游说了什么，都得在那儿。
 *
 * 正文进文件之前先过一道：截断只管长度，管不住里面有没有令牌、邮箱、
 * 账号 id 这样的字段 —— 上游要是把它们塞进拒绝理由里，一个 200 字符的
 * 窗口足够把它们原样带出去。所以按字段去掉那些，只留能读懂这句话的部分。
 */
export function logCredentialRejection(status: number, providerId: string, detail = ""): void {
  const body = scrubForLog(detail);
  authLog(
    dataDir(),
    // 事件里只有状态码：stdout 打的是事件，账号标识不该出现在那儿。
    // 账号与正文都放进 detail —— 那部分只进文件。
    `workbuddy 上游拒了当前凭据 HTTP ${status}`,
    [`provider=${providerId}`, body ? `正文：${body}` : ""].filter(Boolean).join(" "),
    { toStdout: false },
  );
}

/** 调试文件的体积上限：里面是用户的完整对话，不能无限长。 */
const DEBUG_FILE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 把发给上游的请求体记下来（排查用）。
 *
 * 只有开了 BUDDY_DEBUG_UPSTREAM 才记：请求体有整个系统提示词那么长，
 * 平时留着只是噪音。排查上游行为时打开它，一次就够。
 *
 * BUDDY_DEBUG_UPSTREAM_FILE 给一个**文件名**时，完整的请求体写进数据目录里
 * 的那个文件（一行一个 JSON），截断只留给控制台。排查「上游为什么拒这一条」
 * 要看的正是被截断的那半截。
 *
 * 那个文件里是**用户的完整对话**（系统提示词、消息、工具定义），所以只能
 * 写在数据目录里 —— 路径由环境变量说了算的话，一个手滑的相对路径就能把它
 * 写进仓库或者家目录里。数据目录本身是卷，重建容器也还在。
 *
 * 到上限就不再写了。
 */
export function logUpstreamPayload(payload: Json): void {
  if (process.env.BUDDY_DEBUG_UPSTREAM !== "1") return;
  let text: string;
  try {
    text = JSON.stringify(payload);
  } catch {
    console.log("[WORKBUDDY] upstream request: (记不下来)");
    return;
  }
  const file = debugFileInDataDir();
  if (file) {
    try {
      if (fs.existsSync(file) && fs.statSync(file).size >= DEBUG_FILE_MAX_BYTES) {
        console.log(`[WORKBUDDY] upstream request: (调试文件已到上限，不写了：${file})`);
        return;
      }
      fs.appendFileSync(file, `${text}\n`);
    } catch {
      console.log("[WORKBUDDY] upstream request: (写不进调试文件)");
    }
    return;
  }
  console.log(`[WORKBUDDY] upstream request: ${text.slice(0, 4000)}`);
}

/**
 * 调试文件放在数据目录里。
 *
 * 环境变量给的是文件名（不是路径）：文件名会被拼到数据目录后面，别的路径
 * 一律不认 —— 那个文件里是用户的完整对话。
 *
 * 给了一个带目录的路径（`/tmp/x.json`）时不静默改写：只取文件名会让人以为
 * 写在别处、其实写在了数据目录里（还可能盖掉那儿的同名文件）。所以这里只
 * 认纯文件名，带路径的报一句、然后不写文件（正文还是截断着打给控制台）。
 */
function debugFileInDataDir(): string | null {
  const raw = (process.env.BUDDY_DEBUG_UPSTREAM_FILE ?? "").trim();
  if (!raw) return null;
  if (raw !== path.basename(raw)) {
    console.log(
      "[WORKBUDDY] upstream request: (调试文件只认文件名，不认路径 —— 这次只打控制台)",
    );
    return null;
  }
  const name = raw;
  if (!name || name === "." || name === "..") return null;
  const dir = dataDir();
  const file = path.join(dir, name);
  const rel = path.relative(dir, file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return file;
}
