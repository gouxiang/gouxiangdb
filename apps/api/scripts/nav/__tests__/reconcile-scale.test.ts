// M3/S4 小规模耗时留证（S10 扩到 10 万）：造 1k / 1w 实体节点，测只读 reconcile
// computeDiffs 全表扫耗时。仅断言"完成且健康库 0 阻断"，耗时打印留证（不设过严阈值，
// 避免在抖动 CI 上 flaky；S10 用此基线对照 10 万 P95 目标）。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { computeDiffs } from "../../../src/domain/nav/reconcile.js";
import { WS_ID } from "../../../src/domain/nav/backfill.js";

const SCALES = [1_000, 10_000] as const;

for (const scale of SCALES) {
  describe(`reconcile 规模 ${scale} 节点`, () => {
    let tmpDir: string;
    let dbFile: string;
    let prisma: PrismaClient;

    beforeAll(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `gx-s4-scale-${scale}-`));
      dbFile = path.join(tmpDir, "scale.db");
      execFileSync(
        "pnpm",
        ["exec", "prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"],
        { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: `file:${dbFile}` }, stdio: "ignore" },
      );
      prisma = new PrismaClient({ datasources: { db: { url: `file:${dbFile}` } } });

      // 一个 workspace + 一个 owner user；批量造 base/table/view 实体（每 base 1 table 1 view）。
      // scale 按 view 节点数计（最末层），总节点数约 3*scale。
      const groups = scale; // 每组 base+table+view = 3 节点
      // createdAt 按 i 递增（秒），避免同毫秒 tie-break 使期望集 ord 不可预测（A5）。
      const baseTime = Date.parse("2026-01-01T00:00:00Z");
      const at = (i: number) => new Date(baseTime + i * 1000);
      const bases = Array.from({ length: groups }, (_, i) => ({
        id: `b_${i}`, name: `base ${i}`, createdBy: "scale_u", createdAt: at(i),
      }));
      const tables = bases.map((b, i) => ({
        id: `t_${i}`, baseId: b.id, name: `table ${i}`, primaryFieldId: "", createdBy: "scale_u", createdAt: at(i),
      }));
      const views = tables.map((t, i) => ({
        id: `v_${i}`, tableId: t.id, name: "grid", type: "grid" as const, order: 0, config: "{}", createdAt: at(i),
      }));
      await prisma.user.create({
        data: { id: "scale_u", email: "scale@x.com", displayName: "scale", passwordHash: "h", status: "ACTIVE", workspaceId: WS_ID },
      });
      await prisma.base.createMany({ data: bases });
      await prisma.table.createMany({ data: tables });
      await prisma.view.createMany({ data: views });

      // 直接批量建 nav 节点（确定性 id/parent/path/depth/ord），不经逐行期望集（规模演练只测读扫耗时）。
      const navNow = new Date();
      const navBases = bases.map((b, i) => ({
        id: `nav_base_${b.id}`, workspaceId: WS_ID, parentId: null, kind: "base", resourceType: "base",
        resourceId: b.id, name: b.name, ord: i, path: `/nav_base_${b.id}/`, depth: 1, isSystem: 1,
        inheritAncestors: 1, createdAt: navNow,
      }));
      const navTables = tables.map((t, i) => ({
        id: `nav_table_${t.id}`, workspaceId: WS_ID, parentId: `nav_base_${t.baseId}`, kind: "table", resourceType: "table",
        resourceId: t.id, name: t.name, ord: 0, path: `/nav_base_${t.baseId}/nav_table_${t.id}/`, depth: 2,
        isSystem: 1, inheritAncestors: 1, createdAt: navNow,
      }));
      const navViews = views.map((v, i) => ({
        id: `nav_view_${v.id}`, workspaceId: WS_ID, parentId: `nav_table_${v.tableId}`, kind: "view", resourceType: "view",
        resourceId: v.id, name: v.name, ord: 0, path: `/nav_base_${tables[i]!.baseId}/nav_table_${v.tableId}/nav_view_${v.id}/`,
        depth: 3, isSystem: 1, inheritAncestors: 1, createdAt: navNow,
      }));
      await prisma.navNode.createMany({ data: navBases });
      await prisma.navNode.createMany({ data: navTables });
      await prisma.navNode.createMany({ data: navViews });
    }, 300_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it(`computeDiffs 全表扫 ${scale} 组（约 ${scale * 3} 节点）：0 阻断`, { timeout: 120_000 }, async () => {
      // 只读留证：直接传 client（DbTx 结构兼容，PrismaClient 本身满足委托形状），
      // 避开交互事务默认 5s 超时；不写入，无原子性需求。
      const t0 = Date.now();
      const report = await computeDiffs(prisma);
      const ms = Date.now() - t0;
      // S4 仅留证；S10 再把 buildExpectedNodes 的逐父 findMany（N+1）改为批量，目标 10 万 P95。
      console.log(`[reconcile-scale] ${scale} 组 / ${scale * 3} 节点 computeDiffs=${ms}ms`);
      expect(report.summary.A + report.summary.B + report.summary.C).toBe(0);
      // 无 menu shortcut：每个 table 一条 C4 warning（未收纳），数量精确。
      expect(report.warnings.filter((w) => w.code === "C4")).toHaveLength(scale);
    });
  });
}
