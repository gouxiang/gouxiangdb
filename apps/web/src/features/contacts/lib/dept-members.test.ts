// M2/S7「添加已有成员」去重口径单测：已在本部门的成员不得进入候选，避免重复 add。
import { describe, it, expect } from "vitest";
import { assignableMembers, isInDept, type DeptMemberLike } from "./dept-members";

function member(id: string, deptIds: string[]): DeptMemberLike {
  return { id, deptMemberships: deptIds.map((departmentId) => ({ departmentId })) };
}

const ALL: DeptMemberLike[] = [
  member("u1", []),
  member("u2", ["d1"]),
  member("u3", ["d1", "d2"]),
  member("u4", ["d2"]),
];

describe("isInDept 部门归属判定", () => {
  it("命中任一归属即算在本部门（兼岗也算）", () => {
    expect(isInDept(ALL[2]!, "d2")).toBe(true);
    expect(isInDept(ALL[3]!, "d1")).toBe(false);
  });

  it("无任何归属的成员不在任何部门", () => {
    expect(isInDept(ALL[0]!, "d1")).toBe(false);
  });
});

describe("assignableMembers 候选过滤", () => {
  it("剔除已在本部门的成员，保留其余", () => {
    expect(assignableMembers(ALL, "d1").map((m) => m.id)).toEqual(["u1", "u4"]);
  });

  it("换一个部门口径结果随之变化", () => {
    expect(assignableMembers(ALL, "d2").map((m) => m.id)).toEqual(["u1", "u2"]);
  });

  it("未知部门：全部成员都可添加", () => {
    expect(assignableMembers(ALL, "d9").map((m) => m.id)).toEqual(["u1", "u2", "u3", "u4"]);
  });

  it("空目录返回空数组，不抛错", () => {
    expect(assignableMembers([], "d1")).toEqual([]);
  });

  it("不修改入参数组（返回新数组）", () => {
    const input = [member("u9", ["d1"])];
    const out = assignableMembers(input, "d1");
    expect(out).toHaveLength(0);
    expect(input).toHaveLength(1);
  });
});
