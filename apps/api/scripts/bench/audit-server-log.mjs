#!/usr/bin/env node
// apps/api/scripts/bench/audit-server-log.mjs
// M1/S10 T0 自动化对账器（ADR-0008 §5.2 / 附录 B 的脚本化版本，任务 #84 收尾）。
//
// 对 run-gate 产出的 *.server.log 按【连接内顺序】做 hono logger 的 `<--`（进入）/
// `-->`（响应）FIFO 配对：hono logger 在请求开始写 `<-- METHOD PATH`、结束写
// `--> METHOD PATH STATUS Nms`，同一 keep-alive 连接严格嵌套，故每条流维护一个
// method+path 栈即可配对（并发请求按完成顺序弹同 key 的最早进入项）。
//
// 三流（对齐 ADR §5.1）：
//   home        GET /api/records 且无 viewId/search（含 cursor/offset 深页）
//   view-search GET /api/records 且带 viewId 或 search
//   write       POST /api/records
// 健康检查/登录（/readyz、/healthz、/api/auth/login）不计入业务流。
//
// T0 三条件机器判定（exit code）：
//   0 = 通过：每条业务流「进入数 == 响应数」（无尾挂）、无 5xx；
//       配合 JSON 报告 status=0=0 / errors={} 即满足 ADR §5.3 全部三条。
//   2 = 不通过：存在尾挂或 5xx（打印流账目与尾挂行号）。
//   1 = 用法/文件错误。
// 注意：尾挂在"客户端主动放弃等待"时也会出现（修复前的 keep-alive 竞态），脚本只如实
// 计数并给行号，是否"服务端挂死"需结合客户端时间窗人工/报告复核（ADR §5.2 口径）。

import fs from "node:fs";

function classify(method, path) {
  const u = path.split("?")[0];
  if (u === "/readyz" || u === "/healthz" || u === "/api/auth/login") return null;
  if (method === "POST" && u === "/api/records") return "write";
  if (method !== "GET" || u !== "/api/records") return null;
  const qs = path.includes("?") ? path.slice(path.indexOf("?") + 1) : "";
  const params = new URLSearchParams(qs);
  if (params.has("viewId") || params.has("search")) return "view-search";
  return "home";
}

/** 去掉 query 中的易变值，得到用于配对的稳定 key（method + 端点 + 业务参数存在性）。 */
function pairKey(method, path) {
  const u = path.split("?")[0];
  if (method === "POST") return `POST ${u}`;
  const qs = path.includes("?") ? path.slice(path.indexOf("?") + 1) : "";
  const params = new URLSearchParams(qs);
  // 配对只区分会改变处理路径的参数；cursor/offset/page 值不同但同为 home，归同 key 栈。
  const sig = ["viewId", "search", "tableId"].filter((k) => params.has(k)).sort();
  return `GET ${u}?${sig.join(",")}`;
}

/**
 * 解析服务端日志文本，返回三流 FIFO 账目（纯函数，CLI 与 vitest 共用）。
 */
export function parseServerLog(text) {
  const lines = text.split("\n");
  const flows = new Map();
  const ensure = (flow) => {
    let f = flows.get(flow);
    if (!f) {
      f = { in: 0, out: 0, status: {}, stacks: new Map(), trailing: [] };
      flows.set(flow, f);
    }
    return f;
  };

  lines.forEach((raw, idx) => {
    // hono logger 在 TTY/重定下给状态码加 ANSI 颜色（\x1b[32m200\x1b[0m），统一剥离再匹配。
    const line = raw.trim().replace(/\x1b\[[0-9;]*m/g, "");
    const mIn = line.match(/^<--\s+([A-Z]+)\s+(\S+)/);
    const mOut = line.match(/^-->\s+([A-Z]+)\s+(\S+)\s+(\d{3})\b/);
    if (mIn) {
      const [, method, path] = mIn;
      const flow = classify(method, path);
      if (!flow) return;
      const f = ensure(flow);
      f.in += 1;
      const key = pairKey(method, path);
      const arr = f.stacks.get(key) ?? [];
      arr.push(idx + 1);
      f.stacks.set(key, arr);
    } else if (mOut) {
      const [, method, path, status] = mOut;
      const flow = classify(method, path);
      if (!flow) return;
      const f = ensure(flow);
      f.out += 1;
      f.status[status] = (f.status[status] ?? 0) + 1;
      const key = pairKey(method, path);
      const arr = f.stacks.get(key);
      if (arr && arr.length > 0) arr.shift();
      // 无对应进入项的响应也算异常（理论不可达，记一行号便于排查）。
      else f.trailing.push({ line: idx + 1, kind: "response-without-request" });
    }
  });

  // 各 key 栈中剩余的进入项 = 尾挂（进入未响应）。
  for (const f of flows.values()) {
    for (const arr of f.stacks.values()) {
      for (const line of arr) f.trailing.push({ line, kind: "request-without-response" });
    }
  }
  return flows;
}

function auditFile(file) {
  return parseServerLog(fs.readFileSync(file, "utf8"));
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("用法：node audit-server-log.mjs <run-gate .read.server.log|.write.server.log>");
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error(`日志不存在：${file}`);
    process.exit(1);
  }
  const flows = auditFile(file);
  let bad = false;
  const summary = {};
  for (const [flow, f] of [...flows.entries()].sort()) {
    const trailing = f.trailing.length;
    const fiveXx = Object.entries(f.status)
      .filter(([code]) => Number(code) >= 500)
      .reduce((a, [, n]) => a + n, 0);
    summary[flow] = { in: f.in, out: f.out, trailing, status: f.status };
    if (trailing > 0 || fiveXx > 0) bad = true;
  }
  console.log(JSON.stringify({ file: file.split("/").pop(), flows: summary, t0Pass: !bad }, null, 2));
  for (const [flow, f] of [...flows.entries()].sort()) {
    if (f.trailing.length > 0) {
      const sample = f.trailing.slice(0, 10).map((t) => `L${t.line}:${t.kind}`).join(", ");
      console.error(`[fail] ${flow} 尾挂 ${f.trailing.length}（${sample}）`);
    }
  }
  if (bad) process.exit(2);
  console.log("[pass] 各业务流进入数==响应数、无 5xx（T0 服务端侧通过；仍需配合 JSON status=0=0）");
  process.exit(0);
}

// 仅直接运行时执行 main；被 vitest import 时不读 argv。
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

