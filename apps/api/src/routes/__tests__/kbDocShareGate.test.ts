// apps/api/src/routes/__tests__/kbDocShareGate.test.ts
// POST /api/kb/docs/:docId/share 的库级「允许分享」总闸（fake prisma，不碰真实 SQLite）。
//
// 产品口径：总闸关着，这个知识库就一份都发不出去。数据表侧早已如此
// （tableShares 要求库级 && 表级），知识库文档侧本轮对齐——但【关闭一律放行】：
//   若关闭也校验，总闸一关，已经开着的文档分享就再也关不掉，
//   反而留下永远吊销不掉的悬空链接。关闭是收敛操作，必须放行。
//
// mock 组织沿用 publicDocWrite.test.ts：顶替 db.js（取数）与 auth.js（身份），
// 库权限裁决（libraryPolicy）用可切换的 state 顶替，因为本组用例的靶子是【总闸】这一级，
// 不是角色裁决链；libraryVisibility.readShareEnabled 跑真实代码（打进 fake knowledgeBase），
// 否则测到的就不是"总闸算得对不对"。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { LibraryAccessDTO } from "@gx/shared-types";

const KB = "kb1";
const DOC = "d1";
const USER = "u1";

const state = {
  /** 库级「允许分享」总闸（本组用例的唯一自变量）。 */
  kbShareEnabled: 1,
  /** 请求者对库内容的四动作：needEdit=true 的 requireDocAccess 要求 update=true。 */
  content: { read: true, create: true, update: true, delete: true } as Record<string, boolean>,
  /** 请求者的 access.canShare（另一道闸：与本轮的总闸彼此独立）。 */
  canShare: true,
};

interface FakeDoc {
  id: string;
  kbId: string;
  shareEnabled: boolean;
  shareToken: string | null;
  shareRole: string;
  shareIncludeChildren: boolean;
  shareCreatedBy: string | null;
}

const store = new Map<string, FakeDoc>();

vi.mock("../../db.js", () => ({
  prisma: {
    knowledgeBase: {
      // requireKb 的存在性检查（findFirst）与 readShareEnabled 的总闸读数（findUnique）。
      findFirst: ({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === KB ? { id: KB } : null),
      findUnique: ({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === KB ? { shareEnabled: state.kbShareEnabled } : null),
    },
    kbDoc: {
      findFirst: ({ where }: { where: Record<string, unknown> }) => {
        const d = store.get(where.id as string);
        return Promise.resolve(d ? { ...d } : null);
      },
      update: ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const d = store.get(where.id);
        if (!d) return Promise.reject(new Error("doc not found"));
        Object.assign(d, data);
        return Promise.resolve({ ...d });
      },
    },
  },
  withWriteTx: (_label: string, fn: (tx: unknown) => unknown) => Promise.resolve(fn({})),
}));

vi.mock("../../auth.js", () => ({
  getUserId: () => Promise.resolve(USER),
}));

vi.mock("../../domain/authz/libraryPolicy.js", () => ({
  resolveKbAccess: () =>
    Promise.resolve({
      visible: true,
      canManage: false,
      canDeleteLibrary: false,
      canToggleShare: false,
      canShare: state.canShare,
      source: "role_scope",
      tables: { content: state.content },
      fields: {},
    } as unknown as LibraryAccessDTO),
  contentAccessOf: (access: LibraryAccessDTO) =>
    access.tables["content"] ?? { read: false, create: false, update: false, delete: false },
  resolveBaseAccessByTable: () => Promise.resolve(null),
  tableAccessOf: () => ({ read: true, create: false, update: false, delete: false }),
  fieldAccessOf: () => "editable",
}));

const { sharingRoutes } = await import("../kb/sharing.js");
const app = new Hono();
app.route("/api/kb", sharingRoutes);

beforeEach(() => {
  state.kbShareEnabled = 1;
  state.content = { read: true, create: true, update: true, delete: true };
  state.canShare = true;
  store.clear();
  store.set(DOC, {
    id: DOC,
    kbId: KB,
    shareEnabled: false,
    shareToken: null,
    shareRole: "viewer",
    shareIncludeChildren: false,
    shareCreatedBy: null,
  });
});

async function postShare(body: unknown) {
  const res = await app.request(`/api/kb/docs/${DOC}/share`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as {
      share?: { shareEnabled?: boolean; shareToken?: string | null; shareUrl?: string | null };
      error?: string;
    },
  };
}

describe("POST /api/kb/docs/:docId/share 库级「允许分享」总闸", () => {
  it("★总闸关 + shareEnabled:true -> 403（有 canShare 也开不出去）", async () => {
    state.kbShareEnabled = 0;
    const r = await postShare({ shareEnabled: true });
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("未开启分享");
    // 关键：被拒时不得落库生成令牌（否则等于"开了一半"）
    expect(store.get(DOC)!.shareEnabled).toBe(false);
    expect(store.get(DOC)!.shareToken).toBeNull();
  });

  it("总闸开 + shareEnabled:true -> 200，且真的发出令牌", async () => {
    const r = await postShare({ shareEnabled: true });
    expect(r.status).toBe(200);
    expect(r.body.share?.shareEnabled).toBe(true);
    expect(typeof r.body.share?.shareToken).toBe("string");
    expect(r.body.share?.shareUrl).toBe(`/s/${r.body.share?.shareToken}`);
    expect(store.get(DOC)!.shareEnabled).toBe(true);
    expect(store.get(DOC)!.shareCreatedBy).toBe(USER);
  });

  it("★总闸关 + shareEnabled:false -> 200（关闭是收敛操作，一律放行）", async () => {
    // 先造一个"总闸还开着时已发出"的存量链接
    store.set(DOC, {
      id: DOC, kbId: KB, shareEnabled: true, shareToken: "tok-existing",
      shareRole: "viewer", shareIncludeChildren: false, shareCreatedBy: USER,
    });
    state.kbShareEnabled = 0;
    const r = await postShare({ shareEnabled: false });
    expect(r.status).toBe(200);
    expect(r.body.share?.shareEnabled).toBe(false);
    // 关闭即吊销：令牌清空，不留悬空外链
    expect(store.get(DOC)!.shareToken).toBeNull();
    expect(store.get(DOC)!.shareCreatedBy).toBeNull();
  });

  it("另一道闸仍在：无 canShare -> 403（总闸开也不放行，两道闸彼此独立）", async () => {
    state.canShare = false;
    const r = await postShare({ shareEnabled: true });
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("分享权限");
    expect(store.get(DOC)!.shareEnabled).toBe(false);
  });
});
