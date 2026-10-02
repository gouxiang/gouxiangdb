// 常规门 vitest 配置（`vitest run` / `pnpm test` 自动拾取本文件）。
//
// 为什么需要它：M5 之后常规门一直没有 config、走默认 hookTimeout=10000ms。迁移从早期 23 个
// 增长到现在 40 个后，真库测试夹具在 beforeEach/beforeAll 里真实执行 `prisma migrate deploy`
// 建临时库，无争用也要约 10-14s，高负载并发下更久 -> hook 超 10s 触发：
//   - 重夹具文件 beforeAll 超时 -> 整组测试被 skip（假绿/漏测）；
//   - 或报 "Hook timed out in 10000ms"（假红）。
// 统一把 hookTimeout 放宽到 120s 解决（这不是掩盖挂死：挂死由各 spec 内显式超时用例证明）。
//
// 与 e2e 隔离不冲突：test:e2e 显式 --config vitest.e2e.config.ts；本文件沿用 vitest 默认
// include（**/*.{test,spec}.*），本来就不匹配 *.e2e.ts。其余配置保持默认，含文件并行。

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    hookTimeout: 120_000,
  },
});
