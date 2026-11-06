/**
 * app_settings KV 适配器：授权 store 的 KvStore 生产实现。零新表。
 * 读走 prisma 直读；写经 runWrite 串行化（遵守项目单写者纪律，避免 database is locked）。
 */
import { prisma, runWrite, type DbTx } from "../../db.js";
import type { KvStore } from "./store.js";

export const prismaKv: KvStore = {
  async getMany(keys: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (keys.length === 0) return out;
    const rows = await prisma.appSetting.findMany({ where: { k: { in: keys } } });
    for (const r of rows) out.set(r.k, r.v);
    return out;
  },
  async setMany(entries: Record<string, string>): Promise<void> {
    const pairs = Object.entries(entries);
    if (pairs.length === 0) return;
    await runWrite("license.kv.setMany", async () => {
      await prisma.$transaction(
        async (tx: DbTx) => {
          for (const [k, v] of pairs) {
            await tx.appSetting.upsert({
              where: { k },
              create: { k, v },
              update: { v },
            });
          }
        },
        { timeout: 20_000, maxWait: 10_000 },
      );
    });
  },
};
