// apps/api/src/routes/__tests__/publicDocWrite.test.ts
// 分享文档正文匿名写（HTTP 层，fake prisma，沿用 publicTableWrite.test.ts 的 mock 风格）。
// 锁定本工单的五道闸 + 乐观锁：
//   ① 只读档位 -> 403；
//   ② 可编辑 + baseUpdatedAt 正确 -> 200 且库中内容真的变了；
//   ③ ★可编辑 + baseUpdatedAt 过期 -> 409 且库中内容零改动（防静默覆盖，核心用例）；
//   ④ 缺 baseUpdatedAt -> 400；
//   ⑤ 分享人被降权 -> 403；子文档在/不在可写范围；引用闭包内文档一律拒写。
// 另验证读取侧 canEdit 口径（根/子树跟随 caps，ref 闭包恒 false）。

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LibraryAccessDTO } from "@gx/shared-types";

// ---- 内存文档夹具 ----
interface FakeDoc {
  id: string;
  kbId: string;
  kind: "doc" | "canvas";
  title: string;
  content: string;
  parentId: string | null;
  updatedAt: Date;
  contentVersion: number;
  shareEnabled: boolean;
  shareToken: string | null;
  shareRole: string;
  shareIncludeChildren: boolean;
  shareCreatedBy: string | null;
}

function doc(p: Partial<FakeDoc> & Pick<FakeDoc, "id" | "kind">): FakeDoc {
  return {
    kbId: "kb1",
    title: p.id,
    content: "",
    parentId: null,
    updatedAt: new Date("2026-09-20T10:00:00.000Z"),
    contentVersion: 1,
    shareEnabled: true,
    shareToken: null,
    shareRole: "editor",
    shareIncludeChildren: false,
    shareCreatedBy: "u1",
    ...p,
  };
}

const state = {
  kbVisible: true,
  content: { read: true, create: true, update: true, delete: true } as Record<string, boolean>,
};

const docs = new Map<string, FakeDoc>();

/** 把 saveDocContentTx 的 data 落到内存 store（含 contentVersion 自增、updatedAt 刷新）。 */
function applyData(d: FakeDoc, data: Record<string, unknown>): void {
  if (typeof data.content === "string") d.content = data.content;
  const cv = data.contentVersion as { increment?: number } | undefined;
  if (cv && typeof cv.increment === "number") d.contentVersion += cv.increment;
  d.updatedAt = new Date(d.updatedAt.getTime() + 1000);
}

// 事务内 fake tx：仅实现文档正文写路径用到的三个操作。
const txClient = {
  kbDoc: {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const d = docs.get(where.id);
      if (!d) return null;
      return { content: d.content, updatedAt: d.updatedAt, contentVersion: d.contentVersion, kind: d.kind };
    },
    updateMany: async ({ where, data }: { where: { id: string; contentVersion?: number }; data: Record<string, unknown> }) => {
      const d = docs.get(where.id);
      if (!d) return { count: 0 };
      if (where.contentVersion !== undefined && d.contentVersion !== where.contentVersion) return { count: 0 };
      applyData(d, data);
      return { count: 1 };
    },
  },
};

vi.mock("../../db.js", () => ({
  prisma: {
    // 全部用例走 kb_docs.share_token（历史文档分享令牌）路径：对象化链接查不到。
    shareLink: { findUnique: () => Promise.resolve(null) },
    kbDoc: {
      findFirst: ({ where }: { where: Record<string, unknown> }) => {
        if ("shareToken" in where) {
          const hit = [...docs.values()].find((d) => d.shareToken === where.shareToken && d.shareEnabled === true);
          return Promise.resolve(hit ? { ...hit } : null);
        }
        return Promise.resolve(docs.has(where.id as string) ? { ...docs.get(where.id as string)! } : null);
      },
      findMany: ({ where }: { where?: Record<string, unknown> } = {}) => {
        let list = [...docs.values()];
        const idCond = where?.id as { in?: string[] } | undefined;
        if (idCond?.in) list = list.filter((d) => idCond.in!.includes(d.id));
        if (typeof where?.kind === "string") list = list.filter((d) => d.kind === where.kind);
        // 同时带上子树遍历（id/parentId）与树/闭包读取（id/kind/title/content）所需字段。
        return Promise.resolve(list.map((d) => ({
          id: d.id, parentId: d.parentId, kind: d.kind, title: d.title, content: d.content,
        })));
      },
    },
  },
  withWriteTx: (_label: string, fn: (tx: unknown) => unknown) => Promise.resolve(fn(txClient)),
}));

vi.mock("../../domain/authz/libraryPolicy.js", () => ({
  resolveKbAccess: () =>
    Promise.resolve(
      state.kbVisible
        ? ({
            visible: true, canManage: false, canDeleteLibrary: false, canToggleShare: false,
            source: "role_scope", tables: { content: state.content }, fields: {},
          } as unknown as LibraryAccessDTO)
        : null,
    ),
  contentAccessOf: (access: LibraryAccessDTO) =>
    access.tables["content"] ?? { read: false, create: false, update: false, delete: false },
  resolveBaseAccessByTable: () => Promise.resolve(null),
  tableAccessOf: () => ({ read: true, create: false, update: false, delete: false }),
  fieldAccessOf: () => "editable",
}));

// saveDocContentTx 的旁路依赖（快照/检索 outbox/nav 同步）在 HTTP 层单测中隔离。
vi.mock("../../domain/kb.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../domain/kb.js")>();
  return { ...actual, maybeAutoSnapshotTx: async () => false };
});
vi.mock("../../domain/search/outbox.js", () => ({ enqueueChangeEventTx: async () => undefined }));
vi.mock("../../domain/nav/sync.js", () => ({ syncNavFromEntitiesTx: async () => undefined }));

const { pub } = await import("../public.js");

const T0 = new Date("2026-09-20T10:00:00.000Z");

beforeEach(() => {
  docs.clear();
  state.kbVisible = true;
  state.content = { read: true, create: true, update: true, delete: true };
});

function seedRoot(over: Partial<FakeDoc> = {}): void {
  docs.set("R", doc({
    id: "R", kind: "doc", shareToken: "tok", shareRole: "editor", content: "v0",
    updatedAt: T0, contentVersion: 1, shareIncludeChildren: false, ...over,
  }));
}

async function putContent(token: string, docId: string, body: unknown) {
  const res = await pub.request(`/s/${token}/doc/${docId}/content`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body: json };
}

describe("PUT /s/:token/doc/:docId/content 匿名写正文", () => {
  it("① 只读链接（shareRole=viewer）-> 403", async () => {
    seedRoot({ shareRole: "viewer" });
    const r = await putContent("tok", "R", { content: "v1", baseUpdatedAt: T0.toISOString() });
    expect(r.status).toBe(403);
    expect(String(r.body.error)).toContain("只读");
    expect(docs.get("R")!.content).toBe("v0");
  });

  it("② 可编辑链接 + baseUpdatedAt 正确 -> 200，且库中内容真的变了", async () => {
    seedRoot();
    const r = await putContent("tok", "R", { content: "v1-新内容", baseUpdatedAt: T0.toISOString() });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.canEdit).toBe(true);
    expect(r.body.mode).toBe("edit");
    expect(typeof r.body.updatedAt).toBe("string");
    expect(docs.get("R")!.content).toBe("v1-新内容");
    // 版本号照常递增（检索/快照的对齐依据）
    expect(docs.get("R")!.contentVersion).toBe(2);
  });

  it("③ ★可编辑链接 + baseUpdatedAt 过期 -> 409，且库中内容零改动（防静默覆盖）", async () => {
    seedRoot({ content: "B-别人的改动" });
    const stale = new Date(T0.getTime() - 60_000).toISOString();
    const r = await putContent("tok", "R", { content: "A-我的旧内容", baseUpdatedAt: stale });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("CONFLICT");
    // 冲突响应必须带库中最新内容与时间，供前端刷新
    expect(r.body.content).toBe("B-别人的改动");
    expect(r.body.updatedAt).toBe(T0.toISOString());
    // 关键：库中内容未被写入（A 的旧内容没有抹掉 B 的改动）
    expect(docs.get("R")!.content).toBe("B-别人的改动");
    expect(docs.get("R")!.contentVersion).toBe(1);
  });

  it("④ 缺少 baseUpdatedAt -> 400（必填，不做可选）", async () => {
    seedRoot();
    const r = await putContent("tok", "R", { content: "v1" });
    expect(r.status).toBe(400);
    expect(docs.get("R")!.content).toBe("v0");
  });

  it("④b baseUpdatedAt 非合法时间 -> 400", async () => {
    seedRoot();
    const r = await putContent("tok", "R", { content: "v1", baseUpdatedAt: "not-a-time" });
    expect(r.status).toBe(400);
    expect(docs.get("R")!.content).toBe("v0");
  });

  it("⑤a shareIncludeChildren=false 时对非根 docId PUT -> 拒（403/404）", async () => {
    seedRoot({ shareIncludeChildren: false });
    docs.set("C", doc({ id: "C", kind: "doc", parentId: "R", shareEnabled: false }));
    const r = await putContent("tok", "C", { content: "x", baseUpdatedAt: T0.toISOString() });
    expect([403, 404]).toContain(r.status);
    expect(docs.get("C")!.content).toBe("");
  });

  it("⑤b shareIncludeChildren=true 时子树内文档可写 -> 200", async () => {
    seedRoot({ shareIncludeChildren: true });
    docs.set("C", doc({ id: "C", kind: "doc", parentId: "R", content: "c0", updatedAt: T0 }));
    const r = await putContent("tok", "C", { content: "c1", baseUpdatedAt: T0.toISOString() });
    expect(r.status).toBe(200);
    expect(docs.get("C")!.content).toBe("c1");
  });

  it("⑤c 分享人被降权（失去 content.update）-> PUT 403", async () => {
    seedRoot();
    state.content = { read: true, create: false, update: false, delete: false };
    const r = await putContent("tok", "R", { content: "v1", baseUpdatedAt: T0.toISOString() });
    expect(r.status).toBe(403);
    expect(String(r.body.error)).toContain("只读");
    expect(docs.get("R")!.content).toBe("v0");
  });

  it("⑤d 引用闭包内文档（画布引用、不在本次分享子树）-> PUT 一律拒", async () => {
    // 根是画布，引用子树外的 X；X 对读者可见但绝不可经链接改写。
    docs.set("R", doc({
      id: "R", kind: "canvas", shareToken: "tok", shareRole: "editor", shareIncludeChildren: false,
      content: JSON.stringify([{ gxDocRef: { docId: "X" } }]), updatedAt: T0,
    }));
    docs.set("X", doc({ id: "X", kind: "doc", parentId: "elsewhere", content: "他人内容" }));
    const r = await putContent("tok", "X", { content: "篡改", baseUpdatedAt: T0.toISOString() });
    expect([403, 404]).toContain(r.status);
    expect(docs.get("X")!.content).toBe("他人内容");
  });
});

describe("读取侧 canEdit 口径（根/子树跟随 caps，ref 闭包恒 false）", () => {
  it("可编辑根：GET /s/:token 与 GET /s/:token/doc/:rootId 均 canEdit=true", async () => {
    seedRoot();
    const root = await pub.request("/s/tok", { method: "GET" });
    const rootBody = (await root.json()) as { canEdit?: boolean; doc?: { canEdit?: boolean } };
    expect(rootBody.canEdit).toBe(true);
    expect(rootBody.doc?.canEdit).toBe(true);

    const one = await pub.request("/s/tok/doc/R", { method: "GET" });
    const oneBody = (await one.json()) as { canEdit?: boolean; doc?: { canEdit?: boolean } };
    expect(oneBody.canEdit).toBe(true);
    expect(oneBody.doc?.canEdit).toBe(true);
  });

  it("只读根：canEdit=false（档位不足时前端应渲染只读）", async () => {
    seedRoot({ shareRole: "viewer" });
    const root = await pub.request("/s/tok", { method: "GET" });
    const rootBody = (await root.json()) as { canEdit?: boolean };
    expect(rootBody.canEdit).toBe(false);
  });

  it("ref 闭包内文档：即便根可编辑，GET /s/:token/ref/:docId 仍 canEdit=false", async () => {
    docs.set("R", doc({
      id: "R", kind: "canvas", shareToken: "tok", shareRole: "editor", shareIncludeChildren: false,
      content: JSON.stringify([{ gxDocRef: { docId: "X" } }]), updatedAt: T0,
    }));
    docs.set("X", doc({ id: "X", kind: "doc", parentId: "elsewhere" }));
    const res = await pub.request("/s/tok/ref/X", { method: "GET" });
    const body = (await res.json()) as { canEdit?: boolean; doc?: { canEdit?: boolean } };
    expect(res.status).toBe(200);
    expect(body.canEdit).toBe(false);
    expect(body.doc?.canEdit).toBe(false);
  });
});
