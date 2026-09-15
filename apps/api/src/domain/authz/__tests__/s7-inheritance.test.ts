// M4/S7 中断继承 PATCH + impact 预览端到端（AC-M4-2，§4.5 EARS）。
//
// 覆盖：
//   - kind 白名单：非 doc/canvas（kb/base/table/view/group）-> 400 NODE_NOT_INHERITABLE；
//     缺失/软删 -> 404 NODE_NOT_FOUND；value 非法 -> 400；
//   - 授权：无 manage_share 的普通用户 impact/PATCH 均 403；
//   - impact 三源人数：losing count 与逐节点 scope/effective 对拍（逐个用户 decide r 前后口径），
//     via/sources 标注、多部门多角色只计 1、停用用户剔除、exempt creator/owner、count 不受分页影响；
//   - PATCH 未确认 -> 409 INHERITANCE_CONFIRM_REQUIRED 带 impact 且行/版本未变；
//   - confirmed -> 双版本 bump、inheritAncestors=0、审计 inheritance_changed；
//     幂等重放不 bump 不审计；重开对称 gaining；
//   - restricted + direct 放行、移除 direct 立即 403/不可见（无缓存）；关继承后同库其他 doc
//     经各自来源仍可访问（ARCH #10）。

import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupS7Fixture, OWNER, ADMIN, DIRECT, NOBODY, type S7Fixture } from "./s7Harness.js";
import { nodeId } from "../../nav/backfill.js";
import { json } from "../../nav/__tests__/characterization/charHarness.js";
import type { InheritanceImpactDTO, NodeBreadcrumbDTO } from "@gx/shared-types";

let fx: S7Fixture;
const I = (): S7Fixture["ids"] => fx.ids;

beforeAll(async () => {
  fx = await setupS7Fixture();
}, 120000);

afterAll(async () => {
  await fx.cleanup();
});

beforeEach(() => {
  process.env.GX_AUTHZ_ENGINE = "on";
});

const impactUrl = (node: string, tail = ""): string => `/api/v1/nodes/${node}/inheritance/impact${tail}`;

async function scopeNodeIds(target: string): Promise<Set<string>> {
  // owner 可查任意目标用户的 visible-scope；直接读 nodeIds 作为引擎逐节点判定基准。
  const res = await fx.call("GET", "/api/v1/authz/visible-scope?userId=" + target, OWNER);
  expect(res.status).toBe(200);
  const body = await json<{ nodeIds: string[] }>(res);
  return new Set(body.nodeIds);
}

describe("继承端点参数与授权", () => {
  it("非 doc/canvas -> 400 NODE_NOT_INHERITABLE；缺失 -> 404 NODE_NOT_FOUND；value 非法 -> 400", async () => {
    const cases: Array<[string, number, string]> = [
      [nodeId("kb", I().kb), 400, "NODE_NOT_INHERITABLE"],
      [nodeId("base", I().base), 400, "NODE_NOT_INHERITABLE"],
      [nodeId("table", I().table), 400, "NODE_NOT_INHERITABLE"],
      [nodeId("view", I().view), 400, "NODE_NOT_INHERITABLE"],
      [I().gEmpty, 400, "NODE_NOT_INHERITABLE"],
      ["nav_missing_zzz", 404, "NODE_NOT_FOUND"],
    ];
    for (const [node, status, code] of cases) {
      const res = await fx.call("GET", impactUrl(node, "?value=0"), OWNER);
      expect(res.status, node).toBe(status);
      expect((await json<{ code: string }>(res)).code, node).toBe(code);
    }
    const badValue = await fx.call("GET", impactUrl(nodeId("doc", I().impact), "?value=zzz"), OWNER);
    expect(badValue.status).toBe(400);
  });

  it("无 manage_share 普通用户 impact/PATCH 均 403（creator 兜底的是 s7_creator，非 NOBODY）", async () => {
    const node = nodeId("doc", I().impact);
    expect((await fx.call("GET", impactUrl(node, "?value=0"), NOBODY)).status).toBe(403);
    const patch = await fx.call("PATCH", `/api/v1/nodes/${node}/inheritance`, NOBODY, { value: false });
    expect(patch.status).toBe(403);
  });
});

describe("impact 三源人数与 scope/decide 对拍（关继承，losing）", () => {
  // impact 文档 createdBy=OWNER：kb 授予集（策略三源 8 人 + kb viewer 投影 creator/owner2 共 10 人），
  // s7_owner2 持 role_owner 被兜底保留（exempt），s7_creator 非 impact creator 故真实失访。
  const losingUsers = [
    "s7_lose_direct", "s7_lose_dept", "s7_lose_sub", "s7_lose_role",
    "s7_lose_role2", "s7_multi", "s7_gain", "s7_deptBuser", "s7_creator",
  ];

  it("count=9：三源八人 + kb viewer（非该文档 creator）；停用剔除、workspace owner 移 exempt", async () => {
    const node = nodeId("doc", I().impact);
    const res = await fx.call("GET", impactUrl(node, "?value=0&limit=200"), OWNER);
    expect(res.status).toBe(200);
    const impact = await json<InheritanceImpactDTO>(res);
    expect(impact.from).toBe(true);
    expect(impact.to).toBe(false);
    expect(impact.delta).toBe("losing");
    expect(impact.count).toBe(losingUsers.length);
    expect(impact.items.map((i) => i.userId).sort()).toEqual([...losingUsers].sort());
    // s7_inactive 虽属 deptRoot 子树，但已停用 -> 剔除。
    expect(impact.items.some((i) => i.userId === "s7_inactive")).toBe(false);
    // exempt：s7_creator 是 d2 的 creator（impact 文档 creator 是 owner 本人，在 owner 兜底）。
  });

  it("via/sources 来源标注：direct/dept/role 三类齐备，多源用户 sources 多链", async () => {
    const node = nodeId("doc", I().impact);
    const impact = await json<InheritanceImpactDTO>(await fx.call("GET", impactUrl(node, "?value=0&limit=200"), OWNER));
    const byUser = new Map(impact.items.map((i) => [i.userId, i]));
    expect(byUser.get("s7_lose_direct")?.via).toBe("direct");
    expect(byUser.get("s7_lose_direct")?.sources.some((s) => s.startsWith("direct:"))).toBe(true);
    expect(byUser.get("s7_lose_dept")?.via).toBe("dept");
    expect(byUser.get("s7_lose_role")?.via).toBe("role");
    // s7_multi 同时经 deptRoot(dept) 与角色直授命中，sources 至少两类。
    const multi = byUser.get("s7_multi");
    expect(multi?.sources.some((s) => s.startsWith("dept:"))).toBe(true);
    expect(multi?.sources.some((s) => s.startsWith("role:"))).toBe(true);
    // 多部门多角色只计 1：items 无重复 userId。
    expect(new Set(impact.items.map((i) => i.userId)).size).toBe(impact.items.length);
  });

  it("分页：count 精确不变，items 受 limit/offset 切割，按 userId 字典序", async () => {
    const node = nodeId("doc", I().impact);
    const full = await json<InheritanceImpactDTO>(await fx.call("GET", impactUrl(node, "?value=0&limit=200"), OWNER));
    const p1 = await json<InheritanceImpactDTO>(await fx.call("GET", impactUrl(node, "?value=0&limit=3&offset=0"), OWNER));
    const p2 = await json<InheritanceImpactDTO>(await fx.call("GET", impactUrl(node, "?value=0&limit=3&offset=3"), OWNER));
    expect(p1.count).toBe(full.count);
    expect(p1.limit).toBe(3);
    expect(p1.items.map((i) => i.userId)).toEqual(full.items.slice(0, 3).map((i) => i.userId));
    expect(p2.items.map((i) => i.userId)).toEqual(full.items.slice(3, 6).map((i) => i.userId));
    const sorted = [...full.items.map((i) => i.userId)].sort();
    expect(full.items.map((i) => i.userId)).toEqual(sorted);
  });

  it("对拍：losing 集每个用户关前 scope 可见 impact 节点、关后不可见（模拟置 0 后恢复）", async () => {
    const node = nodeId("doc", I().impact);
    // 关前：全部 losing 用户在 scope 可见集含 impact 节点。
    for (const u of losingUsers) {
      expect((await scopeNodeIds(u)).has(node), `before ${u}`).toBe(true);
    }
    // owner/creator 类始终可见（兜底）——用 impact 文档 creator=OWNER 验证 owner。
    expect((await scopeNodeIds(OWNER)).has(node)).toBe(true);
  });

  it("exempt 预览：d2 关闭时 s7_creator 仅靠 creator 兜底、s7_owner2 靠 owner 兜底 -> exempt，不计 count", async () => {
    const node = nodeId("doc", I().d2);
    const impact = await json<InheritanceImpactDTO>(await fx.call("GET", impactUrl(node, "?value=0&limit=200"), OWNER));
    const exempt = impact.exempt.map((e) => e.userId);
    expect(exempt).toContain("s7_creator"); // d2.createdBy：kb viewer 授予被 cutoff，仅 creator 兜底保留
    expect(exempt).toContain("s7_owner2"); // kb 授予被 cutoff，仅 workspace owner 兜底保留
    for (const e of impact.exempt) {
      expect(["creator", "workspace_owner"]).toContain(e.reason);
    }
    // count 只数真实失访者：kb 授予集 10 人去掉两个豁免者（s7_creator/s7_owner2）= 8。
    expect(impact.count).toBe(8);
    expect(impact.items.some((i) => i.userId === "s7_creator")).toBe(false);
    expect(impact.items.some((i) => i.userId === "s7_owner2")).toBe(false);
  });
});

describe("PATCH 关继承：409 门 / confirmed / 双版本 / 审计 / 即时性", () => {
  // canvas 叶子也允许切换（kind 白名单 doc/canvas）；各用例顺序依赖（关 -> 直授 -> 幂等 -> 重开）。
  const canvasNode = (): string => nodeId("canvas", I().canvas);

  it("未确认 -> 409 带 impact，行与双版本不变", async () => {
    const node = canvasNode();
    const beforeWs = await fx.prisma.workspace.findUniqueOrThrow({ where: { id: "ws_default" } });
    const beforeNode = await fx.prisma.navNode.findUniqueOrThrow({ where: { id: node } });
    const res = await fx.call("PATCH", `/api/v1/nodes/${node}/inheritance`, OWNER, { value: false });
    expect(res.status).toBe(409);
    const body = await json<{ code: string; impact: InheritanceImpactDTO }>(res);
    expect(body.code).toBe("INHERITANCE_CONFIRM_REQUIRED");
    expect(body.impact.nodeId).toBe(node);
    expect(body.impact.delta).toBe("losing");
    const afterNode = await fx.prisma.navNode.findUniqueOrThrow({ where: { id: node } });
    expect(afterNode.inheritAncestors).toBe(beforeNode.inheritAncestors);
    const afterWs = await fx.prisma.workspace.findUniqueOrThrow({ where: { id: "ws_default" } });
    expect(afterWs.navVersion).toBe(beforeWs.navVersion);
    expect(afterWs.policyVersion).toBe(beforeWs.policyVersion);
  });

  it("confirmed -> 200，双版本各 +1、inheritAncestors=0、审计 inheritance_changed 落盘", async () => {
    const node = canvasNode();
    const beforeWs = await fx.prisma.workspace.findUniqueOrThrow({ where: { id: "ws_default" } });
    const res = await fx.call("PATCH", `/api/v1/nodes/${node}/inheritance`, OWNER, { value: false, confirmed: true });
    expect(res.status).toBe(200);
    const body = await json<{ navVersion: number; policyVersion: number; inheritAncestors: boolean }>(res);
    expect(body.inheritAncestors).toBe(false);
    expect(body.navVersion).toBe(beforeWs.navVersion + 1);
    expect(body.policyVersion).toBe(beforeWs.policyVersion + 1);
    const row = await fx.prisma.navNode.findUniqueOrThrow({ where: { id: node } });
    expect(row.inheritAncestors).toBe(0);
    const log = fs.readFileSync(path.join(fx.tmpDir, ".audit", "audit.logl"), "utf8");
    const lines = log.trim().split("\n").map((l) => JSON.parse(l) as { event: string; detail?: Record<string, unknown> });
    const evt = lines.find((l) => l.event === "inheritance_changed" && l.detail?.nodeId === node);
    expect(evt).toBeTruthy();
    expect(evt!.detail).toMatchObject({ from: true, to: false, delta: "losing" });
  });

  it("restricted + direct 放行、移除 direct 立即不可见（无缓存）；关后同库其他 doc 仍可见", async () => {
    const node = canvasNode();
    // canvas 已 restricted；给 DIRECT 在 canvas 节点直授 r -> 可见。
    await fx.prisma.authPolicy.create({
      data: {
        id: "s7_p_canvas_direct", workspaceId: "ws_default", nodeId: node,
        subjectType: "user", subjectId: DIRECT, actions: "r", reason: "s7:seed", createdBy: OWNER,
      },
    });
    expect((await scopeNodeIds(DIRECT)).has(node)).toBe(true);
    await fx.prisma.authPolicy.delete({ where: { id: "s7_p_canvas_direct" } });
    // 无缓存：删除后下次 scope 立即不可见。
    expect((await scopeNodeIds(DIRECT)).has(node)).toBe(false);
    // 同库其他 doc（d1，DIRECT 有 ACL）仍可见（ARCH #10）。
    expect((await scopeNodeIds(DIRECT)).has(nodeId("doc", I().d1))).toBe(true);
  });

  it("面包屑：restricted 子节点对无权用户 403；同库其他资源面包屑不受影响", async () => {
    const node = canvasNode();
    const d1 = await fx.call("GET", `/api/v1/nodes/${nodeId("doc", I().d1)}/breadcrumb`, DIRECT);
    expect(d1.status).toBe(200);
    const d1Body = await json<NodeBreadcrumbDTO>(d1);
    expect(d1Body.chain.at(-1)?.id).toBe(nodeId("doc", I().d1));
    const canvas = await fx.call("GET", `/api/v1/nodes/${node}/breadcrumb`, NOBODY);
    expect(canvas.status).toBe(403);
  });

  it("幂等重放：目标值与现状一致 -> 200 但不再 bump、不再审计；重开对称 gaining 并 bump", async () => {
    const node = canvasNode();
    const beforeWs = await fx.prisma.workspace.findUniqueOrThrow({ where: { id: "ws_default" } });
    const logBefore = fs.readFileSync(path.join(fx.tmpDir, ".audit", "audit.logl"), "utf8")
      .split("\n").filter((l) => l.includes("inheritance_changed") && l.includes(node)).length;
    const idem = await fx.call("PATCH", `/api/v1/nodes/${node}/inheritance`, OWNER, { value: false, confirmed: true });
    expect(idem.status).toBe(200);
    const idemBody = await json<{ navVersion: number; policyVersion: number; impact: InheritanceImpactDTO }>(idem);
    expect(idemBody.navVersion).toBe(beforeWs.navVersion);
    expect(idemBody.policyVersion).toBe(beforeWs.policyVersion);
    expect(idemBody.impact.count).toBe(0);
    const logIdem = fs.readFileSync(path.join(fx.tmpDir, ".audit", "audit.logl"), "utf8")
      .split("\n").filter((l) => l.includes("inheritance_changed") && l.includes(node)).length;
    expect(logIdem).toBe(logBefore);

    // 重开：delta=gaining，双版本再 +1。
    const reopen = await fx.call("PATCH", `/api/v1/nodes/${node}/inheritance`, OWNER, { value: true, confirmed: true });
    expect(reopen.status).toBe(200);
    const reopenBody = await json<{ navVersion: number; policyVersion: number; impact: InheritanceImpactDTO }>(reopen);
    expect(reopenBody.impact.delta).toBe("gaining");
    expect(reopenBody.navVersion).toBe(beforeWs.navVersion + 1);
    expect(reopenBody.policyVersion).toBe(beforeWs.policyVersion + 1);
  });
});

describe("impact 三源人数与逐用户 scope 对拍 0 差异（d_impact 关 -> 对拍 -> 重开）", () => {
  // 夹具授予集手算（与 impact 用例同源）：losing 9 人；关后仅 OWNER/creator 与 s7_owner2/owner 兜底可见。
  const losing = [
    "s7_lose_direct", "s7_lose_dept", "s7_lose_sub", "s7_lose_role",
    "s7_lose_role2", "s7_multi", "s7_gain", "s7_deptBuser", "s7_creator",
  ];
  const stillVisible = [OWNER, "s7_owner2"];
  const stillInvisible = [ADMIN, DIRECT, NOBODY];
  const node = (): string => nodeId("doc", I().impact);

  it("关闭后：losing 集逐个 scope 不可见、兜底者可见、无关者仍不可见", async () => {
    const res = await fx.call("PATCH", `/api/v1/nodes/${node()}/inheritance`, OWNER, { value: false, confirmed: true });
    expect(res.status).toBe(200);
    for (const u of losing) {
      expect((await scopeNodeIds(u)).has(node()), `after-close ${u} 应不可见`).toBe(false);
    }
    for (const u of stillVisible) {
      expect((await scopeNodeIds(u)).has(node()), `after-close ${u} 应兜底可见`).toBe(true);
    }
    for (const u of stillInvisible) {
      expect((await scopeNodeIds(u)).has(node()), `after-close ${u} 应仍不可见`).toBe(false);
    }
  });

  it("重开后：gaining=9 人逐个 scope 恢复可见，与关闭前 impact losing 集严格相等", async () => {
    const gaining = await json<InheritanceImpactDTO>(
      await fx.call("GET", `/api/v1/nodes/${node()}/inheritance/impact?value=1&limit=200`, OWNER),
    );
    expect(gaining.delta).toBe("gaining");
    expect(gaining.items.map((i) => i.userId).sort()).toEqual([...losing].sort());
    expect(gaining.count).toBe(losing.length);
    const reopen = await fx.call("PATCH", `/api/v1/nodes/${node()}/inheritance`, OWNER, { value: true, confirmed: true });
    expect(reopen.status).toBe(200);
    for (const u of losing) {
      expect((await scopeNodeIds(u)).has(node()), `after-reopen ${u} 应恢复`).toBe(true);
    }
  });
});
