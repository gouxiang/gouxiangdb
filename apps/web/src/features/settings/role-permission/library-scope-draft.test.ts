// apps/web/src/features/settings/role-permission/library-scope-draft.test.ts
// 库权限草稿的纯函数回归：这份转换是「整份替换」写语义的落点，
// 漏一条库 = 撤销一次授权，是整块功能里最贵的一类静默错误。

import { describe, it, expect } from "vitest";
import type { RoleLibraryScopeDTO } from "@gx/shared-types";
import { KB_CONTENT_KEY, READONLY_TABLE_ACCESS } from "@gx/shared-types";
import {
  draftFromScopes,
  draftToItems,
  setFieldAccess,
  setTableAction,
  toggleTable,
  type ScopeConfigDraft,
} from "./library-scope-draft";

function scope(over: Partial<RoleLibraryScopeDTO>): RoleLibraryScopeDTO {
  return {
    id: "s1",
    roleId: "r1",
    libraryKind: "base",
    libraryId: "b1",
    libraryName: "库A",
    canManage: false,
    visible: false,
    canShare: false,
    tables: {},
    fields: {},
    updatedAt: "2026-09-21T00:00:00.000Z",
    ...over,
  };
}

describe("draftFromScopes → draftToItems", () => {
  it("可管理隐含可见：后端 visible=false 且 canManage=true 时人进不去这个库", () => {
    const items = draftToItems(draftFromScopes([scope({ canManage: true, visible: false })]));
    expect(items).toHaveLength(1);
    expect(items[0]!.canManage).toBe(true);
    expect(items[0]!.visible).toBe(true);
  });

  it("没出现在草稿里的库不进 items —— 整份替换下这就是一次撤销", () => {
    const draft = draftFromScopes([
      scope({ libraryId: "b1", visible: true }),
      scope({ id: "s2", libraryId: "b2", visible: true }),
    ]);
    draft.visible.delete("base:b2");
    const items = draftToItems(draft);
    expect(items.map((i) => i.libraryId)).toEqual(["b1"]);
  });

  it("勾了库但没做逐表设置 → 不写逐表条目（后端按「可见即只读」回退）", () => {
    const items = draftToItems(draftFromScopes([scope({ visible: true })]));
    expect(items[0]!.config?.tables).toEqual({});
    expect(items[0]!.config?.fields).toEqual({});
  });
});

describe("canShare 显式分享位", () => {
  it("DTO 带 canShare 进草稿：显式分享位独立于可管理", () => {
    const draft = draftFromScopes([scope({ visible: true, canShare: true, canManage: false })]);
    expect(draft.share.has("base:b1")).toBe(true);
    expect(draft.manage.has("base:b1")).toBe(false);
  });

  it("草稿出 PUT 入参带 canShare，与 DTO 一对一回写", () => {
    const items = draftToItems(
      draftFromScopes([scope({ visible: true, canShare: true, canManage: false })]),
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.canShare).toBe(true);
  });

  it("可管理隐含可见仍成立；canManage 不带 canShare 时分享位不被凭空写上", () => {
    const items = draftToItems(
      draftFromScopes([scope({ canManage: true, visible: false, canShare: false })]),
    );
    expect(items[0]!.canManage).toBe(true);
    expect(items[0]!.visible).toBe(true);
    expect(items[0]!.canShare).toBe(false);
  });

  it("只显式勾了可分享的库也会输出——整份替换下不能静默丢掉这次授权", () => {
    const draft = draftFromScopes(
      [scope({ visible: false, canManage: false, canShare: true })],
    );
    const items = draftToItems(draft);
    expect(items).toHaveLength(1);
    expect(items[0]!.canShare).toBe(true);
    expect(items[0]!.visible).toBe(false);
  });

  it("三份集合都没提过的库不输出（真·撤销）", () => {
    const draft = draftFromScopes([
      scope({ libraryId: "b1", visible: true }),
      scope({ id: "s2", libraryId: "b2", visible: true, canShare: true }),
    ]);
    draft.visible.delete("base:b1");
    const items = draftToItems(draft);
    expect(items.map((i) => i.libraryId)).toEqual(["b2"]);
  });
});

describe("逐表 / 逐字段编辑", () => {
  it("勾上一张表默认只读可见：能看，不能增改删", () => {
    const cfg = toggleTable({ tables: {}, fields: {} }, "t1", true);
    expect(cfg.tables.t1).toEqual(READONLY_TABLE_ACCESS);
    expect(cfg.tables.t1!.create).toBe(false);
    expect(cfg.tables.t1!.update).toBe(false);
    expect(cfg.tables.t1!.delete).toBe(false);
  });

  it("取消勾选某张表时，它的字段权限一并清掉，不留读不到的配置", () => {
    let cfg: ScopeConfigDraft = toggleTable({ tables: {}, fields: {} }, "t1", true);
    cfg = setFieldAccess(cfg, "t1", "f1", "hidden");
    expect(cfg.fields.t1).toEqual({ f1: "hidden" });
    cfg = toggleTable(cfg, "t1", false);
    expect(cfg.tables.t1).toBeUndefined();
    expect(cfg.fields.t1).toBeUndefined();
  });

  it("改一枚数据动作不动其他三枚", () => {
    let cfg: ScopeConfigDraft = toggleTable({ tables: {}, fields: {} }, "t1", true);
    cfg = setTableAction(cfg, "t1", "update", true);
    expect(cfg.tables.t1).toEqual({ read: true, create: false, update: true, delete: false });
  });

  it("知识库用 content 这个 key，与后端 KB_CONTENT_KEY 同源", () => {
    const cfg = toggleTable({ tables: {}, fields: {} }, KB_CONTENT_KEY, true);
    expect(Object.keys(cfg.tables)).toEqual([KB_CONTENT_KEY]);
  });
});
