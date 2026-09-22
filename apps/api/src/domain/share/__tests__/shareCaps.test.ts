// apps/api/src/domain/share/__tests__/shareCaps.test.ts
// 可编辑分享的两条硬要求（纯单测，不碰真实 SQLite）：
//   ① 创建时：分享人本人没有编辑权 -> 不许创建可编辑分享；
//   ② 运行时：分享人事后被降权/移出 -> 链接当次降级为只读（不是残留写权限）。
// 外加字段闸：外部写入按分享人的字段权限判定。

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LibraryAccessDTO } from "@gx/shared-types";

// 裁决出口是唯一授权来源，这里整体替身：把"分享人此刻有什么权限"直接喂给被测逻辑。
const resolveBaseAccessByTable = vi.fn<(userId: string, tableId: string) => Promise<LibraryAccessDTO | null>>();
const resolveKbAccess = vi.fn<(userId: string, kbId: string) => Promise<LibraryAccessDTO | null>>();

vi.mock("../../authz/libraryPolicy.js", () => ({
  resolveBaseAccessByTable: (u: string, t: string) => resolveBaseAccessByTable(u, t),
  resolveKbAccess: (u: string, k: string) => resolveKbAccess(u, k),
  tableAccessOf: (access: LibraryAccessDTO, tableId: string) =>
    access.tables["*"] ?? access.tables[tableId] ?? (access.visible
      ? { read: true, create: false, update: false, delete: false }
      : { read: false, create: false, update: false, delete: false }),
  contentAccessOf: (access: LibraryAccessDTO) =>
    access.tables["*"] ?? access.tables["content"] ?? (access.visible
      ? { read: true, create: false, update: false, delete: false }
      : { read: false, create: false, update: false, delete: false }),
  fieldAccessOf: (access: LibraryAccessDTO, tableId: string, fieldId: string) =>
    access.fields[tableId]?.[fieldId] ?? "editable",
}));

const { resolveTableShareCaps, assertSharerCanGrantEdit, externalFieldGate } = await import("../shareCaps.js");

function access(tables: Record<string, { read: boolean; create: boolean; update: boolean; delete: boolean }>, visible = true, fields: Record<string, Record<string, string>> = {}): LibraryAccessDTO {
  return {
    visible,
    canManage: false,
    canDeleteLibrary: false,
    canToggleShare: false,
    canShare: false,
    source: "role_scope",
    tables,
    fields: fields as LibraryAccessDTO["fields"],
  };
}

const FULL = { read: true, create: true, update: true, delete: true };
const READ = { read: true, create: false, update: false, delete: false };

function editLink(createdBy: string | null = "u1") {
  return {
    id: "l1", token: "tok", objectType: "table", objectId: "t1", baseId: "b1",
    viewId: null, mode: "edit", createdBy, role: "viewer", expiresAt: null, createdAt: new Date(),
  };
}

beforeEach(() => {
  resolveBaseAccessByTable.mockReset();
  resolveKbAccess.mockReset();
});

describe("可编辑分享的动态降级", () => {
  it("分享人有编辑权 -> 生效档位 edit，不降级", async () => {
    resolveBaseAccessByTable.mockResolvedValue(access({ t1: FULL }));
    const caps = await resolveTableShareCaps(editLink(), "t1");
    expect(caps.mode).toBe("edit");
    expect(caps.degraded).toBe(false);
    expect(caps.canEdit).toBe(true);
  });

  it("★分享人事后被降权（角色改了/库权限收回）-> 链接自动降级为只读", async () => {
    // 降权后：visible 仍在（还能进库），但对这张表只剩 read。
    resolveBaseAccessByTable.mockResolvedValue(access({ t1: READ }));
    const caps = await resolveTableShareCaps(editLink(), "t1");
    expect(caps.requestedMode).toBe("edit");
    expect(caps.mode).toBe("view");
    expect(caps.degraded).toBe(true);
    expect(caps.canEdit).toBe(false);
    expect(caps.canCreate).toBe(false);
    expect(caps.canDelete).toBe(false);
  });

  it("分享人被移出该库（不可见）-> 降级为只读", async () => {
    resolveBaseAccessByTable.mockResolvedValue(access({}, false));
    const caps = await resolveTableShareCaps(editLink(), "t1");
    expect(caps.mode).toBe("view");
    expect(caps.degraded).toBe(true);
  });

  it("分享人账号已不存在（裁决返回 null）-> 降级为只读", async () => {
    resolveBaseAccessByTable.mockResolvedValue(null);
    const caps = await resolveTableShareCaps(editLink(), "t1");
    expect(caps.mode).toBe("view");
    expect(caps.degraded).toBe(true);
  });

  it("只读链接永不升级：即便分享人有编辑权也只回 view", async () => {
    resolveBaseAccessByTable.mockResolvedValue(access({ t1: FULL }));
    const caps = await resolveTableShareCaps({ ...editLink(), mode: "view" }, "t1");
    expect(caps.mode).toBe("view");
    expect(caps.degraded).toBe(false);
    expect(caps.canEdit).toBe(false);
  });

  it("存量无分享人的链接（createdBy 为空）-> 恒只读", async () => {
    const caps = await resolveTableShareCaps(editLink(null), "t1");
    expect(caps.mode).toBe("view");
    expect(caps.canEdit).toBe(false);
  });
});

describe("创建可编辑分享的前置校验", () => {
  it("分享人本人有编辑权 -> 放行", async () => {
    resolveBaseAccessByTable.mockResolvedValue(access({ t1: FULL }));
    await expect(assertSharerCanGrantEdit("u1", "t1")).resolves.toBeUndefined();
  });

  it("★分享人本人无编辑权 -> 拒绝创建（403，前端置灰被绕过也不放行）", async () => {
    resolveBaseAccessByTable.mockResolvedValue(access({ t1: READ }));
    await expect(assertSharerCanGrantEdit("u1", "t1")).rejects.toMatchObject({ status: 403 });
  });

  it("分享人连库都进不去 -> 拒绝创建", async () => {
    resolveBaseAccessByTable.mockResolvedValue(null);
    await expect(assertSharerCanGrantEdit("u1", "t1")).rejects.toMatchObject({ status: 403 });
  });
});

describe("外部写入按分享人的字段权限过闸", () => {
  const fields = [
    { id: "f-ok", name: "可编辑字段" },
    { id: "f-ro", name: "仅可见字段" },
    { id: "f-hi", name: "隐藏字段" },
  ] as never;

  const sharerAccess = access({ t1: FULL }, true, {
    t1: { "f-ok": "editable", "f-ro": "visible", "f-hi": "hidden" },
  });

  it("editable 字段放行", () => {
    expect(() => externalFieldGate(sharerAccess, "t1", fields)(["f-ok"])).not.toThrow();
  });

  it("仅可见字段拒写", () => {
    expect(() => externalFieldGate(sharerAccess, "t1", fields)(["f-ro"])).toThrow(/仅可见或已隐藏/);
  });

  it("隐藏字段拒写", () => {
    expect(() => externalFieldGate(sharerAccess, "t1", fields)(["f-hi"])).toThrow(/仅可见或已隐藏/);
  });

  it("整批里混一个坏字段 -> 整批拒写（不留半条记录）", () => {
    expect(() => externalFieldGate(sharerAccess, "t1", fields)(["f-ok", "f-hi"])).toThrow(/仅可见或已隐藏/);
  });

  it("无分享人（无法判定字段权限）-> 一律拒写", () => {
    expect(() => externalFieldGate(null, "t1", fields)(["f-ok"])).toThrow(/不可编辑/);
  });
});
