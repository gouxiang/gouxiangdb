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
    // requireKb 走真实引擎：资源 -> kb nav 节点反查 + 祖先链 + 候选策略这几步 IO 会发生。
    // 补最小 nav 桩（kb 自闭环单节点），authPolicy 返回空（放行由 legacy canShare + 本测试
    // 意图决定；enforce 走 authority 语义，legacyAllowed=access.canShare 直接反映用例期望）。
    navNode: {
      findUnique: () => Promise.resolve({ id: "nav_kb", deletedAt: null }),
      findFirst: () => Promise.resolve({
        id: "nav_kb", workspaceId: "ws_default", parentId: null, kind: "kb",
        resourceType: "kb", resourceId: KB, name: KB, path: "/nav_kb/", depth: 1,
        inheritAncestors: 1, deletedAt: null,
      }),
      findMany: () => Promise.resolve([{
        id: "nav_kb", workspaceId: "ws_default", parentId: null, kind: "kb",
        resourceType: "kb", resourceId: KB, name: KB, path: "/nav_kb/", depth: 1,
        inheritAncestors: 1, deletedAt: null,
      }]),
    },
    workspace: {
      findUnique: () => Promise.resolve({ navVersion: 1 }),
    },
    // resolveSubject -> effectiveRoleRows 真实查 roleAssignment（include role）与 deptMember。
    // USER 无角色 -> 返回空（isWorkspaceOwner=false），放行完全由下面节点策略承载。
    roleAssignment: {
      findMany: () => Promise.resolve([]),
    },
    deptMember: {
      findMany: () => Promise.resolve([]),
    },
    // 节点策略：USER 恒持 enter + r（requireDocAccess needEdit=false 会先判 enter 再判 r，
    // 两道都要过才走得到分享闸）；share_link 仅在 access.canShare 时承载。
    // 于是「无 canShare -> share_link 不命中 -> 403」；canShare=true 时引擎放行 share_link，
    // 路由内部再按总闸与开/关动作决定结果（总闸关闭开启动作 -> 403；关闭动作一律放行）。
    authPolicy: {
      findMany: () => {
        const row = {
          id: "pol_kb_user", nodeId: "nav_kb", subjectType: "user", subjectId: USER,
          actions: state.canShare ? "enter,r,share_link" : "enter,r",
          fieldMask: null, conditions: null,
        };
        return Promise.resolve([row]);
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
