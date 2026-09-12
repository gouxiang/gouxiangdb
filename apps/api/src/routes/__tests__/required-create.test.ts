// apps/api/src/routes/__tests__/required-create.test.ts
// 创建期必填兜底校验 assertRequiredOnCreate
// 回归：applyFieldWrites 只遍历 payload 中出现的字段，整条必填字段被【省略】时
// 校验被完全绕过（缺必填记录 201 落库）。assertRequiredOnCreate 对全表 required 兜底。

import { describe, it, expect } from "vitest";
import { assertRequiredOnCreate } from "../records.js";
import type { FieldMeta } from "../../domain/types.js";

function field(partial: Partial<FieldMeta> & Pick<FieldMeta, "id" | "name" | "type">): FieldMeta {
  return {
    order: 0,
    required: false,
    unique: false,
    options: null,
    precision: null,
    linkFieldId: null,
    relatedTableId: null,
    relationKind: null,
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
    description: "",
    ...partial,
  } as FieldMeta;
}

const reqText = (id: string, extra: Partial<FieldMeta> = {}) =>
  field({ id, name: id, type: "singleLineText", required: true, ...extra });

describe("assertRequiredOnCreate", () => {
  it("省略必填字段时拒绝", async () => {
    await expect(
      assertRequiredOnCreate([reqText("F_req")], { F_other: "x" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("必填字段显式空串 / null / 空数组时拒绝", async () => {
    const fields = [reqText("F_req")];
    await expect(assertRequiredOnCreate(fields, { F_req: "" })).rejects.toMatchObject({ status: 400 });
    await expect(assertRequiredOnCreate(fields, { F_req: null })).rejects.toMatchObject({ status: 400 });
    await expect(assertRequiredOnCreate(fields, { F_req: [] })).rejects.toMatchObject({ status: 400 });
  });

  it("必填字段给了非空值时通过", async () => {
    await expect(assertRequiredOnCreate([reqText("F_req")], { F_req: "ok" })).resolves.toBeUndefined();
  });

  it("非必填字段省略时通过", async () => {
    await expect(
      assertRequiredOnCreate([field({ id: "F_opt", name: "F_opt", type: "singleLineText" })], {}),
    ).resolves.toBeUndefined();
  });

  it("必填 + 非空 static 默认值：省略也通过（创建后自动填）", async () => {
    const f = reqText("F_reqstatic", { defaultConfig: { mode: "static", value: "默认X" } });
    await expect(assertRequiredOnCreate([f], {})).resolves.toBeUndefined();
  });

  it("必填 + 空串 static 默认值：省略仍拒绝", async () => {
    const f = reqText("F_reqempty", { defaultConfig: { mode: "static", value: "" } });
    await expect(assertRequiredOnCreate([f], {})).rejects.toMatchObject({ status: 400 });
  });

  it("必填 autoNumber 带非空编号规则：省略通过", async () => {
    const f = field({
      id: "F_auto",
      name: "F_auto",
      type: "autoNumber",
      required: true,
      numberRule: { segments: [{ type: "fixed", text: "ORD-" }, { type: "counter", digits: 4, reset: "never" }] },
    });
    await expect(assertRequiredOnCreate([f], {})).resolves.toBeUndefined();
  });

  it("必填 autoNumber 无编号规则：省略拒绝（不会被自动编号）", async () => {
    const f = field({ id: "F_auto2", name: "F_auto2", type: "autoNumber", required: true });
    await expect(assertRequiredOnCreate([f], {})).rejects.toMatchObject({ status: 400 });
  });

  it("计算字段 / 系统字段即使 required 也不参与创建期校验", async () => {
    const formula = field({ id: "F_formula", name: "F_formula", type: "formula", required: true, formula: "{x}" });
    const sys = field({ id: "F_ct", name: "F_ct", type: "createdTime", required: true });
    await expect(assertRequiredOnCreate([formula, sys], {})).resolves.toBeUndefined();
  });

  it("多个必填字段，第一个缺失即报错且消息含字段名", async () => {
    const f1 = reqText("F_a");
    const f2 = reqText("F_b");
    await expect(assertRequiredOnCreate([f1, f2], { F_b: "v" })).rejects.toThrow("F_a");
  });
});
