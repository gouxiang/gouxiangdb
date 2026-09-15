// M4/S9 契约 DTO 与 openapi schema 交叉断言（防漂移，沿 S2 backfill-literals 套路）。
//
// shared-types/src/policy.ts 的 *_KEYS 运行时常量是前端/后端共用的键单一真源；
// docs/api/openapi.yaml 的命名 schema required 是文档契约。本测试不起库、零 yaml 解析依赖，
// 直接切 schema 文本块提取全部 required:[...] 组，与 KEYS 常量按组对拍（排序后集合相等），
// 任一处增删键即红。继承/面包屑 DTO 真源在 nav.ts，一并列管。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  POLICY_SUBJECT_KEYS,
  POLICY_ROW_KEYS,
  POLICY_ANCESTOR_SUMMARY_KEYS,
  NODE_POLICIES_VIEW_KEYS,
  NODE_POLICIES_VIEW_NODE_KEYS,
  POLICY_UPSERT_KEYS,
  POLICY_DELETE_KEYS,
  LEGACY_UNMAPPABLE_ITEM_KEYS,
  POLICY_WRITE_RESULT_KEYS,
  POLICY_WRITE_RESULT_NODE_KEYS,
  EFFECTIVE_SOURCE_KEYS,
  EFFECTIVE_PERMISSION_KEYS,
  EFFECTIVE_VIEW_KEYS,
  EFFECTIVE_VIEW_NODE_KEYS,
  VISIBLE_SCOPE_KEYS,
} from "@gx/shared-types";

const here = path.dirname(fileURLToPath(import.meta.url));
const OPENAPI_PATH = path.resolve(here, "../../../../../docs/api/openapi.yaml");
const yaml = fs.readFileSync(OPENAPI_PATH, "utf8");

/** 切出某个 4 空格缩进命名 schema 的文本块（到下一个同级 schema 名为止）。 */
function schemaBlock(name: string): string {
  const start = yaml.indexOf("    " + `${name}:\n`);
  expect(start, `openapi 缺少 schema ${name}`).toBeGreaterThanOrEqual(0);
  const rest = yaml.slice(start + name.length + 6);
  const next = rest.search(/\n {4}[A-Za-z][A-Za-z0-9_]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** 提取块内全部 required 组（支持跨行 flow），每组排序返回；再按组排序去重。 */
function requiredGroups(block: string): string[][] {
  const out: string[][] = [];
  const re = /required:\s*\[([\s\S]*?)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) {
    const keys = m[1]!.split(",").map((s) => s.trim().replace(/\n\s*/g, " ")).filter(Boolean);
    out.push([...new Set(keys)].sort());
  }
  return out.sort((a, b) => a.join(",").localeCompare(b.join(",")));
}

const norm = (keys: readonly string[]): string[] => [...keys].sort();
/** 块内 required 组集合必须恰为期望的若干组（顺序无关）。 */
function expectGroups(name: string, expected: Array<readonly string[]>): void {
  const got = requiredGroups(schemaBlock(name));
  const want = expected.map(norm).sort((a, b) => a.join(",").localeCompare(b.join(",")));
  expect(got, name).toEqual(want);
}

describe("S9 policy DTO KEYS 与 openapi schema required 交叉一致", () => {
  it("PolicySubject / PolicyRow", () => {
    expectGroups("PolicySubject", [POLICY_SUBJECT_KEYS]);
    expectGroups("PolicyRow", [POLICY_ROW_KEYS]);
  });

  it("NodePoliciesView（含内嵌 node 5 键）", () => {
    expectGroups("NodePoliciesView", [NODE_POLICIES_VIEW_KEYS, NODE_POLICIES_VIEW_NODE_KEYS]);
  });

  it("PolicyAncestorSummary", () => {
    // 块文本内只显式 required 自身 3 键与内嵌 policies[] 行的 actions；
    // 行主体三键经 $ref PolicySubject 复用，由 PolicySubject 用例单独对拍。
    expectGroups("PolicyAncestorSummary", [POLICY_ANCESTOR_SUMMARY_KEYS, ["actions"]]);
  });

  it("PolicyChange / PolicyDelete", () => {
    expectGroups("PolicyChange", [POLICY_UPSERT_KEYS]);
    expectGroups("PolicyDelete", [POLICY_DELETE_KEYS]);
  });

  it("LegacyUnmappableItem / PolicyWriteResult（含内嵌 node 5 键）", () => {
    expectGroups("LegacyUnmappableItem", [LEGACY_UNMAPPABLE_ITEM_KEYS]);
    expectGroups("PolicyWriteResult", [POLICY_WRITE_RESULT_KEYS, POLICY_WRITE_RESULT_NODE_KEYS]);
  });

  it("DiagSource / EffectivePermission / EffectiveView（含内嵌 node 4 键）", () => {
    expectGroups("DiagSource", [EFFECTIVE_SOURCE_KEYS]);
    expectGroups("EffectivePermission", [EFFECTIVE_PERMISSION_KEYS]);
    expectGroups("EffectiveView", [EFFECTIVE_VIEW_KEYS, EFFECTIVE_VIEW_NODE_KEYS]);
  });

  it("VisibleScope 13 键", () => {
    expectGroups("VisibleScope", [VISIBLE_SCOPE_KEYS]);
  });

  it("InheritanceImpact / 继承链 DTO 在 nav.ts 的真源与 openapi 一致", () => {
    // 继承 impact 9 键（无 willBreakInheritanceHint）。
    expectGroups("InheritanceImpact", [[
      "count", "delta", "exempt", "from", "items", "limit", "nodeId", "offset", "to",
    ]]);
    expectGroups("InheritanceImpactItem", [["name", "sources", "userId", "via"]]);
    expectGroups("InheritanceExemptItem", [["name", "reason", "userId"]]);
    expectGroups("NodeBreadcrumb", [["chain", "nodeId", "truncatedAbove"]]);
    expectGroups("BreadcrumbNode", [["depth", "id", "kind", "name", "parentId", "path", "resourceId", "resourceType"]]);
  });
});
