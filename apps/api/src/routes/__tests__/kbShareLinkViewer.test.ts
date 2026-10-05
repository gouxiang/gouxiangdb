// POST /api/kb/docs/:docId/share 的建链位 share_link 行为（fake prisma，不碰真实 SQLite）：
//   - canShare-only viewer（无内容 u）开【查看模式】链接 -> 200；
//   - 同一 viewer 开【可编辑】链接 -> 403（assertSharerCanGrantDocEdit 独立把 u）；
//   - 关闭/吊销链接：即便无 u 也放行（收敛操作）；
//   - 无 canShare -> 403。
//
// requireDocAccess 本片由 needEdit=true 改为 false：viewer 建查看链接不再被 u 挡住。
// enforceOrLegacy 按 off 语义回传 {allowed: legacyAllowed}（生产当前 off，零引擎 IO）。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { LibraryAccessDTO } from "@gx/shared-types";

const KB = "kb1";
const DOC = "d1";
const USER = "u1";

const state = {
  kbShareEnabled: 1,
  visible: true,
  canShare: true,
  content: { read: true, create: false, update: false, delete: false } as Record<string, boolean>,
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
      visible: state.visible,
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
  fieldAccessOf: () => "visible",
}));

// off 语义：直接回传 legacyAllowed（不触引擎）。share_link 的 legacy 入参即 access.canShare。
vi.mock("../../domain/authz/enforceGate.js", () => ({
  enforceOrLegacy: async (opts: { legacyAllowed: boolean }) => ({ allowed: opts.legacyAllowed }),
}));

const { sharingRoutes } = await import("../kb/sharing.js");
const app = new Hono();
app.route("/api/kb", sharingRoutes);

beforeEach(() => {
  state.kbShareEnabled = 1;
  state.visible = true;
  state.canShare = true;
  state.content = { read: true, create: false, update: false, delete: false };
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

describe("share_link 建链位：canShare-only viewer", () => {
  it("无内容 u 也能开查看模式链接 -> 200（needEdit=false 不再被 u 挡）", async () => {
    const r = await postShare({ shareEnabled: true });
    expect(r.status).toBe(200);
    expect(r.body.share?.shareEnabled).toBe(true);
    expect(typeof r.body.share?.shareToken).toBe("string");
    expect(store.get(DOC)!.shareEnabled).toBe(true);
    expect(store.get(DOC)!.shareCreatedBy).toBe(USER);
  });

  it("开可编辑链接 -> 403（assertSharerCanGrantDocEdit 独立把 u），不发令牌", async () => {
    const r = await postShare({ shareEnabled: true, shareRole: "editor" });
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("编辑权");
    expect(store.get(DOC)!.shareEnabled).toBe(false);
    expect(store.get(DOC)!.shareToken).toBeNull();
  });

  it("吊销已开链接 -> 200（无 u 也放行，收敛操作）", async () => {
    store.set(DOC, {
      id: DOC, kbId: KB, shareEnabled: true, shareToken: "tok-existing",
      shareRole: "viewer", shareIncludeChildren: false, shareCreatedBy: USER,
    });
    const r = await postShare({ shareEnabled: false });
    expect(r.status).toBe(200);
    expect(r.body.share?.shareEnabled).toBe(false);
    expect(store.get(DOC)!.shareToken).toBeNull();
    expect(store.get(DOC)!.shareCreatedBy).toBeNull();
  });

  it("总闸关闭时仍可吊销（不被 readShareEnabled 挡）", async () => {
    store.set(DOC, {
      id: DOC, kbId: KB, shareEnabled: true, shareToken: "tok-existing",
      shareRole: "viewer", shareIncludeChildren: false, shareCreatedBy: USER,
    });
    state.kbShareEnabled = 0;
    const r = await postShare({ shareEnabled: false });
    expect(r.status).toBe(200);
    expect(store.get(DOC)!.shareToken).toBeNull();
  });

  it("无 canShare -> 403（share_link 位不放行）", async () => {
    state.canShare = false;
    const r = await postShare({ shareEnabled: true });
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("分享权限");
    expect(store.get(DOC)!.shareEnabled).toBe(false);
  });
});
