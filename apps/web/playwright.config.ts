// M6/S6b 画布 MCP 写入真实加载 golden 的 Playwright 配置。
//
// 设施约束（M6-S6b-FE 派工）：
//  - 不引新依赖（@playwright/test 已在 package.json，test:e2e script 已在）。
//  - e2e/ 目录独立，vitest 不扫描（vitest 入口只认 *.test.*，见各 *.test.ts 约定），
//    故 test:e2e 与 pnpm -r run test 常规门互不污染。
//  - dev 环境由 scripts/dev-up.sh 起 API(:3001)+Web(:5173，vite 代理 /api 与 /mcp → :3001)。
//    开发期 reuseExistingServer:true：CI/无服务时由 CI（S8 再议）传 WEB_SERVER=managed 或
//    后续在 CI 里自行起；本片本地一键跑，dev-up restart 后直接 playwright test。
import { defineConfig, devices } from "@playwright/test";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:5173";

export default defineConfig({
  testDir: "./e2e",
  // e2e 较慢（真实浏览器 + 真实服务端落库），给足超时但不挂起。
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false, // 共享 dev.db + 真实登录，串行避免相互干扰
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    baseURL: BASE_URL,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    // 控制台 error 收集在 spec 内断言（无白屏/无 plait 报错）。
    console: true,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
