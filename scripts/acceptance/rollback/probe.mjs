// scripts/acceptance/rollback/probe.mjs
// 门③回滚演练共享探针：极简 HTTP + 命中式断言计数。单一职责——
// 发请求（可带 Bearer/裸根路径）、记录"断言命中数"、不做业务编排。
//
// 设计：每个 check 脚本返回 exit 0/1，并把命中行写到 --hit-file（一行一条命中），
// 由驱动 run-rollback-drill.sh 用 wc -l 汇总"断言真实命中数"。任何 expect 不符即抛错->exit1，
// 绝不允许"跑了但没断言"的空绿。

import fs from "node:fs";

/** 读 --key=value / --key value 参数。 */
export function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const eq = key.indexOf("=");
      if (eq >= 0) {
        out[key.slice(0, eq)] = key.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          out[key] = true;
        } else {
          out[key] = next;
          i += 1;
        }
      }
    }
  }
  return out;
}

/** 读 seed 产出的上下文 JSON（baseUrl/token/ids）。 */
export function loadContext(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * 一次原始 HTTP 调用。path 以 "/" 开头按相对根 URL 拼（含 /mcp、/api/v1、/api、/readyz）。
 * @returns {Promise<{status:number, json:any, text:string}>}
 */
export async function http(baseUrl, method, path, opts = {}) {
  const url = path.startsWith("http") ? path : `${baseUrl.replace(/\/+$/, "")}${path}`;
  const headers = new Headers();
  if (opts.body !== undefined) headers.set("Content-Type", "application/json");
  if (opts.token) headers.set("Authorization", `Bearer ${opts.token}`);
  const res = await fetch(url, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let json = null;
  if (text) { try { json = JSON.parse(text); } catch { json = null; } }
  return { status: res.status, json, text };
}

/** 命中记账器：hit(说明) 落一行到文件并打印。 */
export class HitCounter {
  constructor(hitFile, label) {
    this.file = hitFile;
    this.label = label;
    this.n = 0;
    fs.mkdirSync(hitFile.slice(0, hitFile.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(hitFile, "");
  }

  hit(desc) {
    this.n += 1;
    const line = `HIT\t${this.label}\t${this.n}\t${desc}`;
    fs.appendFileSync(this.file, `${line}\n`);
    console.log(`  [hit ${this.n}] ${desc}`);
  }
}

/**
 * 断言 HTTP 状态码精确相等，记一次命中。
 * @param {Awaited<ReturnType<http>>} r
 * @param {number} expected
 * @param {string} what
 * @param {HitCounter} hits
 */
export function expectStatus(r, expected, what, hits) {
  if (r.status !== expected) {
    throw new Error(`${what}: 期望 ${expected}，实得 ${r.status} body=${r.text.slice(0, 200)}`);
  }
  hits.hit(`${what} => ${expected}`);
}

/** 断言谓词为真，记一次命中。 */
export function expectTrue(cond, what, hits, detail = "") {
  if (!cond) throw new Error(`${what} 断言失败${detail ? `：${detail}` : ""}`);
  hits.hit(what);
}

/** 顶层运行壳：把异常转 exit 1，成功打印 SUMMARY 行。 */
export async function runCheck(label, main) {
  const t0 = Date.now();
  try {
    const hits = await main();
    const ms = Date.now() - t0;
    console.log(`SUMMARY\t${label}\tOK\thits=${hits}\t${ms}ms`);
    process.exit(0);
  } catch (e) {
    console.error(`SUMMARY\t${label}\tFAIL\t${e instanceof Error ? e.stack || e.message : String(e)}`);
    process.exit(1);
  }
}
