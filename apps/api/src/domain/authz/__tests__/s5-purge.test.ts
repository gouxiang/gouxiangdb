// M4/S5 purge 三函数同事务清策略：view/table/doc 物理删后挂在对应节点的 auth_policies 同灭。
//
// auth_policies 对 nav_nodes 无 FK（DDL 刻意解耦），物理删节点不会级联清策略，
// 故 purgeViewNodeTx / purgeTableNodeTx / purgeDocNodeTx 必须各自在同事务显式删。
// 域级直调三函数（不经 HTTP），前置造 nav 节点 + 各来源策略行（legacy / v1 / role / dept）。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupEngineHarness, type EngineHarness } from "./engineHarness.js";

let h: EngineHarness;
let sync: typeof import("../../nav/sync.js");

async function mkNode(id: string, kind: string, parentId: string | null = null): Promise<void> {
  await h.prisma.navNode.create({
    data: {
      id, workspaceId: "ws_default", parentId, kind,
      resourceType: kind === "group" ? null : kind,
      resourceId: id.replace(/^nav_(view|table|doc|canvas)_/, ""),
      name: id, path: parentId ? `/${parentId}/${id}/` : `/${id}/`,
      depth: parentId ? 2 : 1, isSystem: 1, inheritAncestors: 1,
    },
  });
}

async function seedPolicy(id: string, nodeIdValue: string, subjectType = "user", reason: string | null = "policy:v1"): Promise<void> {
  await h.prisma.authPolicy.create({
    data: {
      id, workspaceId: "ws_default", nodeId: nodeIdValue,
      subjectType, subjectId: `${id}_subj`, actions: "r", reason, createdBy: "seed",
    },
  });
}

beforeAll(async () => {
  h = await setupEngineHarness("gx-s5-purge-");
  sync = await import("../../nav/sync.js");
}, 120000);

afterAll(async () => {
  await h.cleanup();
});

async function policyCount(nodeIdValue: string): Promise<number> {
  return await h.prisma.authPolicy.count({ where: { nodeId: nodeIdValue } });
}

describe("purgeViewNodeTx：view 节点策略同事务消失", () => {
  it("view 物理删 -> 挂在该 view 的 legacy/v1/role 策略全删", async () => {
    const viewNode = "nav_view_s5pv";
    await mkNode(viewNode, "view");
    await seedPolicy("s5pv_legacy", viewNode, "user", "legacy:acl");
    await seedPolicy("s5pv_v1", viewNode, "user", "policy:v1");
    await seedPolicy("s5pv_role", viewNode, "role", "policy:v1");
    expect(await policyCount(viewNode)).toBe(3);

    await h.prisma.$transaction((tx) => sync.purgeViewNodeTx(tx, "s5pv"));

    expect(await policyCount(viewNode)).toBe(0);
    expect(await h.prisma.navNode.findUnique({ where: { id: viewNode } })).toBeNull();
  });
});

describe("purgeTableNodeTx：table 与其子 view 节点策略同事务消失", () => {
  it("table 物理删 -> table 节点 + 子 view 节点策略全删（两节点一并清）", async () => {
    const tableNode = "nav_table_s5pt";
    const childView = "nav_view_s5pt_child";
    await mkNode(tableNode, "table");
    await mkNode(childView, "view", tableNode);
    await seedPolicy("s5pt_table_v1", tableNode, "user", "policy:v1");
    await seedPolicy("s5pt_table_dept", tableNode, "dept", "policy:v1");
    await seedPolicy("s5pt_view_v1", childView, "user", "policy:v1");
    expect(await policyCount(tableNode)).toBe(2);
    expect(await policyCount(childView)).toBe(1);

    await h.prisma.$transaction((tx) => sync.purgeTableNodeTx(tx, "s5pt"));

    expect(await policyCount(tableNode)).toBe(0);
    expect(await policyCount(childView)).toBe(0);
    expect(await h.prisma.navNode.findUnique({ where: { id: tableNode } })).toBeNull();
    expect(await h.prisma.navNode.findUnique({ where: { id: childView } })).toBeNull();
  });
});

describe("purgeDocNodeTx：doc/canvas 节点策略同事务消失", () => {
  it("doc 永久删 -> 挂在该 doc 节点的 legacy:acl 与 v1 策略全删", async () => {
    const docNode = "nav_doc_s5pd";
    await mkNode(docNode, "doc");
    await seedPolicy("s5pd_legacy", docNode, "user", "legacy:acl");
    await seedPolicy("s5pd_v1", docNode, "user", "policy:v1");
    expect(await policyCount(docNode)).toBe(2);

    await h.prisma.$transaction((tx) => sync.purgeDocNodeTx(tx, "s5pd"));

    expect(await policyCount(docNode)).toBe(0);
    expect(await h.prisma.navNode.findUnique({ where: { id: docNode } })).toBeNull();
  });
});
