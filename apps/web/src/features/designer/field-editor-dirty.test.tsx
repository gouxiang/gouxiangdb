// apps/web/src/features/designer/field-editor-dirty.test.tsx
// F-01 回归：字段编辑器脏检查纯逻辑 + 提交分支源码锁定。
// 运行环境为 node（仓库无 jsdom），组件行为用「纯逻辑单测 + 源码断言」双层锁定；
// 真机 E2E（VM 192.168.31.167，独立账号/库）已人工复验：
//   - 新建模式选「查阅」保存 → POST /api/fields 成功建出 lookup 字段（修复前同版本可复现）；
//   - 编辑模式无修改点保存 → 修复前发 no-op PATCH 到 link 字段并提示已保存（即走查 F-01 现象）。

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FieldDTO, FieldIdT, TableIdT } from "@gx/shared-types";
import { draftFromField, emptyDraft, isDirty, stableStringify } from "./field-editor-dirty";

function mkField(patch: Partial<FieldDTO> = {}): FieldDTO {
  return {
    id: "f1" as FieldIdT,
    tableId: "t1" as TableIdT,
    name: "客户",
    type: "links",
    description: "",
    order: 1,
    required: false,
    unique: false,
    options: null,
    precision: null,
    linkFieldId: "rev1" as FieldIdT,
    relatedTableId: "t2" as TableIdT,
    relationKind: "mm",
    isReverse: false,
    reverseFieldId: null,
    linkDisplayFieldId: null,
    lookupFieldId: null,
    rollupFunction: null,
    recordFilter: null,
    formula: null,
    tabsConfig: null,
    displayedFieldIds: null,
    visibleFieldIds: null,
    defaultConfig: null,
    numberRule: null,
    ...patch,
  };
}

/** 新建模式下的初始草稿（与编辑器各 state 初值一致）。 */
function freshCreateDraft(): ReturnType<typeof emptyDraft> {
  return emptyDraft();
}

describe("isDirty：新建模式基线", () => {
  it("刚打开新建弹窗、什么都没填 → 不算脏（切换目标不弹确认）", () => {
    expect(isDirty(freshCreateDraft(), emptyDraft())).toBe(false);
  });

  it("选了「查阅」+ 关联字段 + 子字段（走查 F-01 的配置）→ 算脏，切换必须被拦下确认", () => {
    const draft = {
      ...freshCreateDraft(),
      name: "查阅等级",
      type: "lookup" as const,
      linkFieldId: "link-1",
      subFieldId: "sub-9",
    };
    expect(isDirty(draft, emptyDraft())).toBe(true);
  });

  it("只改了字段名 → 算脏；只输了空格名 → 不算脏（与保存口径一致按 trim 比较）", () => {
    expect(isDirty({ ...freshCreateDraft(), name: "x" }, emptyDraft())).toBe(true);
    expect(isDirty({ ...freshCreateDraft(), name: "   " }, emptyDraft())).toBe(false);
  });
});

describe("isDirty：编辑模式基线", () => {
  const base = draftFromField(mkField());

  it("什么都没改 → 不算脏（保存走「没有修改」分支，不再发 no-op PATCH 假装成功）", () => {
    const draft = { ...base };
    expect(isDirty(draft, base)).toBe(false);
  });

  it("重命名 / 换查阅子字段 / 清空关联表（空串 ↔ null 等价）→ 都算脏", () => {
    expect(isDirty({ ...base, name: "大客户" }, base)).toBe(true);
    expect(isDirty({ ...base, subFieldId: "sub-1" }, base)).toBe(true);
    // "" 与 null 归一等价：未设关联表的字段上，空串不算改动
    const noRel = draftFromField(mkField({ relatedTableId: null, linkFieldId: null }));
    expect(isDirty({ ...noRel, relTableId: "" }, noRel)).toBe(false);
    expect(isDirty({ ...noRel, relTableId: "t3" }, noRel)).toBe(true);
    expect(isDirty({ ...base, relTableId: "" }, base)).toBe(true);
  });

  it("对象/数组配置键序无关：filter/defaultConfig 键序打乱不算脏，内容变了才算脏", () => {
    const withFilter = mkField({
      recordFilter: { op: "and", children: [{ fieldId: "a", op: "is", value: "1" }] } as never,
    });
    const baseline = draftFromField(withFilter);
    const sameFilterReordered = {
      op: "and",
      children: [{ value: "1", op: "is", fieldId: "a" }],
    };
    expect(
      isDirty({ ...baseline, recordFilter: sameFilterReordered as never }, baseline),
    ).toBe(false);
    expect(
      isDirty({ ...baseline, recordFilter: { op: "and", children: [] } as never }, baseline),
    ).toBe(true);
  });

  it("defaultNow 后端有值但 FieldDTO 未声明 → 投影仍能读到，改勾选算脏", () => {
    const f = mkField() as FieldDTO & { defaultNow?: boolean };
    f.defaultNow = true;
    const baseline = draftFromField(f);
    expect(isDirty({ ...baseline, defaultNow: false }, baseline)).toBe(true);
    expect(isDirty({ ...baseline }, baseline)).toBe(false);
  });
});

describe("stableStringify", () => {
  it("键序无关、数组有序、原始值直出", () => {
    expect(stableStringify({ b: 1, a: [2, { y: 1, x: 2 }] })).toBe(
      stableStringify({ a: [2, { x: 2, y: 1 }], b: 1 }),
    );
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
    expect(stableStringify(null)).toBe("null");
  });
});

describe("源码回归：新建走 POST、编辑脏检查、切换确认（F-01）", () => {
  const src = readFileSync(join(__dirname, "FieldEditorSheet.tsx"), "utf8");

  it("handleSave 仍是「新建 → createField(POST)、编辑 → updateField(PATCH)」的分支顺序", () => {
    const iCreate = src.indexOf("m.createField.mutateAsync");
    const iUpdate = src.indexOf("m.updateField.mutateAsync");
    expect(iCreate).toBeGreaterThan(-1);
    expect(iUpdate).toBeGreaterThan(iCreate);
    // 新建分支必须由 isNew 把守（保证查阅等类型的新建真的发 POST /api/fields）
    const iGate = src.indexOf("if (isNew) {", Math.max(0, src.indexOf("const handleSave")));
    expect(iGate).toBeGreaterThan(-1);
    expect(iGate).toBeLessThan(iCreate);
  });

  it("编辑模式无修改 → 提示「没有修改，无需保存」并直接返回（不再发 no-op PATCH）", () => {
    const iGuard = src.indexOf("没有修改，无需保存");
    expect(iGuard).toBeGreaterThan(-1);
    const iSave = src.indexOf("const handleSave");
    expect(iGuard).toBeGreaterThan(iSave);
    // 守卫必须在 try（真正发请求）之前
    const iTry = src.indexOf("try {", iSave);
    expect(iGuard).toBeLessThan(iTry);
  });

  it("弹窗内切换目标字段（新建 ↔ 编辑现有字段）有脏检查 + 放弃确认", () => {
    expect(src).toContain("handleSwitchTarget");
    expect(src).toContain("confirmDiscardChanges");
    // 顶 Select 的 onChange 必须走守卫，而不是直接 setManagedFieldId
    const iSelect = src.indexOf('value={managedFieldId ?? ""}');
    const iWired = src.indexOf("void handleSwitchTarget(", iSelect);
    expect(iWired).toBeGreaterThan(-1);
  });

  it("查阅/聚合/计数的 payload 仍带上 linkFieldId / lookupFieldId（新建 POST 的配置不丢）", () => {
    expect(src).toContain("data.linkFieldId = idOrNull(linkFieldId)");
    expect(src).toContain("data.lookupFieldId = idOrNull(subFieldId)");
  });
});
