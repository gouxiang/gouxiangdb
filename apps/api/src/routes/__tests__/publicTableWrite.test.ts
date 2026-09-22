// apps/api/src/routes/__tests__/publicTableWrite.test.ts
// HTTP 层（Hono 直调，无真实 SQLite）验证外部写入的三道闸：
//   ① 分享人被降权 -> 曾可编辑的链接当次写被拒（不是残留写权限）；
//   ② 分享人仍有编辑权、但目标字段对他是隐藏/仅可见 -> 字段闸拒写；
//   ③ 表级「允许分享」开关关掉 -> 链接当次失效。

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LibraryAccessDTO } from "@gx/shared-types";

const state = {
  /** 分享人此刻对该表的四枚动作。 */
  table: { read: true, create: true, update: true, delete: true },
  /** 字段权限：f-hidden 隐藏、f-ro 仅可见。 */
  fields: { "f-ok": "editable", "f-ro": "visible", "f-hidden": "hidden" } as Record<string, string>,
  shareAllowed: true,
  visible: true,
};

vi.mock("../../db.js", () => ({
  prisma: {
    shareLink: {
      findUnique: () => Promise.resolve({
        id: "l1", token: "tok", objectType: "table", objectId: "t1", baseId: "b1",
        viewId: null, mode: "edit", createdBy: "u1", role: "viewer", expiresAt: null,
        createdAt: new Date("2026-09-20T00:00:00.000Z"),
      }),
    },
    table: {
      findFirst: () => Promise.resolve({
        id: "t1", name: "测试表", icon: null, iconColor: null, primaryFieldId: "f-ok",
        baseId: "b1", base: { name: "测试库" },
      }),
    },
    field: {
      findMany: () => Promise.resolve([
        { id: "f-ok", tableId: "t1", name: "可编辑", type: "text", description: "", order: 0, required: false, unique: false,
          options: null, precision: null, maxLength: null, defaultNow: false, linkFieldId: null, relatedTableId: null,
          relationKind: null, isReverse: false, reverseFieldId: null, linkDisplayFieldId: null, lookupFieldId: null,
          rollupFunction: null, formula: null, recordFilter: null, tabsConfig: null, displayedFieldIds: null,
          visibleFieldIds: null, defaultConfig: null, numberRule: null },
        { id: "f-hidden", tableId: "t1", name: "隐藏字段", type: "text", description: "", order: 1, required: false, unique: false,
          options: null, precision: null, maxLength: null, defaultNow: false, linkFieldId: null, relatedTableId: null,
          relationKind: null, isReverse: false, reverseFieldId: null, linkDisplayFieldId: null, lookupFieldId: null,
          rollupFunction: null, formula: null, recordFilter: null, tabsConfig: null, displayedFieldIds: null,
          visibleFieldIds: null, defaultConfig: null, numberRule: null },
      ]),
    },
    view: { findFirst: () => Promise.resolve(null) },
  },
  withWriteTx: (_label: string, fn: (tx: unknown) => unknown) => Promise.resolve(fn({})),
}));

vi.mock("../../domain/authz/libraryPolicy.js", () => ({
  resolveBaseAccessByTable: () => Promise.resolve({
    visible: state.visible,
    canManage: false,
    canDeleteLibrary: false,
    canToggleShare: false,
    canShare: false,
    source: "role_scope",
    tables: { t1: state.table },
    fields: { t1: state.fields },
  } as unknown as LibraryAccessDTO),
  tableAccessOf: (access: LibraryAccessDTO, tableId: string) =>
    access.tables[tableId] ?? (access.visible
      ? { read: true, create: false, update: false, delete: false }
      : { read: false, create: false, update: false, delete: false }),
  fieldAccessOf: (_access: LibraryAccessDTO, _tableId: string, fieldId: string) => state.fields[fieldId] ?? "editable",
}));

vi.mock("../../domain/authz/libraryVisibility.js", () => ({
  tableShareAllowed: () => Promise.resolve(state.shareAllowed),
  readShareEnabled: () => Promise.resolve(true),
}));

const { pub } = await import("../public.js");

beforeEach(() => {
  state.table = { read: true, create: true, update: true, delete: true };
  state.fields = { "f-ok": "editable", "f-ro": "visible", "f-hidden": "hidden" };
  state.shareAllowed = true;
  state.visible = true;
});

async function post(fields: Record<string, unknown>) {
  const res = await pub.request("/s/tok/records", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as { error?: string; mode?: string } };
}

describe("外部写入的运行时闸", () => {
  it("★分享人被降权后，原本可编辑的链接写入被拒（自动降级为只读）", async () => {
    state.table = { read: true, create: false, update: false, delete: false };
    const r = await post({ "f-ok": "x" });
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("只读");
  });

  it("分享人有编辑权 + 字段可编辑 -> 两道闸都放行（错误只可能来自后续事务体，不是权限）", async () => {
    const r = await post({ "f-ok": "x" });
    // fake tx 里没有 record.create，写会炸在事务体；只要不是权限类拒绝，就证明闸放行了。
    expect(r.body.error ?? "").not.toContain("只读");
    expect(r.body.error ?? "").not.toContain("仅可见或已隐藏");
    expect(r.body.error ?? "").not.toContain("不可编辑");
  });

  it("字段对分享人是隐藏 -> 拒写（即便链接本身仍可编辑）", async () => {
    const r = await post({ "f-hidden": "x" });
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("仅可见或已隐藏");
  });

  it("字段对分享人是仅可见 -> 拒写", async () => {
    state.fields["f-ro"] = "visible";
    const r = await post({ "f-ro": "x" });
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("仅可见或已隐藏");
  });

  it("表级「允许分享」开关关掉 -> 链接当次失效", async () => {
    state.shareAllowed = false;
    const res = await pub.request("/s/tok/records", { method: "GET" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("已关闭分享");
  });
});
