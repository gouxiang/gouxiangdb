// M6/S8 e2e 共享引导：临时库环境 + 真迁移 + 夹具 + 真服务（TCP 与 unix socket）。
//
// 抽出来的理由：每个 e2e 文件都需要同一套前置（且文件数受"单文件 ≤300 行"门禁约束），
// 但**不强求共享进程状态**——每个文件仍有自己的临时库与监听端口（vitest forks + fileParallelism=false），
// 即"文件级隔离、形态级共享"。

import { PrismaClient } from "@prisma/client";
import { migrateFresh, prepareEnv, restoreEnv, startTcpServer, startUnixServer, type E2eEnv, type RunningServer } from "./serverHarness.js";
import { seedFixtures, type Fixtures } from "./fixtures.js";

export interface E2eStack {
  env: E2eEnv;
  prisma: PrismaClient;
  fx: Fixtures;
  tcp: RunningServer;
  unix: RunningServer;
  close: () => Promise<void>;
}

export async function bootstrapE2e(label: string): Promise<E2eStack> {
  const env = prepareEnv(label);
  migrateFresh();
  const prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;
  const fx = await seedFixtures(prisma);
  // 动态 import：必须在 env 就位之后（config 在 import 时求值并冻结）。
  const app = (await import("../app.js")).createApp().app;
  const tcp = await startTcpServer(app);
  const unix = await startUnixServer(app, `${env.tmpDir}/api.sock`);
  return {
    env, prisma, fx, tcp, unix,
    close: async () => {
      await unix.close();
      await tcp.close();
      await prisma.$disconnect();
      restoreEnv(env);
    },
  };
}
