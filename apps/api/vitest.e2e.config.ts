// M6/S8 真服务 e2e 专用配置（**与常规门完全隔离**）。
//
// 隔离机制（两条互不重叠的 include）：
//   - 常规门 `vitest run`（无 config）：vitest 默认只收 `**/*.{test,spec}.*` -> 收不到本片的 `*.e2e.ts`；
//   - 本配置：只收 `src/e2e/**/*.e2e.ts` -> 收不到任何 `*.test.ts`。
// 因此 `pnpm --filter @gx/api test`（2089 例）不被本片新增/改动影响，e2e 也不计入常规门。
//
// 串行（fileParallelism=false）：本片起真监听（TCP 随机端口 + unix socket 文件 + stdio 子进程），
// 并行会让端口分配、socket 文件与 stdio 审计目录互相干扰，且日志不可读。e2e 数量少，串行成本可接受。

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/e2e/**/*.e2e.ts"],
    globalSetup: ["./src/e2e/globalSetup.ts"],
    fileParallelism: false,
    pool: "forks",
    // 真服务 + 真迁移 + 多客户端往返：单例预算放宽（不是掩盖挂死——挂死由 spec 内显式超时用例证明）。
    testTimeout: 60_000,
    hookTimeout: 240_000,
    teardownTimeout: 30_000,
  },
});
