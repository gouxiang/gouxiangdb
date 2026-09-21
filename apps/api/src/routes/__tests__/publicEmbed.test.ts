// apps/api/src/routes/__tests__/publicEmbed.test.ts
// 嵌入数据表预览的分享态通道（HTTP 层，fake prisma）：
//   - 档位由【宿主文档/画布的分享设置】决定，且随分享人权限每次现算；
//   - 不能用数据表自己的分享 token 走嵌入通道（绕不过宿主分享设置）；
//   - 分享人被降权时，嵌入预览同样回落只读。

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LibraryAccessDTO } from "@gx/shared-types";

const state = {
  /** 宿主文档分享令牌是否走 share_links（true=数据表链接，用来验证不能冒充宿主）。 */
  linkIsTable: false,
  docShareRole: "editor",
  docSharerId: "u1" as string | null,
  /** 分享人对该知识库内容的四枚动作。 */
  kbContent: { read: true, create: true, update: true, delete: true } as Record<string, boolean>,
  /** 分享人对该表的四枚动作。 */
  table: { read: true, create: true, update: true, delete: true } as Record<string, boolean>,
};

const TABLE_LINK = {
  id: "l1", token: "tok", objectType: "table", objectId: "t1", baseId: "b1",
  viewId: null, mode: "edit", createdBy: "u1", role: "viewer", expiresAt: null,
  createdAt: new Date("2026-09-20T00:00:00.000Z"),
};

vi.mock("../../db.js", () => ({
  prisma: {
    shareLink: {
      findUnique: () => Promise.resolve(state.linkIsTable ? TABLE_LINK : null),
    },
    kbDoc: {
      findFirst: () => Promise.resolve({
        id: "d1", kbId: "kb1", kind: "doc", title: "宿主文档", content: "", parentId: null,
        shareRole: state.docShareRole, shareIncludeChildren: false, shareCreatedBy: state.docSharerId,
        updatedAt: new Date(),
      }),
    },
    table: {
      findFirst: () => Promise.resolve({
        id: "t1", name: "嵌入表", icon: null, iconColor: null, primaryFieldId: "f1",
        baseId: "b1", base: { name: "库" },
      }),
    },
    field: {
      findMany: () => Promise.resolve([
        { id: "f1", tableId: "t1", name: "字段", type: "text", description: "", order: 0, required: false, unique: false,
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
    visible: true, canManage: false, canDeleteLibrary: false, canToggleShare: false,
    source: "role_scope", tables: { t1: state.table }, fields: {},
  } as unknown as LibraryAccessDTO),
  resolveKbAccess: () => Promise.resolve({
    visible: true, canManage: false, canDeleteLibrary: false, canToggleShare: false,
    source: "role_scope", tables: { content: state.kbContent }, fields: {},
  } as unknown as LibraryAccessDTO),
  tableAccessOf: (access: LibraryAccessDTO, tableId: string) =>
    access.tables[tableId] ?? { read: false, create: false, update: false, delete: false },
  contentAccessOf: (access: LibraryAccessDTO) =>
    access.tables["content"] ?? { read: false, create: false, update: false, delete: false },
  fieldAccessOf: () => "editable",
}));

vi.mock("../../domain/authz/libraryVisibility.js", () => ({
  tableShareAllowed: () => Promise.resolve(true),
  readShareEnabled: () => Promise.resolve(true),
}));

const { pub } = await import("../public.js");

beforeEach(() => {
  state.linkIsTable = false;
  state.docShareRole = "editor";
  state.docSharerId = "u1";
  state.kbContent = { read: true, create: true, update: true, delete: true };
  state.table = { read: true, create: true, update: true, delete: true };
});

async function writeEmbed() {
  const res = await pub.request("/s/tok/embed/t1/records", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fields: { f1: "x" } }),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as { error?: string; mode?: string; canEdit?: boolean } };
}

describe("嵌入数据表预览的分享态口径", () => {
  it("宿主可编辑 + 分享人对表仍有改权 -> 不被权限拒", async () => {
    const r = await writeEmbed();
    expect(r.body.error ?? "").not.toContain("只读");
  });

  it("★分享人被降权 -> 嵌入预览回落只读（宿主档位随分享人权限现算）", async () => {
    state.table = { read: true, create: false, update: false, delete: false };
    const r = await writeEmbed();
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("只读");
  });

  it("宿主分享是只读档 -> 嵌入预览不可写", async () => {
    state.docShareRole = "viewer";
    const r = await writeEmbed();
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("只读");
  });

  it("宿主失去知识库编辑权 -> 嵌入预览不可写", async () => {
    state.kbContent = { read: true, create: false, update: false, delete: false };
    const r = await writeEmbed();
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("只读");
  });

  it("拿数据表自己的分享 token 走嵌入通道 -> 404（绕不过宿主分享设置）", async () => {
    state.linkIsTable = true;
    const res = await pub.request("/s/tok/embed/t1", { method: "GET" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("文档或画布");
  });
});
