// M4/S2 回填+对账端到端（真迁移临时库，service/CLI 同域函数直调）：
//   1) migrate deploy 全 18 迁移成功，空库回填 0 行；
//   2) 造 v0.1.0 风格旧库（五档成员/四档 kb 成员/ACL 例外/软删资源/未知档位），
//      手工执行回填迁移 DML 模拟"旧库直升"：投影行数=三活表行数（无逐 doc 膨胀）；
//   3) 迁移 DML 连跑第二次零增长（幂等）；
//   4) reconcile 只读 0 差异；--apply 补 A1（迁移前造的新行）后再 0，连跑 no changes；
//   5) B1/B2/B3 悬挂与 C1 非法动作/A3 手工污染被报告，--apply 修 B 不动 A3/C。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import {
  applyAuthzReconcileFixes,
  computeAuthzReconcile,
} from "../reconcile.js";
import type { AuthzClient } from "../types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_FILE = path.resolve(
  here,
  "../../../../prisma/migrations/20260916110000_authz_policies_backfill/migration.sql",
);

let tmpDir: string;
let db: PrismaClient;
let tx: AuthzClient;

/** 执行回填迁移文件的全部语句（better-sqlite3 一次一条；按行尾分号切）。 */
async function runBackfillMigration(): Promise<void> {
  const sql = fs.readFileSync(MIGRATION_FILE, "utf8");
  const statements = sql
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of statements) {
    await db.$executeRawUnsafe(stmt);
  }
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-m4-backfill-"));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "bf.db")}`;
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  process.env.GX_DATA_DIR = tmpDir;
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  db = new PrismaClient();
  globalThis.__gx_prisma = db;
  tx = db as unknown as AuthzClient;
}, 120000);

afterAll(async () => {
  await db.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function seedOldLibrary(): Promise<{
  live: number; memberRows: number; kbMemberRows: number; aclRows: number;
}> {
  await db.user.createMany({
    data: ["u1", "u2", "u3", "u4", "u5", "u6", "u_disabled", "u_orphan"].map((id) => ({
      id, email: `${id}@x.com`, displayName: id, passwordHash: "x",
      workspaceId: "ws_default", status: id === "u_disabled" ? "DISABLED" : "ACTIVE",
    })),
  });

  // 活 base + 5 档成员（owner/creator/editor/commenter/viewer），加 1 软删 base 的成员。
  await db.base.create({ data: { id: "base1", name: "B1", iconColor: "#000", createdBy: "u1" } });
  await db.base.create({ data: { id: "base_dead", name: "Dead", iconColor: "#000", createdBy: "u1", deletedAt: new Date() } });
  await db.navNode.create({ data: { id: "nav_base_base1", workspaceId: "ws_default", kind: "base", resourceType: "base", resourceId: "base1", name: "B1", path: "/nav_base_base1/", depth: 0, isSystem: 1 } });
  await db.navNode.create({ data: { id: "nav_base_dead", workspaceId: "ws_default", kind: "base", resourceType: "base", resourceId: "base_dead", name: "Dead", path: "/nav_base_dead/", depth: 0, isSystem: 1, deletedAt: new Date() } });
  const baseRoles = ["owner", "creator", "editor", "commenter", "viewer"];
  await db.member.createMany({
    data: baseRoles.map((role, i) => ({ id: `mem_${i}`, baseId: "base1", userId: `u${i + 1}`, role })),
  });
  await db.member.create({ data: { id: "mem_dead", baseId: "base_dead", userId: "u1", role: "owner" } });
  // 未知档位成员（不投影，报 A1_UNMAPPABLE_ROLE）。
  await db.member.create({ data: { id: "mem_weird", baseId: "base1", userId: "u6", role: "superuser" } });

  // 活 kb + 4 档 kb 成员；2 个 doc（含 1 canvas），ACL 三档挂在 doc/canvas 上。
  await db.knowledgeBase.create({ data: { id: "kb1", name: "K1", iconColor: "#000", createdBy: "u1" } });
  await db.navNode.create({ data: { id: "nav_kb_kb1", workspaceId: "ws_default", parentId: null, kind: "kb", resourceType: "kb", resourceId: "kb1", name: "K1", path: "/nav_kb_kb1/", depth: 0, isSystem: 1 } });
  const kbRoles = ["owner", "editor", "commenter", "viewer"];
  await db.kbMember.createMany({
    data: kbRoles.map((role, i) => ({ id: `km_${i}`, kbId: "kb1", userId: `u${i + 1}`, role })),
  });

  await db.kbDoc.create({ data: { id: "doc1", kbId: "kb1", kind: "doc", title: "D1", createdBy: "u1", updatedBy: "u1" } });
  await db.kbDoc.create({ data: { id: "canvas1", kbId: "kb1", kind: "canvas", title: "C1", content: "[]", createdBy: "u1", updatedBy: "u1" } });
  await db.navNode.create({ data: { id: "nav_doc_doc1", workspaceId: "ws_default", parentId: "nav_kb_kb1", kind: "doc", resourceType: "doc", resourceId: "doc1", name: "D1", path: "/nav_kb_kb1/nav_doc_doc1/", depth: 1, isSystem: 1 } });
  await db.navNode.create({ data: { id: "nav_canvas_canvas1", workspaceId: "ws_default", parentId: "nav_kb_kb1", kind: "canvas", resourceType: "canvas", resourceId: "canvas1", name: "C1", path: "/nav_kb_kb1/nav_canvas_canvas1/", depth: 1, isSystem: 1 } });
  const aclRoles = ["editor", "commenter", "viewer"];
  await db.kbDocAcl.createMany({
    data: [
      ...aclRoles.map((role, i) => ({ id: `acl_doc_${i}`, docId: "doc1", userId: `u${i + 3}`, role })),
      { id: "acl_canvas_0", docId: "canvas1", userId: "u4", role: "viewer" }, // canvas ACL 也投影
    ],
  });

  const memberRows = 5; // 软删 base 与未知档不计活投影
  const kbMemberRows = 4;
  const aclRows = 4;
  return { live: memberRows + kbMemberRows + aclRows, memberRows, kbMemberRows, aclRows };
}

describe("旧库直升：迁移 DML 回填", () => {
  it("空库 migrate deploy 后 auth_policies 为 0", async () => {
    expect(await db.authPolicy.count()).toBe(0);
  });

  it("执行回填 DML：投影行数=活 members+kb_members+acls（canvas ACL 覆盖，软删/未知不投影）", async () => {
    const expected = await seedOldLibrary();
    await runBackfillMigration();
    const total = await db.authPolicy.count();
    expect(total).toBe(expected.live);

    // 三来源计数分别核对
    expect(await db.authPolicy.count({ where: { reason: "legacy:member" } })).toBe(expected.memberRows);
    expect(await db.authPolicy.count({ where: { reason: "legacy:kb_member" } })).toBe(expected.kbMemberRows);
    expect(await db.authPolicy.count({ where: { reason: "legacy:acl" } })).toBe(expected.aclRows);

    // 无逐 doc 膨胀：kb_members 只到 kb 容器，不在 doc1/canvas1 产生成员投影
    const kbMemberPolicyNodes = await db.authPolicy.findMany({
      where: { reason: "legacy:kb_member" }, select: { nodeId: true }, distinct: ["nodeId"],
    });
    expect(kbMemberPolicyNodes.map((n) => n.nodeId)).toEqual(["nav_kb_kb1"]);

    // owner 动作位齐全（base owner 含 manage_share+manage_schema；kb owner 含 manage_share 不含 schema）
    const baseOwner = await db.authPolicy.findFirstOrThrow({ where: { reason: "legacy:member", subjectId: "u1" } });
    expect(baseOwner.actions).toBe("c,comment,d,manage_schema,manage_share,r,u");
    const kbOwner = await db.authPolicy.findFirstOrThrow({ where: { reason: "legacy:kb_member", subjectId: "u1" } });
    expect(kbOwner.actions).toBe("c,comment,d,manage_share,r,u");
    // canvas ACL 确实投影到 canvas 节点
    expect(await db.authPolicy.findFirst({ where: { reason: "legacy:acl", nodeId: "nav_canvas_canvas1" } })).not.toBeNull();
  });

  it("回填 DML 连跑第二次零增长（NOT EXISTS 幂等）", async () => {
    const before = await db.authPolicy.count();
    expect(before).toBe(13); // 5 活成员 + 4 kb 成员 + 4 ACL（软删/未知档不投影）
    await runBackfillMigration();
    expect(await db.authPolicy.count()).toBe(before);
  });
});

describe("reconcile 对账", () => {
  it("直升后新增一条 DISABLED 成员：A1 缺投影；apply 补后 A/B/C=0，行数=活三表", async () => {
    // DISABLED 用户的成员行仍投影（停用归鉴权层 tokenVersion/status 拦，行保留）。
    await db.member.create({ data: { id: "mem_disabled", baseId: "base1", userId: "u_disabled", role: "viewer" } });
    const report1 = await computeAuthzReconcile(tx);
    const a1 = report1.A.filter((d) => d.code === "A1_MISSING_POLICY");
    expect(a1.length).toBe(1); // 仅后造的 u_disabled 成员
    const unknown = report1.A.filter((d) => d.code === "A1_UNMAPPABLE_ROLE");
    expect(unknown.length).toBe(1); // superuser 不可投影（A 类提示但 apply 不造）

    const fix = await applyAuthzReconcileFixes(tx);
    expect(fix.created).toBe(1);
    const report2 = await computeAuthzReconcile(tx);
    // A1_UNMAPPABLE_ROLE 是 A 类提示：apply 无法消（旧行档位非法），属人工数据，单独断言其存在而非要求全 A=0
    expect(report2.A.filter((d) => d.code !== "A1_UNMAPPABLE_ROLE")).toHaveLength(0);
    expect(report2.B).toHaveLength(0);
    expect(report2.C).toHaveLength(0);

    // 行数 = 活 members(6，含 disabled，剔除软删/未知) + kb_members(4) + acls(4) = 14
    expect(report2.counts.expected).toBe(14);
    expect(report2.counts.legacyPolicies).toBe(14);
  });

  it("连跑 apply 第二次 no changes（幂等）", async () => {
    const fix2 = await applyAuthzReconcileFixes(tx);
    expect(fix2.created + fix2.updated + fix2.deleted).toBe(0);
  });

  it("B1 旧行消失：删除 member 后投影变悬挂，apply 清除", async () => {
    await db.member.delete({ where: { id: "mem_4" } }); // viewer 行 u5
    const r = await computeAuthzReconcile(tx);
    expect(r.B.some((d) => d.code === "B1_ORPHAN_PROJECTION")).toBe(true);
    const before = await db.authPolicy.count();
    await applyAuthzReconcileFixes(tx);
    expect(await db.authPolicy.count()).toBe(before - 1);
    const after = await computeAuthzReconcile(tx);
    expect(after.B.filter((d) => d.code === "B1_ORPHAN_PROJECTION")).toHaveLength(0);
  });

  it("B2 节点软删 + B3 主体用户物理删除被报告并清除", async () => {
    // B3：物理删 u3（其 member/km/acl 经 FK cascade 消失，模拟残留投影：直接造一条悬挂 legacy 行）
    await db.authPolicy.create({
      data: { id: "pol_orphan_user", workspaceId: "ws_default", nodeId: "nav_base_base1", subjectType: "user", subjectId: "u_orphan", actions: "r", reason: "legacy:member", createdBy: "legacy-backfill" },
    });
    await db.user.delete({ where: { id: "u_orphan" } }).catch(() => undefined);
    // B2：软删 doc 节点
    await db.navNode.update({ where: { id: "nav_canvas_canvas1" }, data: { deletedAt: new Date() } });

    const r = await computeAuthzReconcile(tx);
    expect(r.B.some((d) => d.code === "B2_BROKEN_NODE")).toBe(true);
    expect(r.B.some((d) => d.code === "B3_MISSING_USER")).toBe(true);
    await applyAuthzReconcileFixes(tx);
    const after = await computeAuthzReconcile(tx);
    expect(after.B.filter((d) => d.code === "B2_BROKEN_NODE" || d.code === "B3_MISSING_USER")).toHaveLength(0);
  });

  it("C1 非法动作词与 A3 手工污染被报告且 apply 不自动改", async () => {
    // 恢复 canvas 节点后造 C1/A3
    await db.navNode.update({ where: { id: "nav_canvas_canvas1" }, data: { deletedAt: null } });
    await db.authPolicy.create({
      data: { id: "pol_bad_action", workspaceId: "ws_default", nodeId: "nav_doc_doc1", subjectType: "user", subjectId: "u6", actions: "r,hack", reason: "manual", createdBy: "u1" },
    });
    // A3：非 legacy 行但动作串恰等于 viewer 档 "r"
    await db.authPolicy.create({
      data: { id: "pol_manual_like_legacy", workspaceId: "ws_default", nodeId: "nav_kb_kb1", subjectType: "user", subjectId: "u6", actions: "r", reason: "manual-grant", createdBy: "u1" },
    });
    const r = await computeAuthzReconcile(tx);
    expect(r.C.some((d) => d.code === "C1_BAD_ACTION")).toBe(true);
    expect(r.A.some((d) => d.code === "A3_MANUAL_MATCHES_LEGACY")).toBe(true);

    const before = await db.authPolicy.findMany({ where: { id: { in: ["pol_bad_action", "pol_manual_like_legacy"] } } });
    await applyAuthzReconcileFixes(tx);
    const after = await db.authPolicy.findMany({ where: { id: { in: ["pol_bad_action", "pol_manual_like_legacy"] } } });
    expect(after.length).toBe(before.length); // C/A3 不自动改
  });
});
