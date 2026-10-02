// apps/web/src/features/contacts/member-roster.test.tsx
// 成员字段复用件的纯渲染回归（react-dom/server，无网络、无新增依赖）。
// 锁的是：① 有/无头像两种头像形态；② userId 命中名册显名字、未命中兜底短 id、
// 非字符串值显占位 —— 保证成员字段在存量数据（停用成员/旧 id）下也不炸。
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import { MemberAvatar, MemberDisplay, type RosterMember } from "./member-roster";

const m = (over: Partial<RosterMember> = {}): RosterMember => ({
  id: "u1234567",
  displayName: "张三",
  email: "z@x.com",
  avatarUrl: null,
  ...over,
});

describe("MemberAvatar", () => {
  it("无头像时显姓名首字", () => {
    const html = render(<MemberAvatar member={m()} />);
    expect(html).toContain("张");
    expect(html).toContain("rounded-full");
  });

  it("有头像时渲染 img", () => {
    const html = render(<MemberAvatar member={m({ avatarUrl: "http://x/a.png" })} />);
    expect(html).toContain("<img");
    expect(html).toContain("http://x/a.png");
  });

  it("member 为 null 时显问号", () => {
    const html = render(<MemberAvatar member={null} />);
    expect(html).toContain("?");
  });
});

describe("MemberDisplay", () => {
  const byId = new Map<string, RosterMember>([["u1234567", m()]]);

  it("userId 命中名册显头像+名字", () => {
    const html = render(<MemberDisplay userId="u1234567" byId={byId} />);
    expect(html).toContain("张三");
  });

  it("userId 不在名册（停用/旧 id）兜底显短 id，不抛错", () => {
    const html = render(<MemberDisplay userId="u9999999" byId={byId} />);
    expect(html).toContain("u9999999");
    expect(html).not.toContain("张三");
  });

  it("空串/非字符串值显占位", () => {
    expect(render(<MemberDisplay userId="" byId={byId} />)).toContain("—");
    expect(render(<MemberDisplay userId={null} byId={byId} />)).toContain("—");
    expect(render(<MemberDisplay userId={42} byId={byId} />)).toContain("—");
  });
});
