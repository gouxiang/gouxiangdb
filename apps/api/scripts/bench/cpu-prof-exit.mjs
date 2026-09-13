// apps/api/scripts/bench/cpu-prof-exit.mjs
// S5b-P2 bench 专用预加载（仅随 --cpu-prof 经 --import 注入，绝不进生产启动 src/index.ts）。
//
// 背景：node --cpu-prof 只在进程【正常退出】（exit hooks 跑完）时把 profile flush 到
// --cpu-prof-dir；run-gate 的 stop() 对被测服务发 SIGTERM，而 src/index.ts 不注册信号
// handler，默认 SIGTERM 直接终止、exit hooks 不执行 → 不产生 .cpuprofile。
// 本预加载在不改动 src/index.ts 的前提下，把 SIGTERM 转成 process.exit(0)，使 V8 落盘。
// 仅 CPU 归因运行启用；正常门（不传 --cpu-prof）不加载本文件，停机行为字节不变。

import process from "node:process";

process.on("SIGTERM", () => {
  process.exit(0);
});
