// M3/S4 reconcile CLI 端到端：真子进程跑 scripts/nav/reconcile-nav.ts，
// 验 exit code（只读有阻断=1、健康=0）、--apply 修复、--purge-broken 物理清理 +
// 审计 JSONL 落 actor='reconcile-script'、连跑第二次 no changes。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import Database from "better-sqlite3";
import { buildExpectedNodes, reconcileNodesTx, rebuildPathsTx, nodeId, WS_ID } from "../../../src/domain/nav/backfill.js";

const scriptPath = path.resolve("scripts/nav/reconcile-nav.ts");

function runCli(dbFile: string, args: string[]): { status: number; stdout: string } {
  try {
    const stdout = execFileSync(
      "pnpm",
      ["exec", "tsx", scriptPath, ...args],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: `file:${dbFile}`, NODE_ENV: "test", GX_AUDIT_DIR: path.join(path.dirname(dbFile), ".audit") },
        encoding: "utf8",
      },
    );
    return { status: 0, stdout };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? -1, stdout: err.stdout ?? "" };
  }
}

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gx-s4-cli-"));
}, 180000);
afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function deployDb(name: string): string {
  const file = path.join(tmpRoot, `${name}.db`);
  execFileSync(
    "pnpm",
    ["exec", "prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: `file:${file}` },
      stdio: "ignore",
    },
  );
  return file;
}

/** 每个库独立 client（SQLite 单连接，env 切换不影响已实例化的全局 client）。 */
function clientFor(file: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: `file:${file}` } } });
}

describe("reconcile-nav CLI", () => {
  it("健康库只读 exit=0；制造 A4 后只读 exit=1、--apply 修复后 exit=0", async () => {
    const file = deployDb("a4");
    const prisma = clientFor(file);
    await prisma.user.create({
      data: { id: "u1", email: "u1@x.com", displayName: "u1", passwordHash: "h", status: "ACTIVE", workspaceId: WS_ID },
    });
    await prisma.$transaction([
      prisma.base.create({ data: { id: "b1", name: "b1", createdBy: "u1" } }),
      prisma.member.create({ data: { id: "m1", baseId: "b1", userId: "u1", role: "owner" } }),
      prisma.table.create({ data: { id: "t1", baseId: "b1", name: "t1", primaryFieldId: "", createdBy: "u1" } }),
      prisma.view.create({ data: { id: "v1", tableId: "t1", name: "g", type: "grid", order: 0, config: "{}" } }),
    ]);
    await prisma.$transaction(async (tx) => {
      await reconcileNodesTx(tx, await buildExpectedNodes(tx));
      await rebuildPathsTx(tx);
    });

    expect(runCli(file, []).status).toBe(0);
    await prisma.navNode.update({ where: { id: nodeId("table", "t1") }, data: { name: "坏" } });
    expect(runCli(file, []).status).toBe(1); // 只读有阻断

    const applied = runCli(file, ["--apply"]);
    expect(applied.status).toBe(0);
    expect(applied.stdout).toContain("applied changes=");
    // 第二次 no changes。
    const again = runCli(file, ["--apply"]);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("no changes");
    await prisma.$disconnect();
  });

  it("broken：只读 exit=1 且 --apply（无 purge）不清；--apply --purge-broken 清干净并写审计", async () => {
    const file = deployDb("brk");
    const p = clientFor(file);
    await p.user.create({
      data: { id: "u2", email: "u2@x.com", displayName: "u2", passwordHash: "h", status: "ACTIVE", workspaceId: WS_ID },
    });
    await p.$transaction([
      p.base.create({ data: { id: "b2", name: "b2", createdBy: "u2" } }),
      p.member.create({ data: { id: "m2", baseId: "b2", userId: "u2", role: "owner" } }),
      p.table.create({ data: { id: "t2", baseId: "b2", name: "t2", primaryFieldId: "", createdBy: "u2" } }),
      p.view.create({ data: { id: "v2", tableId: "t2", name: "g", type: "grid", order: 0, config: "{}" } }),
    ]);
    await p.$transaction(async (tx) => {
      await reconcileNodesTx(tx, await buildExpectedNodes(tx));
      await rebuildPathsTx(tx);
    });
    const raw = new Database(file);
    raw.pragma("foreign_keys=ON");
    raw.exec(fs.readFileSync(
      path.resolve("prisma/migrations/20260916093000_enterprise_nav_backfill/migration.sql"), "utf8"));
    await p.table.delete({ where: { id: "t2" } }); // B1 broken（节点+shortcut 留）

    expect(runCli(file, []).status).toBe(1);
    runCli(file, ["--apply"]); // 不带 purge
    expect(await p.navNode.count({ where: { id: nodeId("table", "t2") } })).toBe(1);

    const auditDir = path.join(path.dirname(file), ".audit");
    const purged = runCli(file, ["--apply", "--purge-broken"]);
    expect(purged.status).toBe(0);
    expect(await p.navNode.count({ where: { id: { startsWith: "nav_" } } })).toBeGreaterThan(0); // base 节点仍在
    expect(await p.navNode.count({ where: { id: nodeId("table", "t2") } })).toBe(0);

    // 审计 JSONL：actor='reconcile-script'、event=nav_broken_purged。
    const logFile = path.join(auditDir, "audit.logl");
    expect(fs.existsSync(logFile)).toBe(true);
    const lines = fs.readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const rec = lines.find((l) => l.event === "nav_broken_purged");
    expect(rec).toBeTruthy();
    expect(rec.actorId).toBe("reconcile-script");
    expect(rec.detail.purgedNodes).toBeGreaterThan(0);

    raw.close();
    await p.$disconnect();
  });
});
