// M4/S2 防漂移：回填迁移 SQL 内 CASE 动作字面量必须与 shared-types 单一真源
// resourceActionsForLegacyRole 逐字一致（M4 计划 §7-S2 明确要求交叉断言）。
// 另断言：确定性 id 前缀、三 reason、NOT EXISTS 幂等门、不写 role_assignments。

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RESOURCE_ACTIONS,
  resourceActionsForLegacyRole,
  toActionString,
  type LegacyRoleFamily,
} from "@gx/shared-types";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(
  here,
  "../../../../prisma/migrations/20260916110000_authz_policies_backfill/migration.sql",
);
const DOWN = path.resolve(
  here,
  "../../../../prisma/docs/rollback/20260916110000_authz_backfill.down.sql",
);
const sql = fs.readFileSync(MIGRATION, "utf8");
const down = fs.readFileSync(DOWN, "utf8");

/** 抽取某个 CASE <col>."role" ... END 块内 WHEN 'role' THEN 'actions' 映射。 */
function extractCase(marker: string): Record<string, string> {
  const start = sql.indexOf(marker);
  expect(start, `迁移缺少 ${marker}`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("END", start);
  const block = sql.slice(start, end);
  const out: Record<string, string> = {};
  const re = /WHEN\s+'([a-z]+)'\s+THEN\s+'([^']*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) out[m[1]!] = m[2]!;
  return out;
}

const FAMILY_ROLES: Record<LegacyRoleFamily, readonly string[]> = {
  base: ["owner", "creator", "editor", "commenter", "viewer"],
  kb: ["owner", "editor", "commenter", "viewer"],
  doc: ["editor", "commenter", "viewer"],
};

describe("回填迁移 CASE 字面量 == shared-types 映射（逐字）", () => {
  const cases: Array<{ name: string; marker: string; family: LegacyRoleFamily }> = [
    { name: "members -> base 五档", marker: `CASE m."role"`, family: "base" },
    { name: "kb_members -> kb 四档", marker: `CASE km."role"`, family: "kb" },
    { name: "kb_doc_acls -> doc 三档", marker: `CASE a."role"`, family: "doc" },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const literal = extractCase(c.marker);
      for (const role of FAMILY_ROLES[c.family]) {
        const expected = toActionString(resourceActionsForLegacyRole(c.family, role));
        expect(literal[role], `${c.family}.${role}`).toBe(expected);
      }
      // 不多不少：CASE 档位集合恰好等于该族档位
      expect(Object.keys(literal).sort()).toEqual([...FAMILY_ROLES[c.family]].sort());
    });
  }

  it("所有字面量只由七枚白名单动作组成且字典序（无非法/乱序）", () => {
    for (const c of cases) {
      for (const v of Object.values(extractCase(c.marker))) {
        const acts = v.split(",").filter(Boolean);
        for (const a of acts) expect(RESOURCE_ACTIONS).toContain(a as never);
        expect(acts.join(",")).toBe([...acts].sort().join(","));
      }
    }
  });
});

describe("回填迁移结构纪律", () => {
  it("三段均有 NOT EXISTS 幂等门、确定性 id 前缀、活实体/活节点过滤", () => {
    expect(sql).toContain("NOT EXISTS");
    expect((sql.match(/NOT EXISTS/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(sql).toContain("pol_legacy_member_");
    expect(sql).toContain("pol_legacy_kbmember_");
    expect(sql).toContain("pol_legacy_acl_");
    expect(sql).toContain("legacy:member");
    expect(sql).toContain("legacy:kb_member");
    expect(sql).toContain("legacy:acl");
    expect(sql).toContain(`b."deletedAt" IS NULL`);
    expect(sql).toContain(`k."deletedAt" IS NULL`);
    expect(sql).toContain(`d."deletedAt" IS NULL`);
    expect(sql).toContain(`nb."deletedAt" IS NULL`);
  });

  it("kb_members 只投影 kb 容器一行（段内不 JOIN kb_docs，不逐 doc 物化）", () => {
    // 第 2 段边界：从 kb_members INSERT 到第 3 段 acl INSERT 之前
    const segStart = sql.indexOf(`FROM "kb_members" km`);
    const segEnd = sql.indexOf("pol_legacy_acl_");
    const kbSection = sql.slice(segStart, segEnd);
    expect(kbSection).toContain(`JOIN "nav_nodes" nk`);
    expect(kbSection).not.toContain("kb_docs");
  });

  it("绝不写 role_assignments（裁决 A-2：资源 owner 不抬升为工作区管理员）", () => {
    // 只检查真实 DML 形态，避免命中注释里"不写 role_assignments"的说明文字
    expect(sql).not.toContain(`INSERT INTO "role_assignments"`);
    expect(sql).not.toContain(`JOIN "role_assignments"`);
    expect(sql).toContain("'legacy-backfill'");
  });

  it("down SQL 只清 legacy 三前缀投影行", () => {
    expect(down).toContain("DELETE FROM \"auth_policies\"");
    expect(down).toContain("'legacy:member'");
    expect(down).toContain("'legacy:kb_member'");
    expect(down).toContain("'legacy:acl'");
    expect(down).not.toContain("DROP TABLE");
  });
});
