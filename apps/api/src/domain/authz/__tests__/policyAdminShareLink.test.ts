// share_link 第 11 枚动作的整单校验规格：
//   - actionLegalForNode：仅 kb 节点合法（base/table/doc 一律非法）；
//   - validateBatch：手授 share_link 一律 POLICY_ACTION_INVALID（scope 投影派生位）。
import { describe, expect, it } from "vitest";
import { actionLegalForNode, validateBatch, type PolicyUpsertInput } from "../policyAdmin.js";
import type { AuthzClient, AuthzNode } from "../types.js";

const node = (resourceType: string): AuthzNode =>
  ({
    id: `node_${resourceType}`,
    workspaceId: "ws1",
    parentId: null,
    kind: "entity",
    resourceType,
    resourceId: "r1",
    name: resourceType,
    path: resourceType,
    depth: 0,
    inheritAncestors: 1,
    deletedAt: null,
  }) as AuthzNode;

describe("actionLegalForNode(share_link)", () => {
  it("仅 kb 节点合法", () => {
    expect(actionLegalForNode(node("kb"), "share_link")).toBe(true);
  });

  it("base/table/doc/canvas/view 节点均非法", () => {
    for (const rt of ["base", "table", "doc", "canvas", "view"]) {
      expect(actionLegalForNode(node(rt), "share_link")).toBe(false);
    }
  });

  it("不影响 kb 节点其余动作的合法性", () => {
    const kb = node("kb");
    expect(actionLegalForNode(kb, "r")).toBe(true);
    expect(actionLegalForNode(kb, "manage_share")).toBe(true);
    expect(actionLegalForNode(kb, "manage_schema")).toBe(false);
  });
});

describe("validateBatch: share_link 手授拒绝", () => {
  // share_link 在动作循环内先于 actionLegalForNode 抛错；mock client 只需让主体存在检查通过。
  const client = {
    user: { findFirst: async () => ({ id: "u1" }) },
  } as unknown as AuthzClient;

  const upsert: PolicyUpsertInput = {
    subjectType: "user",
    subjectId: "u1",
    actions: ["share_link"],
    conditions: null,
  };

  it("手工授予 share_link -> POLICY_ACTION_INVALID（即便挂在 kb 节点）", async () => {
    await expect(validateBatch(client, node("kb"), [upsert], [])).rejects.toMatchObject({
      code: "POLICY_ACTION_INVALID",
    });
  });

  it("与其他动作混授同样拒绝（fail-closed，整单不写）", async () => {
    const mixed: PolicyUpsertInput = { ...upsert, actions: ["r", "share_link"] };
    await expect(validateBatch(client, node("kb"), [mixed], [])).rejects.toMatchObject({
      code: "POLICY_ACTION_INVALID",
    });
  });
});
