// P1/S4 projectImplicitAdmin 端到端对拍（纯单测，不查库）：
// 以第二代 libraryPolicy 的 synthesizeAccess + admin 覆盖 + tableAccessOf/fieldAccessOf 为 oracle，
// 逐表/逐字段/库节点比对管理员隐含投影。覆盖边角：visible=0 + tables{T1:{create:true}} -> 能建不能读。

import { describe, expect, it } from "vitest";
import { parseActionString, type FieldMask, type ResourceAction } from "@gx/shared-types";
import {
  projectImplicitAdmin,
} from "../implicitAdminProject.js";
import type {
  LiveSchemaShape,
  ScopeProjectionInput,
} from "../scopeProjection.js";
import {
  synthesizeAccess,
  tableAccessOf,
  fieldAccessOf,
} from "../libraryPolicy.js";

const SHAPE: LiveSchemaShape = {
  tableIds: ["t1", "t2"],
  fieldIdsByTable: new Map([
    ["t1", ["f1", "f2", "f3"]],
    ["t2", ["fa", "fb"]],
  ]),
};

const adminRow = (
  libraryId: string, over: Partial<ScopeProjectionInput> = {},
  libraryKind: "base" | "kb" = "base",
): ScopeProjectionInput => ({
  roleId: "role_admin", libraryKind, libraryId,
  canManage: 0, visible: 0, canShare: 0, config: "{}", ...over,
});

/** oracle：第二代 resolve 的管理员分支 = synthesize 后强制 visible/canShare。 */
function oracleOf(rows: ScopeProjectionInput[]) {
  const dto = synthesizeAccess(
    rows.map((r) => ({
      canManage: r.canManage, visible: r.visible, canShare: r.canShare, config: r.config,
    })),
  );
  return { ...dto, visible: true, canToggleShare: true, canShare: true };
}

const expectedMaskFor = (
  oracle: ReturnType<typeof oracleOf>, tableId: string,
  liveFieldIds: readonly string[],
): FieldMask | null => {
  const allowFields: string[] = [];
  const readOnlyFields: string[] = [];
  for (const f of liveFieldIds) {
    const mode = fieldAccessOf(oracle, tableId, f);
    if (mode === "hidden") continue;
    allowFields.push(f);
    if (mode === "visible") readOnlyFields.push(f);
  }
  // 与 buildFieldMask 口径一致：仅当 config.fields[tableId] 含至少一个字段键才非 null。
  const configured = Object.keys(oracle.fields[tableId] ?? {}).length > 0;
  if (!configured) return null;
  return { allowFields, readOnlyFields };
};

const CASES: Array<{ name: string; rows: ScopeProjectionInput[] }> = [
  {
    name: "无任何 scope 行：默认只读 + 仅 manage_share",
    rows: [],
  },
  {
    name: "visible=1：只读",
    rows: [adminRow("b1", { visible: 1 })],
  },
  {
    name: "canManage=1：全权 + 管理位",
    rows: [adminRow("b1", { canManage: 1, visible: 1 })],
  },
  {
    name: "canShare=1（不含管理权）",
    rows: [adminRow("b1", { visible: 1, canShare: 1 })],
  },
  {
    name: "★边角：visible=0 + tables.t1.create：T1 能建不能读，T2 只读",
    rows: [
      adminRow("b1", { config: JSON.stringify({ tables: { t1: { create: true } } }) }),
    ],
  },
  {
    name: "逐表全档位 + 字段三档",
    rows: [
      adminRow("b1", {
        visible: 1,
        config: JSON.stringify({
          tables: { t2: { read: true, create: true, update: false, delete: true } },
          fields: { t2: { fa: "visible", fb: "hidden" } },
        }),
      }),
    ],
  },
  {
    name: "canManage 下字段仍收窄（admin 不改 fields）",
    rows: [
      adminRow("b1", {
        canManage: 1, visible: 1,
        config: JSON.stringify({ fields: { t1: { f2: "visible", f3: "hidden" } } }),
      }),
    ],
  },
];

describe("projectImplicitAdmin ↔ 第二代 admin oracle 对拍（base）", () => {
  for (const c of CASES) {
    it(c.name, () => {
      const oracle = oracleOf(c.rows);
      const policies = projectImplicitAdmin({
        bases: [{ libraryId: "b1", shape: SHAPE }],
        kbs: [],
        adminScopeRows: c.rows,
      });
      const byNode = new Map(policies.map((p) => [p.nodeId, p]));

      for (const tableId of SHAPE.tableIds) {
        const ta = tableAccessOf(oracle, tableId);
        const expected: ResourceAction[] = [];
        if (ta.read) expected.push("r");
        if (ta.create) expected.push("c");
        if (ta.update) expected.push("u");
        if (ta.delete) expected.push("d");
        if (ta.create || ta.update || ta.delete) expected.push("comment");
        if (oracle.canManage) expected.push("manage_schema");

        const policy = byNode.get(`nav_table_${tableId}`);
        if (expected.length === 0) {
          expect(policy, `${tableId} 应无行`).toBeUndefined();
          continue;
        }
        expect(policy, `${tableId} 缺行`).toBeDefined();
        expect(parseActionString(policy!.actions).sort()).toEqual([...expected].sort());
        const liveFieldIds = SHAPE.fieldIdsByTable.get(tableId) ?? [];
        const expectMask = expectedMaskFor(oracle, tableId, liveFieldIds);
        expect(policy!.fieldMask).toEqual(expectMask ? JSON.stringify(expectMask) : null);
      }

      const lib = byNode.get("nav_base_b1");
      expect(lib).toBeDefined();
      const libActs = parseActionString(lib!.actions);
      expect(libActs.includes("manage_share")).toBe(true); // admin canShare 恒真
      expect(libActs.includes("manage_table")).toBe(oracle.canManage);
      // 库级聚合位（ADR-0056 §4）：enter 恒真——admin 覆盖强制 visible=true（F8）；
      // edit_data 对齐 legacy canEditData = canManage ‖ 任一活表可写（guards.ts:66）。
      expect(libActs.includes("enter")).toBe(true);
      const oracleCanEditData = oracle.canManage
        || Object.values(oracle.tables).some((t) => t.create || t.update || t.delete);
      expect(libActs.includes("edit_data")).toBe(oracleCanEditData);
      // F6 不变量（永不退化）：base 节点【不得出现 r】——一旦出现即说明有人退回
      // 「库节点补 r」的错修法，会经 fieldMask 并集淹没逐表收窄（见 §6.2）。
      expect(libActs.includes("r")).toBe(false);
      expect(lib!.fieldMask).toBeNull();

      // 永不投影超级管理员，永不出现删库语义（动作枚举内无删库位，仅核 subjectId）。
      expect(policies.every((p) => p.subjectId !== "role_owner")).toBe(true);
      expect(policies.every((p) => p.reason === "scope:role")).toBe(true);
    });
  }

  it("★边角坐实：t1 行动作恰为 c,comment 且无 r；t2 为 r", () => {
    const rows = [adminRow("b1", { config: JSON.stringify({ tables: { t1: { create: true } } }) })];
    const policies = projectImplicitAdmin({
      bases: [{ libraryId: "b1", shape: SHAPE }], kbs: [], adminScopeRows: rows,
    });
    const t1 = policies.find((p) => p.nodeId === "nav_table_t1")!;
    expect(parseActionString(t1.actions)).toEqual(["c", "comment"]);
    const t2 = policies.find((p) => p.nodeId === "nav_table_t2")!;
    expect(parseActionString(t2.actions)).toEqual(["r"]);
  });
});

describe("projectImplicitAdmin ↔ oracle 对拍（kb）", () => {
  const KB_CASES: Array<{ name: string; rows: ScopeProjectionInput[] }> = [
    { name: "无 scope 行：content 只读 + manage_share", rows: [] },
    {
      name: "content 增量 create/update",
      rows: [
        adminRow("k1", {
          visible: 1,
          config: JSON.stringify({ tables: { content: { create: true, update: true } } }),
        }, "kb"),
      ],
    },
    {
      name: "canManage：content 全权 + manage_table",
      rows: [adminRow("k1", { canManage: 1, visible: 1 }, "kb")],
    },
  ];

  for (const c of KB_CASES) {
    it(c.name, () => {
      const oracle = oracleOf(c.rows);
      const policies = projectImplicitAdmin({
        bases: [],
        kbs: [{ libraryId: "k1" }],
        adminScopeRows: c.rows,
      });
      expect(policies).toHaveLength(1);
      const policy = policies[0]!;
      expect(policy.nodeId).toBe("nav_kb_k1");
      expect(policy.fieldMask).toBeNull();

      const ta = tableAccessOf(oracle, "content");
      const expected: ResourceAction[] = ["manage_share"];
      expected.push("enter"); // admin 覆盖强制 visible=true；kb 不 emit edit_data（§7.2-3）
      if (ta.read) expected.push("r");
      if (ta.create) expected.push("c");
      if (ta.update) expected.push("u");
      if (ta.delete) expected.push("d");
      if (ta.create || ta.update || ta.delete) expected.push("comment");
      if (oracle.canManage) expected.push("manage_table");
      // 建链位 share_link：admin 覆盖强制 canShare=true，故每个 kb 用例都应投影
      // （与普通角色 projectKb 同口径；与 manage_share 总闸分离）。
      expected.push("share_link");
      expect(parseActionString(policy.actions).sort()).toEqual([...expected].sort());
      const acts = parseActionString(policy.actions);
      expect(acts.includes("share_link")).toBe(true);
      expect(policy.subjectId).toBe("role_admin");
    });
  }
});
