// apps/api/src/routes/__tests__/tableShares.test.ts
// 数据表分享链接路由（GET/POST/DELETE /api/tables/:tableId/share）的权限与降级边界。
//
//   ★核心防线一：申请 mode:"edit" 时，后端必须自己确认【分享人本人此刻对该表有 update】，
//     前端置灰不算防线——抓包改 body 即可绕过。判定在 shareCaps.assertSharerCanGrantEdit。
//   ★核心防线二：已发出的 edit 链接，档位每次访问现算。分享人失去 update 后列表与访问
//     都应当次降级为 view（degraded=true），不留"人已无权、链接还能改数据"的残留写通道。
//
// mock 组织沿用 publicTableWrite.test.ts：内存 fake prisma + vi.mock 掉身份与审计落盘；
// 权限判定链（libraryPolicy -> shareCaps）跑【真实代码】，不 mock。
// 夹具（fake prisma / state / 造数据函数）在 ./_tableSharesHarness.ts。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  state,
  fakePrisma,
  auditCalls,
  resetState,
  scope,
  link,
  TABLE,
  MEMBER,
  OTHER,
  MANAGER,
  type AuditCall,
} from "./_tableSharesHarness.js";

vi.mock("../../db.js", () => ({
  prisma: fakePrisma,
  withWriteTx: (_label: string, fn: (tx: unknown) => unknown) => Promise.resolve(fn({})),
}));

vi.mock("../../auth.js", () => ({
  getUserId: () => Promise.resolve(state.userId || null),
}));

vi.mock("../../audit/emit.js", () => ({
  audit: (_c: unknown, input: AuditCall) => {
    auditCalls.push(input);
  },
}));

const { tableShares } = await import("../tableShares.js");
const app = new Hono();
app.route("/api/tables", tableShares);

beforeEach(resetState);

interface Body {
  links?: Array<Record<string, unknown>>;
  canGrantEdit?: boolean;
  link?: Record<string, unknown>;
  ok?: boolean;
  error?: string;
  code?: string;
}

async function call(method: string, url: string, body?: unknown): Promise<{ status: number; body: Body }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await app.request(url, init);
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Body };
}

const getList = () => call("GET", `/api/tables/${TABLE}/share`);
const create = (body: unknown) => call("POST", `/api/tables/${TABLE}/share`, body);
const revoke = (linkId: string) => call("DELETE", `/api/tables/${TABLE}/share/${linkId}`);
const dtoOf = (r: { body: Body }): Record<string, unknown> =>
  (r.body.links as Array<Record<string, unknown>>)[0];

// ============ 1) 前置门：表存在 / 已登录 / 表可见 / 两级开关 ============

describe("GET /api/tables/:tableId/share 前置门", () => {
  it("表不存在 -> 404", async () => {
    state.tableExists = false;
    const r = await getList();
    expect(r.status).toBe(404);
    expect(r.body.error).toContain("数据表不存在");
  });

  it("未登录 -> 401", async () => {
    state.userId = "";
    const r = await getList();
    expect(r.status).toBe(401);
  });

  it("表对自己不可见（无角色视野）-> 403 无权访问，且不返回链接列表", async () => {
    state.scopes[MEMBER] = scope(false, false);
    state.links = [link({ id: "l1", mode: "view", createdBy: MEMBER })];
    const r = await getList();
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("无权访问该数据表");
    expect(r.body.links).toBeUndefined();
  });

  it("两级开关都开 -> 200，links 为数组、无链接时为空", async () => {
    const r = await getList();
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.links)).toBe(true);
    expect(r.body.links).toHaveLength(0);
  });
});

describe("两级「允许分享」开关（库级 && 表级）", () => {
  it("库级开关关 -> POST 403 含「未开启分享」", async () => {
    state.baseShareEnabled = 0;
    const r = await create({ mode: "view" });
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("未开启分享");
    expect(state.links).toHaveLength(0);
  });

  it("表级开关关（库级仍开）-> POST 403 含「未开启分享」", async () => {
    state.tableShareEnabled = 0;
    const r = await create({ mode: "view" });
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("未开启分享");
    expect(state.links).toHaveLength(0);
  });

  it("库级关 -> GET 同样 403（不是只挡创建）", async () => {
    state.baseShareEnabled = 0;
    const r = await getList();
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("未开启分享");
  });
});

// ============ 1.5) ★第三道闸：本人对这个库的分享权 canShare ============

describe("建/看分享链接的本人分享权 canShare（总闸开了也不等于人人能发）", () => {
  it("★仅有可见权（无 canShare、无 canManage）-> POST 403 含「分享权限」，且未落库", async () => {
    state.scopes[MEMBER] = scope(true, false, { canShare: false });
    const r = await create({ mode: "view" });
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("你没有这个库的分享权限");
    expect(state.links).toHaveLength(0);
    expect(auditCalls).toHaveLength(0);
  });

  it("★仅有可见权 -> GET 同样 403（不是只挡创建）", async () => {
    state.scopes[MEMBER] = scope(true, false, { canShare: false });
    state.links = [link({ id: "l1", mode: "view", createdBy: MEMBER })];
    const r = await getList();
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("你没有这个库的分享权限");
    expect(r.body.links).toBeUndefined();
  });

  it("★授 canShare 位后 -> POST 201、GET 200（收紧是精确的，不是一刀切封死）", async () => {
    state.scopes[MEMBER] = scope(true, false, { canShare: false });
    expect((await create({ mode: "view" })).status).toBe(403);

    state.scopes[MEMBER] = scope(true, false, { canShare: true });
    const created = await create({ mode: "view" });
    expect(created.status).toBe(201);
    expect(state.links).toHaveLength(1);
    expect((await getList()).status).toBe(200);
  });

  it("对本库有管理权的人不靠 canShare 位也能建（放权方向不许回退）", async () => {
    state.userId = MANAGER;
    state.scopes[MANAGER] = scope(true, true, { canShare: false, update: true });
    const r = await create({ mode: "edit" });
    expect(r.status).toBe(201);
  });

  it("有 canShare 但本人无该表 update -> 可建只读档，申请 edit 仍被挡（两道闸各自独立）", async () => {
    state.scopes[MEMBER] = scope(true, false, { canShare: true });
    expect((await create({ mode: "view" })).status).toBe(201);
    const r = await create({ mode: "edit" });
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("只有本人对该数据表有编辑权时才能创建可编辑分享");
    expect(state.links).toHaveLength(1);
  });

  it("库级总闸关时仍报「未开启分享」：两道闸各报各的原因，不互相遮蔽", async () => {
    state.scopes[MEMBER] = scope(true, false, { canShare: false });
    state.baseShareEnabled = 0;
    const r = await create({ mode: "view" });
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("未开启分享");
  });
});

// ============ 2) ★核心防线一：可编辑档位必须由后端自判 ============

describe("POST mode:edit 的分享人编辑权硬约束", () => {
  it("★本人对该表无 update -> 403，且未落库（前端置灰不是防线）", async () => {
    state.scopes[MEMBER] = scope(true, false); // 可见但只读
    const r = await create({ mode: "edit" });
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("只有本人对该数据表有编辑权时才能创建可编辑分享");
    expect(state.links).toHaveLength(0);
    expect(auditCalls).toHaveLength(0);
  });

  it("★本人对该表有 update -> 201，DTO 为 edit 档且未降级", async () => {
    state.scopes[MEMBER] = scope(true, false, { update: true });
    const r = await create({ mode: "edit" });
    expect(r.status).toBe(201);
    const created = r.body.link as Record<string, unknown>;
    expect(created.mode).toBe("edit");
    expect(created.effectiveMode).toBe("edit");
    expect(created.degraded).toBe(false);
    expect(created.canEdit).toBe(true);
    expect(created.createdBy).toBe(MEMBER);
    expect(created.url).toMatch(/^\/s\//);
    expect(state.links).toHaveLength(1);
  });

  it("★可编辑链接必须留下审计（event=share_link_created 且 detail.mode=edit）", async () => {
    state.scopes[MEMBER] = scope(true, false, { update: true });
    const r = await create({ mode: "edit" });
    expect(r.status).toBe(201);
    const hit = auditCalls.find((a) => a.event === "share_link_created");
    expect(hit).toBeTruthy();
    expect(hit?.status).toBe(201);
    expect(hit?.actorId).toBe(MEMBER);
    expect(hit?.detail).toMatchObject({ objectType: "table", objectId: TABLE, mode: "edit" });
  });

  it("只读链接不要求本人有编辑权（无 update 也能建 view 档）", async () => {
    state.scopes[MEMBER] = scope(true, false);
    const r = await create({ mode: "view" });
    expect(r.status).toBe(201);
    expect((r.body.link as Record<string, unknown>).mode).toBe("view");
  });

  it("本库管理者（通配全表权限）-> 可建 edit 档", async () => {
    state.userId = MANAGER;
    const r = await create({ mode: "edit" });
    expect(r.status).toBe(201);
    expect((r.body.link as Record<string, unknown>).effectiveMode).toBe("edit");
  });
});

// ============ 3) GET 的 canGrantEdit（前端置灰信号） ============

describe("GET 的 canGrantEdit 信号", () => {
  it("本人对该表有 update -> true", async () => {
    state.scopes[MEMBER] = scope(true, false, { update: true });
    const r = await getList();
    expect(r.status).toBe(200);
    expect(r.body.canGrantEdit).toBe(true);
  });

  it("本人对该表无 update -> false", async () => {
    state.scopes[MEMBER] = scope(true, false);
    const r = await getList();
    expect(r.status).toBe(200);
    expect(r.body.canGrantEdit).toBe(false);
  });

  it("本库管理者 -> true（管理权=库级全表全权限）", async () => {
    state.userId = MANAGER;
    const r = await getList();
    expect(r.body.canGrantEdit).toBe(true);
  });
});

// ============ 4) ★核心防线二：分享人降级，档位是现算的 ============

describe("分享人降级的实时档位", () => {
  it("★库里是 edit 链接、分享人已失去该表 update -> effectiveMode=view 且 degraded=true", async () => {
    state.links = [link({ id: "l1", mode: "edit", createdBy: MEMBER })];
    state.scopes[MEMBER] = scope(true, false); // 失权：可见但只读
    const r = await getList();
    expect(r.status).toBe(200);
    const dto = dtoOf(r);
    expect(dto.mode).toBe("edit"); // 登记档位不变
    expect(dto.effectiveMode).toBe("view"); // 生效档位已降级
    expect(dto.degraded).toBe(true);
    expect(dto.canEdit).toBe(false);
    expect(r.body.canGrantEdit).toBe(false);
  });

  it("分享人仍有该表 update -> effectiveMode=edit 且 degraded=false（对照组，防误降）", async () => {
    state.links = [link({ id: "l1", mode: "edit", createdBy: MEMBER })];
    state.scopes[MEMBER] = scope(true, false, { update: true });
    const r = await getList();
    const dto = dtoOf(r);
    expect(dto.mode).toBe("edit");
    expect(dto.effectiveMode).toBe("edit");
    expect(dto.degraded).toBe(false);
    expect(dto.canEdit).toBe(true);
  });

  it("分享人被收回库视野（整库都进不去）-> 同样降级为只读", async () => {
    // 请求者是仍能进库的 OTHER；分享人 MEMBER 的库视野已被收回——
    // 降级判的是【分享人】的权限，与谁在看这条列表无关。
    state.userId = OTHER;
    state.links = [link({ id: "l1", mode: "edit", createdBy: MEMBER })];
    state.scopes[MEMBER] = scope(false, false);
    const r = await getList();
    expect(r.status).toBe(200);
    const dto = dtoOf(r);
    expect(dto.effectiveMode).toBe("view");
    expect(dto.degraded).toBe(true);
    expect(dto.canEdit).toBe(false);
  });

  it("★降级判的是【分享人】不是【看列表的人】：本人有 update、分享人没有 -> 仍降级", async () => {
    state.userId = MANAGER; // 本人有全表权限，canGrantEdit=true
    state.links = [link({ id: "l1", mode: "edit", createdBy: MEMBER })];
    state.scopes[MEMBER] = scope(true, false); // 分享人只是只读
    const r = await getList();
    const dto = dtoOf(r);
    expect(r.body.canGrantEdit).toBe(true); // 置灰信号看本人
    expect(dto.effectiveMode).toBe("view"); // 生效档位看分享人
    expect(dto.degraded).toBe(true);
  });

  it("只读链接永不被标降级（degraded 只在申请过 edit 时才有意义）", async () => {
    state.links = [link({ id: "l1", mode: "view", createdBy: MEMBER })];
    state.scopes[MEMBER] = scope(true, false, { update: true });
    const r = await getList();
    const dto = dtoOf(r);
    expect(dto.degraded).toBe(false);
    expect(dto.effectiveMode).toBe("view");
  });
});

// ============ 5) DELETE 吊销权限 ============

describe("DELETE /api/tables/:tableId/share/:linkId 吊销权限", () => {
  it("★非创建者且非本库管理者 -> 403 且链接仍在", async () => {
    state.links = [link({ id: "l1", mode: "view", createdBy: MEMBER })];
    state.userId = OTHER;
    const r = await revoke("l1");
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("只有创建者或本库管理者可吊销该分享链接");
    expect(state.deletedLinkIds).toHaveLength(0);
    expect(state.links).toHaveLength(1);
  });

  it("★创建者是本人 -> 200 ok:true 且记录被删", async () => {
    state.links = [link({ id: "l1", mode: "view", createdBy: MEMBER })];
    const r = await revoke("l1");
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(state.deletedLinkIds).toEqual(["l1"]);
    expect(state.links).toHaveLength(0);
  });

  it("★对本库有管理权的人可吊销别人建的链接 -> 200", async () => {
    state.links = [link({ id: "l1", mode: "edit", createdBy: MEMBER })];
    state.userId = MANAGER;
    const r = await revoke("l1");
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(state.deletedLinkIds).toEqual(["l1"]);
  });

  it("吊销留下审计（event=share_link_revoked）", async () => {
    state.links = [link({ id: "l1", mode: "edit", createdBy: MEMBER })];
    const r = await revoke("l1");
    expect(r.status).toBe(200);
    const hit = auditCalls.find((a) => a.event === "share_link_revoked");
    expect(hit).toBeTruthy();
    expect(hit?.detail).toMatchObject({ objectType: "table", objectId: TABLE, linkId: "l1", mode: "edit" });
  });

  it("链接不存在 -> 404", async () => {
    const r = await revoke("nope");
    expect(r.status).toBe(404);
    expect(r.body.error).toContain("分享链接不存在");
  });

  it("链接属于别的表 -> 404（不能跨表吊销）", async () => {
    state.links = [link({ id: "l1", mode: "view", createdBy: MEMBER, objectId: "t-other" })];
    const r = await revoke("l1");
    expect(r.status).toBe(404);
    expect(state.deletedLinkIds).toHaveLength(0);
  });
});

// ============ 6) viewId 归属校验 ============

describe("POST 的 viewId 归属校验", () => {
  it("★viewId 不属于该表 -> 400", async () => {
    const r = await create({ mode: "view", viewId: "v-foreign" });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("视图不存在或不属于该表");
    expect(state.links).toHaveLength(0);
  });

  it("viewId 属于该表 -> 201 且回显视图", async () => {
    const r = await create({ mode: "view", viewId: "v1" });
    expect(r.status).toBe(201);
    expect((r.body.link as Record<string, unknown>).viewId).toBe("v1");
  });
});
