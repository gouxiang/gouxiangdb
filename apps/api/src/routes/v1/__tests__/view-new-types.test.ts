// 层级 / 甘特两种新视图（#562）端到端：真 createApp / 真 JWT / 真迁移临时库。
//
// 覆盖：
//  - POST /api/views?tableId= 创建 type=tree / type=gantt -> 201；
//  - 回读 config 含新增键默认值（treeParentFieldId/ganttStartFieldId.../ganttZoom）；
//  - 非法类型仍 400（zod 卡口未失效）；
//  - 用两类视图 GET /api/records?viewId= 正常取数（parseViewConfig 新键透传不崩）；
//  - 无 schema 权限者建视图 -> 403。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  makeNavHarness,
  seedBaseWithStarter,
  type CharHarness,
} from "../../../domain/nav/__tests__/navRouteHarness.js";

let h: CharHarness;
let tableId = "";

interface NewViewBody {
  view: {
    id: string;
    type: string;
    config: Record<string, unknown>;
  };
}

async function createView(userId: string, body: unknown): Promise<Response> {
  return await h.app.request(`/api/views?tableId=${tableId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await h.auth(userId)) },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  h = await makeNavHarness("gx-view-newtypes-");
  await h.createUser("owner", { email: "nt-owner@x.com", displayName: "所有者" });
  await h.createUser("viewer", { email: "nt-viewer@x.com", displayName: "阅读者" });
  h.grantRole("owner", "role_owner");
  await h.prisma.roleAssignment.create({
    data: { roleId: "role_viewer", subjectType: "user", subjectId: "viewer", scopeType: "workspace", createdBy: "seed" },
  });

  const seeded = await seedBaseWithStarter(h, "nt");
  tableId = seeded.tableId;

  await h.prisma.roleLibraryScope.upsert({
    where: { roleId_libraryKind_libraryId: { roleId: "role_viewer", libraryKind: "base", libraryId: seeded.baseId } },
    create: { roleId: "role_viewer", libraryKind: "base", libraryId: seeded.baseId, visible: 1, canManage: 0, canShare: 0 },
    update: { visible: 1, canManage: 0 },
  });
}, 120000);

afterAll(async () => {
  await h.cleanup();
});

describe("POST /api/views 新类型", () => {
  it("创建 type=tree -> 201 且含层级默认键", async () => {
    const res = await createView("owner", { name: "层级视图", type: "tree" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as NewViewBody;
    expect(body.view.type).toBe("tree");
    expect(body.view.config.treeParentFieldId).toBeNull();
  });

  it("创建 type=gantt -> 201 且含甘特默认键", async () => {
    const res = await createView("owner", {
      name: "甘特视图",
      type: "gantt",
      config: { ganttZoom: "week" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as NewViewBody;
    expect(body.view.type).toBe("gantt");
    expect(body.view.config.ganttStartFieldId).toBeNull();
    expect(body.view.config.ganttEndFieldId).toBeNull();
    expect(body.view.config.ganttProgressFieldId).toBeNull();
    expect(body.view.config.ganttDependencyFieldId).toBeNull();
    expect(body.view.config.ganttZoom).toBe("week");
  });

  it("非法类型 -> 400", async () => {
    const res = await createView("owner", { name: "x", type: "bogus" });
    expect(res.status).toBe(400);
  });

  it("无 schema 权限者 -> 403", async () => {
    const res = await createView("viewer", { name: "层级视图", type: "tree" });
    expect(res.status).toBe(403);
  });
});

describe("新视图下列表取数", () => {
  it("tree / gantt 视图 GET records 均 200", async () => {
    const tree = await createView("owner", { name: "层级视图2", type: "tree" });
    const treeId = ((await tree.json()) as NewViewBody).view.id;
    const gantt = await createView("owner", { name: "甘特视图2", type: "gantt" });
    const ganttId = ((await gantt.json()) as NewViewBody).view.id;

    for (const vid of [treeId, ganttId]) {
      const res = await h.app.request(
        `/api/records?tableId=${tableId}&viewId=${vid}`,
        { headers: await h.auth("owner") },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { records: unknown[] };
      expect(Array.isArray(body.records)).toBe(true);
    }
  });
});
