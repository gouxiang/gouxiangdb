// scripts/acceptance/rollback/selftest-netguard.mjs
// netguard 探针自检（不连真外网）：验证 netguard.mjs 的包装面确实会记账，否则 R5 的
// "零外网"结论可能是探针没生效的假绿。做法：
//   1) import netguard（GX_NETGUARD_LOG 指向临时文件）；
//   2) 用 fetch 打本机 loopback 的 0 端口（必连接失败，但 fetch 包装在发起时即记账）；
//   3) 用 net.connect 连 127.0.01 与一个外部占位 host（只 connect，不等待真实数据）；
//   4) 读日志，断言 loopback 与 external 各至少被记录到一次 -> 探针有效。
// 不向外部发送任何业务数据；external connect 立即 destroy。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const logFile = path.join(os.tmpdir(), `gx-netguard-selftest-${process.pid}.jsonl`);
process.env.GX_NETGUARD_LOG = logFile;
await import("./netguard.mjs");

async function main() {
  // loopback fetch：端口 1 必失败，仅用于触发 fetch 包装记账（catch 掉网络错误）。
  try { await fetch("http://127.0.0.1:1/x"); } catch { /* expected */ }
  // external TCP 意图：连接即销毁，不发送数据，只为证明非回环 host 被记为 external。
  await new Promise((resolve) => {
    const s = net.connect({ host: "203.0.113.10", port: 9 });
    s.on("connect", () => s.destroy());
    s.on("error", () => s.destroy());
    setTimeout(() => { s.destroy(); resolve(); }, 300);
  });

  const lines = fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const sawFetch = lines.some((e) => e.kind === "fetch" && String(e.target).includes("127.0.0.1"));
  const sawExternalTcp = lines.some((e) => e.kind === "tcp.connect" && String(e.target).startsWith("203.0.113.10"));
  fs.unlinkSync(logFile);
  if (!sawFetch || !sawExternalTcp) {
    console.error(`netguard 自检失败：sawFetch=${sawFetch} sawExternalTcp=${sawExternalTcp} lines=${JSON.stringify(lines)}`);
    process.exit(1);
  }
  console.log(`netguard 自检 OK：fetch 与非回环 tcp.connect 均被记账（${lines.length} 事件），R5 零外网结论可信`);
  process.exit(0);
}
main();
