// apps/web/src/features/collab/__tests__/collab-overlay.test.tsx
// 两个编辑器叠加层（协同光标 / 块占用遮罩）的渲染契约。
//
// 环境限制（如实记录，勿假装覆盖）：本仓 vitest 跑 node 环境且**没有 jsdom**，
//   因此这里只能覆盖「渲染期不崩 + 无协同时零 DOM」，**无法**覆盖：
//     - TreeWalker / Range.getBoundingClientRect 的真实取位（block-cursor-locator.ts 的 DOM 函数）
//     - 滚动/resize 后的重新量测（overlay-anchors.ts 的 useDomTicker）
//     - 遮罩是否真的挡住了点击（需要真实指针事件）
//   这些必定要在浏览器里人工验收。能在 node 里测的纯数学已经全部下沉到
//   block-cursor-locator.test.ts 与 overlay-anchors.test.ts。
//
// D6 的核心断言就是这里的「零 DOM」：不建立协同连接时，页面 DOM 必须与引入前逐元素一致。

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import type { CollabPresenceEntry } from "@gx/shared-types";
import { CollabCursorLayer } from "../CollabCursorLayer";
import { CollabLeaseLayer } from "../CollabLeaseLayer";

const NO_CONTAINER = { current: null as HTMLElement | null };
/** SSR 下 containerRef.current 恒为 null，所有 DOM 量测都会被跳过。 */
const NO_SOURCE = (): string | null => null;

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

const docSelection = { kind: "doc" as const, blockId: "b1", offset: 3, length: 0 };

describe("CollabCursorLayer", () => {
  it("重点：D6 —— 无人在线时零 DOM", () => {
    expect(
      renderToString(
        <CollabCursorLayer containerRef={NO_CONTAINER} entries={[]} selfId="me" getBlockSource={NO_SOURCE} />,
      ),
    ).toBe("");
  });

  it("重点：D6 —— 名单里只有自己时零 DOM", () => {
    expect(
      renderToString(
        <CollabCursorLayer
          containerRef={NO_CONTAINER}
          entries={[entry({ id: "me" })]}
          selfId="me"
          getBlockSource={NO_SOURCE}
        />,
      ),
    ).toBe("");
  });

  it("他人的画布/数据表选区不属于文档，不画", () => {
    const canvas = entry({ id: "p1", selection: { kind: "canvas", elementIds: ["e1"] } });
    const table = entry({ id: "p2", selection: { kind: "table", rowId: "r1", fieldId: null } });
    expect(
      renderToString(
        <CollabCursorLayer
          containerRef={NO_CONTAINER}
          entries={[canvas, table]}
          selfId="me"
          getBlockSource={NO_SOURCE}
        />,
      ),
    ).toBe("");
  });

  it("他人有文档选区 → 无 DOM 可量测时渲染为空，但绝不抛错", () => {
    const peers = [entry({ id: "p1", selection: docSelection }), entry({ id: "p2", selection: docSelection })];
    const run = (): string =>
      renderToString(
        <CollabCursorLayer
          containerRef={NO_CONTAINER}
          entries={peers}
          selfId="me"
          getBlockSource={NO_SOURCE}
        />,
      );
    expect(run).not.toThrow();
    expect(run()).toBe("");
  });
});

describe("CollabLeaseLayer", () => {
  it("重点：D6 —— 没有他人占用时零 DOM", () => {
    expect(
      renderToString(<CollabLeaseLayer containerRef={NO_CONTAINER} entries={[]} selfId="me" />),
    ).toBe("");
  });

  it("他人带着租约但无 DOM 可遮 → 渲染为空且不抛错", () => {
    const holder = entry({
      id: "p1",
      nick: "张三",
      leases: [{ unit: "b1", since: 1_700_000_000_000, expiresAt: 1_700_000_030_000 }],
    });
    const run = (): string =>
      renderToString(<CollabLeaseLayer containerRef={NO_CONTAINER} entries={[holder]} selfId="me" />);
    expect(run).not.toThrow();
    expect(run()).toBe("");
  });

  it("只有自己持有租约时不遮自己", () => {
    const myself = entry({
      id: "me",
      leases: [{ unit: "b1", since: 1_700_000_000_000, expiresAt: 1_700_000_030_000 }],
    });
    expect(
      renderToString(<CollabLeaseLayer containerRef={NO_CONTAINER} entries={[myself]} selfId="me" />),
    ).toBe("");
  });

  it("未启用协同（entries 为空、selfId 为 null）时也安全", () => {
    expect(
      renderToString(<CollabLeaseLayer containerRef={NO_CONTAINER} entries={[]} selfId={null} />),
    ).toBe("");
  });
});
