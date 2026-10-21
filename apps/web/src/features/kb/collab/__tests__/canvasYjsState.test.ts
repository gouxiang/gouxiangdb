// canvasYjsState 回归：画布 PlaitElement[] ↔ Y.Doc 绑定叶子层（离线协同阶段 A：纯映射）。
//
// 纯 node 断言（无 jsdom / 无网络 / 无 React），仓库无 jsdom，也不许新增依赖。覆盖：
//   ① 三键字面量与 key 前缀规则
//   ② 10 类白名单元素往返无损（含单段文本骨架 / 无文本 / 自定义 gxNote 键）
//   ③ 单段文本拆 Y.Text；多段 / 带 marks / 非对象 text 不拆（整值 LWW，富文本无损）
//   ④ 未知 / 坏元素 yToBoard 跳过计数
//   ⑤ 幂等再对账：不重建 key、不重建 Y.Text（字符级历史保住）、不发多余更新
//   ⑥ clientId 前缀防撞、order 重排 / 删除剪枝 / 新增尾追
//   ⑦ 两个 Y.Doc 交错编辑后收敛

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  Y_CANVAS_ORDER_KEY,
  Y_CANVAS_ELEMENTS_KEY,
  Y_CANVAS_TEXTS_KEY,
  KNOWN_ELEMENT_TYPES,
  applyYText,
  boardToY,
  businessIdFromKey,
  canonical,
  createCollabCanvas,
  elementKey,
  hydrateElement,
  minimalTextDiff,
  singleLeafParagraph,
  splitElementText,
  yToBoard,
  type CollabCanvas,
} from "../canvasYjsState";

/* ---------------- 夹具 ---------------- */

const std = (s: string): Record<string, unknown> => ({ children: [{ text: s }] });
/** 裸段经 Y.Text 往返后的还原值：无骨架时 applyYText 补默认 type:paragraph（与服务端逐字一致）。 */
const para = (s: string): Record<string, unknown> => ({ type: "paragraph", children: [{ text: s }] });
const centered = (s: string): Record<string, unknown> => ({
  type: "paragraph",
  align: "center",
  children: [{ text: s }],
});
const marksText = (): Record<string, unknown> => ({
  children: [
    { text: "粗" },
    { text: "体", bold: true },
  ],
});
const multiPara = (): Record<string, unknown> => ({
  children: [{ text: "第一段" }, { text: "第二段" }],
});

/** 10 类白名单元素，混合「标准单段文本 / 无文本」，并带嵌套对象/数组属性。 */
function allTypedBoard(): Record<string, unknown>[] {
  return [
    { id: "g1", type: "geometry", shape: "rectangle", points: [[0, 0], [100, 0], [100, 100], [0, 100]], text: centered("矩形") },
    { id: "t1", type: "text", text: std("文字") },
    { id: "i1", type: "image", shape: "image", points: [[1, 1], [2, 1], [2, 2], [1, 2]], file: { url: "u", width: 10, height: 20 } },
    { id: "tb1", type: "table", columns: [{ width: 1 }], cells: [[std("格")]] },
    { id: "s1", type: "swimlane", lanes: [{ id: "l1" }] },
    { id: "a1", type: "arrow-line", points: [[0, 0], [50, 50]], text: std("箭头") },
    { id: "v1", type: "vector-line", points: [[0, 0], [9, 9]] },
    { id: "m1", type: "mind", topic: { text: std("主题") } },
    { id: "mc1", type: "mind_child", topic: { text: std("分支") } },
    { id: "mm1", type: "mindmap", gxNote: "自定义键原样透传" },
  ];
}

/**
 * 往返期望：只有元素【顶层】裸段（无 type/align 骨架）会被 applyYText 补回默认 type:paragraph
 * （t1/a1）；table.cells / mind.topic 内嵌的 std 是整值保留、不拆不补（与服务端 canvasFlush
 * applyYText 逐字一致，已由 api 侧 canvasYjs-parity.test.ts 锁定）。
 */
function expectedRoundTrip(): Record<string, unknown>[] {
  return allTypedBoard().map((el) =>
    el["id"] === "t1" || el["id"] === "a1"
      ? { ...el, text: para((el["text"] as { children: [{ text: string }] }).children[0].text) }
      : el,
  );
}

function wired(doc = new Y.Doc(), clientId = "c1"): { b: CollabCanvas; clientId: string } {
  return { b: createCollabCanvas(doc), clientId };
}

/** 双向互灌一次 update（模拟一次网络往返后的收敛）。 */
function converge(a: Y.Doc, c: Y.Doc): void {
  Y.applyUpdate(c, Y.encodeStateAsUpdate(a));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(c));
}

/* ---------------- 契约常量 / key 规则 ---------------- */

describe("Y 契约常量", () => {
  it("三键字面量与服务端 canvasFlush 逐字相同", () => {
    expect([Y_CANVAS_ORDER_KEY, Y_CANVAS_ELEMENTS_KEY, Y_CANVAS_TEXTS_KEY]).toEqual([
      "order",
      "elements",
      "texts",
    ]);
  });

  it("白名单恰好 10 类 plait 元素", () => {
    expect([...KNOWN_ELEMENT_TYPES].sort()).toEqual(
      ["arrow-line", "geometry", "image", "mind", "mind_child", "mindmap", "swimlane", "table", "text", "vector-line"].sort(),
    );
  });

  it("createCollabCanvas 懒建三件套且重复取同实例", () => {
    const doc = new Y.Doc();
    const b = createCollabCanvas(doc);
    expect(b.order).toBe(doc.getArray("order"));
    expect(b.elements).toBe(doc.getMap("elements"));
    expect(b.texts).toBe(doc.getMap("texts"));
    expect(createCollabCanvas(doc).order).toBe(b.order);
  });
});

describe("elementKey / businessIdFromKey", () => {
  it("拼前缀 / 剥前缀互逆（取最后冒号后）", () => {
    expect(elementKey("c1", "abcDE")).toBe("c1:abcDE");
    expect(businessIdFromKey("c1:abcDE")).toBe("abcDE");
    expect(businessIdFromKey("server:x:y")).toBe("y");
    expect(businessIdFromKey("nocolon")).toBe("nocolon");
  });

  it("不同 client 同业务 id 不会撞 key", () => {
    expect(elementKey("cA", "x")).not.toBe(elementKey("cB", "x"));
  });
});

/* ---------------- 往返无损 ---------------- */

describe("boardToY → yToBoard：往返无损", () => {
  it("10 类白名单元素逐字段还原（嵌套数组/对象/单段文本/无文本/gxNote）", () => {
    const { b, clientId } = wired();
    const board = allTypedBoard();
    expect(boardToY(b, board, { clientId }).upserted).toBe(10);
    const { elements, dropped } = yToBoard(b);
    expect(dropped).toBe(0);
    // 顶层裸段 t1/a1 被补默认 type:paragraph，其余字面无损（含 topic/cells 内嵌 std 整值）。
    expect(elements).toEqual(expectedRoundTrip());
  });

  it("再还原一次结果稳定（纯函数）", () => {
    const { b, clientId } = wired();
    const board = allTypedBoard();
    boardToY(b, board, { clientId });
    expect(yToBoard(b).elements).toEqual(yToBoard(b).elements);
  });

  it("标准段落回填保留 type/align 骨架", () => {
    const { b, clientId } = wired();
    boardToY(b, [{ id: "g", type: "geometry", text: centered("居中") }], { clientId });
    expect(yToBoard(b).elements[0]?.text).toEqual(centered("居中"));
  });

  it("无骨架裸段：属性 map 不留 text 键，Y.Text 承载；还原补默认 type:paragraph", () => {
    const { b, clientId } = wired();
    boardToY(b, [{ id: "t", type: "text", text: std("裸段") }], { clientId });
    const attr = b.elements.get("c1:t");
    expect(attr?.has("text")).toBe(false);
    expect(b.texts.get("c1:t")?.toString()).toBe("裸段");
    // applyYText 对无骨架 Y.Text 回填默认段落类型（与服务端 canvasFlush 逐字一致）。
    expect(yToBoard(b).elements[0]?.text).toEqual(para("裸段"));
  });

  it("非对象 text（字符串）原样整值往返", () => {
    const { b, clientId } = wired();
    const raw = { id: "x", type: "geometry", text: "裸字符串" };
    boardToY(b, [raw], { clientId });
    expect(yToBoard(b).elements).toEqual([raw]);
  });
});

/* ---------------- 文本拆出规则 ---------------- */

describe("文本拆出：只有标准单段单 leaf 才进 Y.Text", () => {
  it("标准段落：属性 map 留骨架、texts 存字符级 Y.Text", () => {
    const { b, clientId } = wired();
    boardToY(b, [{ id: "g", type: "geometry", text: centered("甲") }], { clientId });
    expect(b.texts.get("c1:g")).toBeInstanceOf(Y.Text);
    expect(b.elements.get("c1:g")?.get("text")).toEqual({ type: "paragraph", align: "center" });
  });

  it("带 marks 的 leaf 不拆：texts 无键、属性 map 整值保留", () => {
    const { b, clientId } = wired();
    const raw = { id: "g", type: "geometry", text: marksText() };
    boardToY(b, [raw], { clientId });
    expect(b.texts.has("c1:g")).toBe(false);
    expect(b.elements.get("c1:g")?.get("text")).toEqual(marksText());
    expect(yToBoard(b).elements).toEqual([raw]);
  });

  it("多段不拆：整值 LWW、往返无损", () => {
    const { b, clientId } = wired();
    const raw = { id: "t", type: "text", text: multiPara() };
    boardToY(b, [raw], { clientId });
    expect(b.texts.has("c1:t")).toBe(false);
    expect(yToBoard(b).elements).toEqual([raw]);
  });

  it("singleLeafParagraph / splitElementText 判定与服务端同口径", () => {
    expect(singleLeafParagraph(std("a"))).toBe("a");
    expect(singleLeafParagraph(centered("a"))).toBe("a");
    expect(singleLeafParagraph(marksText())).toBeNull();
    expect(singleLeafParagraph(multiPara())).toBeNull();
    expect(singleLeafParagraph("裸字符串")).toBeNull();
    expect(singleLeafParagraph(null)).toBeNull();
    expect(singleLeafParagraph({ children: [] })).toBeNull();
    expect(singleLeafParagraph({ children: [{ text: 1 }] })).toBeNull();

    const split = splitElementText({ id: "g", type: "geometry", text: centered("甲") });
    expect(split.text).toBe("甲");
    expect(split.attr["text"]).toEqual({ type: "paragraph", align: "center" });
    const split2 = splitElementText({ id: "t", type: "text", text: std("甲") });
    expect(split2.text).toBe("甲");
    expect("text" in split2.attr).toBe(false);
  });
});

/* ---------------- dropped：未知 / 坏元素 ---------------- */

describe("yToBoard：未知 / 坏元素跳过计数", () => {
  it("未知 type 写入 Y 后被还原侧过滤（写侧宽容、读侧白名单）", () => {
    const { b, clientId } = wired();
    boardToY(
      b,
      [
        { id: "ok", type: "geometry", points: [[0, 0], [1, 1]] },
        { id: "future", type: "future-plugin", x: 1 },
      ],
      { clientId },
    );
    expect(b.elements.has("c1:future")).toBe(true);
    const { elements, dropped } = yToBoard(b);
    expect(elements.map((e) => e["id"])).toEqual(["ok"]);
    expect(dropped).toBe(1);
  });

  it("属性 map 损坏（非 Y.Map）→ dropped 不炸整批", () => {
    const { b, clientId } = wired();
    boardToY(b, [{ id: "ok", type: "geometry" }, { id: "bad", type: "geometry" }], { clientId });
    b.doc.transact(() => {
      b.elements.set("c1:bad", "not-a-map" as unknown as Y.Map<unknown>);
    });
    const { elements, dropped } = yToBoard(b);
    expect(elements.map((e) => e["id"])).toEqual(["ok"]);
    expect(dropped).toBe(1);
  });

  it("缺 id 且无法从 key 恢复 → hydrateElement 返回 null", () => {
    const doc = new Y.Doc();
    const b = createCollabCanvas(doc);
    doc.transact(() => {
      const m = new Y.Map<unknown>();
      m.set("type", "geometry");
      b.elements.set(":", m);
      b.order.push([":"]);
    });
    expect(hydrateElement(":", b.elements.get(":"), b.texts)).toBeNull();
    expect(yToBoard(b).dropped).toBe(1);
  });
});

/* ---------------- 幂等 / 历史保住 ---------------- */

describe("幂等再对账：不重建 key、不重建 Y.Text", () => {
  it("同板再对账 upserted=0，order 与整 doc 字节不变", () => {
    const { b, clientId } = wired(new Y.Doc(), "c1");
    const board = allTypedBoard();
    boardToY(b, board, { clientId });
    const before = Y.encodeStateAsUpdate(b.doc);
    const orderBefore = b.order.toArray();
    const r2 = boardToY(b, board, { clientId });
    expect(r2.upserted).toBe(0);
    expect(b.order.toArray()).toEqual(orderBefore);
    expect(Y.encodeStateAsUpdate(b.doc)).toEqual(before);
  });

  it("沿用既有完整 key（属性 map 的业务 id 反查），新字符不重建 Y.Text", () => {
    const { b, clientId } = wired(new Y.Doc(), "c1");
    boardToY(b, [{ id: "g", type: "geometry", text: std("甲乙") }], { clientId });
    const yt = b.texts.get("c1:g");
    expect(yt).toBeInstanceOf(Y.Text);
    // 模拟本地协同：在 Y.Text 中间插入一个字符（产生字符级历史）。
    b.doc.transact(() => yt!.insert(1, "X"));
    expect(yt!.toString()).toBe("甲X乙");

    const r = boardToY(b, [{ id: "g", type: "geometry", text: std("甲乙") }], { clientId });
    expect(r.upserted).toBe(0);
    expect(b.order.toArray()).toEqual(["c1:g"]);
    // 同一个 Y.Text 实例（没有 delete + new），文本经最小补丁被收回目标值。
    expect(b.texts.get("c1:g")).toBe(yt);
    expect(yt!.toString()).toBe("甲乙");
  });

  it("属性漂移（缺键 / 改值 / 多键）被最小对账修正", () => {
    const { b, clientId } = wired();
    boardToY(b, [{ id: "g", type: "geometry", shape: "r", points: [[0, 0]] }], { clientId });
    const m = b.elements.get("c1:g")!;
    b.doc.transact(() => {
      m.set("shape", "ellipse");
      m.set("ghost", 1);
      m.delete("points");
    });
    boardToY(b, [{ id: "g", type: "geometry", shape: "r", points: [[0, 0]] }], { clientId });
    expect(m.get("shape")).toBe("r");
    expect(m.get("points")).toEqual([[0, 0]]);
    expect(m.has("ghost")).toBe(false);
  });
});

/* ---------------- key 前缀 / order / 剪枝 ---------------- */

describe("key 前缀与 order 对账", () => {
  it("新元素 key 带 clientId 前缀；同 doc 同 id 再对账不换 key", () => {
    const { b } = wired(new Y.Doc(), "me");
    boardToY(b, [{ id: "g", type: "geometry" }], { clientId: "me" });
    expect(b.order.toArray()).toEqual(["me:g"]);
    boardToY(b, [{ id: "g", type: "geometry" }], { clientId: "other" });
    expect(b.order.toArray()).toEqual(["me:g"]);
  });

  it("两个 client 各自新建同业务 id 落不同 key（防撞）", () => {
    const a = createCollabCanvas(new Y.Doc());
    const c = createCollabCanvas(new Y.Doc());
    boardToY(a, [{ id: "x", type: "geometry" }], { clientId: "cA" });
    boardToY(c, [{ id: "x", type: "geometry" }], { clientId: "cB" });
    expect(a.order.toArray()).toEqual(["cA:x"]);
    expect(c.order.toArray()).toEqual(["cB:x"]);
  });

  it("order 重排：key 沿用、Y.Text 不重建、还原顺序更新", () => {
    const { b, clientId } = wired();
    const board1 = [
      { id: "a", type: "text", text: std("甲") },
      { id: "b", type: "text", text: std("乙") },
    ];
    boardToY(b, board1, { clientId });
    const ytA = b.texts.get("c1:a");
    const board2 = [...board1].reverse();
    boardToY(b, board2, { clientId });
    expect(b.order.toArray()).toEqual(["c1:b", "c1:a"]);
    expect(b.texts.get("c1:a")).toBe(ytA);
    expect(yToBoard(b).elements.map((e) => e["id"])).toEqual(["b", "a"]);
  });

  it("删除元素：elements/texts 同步剪枝，不留孤儿", () => {
    const { b, clientId } = wired();
    boardToY(
      b,
      [
        { id: "a", type: "text", text: std("甲") },
        { id: "b", type: "geometry" },
      ],
      { clientId },
    );
    boardToY(b, [{ id: "b", type: "geometry" }], { clientId });
    expect(b.order.toArray()).toEqual(["c1:b"]);
    expect(b.elements.has("c1:a")).toBe(false);
    expect(b.texts.has("c1:a")).toBe(false);
  });

  it("新增元素尾追且带前缀", () => {
    const { b, clientId } = wired();
    boardToY(b, [{ id: "a", type: "geometry" }], { clientId });
    boardToY(b, [{ id: "a", type: "geometry" }, { id: "n", type: "text", text: std("新") }], { clientId });
    expect(b.order.toArray()).toEqual(["c1:a", "c1:n"]);
    expect(b.texts.get("c1:n")?.toString()).toBe("新");
  });

  it("文本从有到无 / 从标准变 marks：剪掉残留 Y.Text，防止 hydrate 复活旧文本", () => {
    const { b, clientId } = wired();
    boardToY(b, [{ id: "g", type: "geometry", text: std("甲") }], { clientId });
    expect(b.texts.has("c1:g")).toBe(true);

    boardToY(b, [{ id: "g", type: "geometry" }], { clientId });
    expect(b.texts.has("c1:g")).toBe(false);
    expect(yToBoard(b).elements[0]?.["text"]).toBeUndefined();

    boardToY(b, [{ id: "g", type: "geometry", text: marksText() }], { clientId });
    expect(b.texts.has("c1:g")).toBe(false);
    expect(yToBoard(b).elements[0]?.["text"]).toEqual(marksText());
  });

  it("非规范元素（非对象 / 无字符串 id）不进 Y", () => {
    const { b, clientId } = wired();
    const r = boardToY(
      b,
      [null, 42, { type: "geometry" }, { id: "", type: "geometry" }, { id: "ok", type: "geometry" }],
      { clientId },
    );
    expect(r.upserted).toBe(1);
    expect(b.order.toArray()).toEqual(["c1:ok"]);
  });
});

/* ---------------- minimalTextDiff / canonical / applyYText ---------------- */

describe("minimalTextDiff：最小前后缀补丁", () => {
  it("单字符增删改只动一处", () => {
    expect(minimalTextDiff("hello", "heXllo")).toEqual({ index: 2, remove: 0, insert: "X" });
    expect(minimalTextDiff("hello", "helo")).toEqual({ index: 3, remove: 1, insert: "" });
    expect(minimalTextDiff("中文", "中文法")).toEqual({ index: 2, remove: 0, insert: "法" });
  });
  it("无变化补丁恒等", () => {
    expect(minimalTextDiff("same", "same")).toEqual({ index: 4, remove: 0, insert: "" });
  });
  it("补丁套用必得目标", () => {
    const apply = (s: string, p: { index: number; remove: number; insert: string }) =>
      s.slice(0, p.index) + p.insert + s.slice(p.index + p.remove);
    for (const [prev, next] of [["", "a"], ["a", ""], ["abc", "axbyc"], ["甲尾", "甲X尾"]] as const) {
      expect(apply(prev, minimalTextDiff(prev, next))).toBe(next);
    }
  });
});

describe("canonical：规范化深比免疫键序", () => {
  it("对象键序不同但结构相同 => 相等；数组保序 => 不等", () => {
    expect(canonical({ a: 1, b: [1, { c: 2 }] })).toBe(canonical({ b: [1, { c: 2 }], a: 1 }));
    expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
    expect(canonical({ a: 1 })).not.toBe(canonical({ a: 2 }));
  });
});

describe("applyYText", () => {
  // Y.Text 必须先挂到 Y.Doc 才能读写（游离 Y.Text 读取会抛 "Add Yjs type to a document"）。
  function attachedText(s: string): Y.Text {
    const doc = new Y.Doc();
    const yt = new Y.Text();
    doc.getMap<Y.Text>("t").set("k", yt);
    yt.insert(0, s);
    return yt;
  }

  it("无 Y.Text 时保留骨架原值；有 Y.Text 时回填段落", () => {
    const rich = marksText();
    const el1: Record<string, unknown> = {};
    applyYText(el1, rich, undefined);
    expect(el1["text"]).toEqual(rich);

    const el2: Record<string, unknown> = {};
    applyYText(el2, { type: "paragraph", align: "right" }, attachedText("回填"));
    expect(el2["text"]).toEqual({ type: "paragraph", align: "right", children: [{ text: "回填" }] });

    const el3: Record<string, unknown> = {};
    applyYText(el3, undefined, attachedText("裸"));
    expect(el3["text"]).toEqual({ type: "paragraph", children: [{ text: "裸" }] });
  });
});

/* ---------------- 并发收敛 ---------------- */

describe("两个 Y.Doc 交错后收敛", () => {
  it("两端用各自前缀铺板并互灌后，order/元素/文本逐字节一致", () => {
    const a = createCollabCanvas(new Y.Doc());
    const c = createCollabCanvas(new Y.Doc());
    boardToY(a, [{ id: "x", type: "text", text: std("甲") }], { clientId: "cA" });
    converge(a.doc, c.doc);
    expect(c.order.toArray()).toEqual(["cA:x"]);
    expect(Y.encodeStateAsUpdate(a.doc)).toEqual(Y.encodeStateAsUpdate(c.doc));
  });

  it("B 端对同一已有元素再对账沿用 A 的 key（不重建），收敛后仍只有一个 key", () => {
    const a = createCollabCanvas(new Y.Doc());
    const c = createCollabCanvas(new Y.Doc());
    boardToY(a, [{ id: "x", type: "text", text: std("甲") }], { clientId: "cA" });
    converge(a.doc, c.doc);
    // B 端拿到板后做一次幂等对账（前缀可能不同），必须沿用 cA:x。
    boardToY(c, [{ id: "x", type: "text", text: std("甲") }], { clientId: "cB" });
    expect(c.order.toArray()).toEqual(["cA:x"]);
    converge(a.doc, c.doc);
    expect(a.order.toArray()).toEqual(["cA:x"]);
    expect(Y.encodeStateAsUpdate(a.doc)).toEqual(Y.encodeStateAsUpdate(c.doc));
  });
});
