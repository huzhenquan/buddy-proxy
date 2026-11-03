// test/fixture-name.ts — how a fixture is named.
//
// The recorder, the mock server and the capture script have to agree on it, so
// it lives in one place.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Json } from "../lib/json.ts";

// The path of this file, as the platform sees it. `new URL(...).pathname` is
// a POSIX path — on Windows it starts with a slash ("/D:/projects/..."), and
// joining it with path.join() yields "\D:\projects\...", which does not exist.
// fileURLToPath() is the one that gives the native path.
export const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

/** A name for the fixture: the method, the whole path and the variant. */
export function fixtureName(method: string, route: string, variant: string): string {
  const slug = route.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "root";
  return `${method.toLowerCase()}-${slug}${variant === "all" ? "" : `-${variant}`}.json`;
}

/**
 * Which variant of the answer a request wants.
 *
 * The same path serves a streaming and a non-streaming request, and the two
 * answers have different shapes — so they cannot share a fixture. A request
 * that carries tools gets its own fixture as well: the answer is a tool call
 * rather than an answer.
 */
export function variantOf(body: Buffer | string): string {
  try {
    const parsed = JSON.parse(typeof body === "string" ? body : body.toString("utf8"));
    if (parsed && typeof parsed === "object") {
      const tools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
      const stream = typeof parsed.stream === "boolean" ? (parsed.stream ? "stream" : "nostream") : "all";
      return tools ? `${stream}-tools` : stream;
    }
  } catch {
    /* not JSON — the legacy protocol sends its own encoded body */
  }
  return "all";
}

export interface Fixture {
  upstream: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  /**
   * The request body that was sent, as it was sent.
   *
   * 渠道校验认的是系统提示词开头那句（见 lib/workbuddy/identity.ts）：录下
   * 整个请求体，是为了让「同一句请求，只差开头那句」这件事能被机械地比对
   * —— 把被拦那次的开头那句换成放行那次的那句，两个请求体应当完全相等。
   * 手抄几个字段做不到这件事（抄错一个字符没人会发现）。
   *
   * 请求体里没有凭据：它是发给上游的正文，身份在请求头里。
   */
  requestBody?: Json;
  /**
   * The names of the request headers (not their values).
   *
   * 值里有令牌与每次请求随机的 id，名字里没有 —— 名字够证明「两次用的是
   * 同一套请求头」，又不把任何东西带进仓库。
   */
  requestHeaderNames?: string[];
}

export function writeFixture(name: string, fixture: Fixture): void {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  fs.writeFileSync(path.join(FIXTURE_DIR, name), JSON.stringify(fixture, null, 2) + "\n");
}

export function readFixture(name: string): Fixture | null {
  const file = path.join(FIXTURE_DIR, name);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Fixture;
  } catch {
    return null;
  }
}
