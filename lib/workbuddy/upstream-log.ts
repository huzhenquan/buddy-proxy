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
//     账号标识的，走凭据日志（数据卷里的 auth.log）。
//   * 调试开关默认关：它记的是**用户的完整对话**。

import fs from "node:fs";
import type { Json } from "../json.ts";
import { authLog } from "../credential.ts";
import { dataDir } from "../paths.ts";

/**
 * 上游把正文也记进日志。
 */
export function logUpstreamBody(status: number, detail: string): void {
  const text = (detail || "").replace(/\s+/g, " ").trim();
  console.log(`[WORKBUDDY] upstream HTTP ${status}: ${text.slice(0, 500) || "(空正文)"}`);
}

/**
 * 上游把凭据拒了：正文里可能有账号标识，不进 stdout（那是容器日志），走
 * 凭据日志（数据卷里的 auth.log）。
 */
export function logCredentialRejection(status: number): void {
  authLog(dataDir(), `workbuddy 上游拒了当前凭据 HTTP ${status}`);
}

/**
 * 上游正文里的业务码（渠道校验是 11128）。
 *
 * 状态码说的是「这个请求被拒了」，业务码说的是「为什么」：风控与参数不认
 * 都是 400，换一个账号的结果却不一样，所以码要带上。
 */
export function businessCodeOfBody(text: string): number | string | null {
  try {
    const parsed = text ? JSON.parse(text) : null;
    const code = parsed?.code ?? parsed?.error?.code ?? null;
    if (typeof code === "string" && code.trim()) return code.trim();
    if (typeof code === "number" && Number.isFinite(code)) return code;
    return null;
  } catch {
    return null;
  }
}

/** 调试文件的体积上限：里面是用户的完整对话，不能无限长。 */
const DEBUG_FILE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 把发给上游的请求体记下来（排查用）。
 *
 * 只有开了 BUDDY_DEBUG_UPSTREAM 才记：请求体有整个系统提示词那么长，
 * 平时留着只是噪音。排查上游行为时打开它，一次就够。
 *
 * BUDDY_DEBUG_UPSTREAM_FILE 指向一个文件时，完整的请求体写进那个文件
 * （一行一个 JSON），截断只留给控制台。排查「上游为什么拒这一条」要看的
 * 正是被截断的那半截。
 *
 * 那个文件里是**用户的完整对话**（系统提示词、消息、工具定义）：路径自己
 * 挑，别放进仓库；到上限就不再写了。
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
  const file = process.env.BUDDY_DEBUG_UPSTREAM_FILE;
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
