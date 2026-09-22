// 阶段 1 · 在线名单裁剪回归：awareness 载荷是远端不可信输入，
// 必须按白名单裁剪后才能进 UI（nick 截断、color 严格校验、selection/leases 形状校验）。
import { describe, expect, it } from "vitest";
import { MAX_NICK_LEN, toPresenceEntries } from "../collab-presence";

/** 拼一个 awareness states 映射（key 是 clientID，值任意 JSON）。 */
function statesOf(...entries: Record<string, unknown>[]): Map<number, Record<string, unknown>> {
  return new Map(entries.map((raw, i) => [i + 1, raw] as const));
}

const VALID_USER = {
  id: "peer-1",
  kind: "user" as const,
  userId: "u-1",
  nick: "阿强",
  color: "#1F6FEB",
};

describe("toPresenceEntries 白名单", () => {
  it("合法条目原样通过，role 缺省为 editor", () => {
    const out = toPresenceEntries(statesOf({ user: VALID_USER }));
    expect(out).toEqual([
      {
        id: "peer-1",
        kind: "user",
        userId: "u-1",
        nick: "阿强",
        color: "#1F6FEB",
        selection: null,
        leases: [],
        role: "editor",
      },
    ]);
  });

  it("nick 超长截断到 32 字符", () => {
    const long = "很长的昵称".repeat(20); // 100 字
    const out = toPresenceEntries(statesOf({ user: { ...VALID_USER, nick: long } }));
    expect(out).toHaveLength(1);
    expect(out[0]!.nick).toHaveLength(MAX_NICK_LEN);
    expect(out[0]!.nick).toBe(long.slice(0, MAX_NICK_LEN));
  });

  it.each(["red", "#FFF", "#GGGGGG", "#1234567", "", "#fff2 junk"])(
    "color 不合法则整条丢弃：%j",
    (color) => {
      expect(toPresenceEntries(statesOf({ user: { ...VALID_USER, color } }))).toEqual([]);
    },
  );

  it("缺失 user / id / 非法 kind 的条目被丢弃", () => {
    expect(toPresenceEntries(statesOf({}))).toEqual([]);
    expect(toPresenceEntries(statesOf({ user: { kind: "user", color: "#123456" } }))).toEqual([]);
    expect(toPresenceEntries(statesOf({ user: { id: "a", kind: "bot", color: "#123456" } }))).toEqual(
      [],
    );
    expect(toPresenceEntries(statesOf({ user: "not an object" }))).toEqual([]);
  });

  it("非法 selection 置 null；合法的 doc / canvas / table 三形保留", () => {
    const pick = (selection: unknown) => toPresenceEntries(statesOf({ user: VALID_USER, selection }))[0]!.selection;

    expect(pick({ kind: "doc", blockId: "b1", offset: 3, length: 5 })).toEqual({
      kind: "doc",
      blockId: "b1",
      offset: 3,
      length: 5,
    });
    expect(pick({ kind: "canvas", elementIds: ["e1", "e2"] })).toEqual({
      kind: "canvas",
      elementIds: ["e1", "e2"],
    });
    expect(pick({ kind: "table", rowId: "r1", fieldId: null })).toEqual({
      kind: "table",
      rowId: "r1",
      fieldId: null,
    });

    // 形状不全的都要退回 null，而不是带着半成品进 UI
    expect(pick({ kind: "doc", blockId: "b1", offset: 3 })).toBeNull();
    expect(pick({ kind: "doc", blockId: "", offset: "x", length: 1 })).toBeNull();
    expect(pick({ kind: "canvas", elementIds: "e1" })).toBeNull();
    expect(pick({ kind: "canvas", elementIds: ["e1", 2] })).toBeNull();
    expect(pick({ kind: "table", fieldId: "f1" })).toBeNull();
    expect(pick({ kind: "unknown" })).toBeNull();
    expect(pick(null)).toBeNull();
  });

  it("非法 leases 置空数组；合法租约按原值保留", () => {
    const leases = [{ unit: "b1", since: 1, expiresAt: 2 }];
    expect(toPresenceEntries(statesOf({ user: VALID_USER, leases }))[0]!.leases).toEqual(leases);

    const bad: unknown[] = ["not-an-array", 42, null, undefined];
    for (const raw of bad) {
      // 数组形状才接受，其余一律空数组
      expect(toPresenceEntries(statesOf({ user: VALID_USER, leases: raw }))[0]!.leases).toEqual([]);
    }
    // 数组里混入非法元素时只丢该元素
    const mixed = [...leases, { unit: "b2", since: NaN, expiresAt: 2 }, { unit: 3 }];
    expect(toPresenceEntries(statesOf({ user: VALID_USER, leases: mixed }))[0]!.leases).toEqual(leases);
  });

  it("访问者条目：kind=guest 且 nick 缺失时回落「匿名」，userId 为 null", () => {
    const out = toPresenceEntries(
      statesOf({ user: { id: "peer-2", kind: "guest", color: "#9A6700", role: "viewer" } }),
    );
    expect(out[0]).toEqual({
      id: "peer-2",
      kind: "guest",
      userId: null,
      nick: "匿名",
      color: "#9A6700",
      selection: null,
      leases: [],
      role: "viewer",
    });
  });

  it("多个 clientID 会各自成条（同一账号多标签页 = 多条 presence）", () => {
    const out = toPresenceEntries(
      statesOf(
        { user: { ...VALID_USER, id: "tab-a" } },
        { user: { ...VALID_USER, id: "tab-b", userId: "u-2" } },
      ),
    );
    expect(out.map((e) => e.id)).toEqual(["tab-a", "tab-b"]);
  });
});
