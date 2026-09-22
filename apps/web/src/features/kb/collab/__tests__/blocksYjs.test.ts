// blocksYjs 回归：文档块 ↔ Y.Doc 绑定层（阶段 2 底层）。
//
// 全部为纯逻辑断言：**不依赖 DOM / jsdom / 网络** —— 仓库无 jsdom，也不许新增依赖，
// 因此本文件不覆盖 DOM 热补（那是阶段 2 接线的活），只覆盖这里承诺的能力：
//   ① 差异最小性（单字符增删改只产生一条 op，且入 Y 的就是这条 op）
//   ② hydrate / seed 幂等与往返
//   ③ 结构化操作 id 稳定
//   ④ 并发交错后两个 Y.Doc 收敛
//   ⑤ 组词期间不提交、compositionend 一次性落，且远端并发改动不被吞 / 不错位

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { Block } from "@gx/blocks";
import {
  applyPatchToText,
  beginComposition,
  bindBlocks,
  commitComposition,
  contentOf,
  createCollabBlocks,
  deltaToPatches,
  enqueuePatch,
  hydrateBlocks,
  insertBlock,
  localText,
  metaOf,
  minimalDiff,
  patchesFromEvents,
  rebasePatch,
  removeBlock,
  seedBlocks,
  setBlockMeta,
  setBlockType,
  textOf,
  type TextPatch,
  type TextPatchGroup,
} from "../blocksYjs";

/* ---------------- 工具 ---------------- */

const p = (id: string, text: string): Block => ({ id, type: "p", text });

/** 把 aDoc 的状态双向合并到 bDoc（模拟一次网络往返后的相互收敛） */
function converge(aDoc: Y.Doc, bDoc: Y.Doc): void {
  Y.applyUpdate(bDoc, Y.encodeStateAsUpdate(aDoc));
  Y.applyUpdate(aDoc, Y.encodeStateAsUpdate(bDoc));
}

/** 起一个订阅了本地 WysiwygEditor 那种接线方式的绑定：事件自动走 patchesFromEvents */
function wired(doc: Y.Doc = new Y.Doc()) {
  const binding = bindBlocks(doc);
  const applied: TextPatchGroup[] = [];
  binding.y.texts.observeDeep((events, transaction) => {
    applied.push(...patchesFromEvents(binding, events, transaction));
  });
  return { binding, applied };
}

describe("minimalDiff：差异最小性", () => {
  it("单字符增删改都只产出一条 op（改 = 删 + 插，同处）", () => {
    // 纯插入：前后缀重合，只有中间那一段是差异
    expect(minimalDiff("hello", "heXllo")).toEqual({ index: 2, remove: 0, insert: "X" });
    expect(minimalDiff("hell", "hellX")).toEqual({ index: 4, remove: 0, insert: "X" });
    // 纯删除
    expect(minimalDiff("hello", "helo")).toEqual({ index: 3, remove: 1, insert: "" });
    expect(minimalDiff("中文输入", "中文输入法")).toEqual({ index: 4, remove: 0, insert: "法" });
    expect(minimalDiff("甲乙丙", "甲丙")).toEqual({ index: 1, remove: 1, insert: "" });
    // 末字符替换：不得不删掉被换掉的那个字符，但仍是**一条** op
    expect(minimalDiff("hello", "hellX")).toEqual({ index: 4, remove: 1, insert: "X" });
    expect(minimalDiff("hello", "hellXXX")).toEqual({ index: 4, remove: 1, insert: "XXX" });
  });

  it("同一串的全面修改才允许整段替换（无可避免）", () => {
    expect(minimalDiff("ab", "cd")).toEqual({ index: 0, remove: 2, insert: "cd" });
  });

  it("无变化时补丁恒等", () => {
    expect(minimalDiff("same", "same")).toEqual({ index: 4, remove: 0, insert: "" });
  });

  it("补丁套用后必得目标文本（含多行与中文）", () => {
    const pairs: Array<[string, string]> = [
      ["", ""],
      ["", "abc"],
      ["abc", ""],
      ["hello world", "hello brave world"],
      ["甲乙丙丁", "甲丙丁"],
      ["line1\nline2", "line1\nlineX\nline2"],
      ["**粗** 与 `码`", "**粗体** 与 `码`"],
    ];
    for (const [prev, next] of pairs) {
      expect(applyPatchToText(prev, minimalDiff(prev, next)), `${prev} → ${next}`).toBe(next);
    }
  });
});

describe("本地编辑 → Y：入 Y 的就是那条最小差异", () => {
  it("中间插入一个字符时 Y 侧只看到一条 insert delta", () => {
    const { binding } = wired();
    const id = insertBlock(binding.y, 0, "p", { text: "hello" });
    const seen: TextPatch[][] = [];
    binding.y.texts.get(id)!.observe((e) => seen.push(deltaToPatches(e.delta)));

    enqueuePatch(binding, id, "heXllo");

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([{ index: 2, remove: 0, insert: "X" }]);
    expect(textOf(binding.y, id)).toBe("heXllo");
    expect(localText(binding, id)).toBe("heXllo");
  });

  it("文本没变就完全不动 Y（不发 update）", () => {
    const { binding } = wired();
    const id = insertBlock(binding.y, 0, "p", { text: "甲乙" });
    const before = Y.encodeStateAsUpdate(binding.y.doc);
    const r = enqueuePatch(binding, id, "甲乙");
    expect(r.outcome).toBe("unchanged");
    expect(r.patch).toBeNull();
    expect(Y.encodeStateAsUpdate(binding.y.doc)).toEqual(before);
  });

  it("未知块 id 显式抛错，不静默吞", () => {
    const { binding } = wired();
    expect(() => enqueuePatch(binding, "nope", "x")).toThrow(/未知块 id/);
  });
});

describe("deltaToPatches：Y 事件 → 最小补丁序列", () => {
  it("retain / insert / delete 组合换算成按序可叠加的补丁", () => {
    expect(deltaToPatches([{ retain: 2 }, { insert: "X" }])).toEqual([{ index: 2, remove: 0, insert: "X" }]);
    expect(deltaToPatches([{ retain: 1 }, { delete: 2 }, { retain: 3 }])).toEqual([
      { index: 1, remove: 2, insert: "" },
    ]);
  });

  it("一次替换（delete+insert 紧邻）合并成单条 replace", () => {
    const patches = deltaToPatches([{ retain: 2 }, { delete: 2 }, { insert: "XY" }]);
    expect(patches).toEqual([{ index: 2, remove: 2, insert: "XY" }]);
    expect(applyPatchToText("abcdef", patches[0]!)).toBe("abXYef");
  });

  it("非字符串插入显式抛错", () => {
    expect(() => deltaToPatches([{ insert: { fake: 1 } }])).toThrow(/不支持非字符串插入/);
  });
});

describe("patchesFromEvents：回声跳过与非文本事件忽略", () => {
  it("本地自己的写入不会被当成远端补丁返回", () => {
    const { binding, applied } = wired();
    const id = insertBlock(binding.y, 0, "p", { text: "abc" });
    enqueuePatch(binding, id, "abcd");
    expect(applied).toEqual([]);
  });

  it("远端（无 origin）更新会被换算成补丁组，并推进 shadow", () => {
    const { binding, applied } = wired();
    const id = insertBlock(binding.y, 0, "p", { text: "abc" });
    const other = createCollabBlocks(new Y.Doc());
    Y.applyUpdate(other.doc, Y.encodeStateAsUpdate(binding.y.doc));
    other.texts.get(id)!.insert(0, "XY");

    Y.applyUpdate(binding.y.doc, Y.encodeStateAsUpdate(other.doc));

    expect(applied).toEqual([{ blockId: id, patches: [{ index: 0, remove: 0, insert: "XY" }] }]);
    expect(textOf(binding.y, id)).toBe("XYabc");
    expect(localText(binding, id)).toBe("XYabc");
  });
});

describe("hydrate / seed：幂等与往返", () => {
  const seed: Block[] = [
    { id: "b1", type: "h1", text: "一级标题" },
    { id: "b2", type: "task", text: "待办事项", checked: true },
    { id: "b3", type: "code", lang: "ts", code: "const a: number = 1;" },
    { id: "b4", type: "p", text: "普通段落" },
  ];

  it("首次 seed 建 4 块，二次 seed 一块不增（幂等）", () => {
    const { binding } = wired();
    expect(seedBlocks(binding.y, seed).added).toEqual(["b1", "b2", "b3", "b4"]);
    const order1 = binding.y.order.toArray();
    const again = seedBlocks(binding.y, seed);
    expect(again.added).toEqual([]);
    expect(again.patched).toEqual([]);
    expect(binding.y.order.toArray()).toEqual(order1);
    expect(order1).toEqual(["b1", "b2", "b3", "b4"]);
  });

  it("hydrate 往返逐字段一致（含 task.checked / code.lang / code.code）", () => {
    const { binding } = wired();
    seedBlocks(binding.y, seed);
    expect(hydrateBlocks(binding.y)).toEqual(seed);
    expect(hydrateBlocks(binding.y)).toEqual(hydrateBlocks(binding.y));
  });

  it("已存在但正文漂移时，二次 seed 用最小差异补齐而非重建", () => {
    const { binding } = wired();
    seedBlocks(binding.y, [p("b1", "甲乙")]);
    binding.y.texts.get("b1")!.insert(2, "丙");
    const r = seedBlocks(binding.y, [p("b1", "甲乙")]);
    expect(r.added).toEqual([]);
    expect(r.patched).toEqual(["b1"]);
    expect(textOf(binding.y, "b1")).toBe("甲乙");
  });

  it("Y 里多出来的非白名单键不会被 hydrate 写进 Block[]", () => {
    const { binding } = wired();
    seedBlocks(binding.y, seed);
    setBlockMeta(binding.y, "b4", { ghostKey: "should-not-leak" });
    expect(metaOf(binding.y, "b4").ghostKey).toBe("should-not-leak");
    expect(hydrateBlocks(binding.y).find((b) => b.id === "b4")).toEqual(p("b4", "普通段落"));
  });
});

describe("结构性操作：id 稳定、三处同步清理", () => {
  it("insertBlock 返回稳定 id（与 newBlock 同源的 uid 形态）且落库和 hydrate 都对得上", () => {
    const { binding } = wired();
    const id = insertBlock(binding.y, 0, "h2", { text: "标题二" });
    expect(id).toMatch(/^b[0-9a-z]{4,}$/);
    const again = insertBlock(binding.y, 1, "h2", { text: "标题三" });
    expect(again).not.toBe(id);
    expect(hydrateBlocks(binding.y).map((b) => [b.id, b.type, b.text])).toEqual([
      [id, "h2", "标题二"],
      [again, "h2", "标题三"],
    ]);
  });

  it("改块类型后正文不动", () => {
    const { binding } = wired();
    const id = insertBlock(binding.y, 0, "p", { text: "转标题" });
    setBlockType(binding.y, id, "h1");
    const b = hydrateBlocks(binding.y)[0]!;
    expect([b.type, b.text]).toEqual(["h1", "转标题"]);
  });

  it("removeBlock 同时清掉 order / blocks / texts，不留孤儿键", () => {
    const { binding } = wired();
    seedBlocks(binding.y, [p("b1", "甲"), p("b2", "乙")]);
    removeBlock(binding.y, "b1");
    expect(binding.y.order.toArray()).toEqual(["b2"]);
    expect(binding.y.blocks.has("b1")).toBe(false);
    expect(binding.y.texts.has("b1")).toBe(false);
    expect(hydrateBlocks(binding.y)).toEqual([p("b2", "乙")]);
  });

  it("结构性操作遇未知 id 显式抛错", () => {
    const { binding } = wired();
    expect(() => setBlockType(binding.y, "nope", "p")).toThrow(/未知块 id/);
    expect(() => setBlockMeta(binding.y, "nope", { lang: "ts" })).toThrow(/未知块 id/);
  });

  it("contentOf 按块类型取正文字段（代码块取 code、公式取 formula）", () => {
    expect(contentOf({ id: "1", type: "p", text: "x" })).toBe("x");
    expect(contentOf({ id: "1", type: "code", code: "print(1)" })).toBe("print(1)");
    expect(contentOf({ id: "1", type: "math", formula: "x^2" })).toBe("x^2");
    expect(contentOf({ id: "1", type: "hr" })).toBe("");
  });
});

describe("并发交错：两个 Y.Doc 必须收敛", () => {
  it("两端同时改同一块（首部 vs 尾部）→ 合并后两边逐字节相同且都保留双方输入", () => {
    const a = wired();
    const b = wired();
    const id = insertBlock(a.binding.y, 0, "p", { text: "甲" });
    seedBlocks(b.binding.y, [{ id, type: "p", text: "甲" }]);
    converge(a.binding.y.doc, b.binding.y.doc);

    enqueuePatch(a.binding, id, "前甲");
    enqueuePatch(b.binding, id, "甲尾");
    converge(a.binding.y.doc, b.binding.y.doc);

    expect(textOf(a.binding.y, id)).toBe(textOf(b.binding.y, id));
    expect(textOf(a.binding.y, id)).toBe("前甲尾");
  });

  it("并发插入新块：两边最终顺序与 id 集合完全一致", () => {
    const a = wired();
    const b = wired();
    seedBlocks(a.binding.y, [p("base", "底")]);
    converge(a.binding.y.doc, b.binding.y.doc);

    const idA = insertBlock(a.binding.y, 1, "p", { text: "A 端插的" });
    const idB = insertBlock(b.binding.y, 1, "p", { text: "B 端插的" });
    converge(a.binding.y.doc, b.binding.y.doc);

    const orderA = a.binding.y.order.toArray();
    const orderB = b.binding.y.order.toArray();
    expect(orderA).toEqual(orderB);
    expect(new Set(orderA)).toEqual(new Set(["base", idA, idB]));
    expect(a.binding.y.order.length).toBe(3);
  });

  it("A 删块 + B 改同一块的正文：删 Operation 优先，两边收敛且不残留孤儿键", () => {
    const a = wired();
    const b = wired();
    seedBlocks(a.binding.y, [p("x1", "将被删除"), p("x2", "留下")]);
    converge(a.binding.y.doc, b.binding.y.doc);

    removeBlock(a.binding.y, "x1");
    enqueuePatch(b.binding, "x1", "将被删除（B 端追加）");
    converge(a.binding.y.doc, b.binding.y.doc);

    expect(a.binding.y.order.toArray()).toEqual(b.binding.y.order.toArray());
    expect(a.binding.y.order.toArray()).toEqual(["x2"]);
    expect(hydrateBlocks(a.binding.y)).toEqual([p("x2", "留下")]);
    expect(hydrateBlocks(b.binding.y)).toEqual([p("x2", "留下")]);
  });
});

describe("组词（中文输入法）：组词期不提交", () => {
  it("begin → enqueue 只入队不入 Y，commit 才一次性落", () => {
    const { binding } = wired();
    const id = insertBlock(binding.y, 0, "p", { text: "甲" });
    const before = Y.encodeStateAsUpdate(binding.y.doc);

    beginComposition(binding, id);
    // enqueuePatch 收的是「块的完整当前文本」（与 onInput 读 textContent 同形），组词中反复
    // 喂最新文本只会覆盖队列，不会累积；未到 compositionend 之前 Y 侧必须毫无变化。
    expect(enqueuePatch(binding, id, "甲中").outcome).toBe("queued");
    expect(enqueuePatch(binding, id, "甲中").outcome).toBe("queued");
    expect(Y.encodeStateAsUpdate(binding.y.doc)).toEqual(before);
    expect(textOf(binding.y, id)).toBe("甲");

    const commit = commitComposition(binding);
    expect(commit.local).toEqual({ index: 1, remove: 0, insert: "中" });
    expect(commit.remote).toEqual([]);
    expect(textOf(binding.y, id)).toBe("甲中");
    expect(localText(binding, id)).toBe("甲中");
  });

  it("组词期间到达的远端补丁被推迟，commit 时才交回上层", () => {
    const { binding } = wired();
    const id = insertBlock(binding.y, 0, "p", { text: "甲乙丙" });
    const other = createCollabBlocks(new Y.Doc());
    Y.applyUpdate(other.doc, Y.encodeStateAsUpdate(binding.y.doc));

    beginComposition(binding, id);
    enqueuePatch(binding, id, "甲乙丙丁"); // 组词中：本地末尾加「丁」
    other.texts.get(id)!.insert(0, "前"); // 远端在首部插入「前」
    Y.applyUpdate(binding.y.doc, Y.encodeStateAsUpdate(other.doc));

    const commit = commitComposition(binding);
    const deferred = commit.remote.flatMap((g) => g.patches);
    expect(deferred).toEqual([{ index: 0, remove: 0, insert: "前" }]);
    // 本地输入没有被远端覆盖，且位置正确（不是错位到「丙」前面）
    expect(textOf(binding.y, id)).toBe("前甲乙丙丁");
    expect(localText(binding, id)).toBe("前甲乙丙丁");
  });

  it("组词未提交就切块 → 显式报错（不静默丢弃上一块）", () => {
    const { binding } = wired();
    insertBlock(binding.y, 0, "p", { text: "甲" });
    const id2 = insertBlock(binding.y, 1, "p", { text: "乙" });
    beginComposition(binding, "x-missing-then-other");
    expect(() => beginComposition(binding, id2)).toThrow(/组词尚未提交/);
  });

  it("没有组词却调用 commit → 显式报错", () => {
    const { binding } = wired();
    expect(() => commitComposition(binding)).toThrow(/没有正在组词的块/);
  });

  it("组词期间无实际输入 → commit 返回 null 且不动 Y", () => {
    const { binding } = wired();
    const id = insertBlock(binding.y, 0, "p", { text: "甲" });
    beginComposition(binding, id);
    const before = Y.encodeStateAsUpdate(binding.y.doc);
    const commit = commitComposition(binding);
    expect(commit.local).toBeNull();
    expect(Y.encodeStateAsUpdate(binding.y.doc)).toEqual(before);
  });
});

describe("rebasePatch：本地补丁沿远端改动位移", () => {
  it("远端在本地区间之前 → 索引按净增量平移", () => {
    const out = rebasePatch({ index: 3, remove: 0, insert: "丁" }, [{ index: 0, remove: 0, insert: "前" }]);
    expect(out).toEqual({ index: 4, remove: 0, insert: "丁" });
  });

  it("远端在本地区间之后 → 原样不动", () => {
    const out = rebasePatch({ index: 1, remove: 0, insert: "X" }, [{ index: 5, remove: 0, insert: "尾" }]);
    expect(out).toEqual({ index: 1, remove: 0, insert: "X" });
  });

  it("远端区间与本地区间相交 → 插入点夹到远端之后且本地删除量作废", () => {
    const out = rebasePatch({ index: 2, remove: 3, insert: "X" }, [{ index: 1, remove: 4, insert: "Y" }]);
    expect(out).toEqual({ index: 2, remove: 0, insert: "X" });
  });

  it("多串远端按顺序叠加位移", () => {
    const local: TextPatch = { index: 6, remove: 0, insert: "Z" };
    const remote: TextPatch[] = [
      { index: 0, remove: 0, insert: "AB" },
      { index: 4, remove: 2, insert: "" },
    ];
    expect(rebasePatch(local, remote)).toEqual({ index: 6, remove: 0, insert: "Z" });
  });
});
