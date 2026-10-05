// apps/api/src/db/databaseFile.ts
// DATABASE_URL → SQLite 数据库文件绝对路径的唯一纯函数实现（M1/S2 抽出）。
// readiness（探针）、rawRead（只读 raw 网关）、backup 脚本三处共用同一解析口径：
// 相对路径基准为 prisma/ 目录（与 Prisma 对 SQLite 相对 schema 目录的解析一致）。
//
// 说明：scripts/backup/lib.mjs 是运行时无法 import TS 的手工镜像，改动本文件算法时
// 必须同步那份 .mjs（其文件头注释已声明镜像关系）。

import path from "node:path";

/**
 * 把 file: 连接串（或裸路径）解析为绝对文件路径。
 * - 去掉 file: 前缀与 ?query（如 ?mode=ro&_pragma=...）；
 * - :memory: 原样返回（调用方自行决定是否支持）；
 * - 相对路径相对 prismaDir（prisma/ 目录）解析。
 */
export function resolveDatabaseFile(databaseUrl: string, prismaDir: string): string {
  const raw = databaseUrl.startsWith("file:") ? databaseUrl.slice("file:".length) : databaseUrl;
  const noQuery = raw.split("?")[0] ?? raw;
  return path.isAbsolute(noQuery) ? noQuery : path.resolve(prismaDir, noQuery);
}
