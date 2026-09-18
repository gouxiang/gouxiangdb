// scripts/acceptance/rollback/check-r8-static.mjs
// 门③ R8 静态读码核查：不臆测 rollback.sh，逐项用文件系统/源码事实核对，落 r8.json。
// 核查项：文件存在、可执行位、确为 `ln -sfn ... current` 原子 symlink 切换、systemctl restart、
// /readyz 轮询、无 systemctl 时 die、READY 超时默认值。运行态回滚（真 systemd）留给手测表。

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "./probe.mjs";

const args = parseArgs(process.argv);
const file = args.file;
const src = fs.readFileSync(file, "utf8");
const st = fs.statSync(file);

const r8 = {
  exists: fs.existsSync(file),
  bytes: st.size,
  executable: Boolean(st.mode & 0o111),
  // ln -sfn "releases/${TARGET}" "$CURRENT"（-n 把既有 symlink 当普通文件处理，原子 rename 语义）
  isSymlinkSwitch: /ln\s+-sfn\s+["']?releases\/\$\{?TARGET\}?["']?\s+["']?\$?\{?CURRENT\}?["']?/.test(src)
    || /ln\s+-sfn\s+.*releases\/\$\{TARGET\}.*\$CURRENT/.test(src),
  systemctlRestart: /systemctl\s+restart/.test(src),
  readyzPoll: /\/readyz/.test(src) && /status.{0,4}ready|ready/.test(src),
  systemctlGuard: /command\s+-v\s+systemctl/.test(src) && /die/.test(src),
  readlinkCurrent: /readlink\s+-f\s+["']?\$CURRENT/.test(src),
  readyTimeoutS: (src.match(/READY_TIMEOUT_S:-(\d+)/) || [])[1] ?? null,
};

fs.writeFileSync(args.out, JSON.stringify(r8, null, 2) + "\n");
const ok = r8.exists && r8.isSymlinkSwitch && r8.systemctlRestart && r8.readyzPoll && r8.systemctlGuard;
console.log(`[r8-static] ${JSON.stringify(r8)} => ${ok ? "OK" : "FAIL"}`);
process.exit(ok ? 0 : 1);
