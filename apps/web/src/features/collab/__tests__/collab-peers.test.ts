// apps/web/src/features/collab/__tests__/collab-peers.test.ts
// 名单切分的回归。「自己不算他人」这条判定一旦写错，头像列表会把自己当成第二个协作者、
// 自己的光标会被当成别人的光标画出来，所以按连接 id 判定的语义在这里锁死。

import { describe, expect, it } from "vitest";
import type { CollabPresenceEntry } from "@gx/shared-types";
import {
  GUEST_DISPLAY_NAME,
  MEMBER_DISPLAY_NAME,
  displayNameOf,
  initialOf,
  splitPresence,
} from "../collab-peers";

function entry(partial: Partial<CollabPresenceEntry> & { id: string }): CollabPresenceEntry {
  return {
    kind: "user",
    userId: `u-${partial.id}`,
    nick: partial.id,
    color: "#3A6DF0",
    selection: null,
    leases: [],
    role: "editor",
    ...partial,
  };
}

describe("splitPresence", () => {
  it("selfId 命中时把自己摘出来，其余按原顺序进入 peers", () => {
    const entries = [entry({ id: "a" }), entry({ id: "b" }), entry({ id: "c" })];
    const { self, peers } = splitPresence(entries, "b");
    expect(self?.id).toBe("b");
    expect(peers.map((p) => p.id)).toEqual(["a", "c"]);
  });

  it("selfId 不在名单里时 self 为 null，全员算他人", () => {
    const entries = [entry({ id: "a" }), entry({ id: "b" })];
    const { self, peers } = splitPresence(entries, "zzz");
    expect(self).toBeNull();
    expect(peers.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("selfId 为 null（未连上/未启用）时全员算他人", () => {
    const entries = [entry({ id: "a" })];
    const { self, peers } = splitPresence(entries, null);
    expect(self).toBeNull();
    expect(peers).toHaveLength(1);
  });

  it("名单为空时不炸", () => {
    expect(splitPresence([], "a")).toEqual({ self: null, peers: [] });
  });

  it("重点：同账号两个标签页 —— userId 相同但 id 不同 → 互不算自己（DESIGN §5.1 两光标符合预期）", () => {
    const entries = [
      entry({ id: "conn-1", userId: "u-alice" }),
      entry({ id: "conn-2", userId: "u-alice" }),
    ];
    const { self, peers } = splitPresence(entries, "conn-1");
    expect(self?.id).toBe("conn-1");
    expect(peers.map((p) => p.id)).toEqual(["conn-2"]);
  });

  it("两条同名的访客（userId 均为 null）也不会被折叠成一个人", () => {
    const entries = [
      entry({ id: "g1", kind: "guest", userId: null, nick: "匿名" }),
      entry({ id: "g2", kind: "guest", userId: null, nick: "匿名" }),
    ];
    expect(splitPresence(entries, "g1").peers.map((p) => p.id)).toEqual(["g2"]);
  });
});

describe("displayNameOf", () => {
  it("正常昵称原样返回", () => {
    expect(displayNameOf(entry({ id: "a", nick: "张三" }))).toBe("张三");
  });

  it("前后空白被 trim", () => {
    expect(displayNameOf(entry({ id: "a", nick: "  李四  " }))).toBe("李四");
  });

  it("访客缺昵称 → 匿名", () => {
    expect(displayNameOf(entry({ id: "a", kind: "guest", nick: "" }))).toBe(GUEST_DISPLAY_NAME);
  });

  it("登录用户缺昵称 → 协作者", () => {
    expect(displayNameOf(entry({ id: "a", kind: "user", nick: "   " }))).toBe(MEMBER_DISPLAY_NAME);
  });
});

describe("initialOf", () => {
  it("中文取首字", () => {
    expect(initialOf("张三丰")).toBe("张");
  });

  it("英文取首字母并转大写", () => {
    expect(initialOf("alice")).toBe("A");
    expect(initialOf("Bob")).toBe("B");
  });

  it("重点：代理对字符不被劈成半个（U+20BB7）", () => {
    expect(initialOf("𠮷野")).toBe("𠮷");
    expect(initialOf("𠮷野")).not.toBe("\ud842");
  });

  it("空串/纯空白 → '?'", () => {
    expect(initialOf("")).toBe("?");
    expect(initialOf("   ")).toBe("?");
  });
});
