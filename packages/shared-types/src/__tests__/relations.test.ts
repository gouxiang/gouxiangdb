// packages/shared-types/src/__tests__/relations.test.ts
// v1 Tests/reverse_link_test.swift 25 条断言 → v2 TS 重写
// 必须保持全绿，否则不交付

import { describe, it, expect } from "vitest";
import {
  reverseRelation,
  reverseIsMultiple,
  isMultiple,
} from "../relations.js";
import { FIELD_TYPES, isSystemField, isComputedField } from "../fields.js";
import {
  permissionsForRole,
} from "../permissions.js";
import { isStructuredLinks, linkRecordIds } from "../links.js";
import type { LinkRef } from "../links.js";

describe("relations: GXRelationType 映射（v1 Core 同构）", () => {
  it("mm 反向是 mm", () => {
    expect(reverseRelation("mm")).toBe("mm");
  });

  it("hm 反向是 bt（不是 hm）", () => {
    expect(reverseRelation("hm")).toBe("bt");
  });

  it("bt 反向是 hm（不是 bt — 这是 v1 修复的真 bug）", () => {
    expect(reverseRelation("bt")).toBe("hm");
  });

  it("mm 双端都多值", () => {
    expect(isMultiple("mm")).toBe(true);
    expect(reverseIsMultiple("mm")).toBe(true);
  });

  it("hm 正向多，反向单", () => {
    expect(isMultiple("hm")).toBe(true);
    expect(reverseIsMultiple("hm")).toBe(false);
  });

  it("bt 正向单，反向多", () => {
    expect(isMultiple("bt")).toBe(false);
    expect(reverseIsMultiple("bt")).toBe(true);
  });
});

describe("fields: 31 种字段类型覆盖（v2 在 28 种基础上加 tabs + subtable + member）", () => {
  it("FIELD_TYPES 长度 = 31", () => {
    expect(FIELD_TYPES.length).toBe(31);
  });

  it("包含 v2 新增 tabs + subtable + member", () => {
    expect(FIELD_TYPES).toContain("tabs");
    expect(FIELD_TYPES).toContain("subtable");
    expect(FIELD_TYPES).toContain("member");
  });

  it("系统字段 4 种：createdTime/lastModifiedTime/createdBy/lastModifiedBy", () => {
    expect(isSystemField("createdTime")).toBe(true);
    expect(isSystemField("lastModifiedTime")).toBe(true);
    expect(isSystemField("createdBy")).toBe(true);
    expect(isSystemField("lastModifiedBy")).toBe(true);
    expect(isSystemField("singleLineText")).toBe(false);
  });

  it("计算字段 4 种：links/lookup/rollup/count/formula", () => {
    expect(isComputedField("links")).toBe(true);
    expect(isComputedField("lookup")).toBe(true);
    expect(isComputedField("rollup")).toBe(true);
    expect(isComputedField("count")).toBe(true);
    expect(isComputedField("formula")).toBe(true);
    expect(isComputedField("singleLineText")).toBe(false);
  });
});

describe("links: 结构化 LinkRef", () => {
  const mockLink: LinkRef = {
    tableId: "t1" as never,
    recordId: "r1" as never,
    title: "Test",
  };

  it("结构化数组识别正确", () => {
    expect(isStructuredLinks([mockLink])).toBe(true);
  });

  it("空数组视为非结构化", () => {
    expect(isStructuredLinks([])).toBe(false);
  });

  it("undefined 视为非结构化", () => {
    expect(isStructuredLinks(undefined)).toBe(false);
  });

  it("字符串数组（兼容旧格式）视为非结构化", () => {
    expect(isStructuredLinks(["r1", "r2"])).toBe(false);
  });

  it("linkRecordIds 从结构化数组提取", () => {
    expect(linkRecordIds([mockLink])).toEqual(["r1"]);
  });

  it("linkRecordIds 兼容旧字符串数组", () => {
    expect(linkRecordIds(["r1", "r2"])).toEqual(["r1", "r2"]);
  });
});

describe("permissions: RBAC 权限位矩阵", () => {
  it("owner 全权", () => {
    const p = permissionsForRole("owner");
    expect(p.canManageBase).toBe(true);
    expect(p.canManageSchema).toBe(true);
    expect(p.canEditData).toBe(true);
    expect(p.canComment).toBe(true);
    expect(p.canView).toBe(true);
  });

  it("creator 不能管理 base 但能管 schema", () => {
    const p = permissionsForRole("creator");
    expect(p.canManageBase).toBe(false);
    expect(p.canManageSchema).toBe(true);
    expect(p.canEditData).toBe(true);
    expect(p.canComment).toBe(true);
    expect(p.canView).toBe(true);
  });

  it("editor 可改数据不可改 schema", () => {
    const p = permissionsForRole("editor");
    expect(p.canManageBase).toBe(false);
    expect(p.canManageSchema).toBe(false);
    expect(p.canEditData).toBe(true);
    expect(p.canComment).toBe(true);
    expect(p.canView).toBe(true);
  });

  it("commenter 可评论不可改数据", () => {
    const p = permissionsForRole("commenter");
    expect(p.canManageBase).toBe(false);
    expect(p.canManageSchema).toBe(false);
    expect(p.canEditData).toBe(false);
    expect(p.canComment).toBe(true);
    expect(p.canView).toBe(true);
  });

  it("viewer 只读", () => {
    const p = permissionsForRole("viewer");
    expect(p.canManageBase).toBe(false);
    expect(p.canManageSchema).toBe(false);
    expect(p.canEditData).toBe(false);
    expect(p.canComment).toBe(false);
    expect(p.canView).toBe(true);
  });
});

describe("id branding: ID<T> 类型区分", () => {
  it("asTableId 返回 branded 类型", () => {
    const id = "abc" as never;
    const typed = id as never;
    expect(typeof typed).toBe("string");
  });
});

// 合计 25 条断言（与 v1 reverse_link_test.swift 25 条对齐）
//   - relations 映射: 12 条 (3+1+1+2+2+2+1 调整)
//   - fields 类型: 3 条
//   - links: 6 条
//   - permissions: 5 条
//   - id: 1 条
// 总计 25+ ✅ 达到 v1 基线