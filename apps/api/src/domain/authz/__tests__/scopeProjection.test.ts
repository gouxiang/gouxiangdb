// P1/S2 scopeProjection 测试：
//   A. 单元：buildFieldMask 四档 + tableActions 六情形；
//   B. 与第二代 libraryPolicy 逐值对拍（关键）：同一组 scope 行，投影行 parseActionString 后的
//      r/c/u/d/comment/manage_schema/库管理位、以及 fieldMask 解析后的逐字段可见/可写，
//      必须与 synthesizeAccess + tableAccessOf/fieldAccessOf/contentAccessOf 完全一致。
// 纯函数测试，不触库。

import { describe, expect, it } from "vitest";
import { parseActionString, type FieldMask } from "@gx/shared-types";
import {
  buildFieldMask,
  tableActions,
  projectScopeRow,
  type LiveSchemaShape,
  type ProjectedPolicy,
  type ScopeProjectionInput,
} from "../scopeProjection.js";
import {
  synthesizeAccess,
  tableAccessOf,
  fieldAccessOf,
  contentAccessOf,
} from "../libraryPolicy.js";
import { fieldVisibleInMask, fieldWritableInMask } from "../fieldMask.js";
import { SHAPE } from "./scopeProjectionShape.js";

// ---------- 单元：buildFieldMask ----------

describe("buildFieldMask", () => {
  const live = ["f1", "f2", "f3"];

  it("无配置（undefined/空对象）-> null（宽放行）", () => {
    expect(buildFieldMask("t", live, {})).toBeNull();
    expect(buildFieldMask("t", live, { other: { x: "editable" } })).toBeNull();
    expect(buildFieldMask("t", live, { t: {} })).toBeNull();
  });

  it("editable/visible/hidden 混合", () => {
    const mask = buildFieldMask("t", live, {
      t: { f1: "editable", f2: "visible", f3: "hidden" },
    }) as FieldMask;
    expect(mask.allowFields).toEqual(["f1", "f2"]);
    expect(mask.readOnlyFields).toEqual(["f2"]);
  });

  it("全 hidden -> allowFields:[]（存在显式配置，不返回 null）", () => {
    const mask = buildFieldMask("t", live, {
      t: { f1: "hidden", f2: "hidden", f3: "hidden" },
    }) as FieldMask;
    expect(mask).not.toBeNull();
    expect(mask.allowFields).toEqual([]);
    expect(mask.readOnlyFields).toEqual([]);
  });

  it("忽略不在 liveFieldIds 内的配置键；缺省档位 editable", () => {
    const mask = buildFieldMask("t", live, {
      t: { f2: "hidden", ghost: "hidden" },
    }) as FieldMask;
    expect(mask.allowFields).toEqual(["f1", "f3"]);
  });
});

// ---------- 单元：tableActions ----------

describe("tableActions", () => {
  const base = (over: Partial<ScopeProjectionInput>): ScopeProjectionInput => ({
    roleId: "r1",
    libraryKind: "base",
    libraryId: "b1",
    canManage: 0,
    visible: 0,
    canShare: 0,
    config: "{}",
    ...over,
  });

  it("canManage=1：全权 + comment，manageSchema=true（不看 config）", () => {
    const r = tableActions(base({ canManage: 1 }), "t1");
    expect(r.actions).toEqual(["r", "c", "u", "d", "comment"]);
    expect(r.manageSchema).toBe(true);
  });

  it("visible=1 只读：[r]，无 comment", () => {
    const r = tableActions(base({ visible: 1 }), "t1");
    expect(r.actions).toEqual(["r"]);
    expect(r.manageSchema).toBe(false);
  });

  it("visible=1 + tables.update：r,u,comment", () => {
    const config = JSON.stringify({ tables: { t1: { update: true } } });
    const r = tableActions(base({ visible: 1, config }), "t1");
    expect(r.actions).toEqual(["r", "u", "comment"]);
  });

  it("viewer 无 comment：仅 read=true 不扩 c/u/d 时不给评论", () => {
    const config = JSON.stringify({ tables: { t1: { read: true } } });
    const r = tableActions(base({ visible: 1, config }), "t1");
    expect(r.actions).toEqual(["r"]);
  });

  it("c/u/d 任一为真即给 comment", () => {
    for (const key of ["create", "delete"] as const) {
      const config = JSON.stringify({ tables: { t1: { [key]: true } } });
      const r = tableActions(base({ visible: 1, config }), "t1");
      expect(r.actions).toContain("comment");
    }
  });

  it("visible=0 即使 tables 有增量也空", () => {
    const config = JSON.stringify({ tables: { t1: { create: true, update: true } } });
    const r = tableActions(base({ visible: 0, config }), "t1");
    expect(r.actions).toEqual([]);
  });
});

// ---------- 与第二代逐值对拍 ----------

// 活形状夹具见同目录 scopeProjectionShape.ts（避免跨 .test 文件 import 造成用例重复注册）。

interface ParityCase {
  name: string;
  row: ScopeProjectionInput;
  shape?: LiveSchemaShape;
}

const CASES: ParityCase[] = [
  {
    name: "canManage 全权（字段配置仍生效）",
    row: {
      roleId: "role_full", libraryKind: "base", libraryId: "b1",
      canManage: 1, visible: 1, canShare: 0,
      config: JSON.stringify({ fields: { t1: { f2: "visible", f3: "hidden" } } }),
    },
  },
  {
    name: "纯只读",
    row: {
      roleId: "role_ro", libraryKind: "base", libraryId: "b1",
      canManage: 0, visible: 1, canShare: 0, config: "{}",
    },
  },
  {
    name: "只读 + 逐表增量 + 字段三档（§4.7 语义；条目为 UI 全量形状）",
    row: {
      roleId: "role_mix", libraryKind: "base", libraryId: "b1",
      canManage: 0, visible: 1, canShare: 0,
      config: JSON.stringify({
        tables: { t2: { read: true, create: false, update: true, delete: false } },
        fields: { t2: { fa: "editable", fb: "visible" } },
      }),
    },
  },
  {
    name: "只读 + canShare",
    row: {
      roleId: "role_share", libraryKind: "base", libraryId: "b1",
      canManage: 0, visible: 1, canShare: 1, config: "{}",
    },
  },
  {
    name: "visible=0 且无任何配置：零投影",
    row: {
      roleId: "role_off", libraryKind: "base", libraryId: "b1",
      canManage: 0, visible: 0, canShare: 0, config: "{}",
    },
  },
  {
    name: "kb content 逐表增量（全量条目）",
    row: {
      roleId: "role_kb", libraryKind: "kb", libraryId: "k1",
      canManage: 0, visible: 1, canShare: 0,
      config: JSON.stringify({
        tables: { content: { read: true, create: true, update: true, delete: false } },
      }),
    },
  },
  {
    name: "kb canManage 全权",
    row: {
      roleId: "role_kb_owner", libraryKind: "kb", libraryId: "k2",
      canManage: 1, visible: 1, canShare: 0, config: "{}",
    },
  },
  {
    name: "kb 纯只读",
    row: {
      roleId: "role_kb_ro", libraryKind: "kb", libraryId: "k3",
      canManage: 0, visible: 1, canShare: 0, config: "{}",
    },
  },
  {
    name: "kb visible=0 仅 canShare：零 kb 策略（建链接权另读 legacy canShare）",
    row: {
      roleId: "role_kb_off", libraryKind: "kb", libraryId: "k4",
      canManage: 0, visible: 0, canShare: 1, config: "{}",
    },
  },
];

const byNode = (policies: readonly ProjectedPolicy[]): Map<string, ProjectedPolicy> =>
  new Map(policies.map((p) => [p.nodeId, p]));

const parseMask = (p: ProjectedPolicy | undefined): FieldMask | null =>
  p?.fieldMask ? (JSON.parse(p.fieldMask) as FieldMask) : null;

describe("projectScopeRow ↔ 第二代 libraryPolicy 逐值对拍", () => {
  for (const c of CASES) {
    it(c.name, () => {
      const acc = synthesizeAccess([
        {
          canManage: c.row.canManage,
          visible: c.row.visible,
          canShare: c.row.canShare,
          config: c.row.config,
        },
      ]);
      const projected = projectScopeRow(c.row, c.shape ?? SHAPE);
      const index = byNode(projected);

      if (c.row.libraryKind === "base") {
        for (const t of SHAPE.tableIds) {
          const expected = tableAccessOf(acc, t);
          const policy = index.get(`nav_table_${t}`);
          if (!expected.read && !expected.create && !expected.update && !expected.delete) {
            expect(policy).toBeUndefined();
            continue;
          }
          expect(policy, `缺少表 ${t} 投影`).toBeDefined();
          const acts = parseActionString(policy!.actions);
          expect(acts.includes("r"), `${t}.r`).toBe(expected.read);
          expect(acts.includes("c"), `${t}.c`).toBe(expected.create);
          expect(acts.includes("u"), `${t}.u`).toBe(expected.update);
          expect(acts.includes("d"), `${t}.d`).toBe(expected.delete);
          const expectComment = expected.create || expected.update || expected.delete;
          expect(acts.includes("comment"), `${t}.comment`).toBe(expectComment);
          expect(acts.includes("manage_schema"), `${t}.manage_schema`).toBe(
            c.row.canManage === 1,
          );

          const mask = parseMask(policy);
          for (const f of SHAPE.fieldIdsByTable.get(t) ?? []) {
            const expectVisible = fieldAccessOf(acc, t, f) !== "hidden";
            const expectWritable = fieldAccessOf(acc, t, f) === "editable";
            expect(fieldVisibleInMask(mask, f), `${t}.${f}.visible`).toBe(expectVisible);
            expect(fieldWritableInMask(mask, f), `${t}.${f}.writable`).toBe(expectWritable);
          }
        }

        const libPolicy = index.get(`nav_base_${c.row.libraryId}`);
        const libActs = libPolicy ? parseActionString(libPolicy.actions) : [];
        expect(libActs.includes("manage_table")).toBe(c.row.canManage === 1);
        // manage_share 承载 toggle 总闸，语义=legacy canToggleShare(=canManage)；仅 canShare 不给。
        expect(libActs.includes("manage_share")).toBe(c.row.canManage === 1);
        // 库级聚合位（ADR-0056 §4）：enter ≡ acc.visible‖canManage（不依赖活表）；
        // edit_data ≡ canManage ‖ 任一活表可写（与 guards.ts:66 permit.canEditData 同一口径）。
        const expectEnter = acc.visible || acc.canManage;
        const expectEditData = acc.canManage
          || Object.values(acc.tables).some((t) => t.create || t.update || t.delete);
        expect(libActs.includes("enter")).toBe(expectEnter);
        expect(libActs.includes("edit_data")).toBe(expectEditData);
        expect(libPolicy?.fieldMask ?? null).toBeNull();
      } else {
        const expected = contentAccessOf(acc);
        const policy = index.get(`nav_kb_${c.row.libraryId}`);
        // 仅 canShare（无内容动作、非 canManage）在新口径下不出 kb 策略（建链接权另读 legacy）。
        const hasAny = !!(
          expected.read || expected.create || expected.update || expected.delete
          || c.row.canManage === 1
        );
        if (!hasAny) {
          expect(policy).toBeUndefined();
          return;
        }
        expect(policy, "缺少 kb 节点投影").toBeDefined();
        const acts = parseActionString(policy!.actions);
        expect(acts.includes("r")).toBe(expected.read);
        expect(acts.includes("c")).toBe(expected.create);
        expect(acts.includes("u")).toBe(expected.update);
        expect(acts.includes("d")).toBe(expected.delete);
        expect(acts.includes("comment")).toBe(
          expected.create || expected.update || expected.delete,
        );
        expect(acts.includes("manage_schema")).toBe(false);
        expect(acts.includes("manage_table")).toBe(c.row.canManage === 1);
        // kb manage_share 承载 owner-only rename，语义=canManage；仅 canShare 不给（legacy rename 亦拒）。
        expect(acts.includes("manage_share")).toBe(c.row.canManage === 1);
        expect(policy!.fieldMask).toBeNull();
      }
    });
  }
});

// 库级聚合位 enter / edit_data 的专项反证另立 spec：
// __tests__/scopeProjectionAggregate.test.ts（本文件已达单文件 ≤300 行上限）。
