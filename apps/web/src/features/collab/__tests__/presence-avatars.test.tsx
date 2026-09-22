// apps/web/src/features/collab/__tests__/presence-avatars.test.tsx
// 在线头像列表的渲染契约。
//
// 环境限制（如实记录）：本仓 vitest 跑 node 且无 jsdom，React 单测一律用 react-dom/server
// 的 renderToString，useEffect 不执行。本组件是纯受控渲染（无 Portal、无 effect），
// 恰好可以被完整覆盖 —— 所以「剔除自己」与「折叠」这两条必须在这一层测掉。

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import type { CollabPresenceEntry } from "@gx/shared-types";
import { AVATAR_MAX_VISIBLE, PresenceAvatars } from "../PresenceAvatars";

function entry(id: string, nick: string, kind: "user" | "guest" = "user"): CollabPresenceEntry {
  return {
    id,
    kind,
    userId: kind === "guest" ? null : `u-${id}`,
    nick,
    color: "#E08A34",
    selection: null,
    leases: [],
    role: "editor",
  };
}

describe("PresenceAvatars", () => {
  it("重点：D6 —— 没有他人时产出零 DOM（单机模式页面必须逐元素不变）", () => {
    expect(renderToString(<PresenceAvatars entries={[]} selfId="me" />)).toBe("");
  });

  it("重点：D6 —— 名单里只有自己时也是零 DOM", () => {
    expect(renderToString(<PresenceAvatars entries={[entry("me", "我")]} selfId="me" />)).toBe("");
  });

  it("自己 + 2 人 → 显示他人名字，绝不显示自己", () => {
    const html = renderToString(
      <PresenceAvatars entries={[entry("me", "我自己"), entry("a", "张三"), entry("b", "李四")]} selfId="me" />,
    );
    expect(html).toContain("张三");
    expect(html).toContain("李四");
    expect(html).not.toContain("我自己");
  });

  it("selfId 为 null（未连上/未启用）时全员按他人显示", () => {
    const html = renderToString(<PresenceAvatars entries={[entry("a", "张三")]} selfId={null} />);
    expect(html).toContain("张三");
  });

  it("超出阈值折叠为 +N，且第 N+1 个人的名字不出现在输出里", () => {
    const entries = ["p1", "p2", "p3", "p4"].map((id, i) => entry(id, `路人${i + 1}`));
    const html = renderToString(<PresenceAvatars entries={entries} selfId="me" />);
    expect(AVATAR_MAX_VISIBLE).toBe(3);
    expect(html).toContain("路人1");
    expect(html).toContain("路人3");
    // 第 4 人不再单独占一个可见 chip（只允许出现在 +N 的 title 里）
    expect(html).not.toContain(">路人4<");
    expect(html).toContain("+1");
  });

  it("折叠后的人名不丢：全部放进 +N 的 title 里", () => {
    const entries = ["p1", "p2", "p3", "p4", "p5"].map((id, i) => entry(id, `路人${i + 1}`));
    const html = renderToString(<PresenceAvatars entries={entries} selfId="me" />);
    expect(html).toContain("+2");
    expect(html).toContain("路人4、路人5");
  });

  it("显式放宽 max 时全部展示、不折叠", () => {
    const entries = ["p1", "p2", "p3", "p4"].map((id, i) => entry(id, `路人${i + 1}`));
    const html = renderToString(<PresenceAvatars entries={entries} selfId="me" max={5} />);
    expect(html).toContain("路人4");
    expect(html).not.toContain("+");
  });

  it("访客缺昵称 → 显示「匿名」（而不是空白头像行）", () => {
    const html = renderToString(
      <PresenceAvatars entries={[entry("g1", "", "guest")]} selfId="me" />,
    );
    expect(html).toContain("匿名");
  });

  it("重点：底色用服务端下发的 color，不能被替换成某个 token", () => {
    const html = renderToString(<PresenceAvatars entries={[entry("a", "张三")]} selfId="me" />);
    expect(html).toContain("#E08A34");
  });

  it("头像首字取第一个完整码点（英文转大写、代理对不被劈开）", () => {
    expect(renderToString(<PresenceAvatars entries={[entry("a", "alice")]} selfId="me" />)).toContain("A");
    expect(renderToString(<PresenceAvatars entries={[entry("a", "𠮷野")]} selfId="me" />)).toContain("𠮷");
  });

  it("名单顺序稳定：不因渲染而被重排", () => {
    const entries = [entry("z", "最后"), entry("a", "最先")];
    const html = renderToString(<PresenceAvatars entries={entries} selfId="me" />);
    expect(html.indexOf("最后")).toBeLessThan(html.indexOf("最先"));
  });
});
