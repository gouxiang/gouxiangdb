// apps/web/src/features/kb/collab/__tests__/useCollabDoc.test.tsx
// 阶段 2 中间层 useCollabDoc 的契约测试。
//
// 环境限制（如实记录）：本仓 vitest 跑 node 且**没有 jsdom**，useEffect 在 SSR 下不执行，
// 因此这里覆盖的是：
//   ① D6 空壳契约 —— 未启用协同时所有写入口必须 no-op（这是"单机零变化"的代码级证据）
//   ② syncStructureToY —— 本地 Block[] → Y 的对账（纯 Y 逻辑，可在 node 跑）
// 覆盖不到的：播种时机（useEffect）、观察者回调分发、DOM 热补 —— 需在浏览器人工验收。

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import * as Y from "yjs";
import type { Block } from "@gx/blocks";
import { bindBlocks, hydrateBlocks, seedBlocks, textOf, type BlocksBinding } from "../blocksYjs";
import { syncStructureToY, useCollabDoc } from "../useCollabDoc";

const p = (id: string, text: string): Block => ({ id, type: "p", text });
const h = (id: string, text: string): Block => ({ id, type: "h2", text });

/** 未启用协同（doc=null / 未连通）时的探针：把关键返回值渲染成一行字符串供断言。 */
function IdleProbe({ active }: { active: boolean }) {
  const c = useCollabDoc({ doc: null, active, entries: [], selfId: null, initialBlocks: [p("a", "x")] });
  const wrote = c.writeText("a", "y");
  c.beginComposition("a");
  const committed = c.commitComposition();
  c.syncStructure([p("a", "y")]);
  return (
    <span>
      {[
        String(c.binding === null),
        String(c.blocks === null),
        String(wrote === null),
        String(committed === null),
        String(c.heldBy("a") === null),
      ].join("|")}
    </span>
  );
}

describe("useCollabDoc · D6 空壳契约", () => {
  it("未启用协同：无绑定、无 Block[]、写入口全部 no-op、无占用", () => {
    expect(renderToString(<IdleProbe active={false} />)).toBe(
      '<span>true|true|true|true|true</span>',
    );
  });

  it("未连通（active=false）即使给了 doc 也不建绑定 —— 单机行为与引入前一致", () => {
    expect(renderToString(<IdleProbe active />)).toBe(
      '<span>true|true|true|true|true</span>',
    );
  });
});

function seeded(blocks: Block[]): BlocksBinding {
  const binding = bindBlocks(new Y.Doc());
  seedBlocks(binding.y, blocks);
  return binding;
}

describe("syncStructureToY：本地 Block[] → Y 对账", () => {
  it("幂等：重复对账不新增块、不改正文", () => {
    const b = seeded([p("a", "一"), p("b", "二")]);
    syncStructureToY(b, [p("a", "一"), p("b", "二")]);
    syncStructureToY(b, [p("a", "一"), p("b", "二")]);
    expect(b.y.order.toArray()).toEqual(["a", "b"]);
    expect(hydrateBlocks(b.y).map((x) => x.text)).toEqual(["一", "二"]);
  });

  it("新增 / 删除 / 改类型 / 改正文都能落到 Y", () => {
    const b = seeded([p("a", "一"), p("b", "二")]);
    syncStructureToY(b, [h("a", "一改"), p("c", "三")]);
    const out = hydrateBlocks(b.y);
    expect(out.map((x) => x.id)).toEqual(["a", "c"]);
    expect(out[0]!.type).toBe("h2");
    expect(textOf(b.y, "a")).toBe("一改");
    expect(textOf(b.y, "c")).toBe("三");
  });

  it("正文只走最小差异，不整块替换（Y.Text 长度守恒）", () => {
    const b = seeded([p("a", "前甲乙丙丁")]);
    syncStructureToY(b, [p("a", "前甲乙X丙丁")]);
    expect(textOf(b.y, "a")).toBe("前甲乙X丙丁");
  });

  it("整包打 localOrigin —— 观察者据此跳过自己的回声", () => {
    const b = seeded([p("a", "一")]);
    const origins: unknown[] = [];
    b.y.doc.on("afterTransaction", (tr: Y.Transaction) => origins.push(tr.origin));
    syncStructureToY(b, [p("a", "二"), p("b", "三")]);
    expect(origins.length).toBeGreaterThan(0);
    for (const o of origins) expect(o).toBe(b.localOrigin);
  });

  it("集合相同、次序不同（纯移动）→ 重写 order", () => {
    const b = seeded([p("a", "一"), p("b", "二")]);
    syncStructureToY(b, [p("b", "二"), p("a", "一")]);
    expect(b.y.order.toArray()).toEqual(["b", "a"]);
  });
});
