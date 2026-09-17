// M3-S11-A/AC-UPG-1 生产产物对账 CLI 集成测试：
// 直接以【node 跑 esbuild 产物 dist/nav-reconcile.js】（不是 tsx 源码），证明第三入口
// 真的被打进生产 dist 且在"migrate deploy 刚完成"的库上行为正确——这正是四个部署面
// （裸机 deploy.sh / docker-entrypoint / fnos install+upgrade callback）接线的同一条命令。
//
// 前置：dist/nav-reconcile.js 必须已由 `node scripts/build.mjs` 产出。
// 常规 vitest 门在未构建时【显式 skip】（不 fail），但本仓自验纪律是先 build 再单跑本文件，
// skip 状态交差视为无效（见 M7 派工单第 6 条）。
//
// cwd 纪律：子进程 cwd 一律用临时目录而不是 apps/api——开发树 @prisma/client 在生成时
// 烤入了 apps/api/.env，DATABASE_URL 未设时自动加载其中的 file:./dev.db（相对路径再按
// cwd/prisma 解析），用 apps/api 当 cwd 会意外撞到开发库 dev.db。临时 cwd 下该相对路径
// 解析到临时目录（不存在），干净命中脚本 64 分支。生产发布目录（裸机/fpk/docker）
// 构造上不含 .env（白名单组装 + 禁带扫描），外置 @prisma/client 从 dist 文件位置上溯
// node_modules 解析、绝对 file: URL 不依赖 cwd，与本测试临时 cwd 同态。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import Database from "better-sqlite3";
import { nodeId, WS_ID } from "../../../src/domain/nav/backfill.js";

const distCli = path.resolve("dist/nav-reconcile.js");
const distExists = fs.existsSync(distCli);
if (!distExists) {
  console.warn(
    "[reconcile-dist] SKIP：dist/nav-reconcile.js 不存在；先运行 `node scripts/build.mjs` 再单跑本测试。",
  );
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runDistCli(cwd: string, dbFile: string | null, args: string[], auditDir: string): RunResult {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "test", GX_AUDIT_DIR: auditDir };
  if (dbFile === null) delete env.DATABASE_URL;
  else env.DATABASE_URL = `file:${dbFile}`;
  try {
    const stdout = execFileSync(process.execPath, [distCli, ...args], {
      cwd,
      env,
      encoding: "utf8",
    });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

// 与 reconcile-cli.test.ts 同款余量：真子进程 + 首次 migrate deploy 固定成本。
const DIST_TEST_TIMEOUT = 60_000;

(distExists ? describe : describe.skip)("dist/nav-reconcile.js 生产产物", () => {
  let tmpRoot: string;
  let dbFile: string;
  let prisma: PrismaClient;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gx-nav-dist-"));
    dbFile = path.join(tmpRoot, "post-migrate.db");
    // 1) 全新库跑全量 migrate deploy（部署面 migrate 步骤的等价动作）。
    execFileSync(
      "pnpm",
      ["exec", "prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: `file:${dbFile}` },
        stdio: "ignore",
      },
    );
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("缺 DATABASE_URL 退出码 64（用法/环境错误）", () => {
    // 64 有两个同源分支（reconcile-nav.ts：缺 DATABASE_URL / 解析出的库文件不存在）。
    // 本机开发树的 @prisma/client 是在 apps/api 生成的，client 内烤入了 apps/api/.env 的
    // 路径并在 DATABASE_URL 未设时自动加载（-> file:./dev.db），故开发机走"库文件不存在"
    // 分支；生产发布目录（裸机/fpk/docker）构造上不含 .env 且禁带扫描兜底，走"缺少
    // DATABASE_URL"分支。两分支退出码同为 64，这里断言退出码 + 两条消息之一。
    const r = runDistCli(tmpRoot, null, ["--apply"], tmpRoot);
    expect(r.status).toBe(64);
    expect(r.stderr).toMatch(/缺少 DATABASE_URL|数据库文件不存在/);
  }, DIST_TEST_TIMEOUT);

  it("迁移后态首跑 --apply 重建 path（exit 0，报改动/pathsRebuilt），再跑 no changes（exit 0）", async () => {
    // 2) 造活实体（migrate 时表为空 -> 迁移 B 回填 0 行；这里复刻"实体先于迁移存在"的
    //    直升场景：手工重放迁移 B 的 DML，得到与真实 migrate deploy 完全一致的库状态——
    //    根节点（base/kb）有 path，非根节点（table/view）path='' depth=0）。
    prisma = new PrismaClient({ datasources: { db: { url: `file:${dbFile}` } } });
    await prisma.user.create({
      data: { id: "u1", email: "u1@x.com", displayName: "u1", passwordHash: "h", status: "ACTIVE", workspaceId: WS_ID },
    });
    // 顺序写入（不用 $transaction(数组)：Prisma 数组事务并行发起，FK 依赖行间歇撞 P2003）。
    await prisma.base.create({ data: { id: "b1", name: "b1", createdBy: "u1" } });
    await prisma.member.create({ data: { id: "m1", baseId: "b1", userId: "u1", role: "owner" } });
    await prisma.table.create({ data: { id: "t1", baseId: "b1", name: "t1", primaryFieldId: "", createdBy: "u1" } });
    await prisma.view.create({ data: { id: "v1", tableId: "t1", name: "g", type: "grid", order: 0, config: "{}" } });

    const raw = new Database(dbFile);
    raw.pragma("foreign_keys=ON");
    raw.exec(fs.readFileSync(
      path.resolve("prisma/migrations/20260916093000_enterprise_nav_backfill/migration.sql"), "utf8"));
    raw.close();

    // 迁移后态证据：table/view 节点 path 为空、depth=0（深层 tree 索引缺节点的故障态）。
    const tableNodeBefore = await prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("table", "t1") } });
    const viewNodeBefore = await prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("view", "v1") } });
    expect(tableNodeBefore.path).toBe("");
    expect(viewNodeBefore.path).toBe("");
    expect(viewNodeBefore.depth).toBe(0);

    // 3) 首跑 --apply（与四个部署面接线的命令逐字一致）；cwd 用临时目录，隔离 dev 树 .env。
    const auditDir = path.join(tmpRoot, ".audit");
    const first = runDistCli(tmpRoot, dbFile, ["--apply"], auditDir);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("applied changes=");
    expect(first.stdout).toContain("pathsRebuilt");
    expect(first.stdout).not.toContain("no changes");

    // path/depth 已真正落库（非根节点拿到完整物化路径）。
    const tableNodeAfter = await prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("table", "t1") } });
    const viewNodeAfter = await prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("view", "v1") } });
    expect(tableNodeAfter.path).toBe(`/${nodeId("base", "b1")}/${nodeId("table", "t1")}/`);
    expect(tableNodeAfter.depth).toBe(2);
    expect(viewNodeAfter.path).toBe(`/${nodeId("base", "b1")}/${nodeId("table", "t1")}/${nodeId("view", "v1")}/`);
    expect(viewNodeAfter.depth).toBe(3);

    // 4) 幂等：再跑一次必须 no changes、exit 0（部署链路重复触发/重入安全）。
    const second = runDistCli(tmpRoot, dbFile, ["--apply"], auditDir);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("no changes");
  }, DIST_TEST_TIMEOUT);
});
