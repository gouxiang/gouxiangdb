// apps/api/src/collab/__tests__/canvasYjs-parity.test.ts
// **画布前后端 Y 映射防漂移红线**（照 docYjs-parity.test.ts 的成熟范式）：
// 前端 apps/web/src/features/kb/collab/canvasYjsState.ts 是【现有】服务端 canvasFlush.ts
// 映射规则的镜像。两处一旦不同步，冷归结就会把协同画布序列化成另一块板（静默错内容）。
// 本文件【不改任何生产码】，只对拍现有 canvasFlush.ts ↔ 现有 web canvasYjsState.ts：
//
//   ① 静态契约：readFileSync 前端源码，断言三键字面量、key 冒号拼接、十类白名单逐字一致。
//   ② 行为对拍：动态 import(pathToFileURL(FE_SRC).href) 前端实现（只依赖 yjs，无 DOM 牵连；
//      tsc 不解析运行时字符串路径，故不把前端依赖拖进 api 类型检查），同一份 BOARD 双向深比；
//      并对两份独立 Y.Doc 做 encodeStateAsUpdate 字节级对拍。
//
// 纯 headless：只用到 yjs + node fs/path/url，不起 DB、不联网。服务端侧虽静态 import
// canvasFlush.js（其链路含 db.js 的顶层 new PrismaClient），但 PrismaClient 构造是 lazy 的、
// 不在 import 时连库；本文件只调用 readBoardFromY / syncBoardToY 两个纯 Y 函数，绝不触库。

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  Y_CANVAS_ORDER_KEY,
  Y_CANVAS_ELEMENTS_KEY,
  Y_CANVAS_TEXTS_KEY,
  KNOWN_ELEMENT_TYPES,
  SERVER_CLIENT_PREFIX,
  readBoardFromY,
  syncBoardToY,
} from "../canvasFlush.js";

/** 前端绑定层叶子模块（服务端镜像的对象）。路径常量化，缺失即红（不许静默跳过）。 */
const FE_SRC = path.resolve(
  __dirname,
  "../../../../web/src/features/kb/collab/canvasYjsState.ts",
);

/** 前端画布 Y 句柄（createCollabCanvas 的返回结构）。 */
interface FeCanvasHandle {
  doc: Y.Doc;
  order: Y.Array<string>;
  elements: Y.Map<Y.Map<unknown>>;
  texts: Y.Map<Y.Text>;
}

/** 只声明对拍用到的三个函数，避免动态 import 的 any 逃逸。 */
interface FeModule {
  createCollabCanvas(doc: Y.Doc): FeCanvasHandle;
  boardToY(
    b: FeCanvasHandle,
    board: readonly unknown[],
    opts: { clientId: string },
  ): { upserted: number };
  yToBoard(b: FeCanvasHandle): { elements: Record<string, unknown>[]; dropped: number };
}

async function loadFrontend(): Promise<FeModule> {
  // 运行时字符串 import：tsc 不解析该路径，前端的 DOM 依赖不会被拖进 api 类型检查（同 docYjs-parity）。
  return (await import(pathToFileURL(FE_SRC).href)) as unknown as FeModule;
}

function readFrontendSource(): string {
  if (!fs.existsSync(FE_SRC)) {
    throw new Error(`前端镜像源文件缺失：${FE_SRC} —— 结构已变，需同步 canvasFlush.ts`);
  }
  return fs.readFileSync(FE_SRC, "utf8");
}

/** 从前端源码 `KNOWN_ELEMENT_TYPES = new Set([ ... ])` 里抠出全部带引号的 type 字面量。 */
function knownTypesOfFrontend(src: string): string[] {
  const m = /KNOWN_ELEMENT_TYPES\s*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(src);
  if (!m) throw new Error("前端源码里找不到 KNOWN_ELEMENT_TYPES = new Set([...]) —— 需同步 canvasFlush.ts");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/* ----------------------------- 夹具：全合法元素（dropped 必须为 0） ----------------------------- */

const std = (s: string): Record<string, unknown> => ({ children: [{ text: s }] });
/** 还原期望用：裸段被补回的默认段落（带 type:paragraph）。 */
const para = (s: string): Record<string, unknown> => ({ type: "paragraph", children: [{ text: s }] });
const centered = (s: string): Record<string, unknown> => ({
  type: "paragraph",
  align: "center",
  children: [{ text: s }],
});
/** 多 leaf，其中一个带 bold marks：不拆 Y.Text，整值 LWW。 */
const marksText = (): Record<string, unknown> => ({
  children: [{ text: "粗" }, { text: "体", bold: true }],
});
/** 两个段落：多段不拆。 */
const multiPara = (): Record<string, unknown> => ({
  children: [{ text: "第一段" }, { text: "第二段" }],
});

/**
 * 覆盖全部 10 类白名单 + 各种文本形态 + 嵌套数组/对象 + gxNote 自定义键。
 * 每一项都是合法元素（有字符串 id + 已知 type），故两端还原后 dropped===0、
 * 元素数===BOARD.length（用这两条防"两边都空 / 全被过滤"的假绿）。
 */
const BOARD: readonly unknown[] = [
  // geometry：单段【居中】文本 -> 拆 Y.Text，属性 map 留 {type,align} 骨架；带 points 嵌套数组
  { id: "g1", type: "geometry", shape: "rectangle", points: [[0, 0], [100, 0], [100, 100], [0, 100]], text: centered("矩形") },
  // text：标准【裸段】（无 type/align）-> 拆 Y.Text，属性 map 里不留 text 键
  { id: "t1", type: "text", text: std("文字") },
  // image：无文本，file 嵌套对象
  { id: "i1", type: "image", shape: "image", points: [[1, 1], [2, 1], [2, 2], [1, 2]], file: { url: "u", meta: { w: 10, h: 20 } } },
  // table：cells 嵌套数组，单元格内是标准段落（整值留在属性 map，不随图元拆 Y.Text）
  { id: "tb1", type: "table", columns: [{ width: 1 }], cells: [[std("格")]] },
  // swimlane：lanes 嵌套数组对象
  { id: "s1", type: "swimlane", lanes: [{ id: "l1" }] },
  // arrow-line：带 points 的标准单段
  { id: "a1", type: "arrow-line", points: [[0, 0], [50, 50]], text: std("箭头") },
  // vector-line：无文本
  { id: "v1", type: "vector-line", points: [[0, 0], [9, 9]] },
  // mind：topic 嵌套对象；其文本是【marks】富文本 -> 不拆，整值保留
  { id: "m1", type: "mind", topic: { text: marksText() } },
  // mind_child：其文本【多段】-> 不拆，整值保留
  { id: "mc1", type: "mind_child", topic: { text: multiPara() } },
  // mindmap：自定义 gxNote 键原样透传，无文本
  { id: "mm1", type: "mindmap", gxNote: "自定义键原样透传" },
];

/** 元素顶层 text 是否为【裸段】（无 type/align 骨架）：这种拆进 Y.Text 后还原会被补默认类型。 */
function isBareStdParagraph(t: unknown): t is { children: [{ text: string }] } {
  return (
    typeof t === "object" &&
    t !== null &&
    !Array.isArray(t) &&
    !("type" in t) &&
    !("align" in t) &&
    Array.isArray((t as { children?: unknown }).children) &&
    (t as { children: unknown[] }).children.length === 1
  );
}

/**
 * 标准【裸段】（{children:[{text}]}，无 type/align 骨架）拆进 Y.Text 后，属性 map 不留 text
 * 键；还原时服务端 applyYText 对「无骨架」一律补回默认 `type:"paragraph"`（canvasFlush.ts
 * applyYText 的既定契约，前端逐字镜像）。故裸段不是字面无损往返，而是补默认段落类型后语义
 * 等价；只作用于元素【顶层 text】——table.cells 内嵌套的 std 段落是整值保留、不拆不补。
 * BOARD 里 t1 / a1 是裸段，其余形态字面无损。
 */
function withRoundTripText(board: readonly unknown[]): unknown[] {
  return board.map((raw) => {
    const el = raw as Record<string, unknown>;
    const t = el["text"];
    if (isBareStdParagraph(t)) {
      return { ...el, text: para(t.children[0]!.text as string) };
    }
    return el;
  });
}
const EXPECTED_BOARD: readonly unknown[] = withRoundTripText(BOARD);

/** 第二轮增量的入参（含裸段 a1）与还原期望（a1 补默认段落类型）。 */
function buildNext(): readonly unknown[] {
  return [
    { id: "a1", type: "arrow-line", points: [[0, 0], [50, 50]], text: std("箭头改字") }, // 提到最前 + 改字（裸段）
    { id: "g1", type: "geometry", shape: "rectangle", points: [[0, 0], [100, 0], [100, 100]], text: centered("矩形") },
    { id: "mm1", type: "mindmap", gxNote: "备注改" },
    { id: "i1", type: "image", file: { url: "u2" } },
    { id: "n1", type: "geometry", shape: "ellipse" }, // 新增尾追；t1 被删除
  ];
}
const EXPECTED_NEXT: readonly unknown[] = withRoundTripText(buildNext());

/**
 * 字节级对拍专用：两份全新 doc 必须钉【同一 clientID】，并以相同顺序取 order/elements/texts
 * 句柄——Yjs 的更新编码含 clientID 与根键创建顺序，任一不同字节必异（与映射规则本身无关）。
 */
const PARITY_CLIENT_ID = 7;

describe("画布前后端 Y 结构镜像（漂移即红）", () => {
  /* ============================ ① 静态契约 ============================ */

  it("①-1 前端源码里三键字面量与服务端常量逐字一致", () => {
    const src = readFrontendSource();
    expect(src).toContain(`"${Y_CANVAS_ORDER_KEY}"`);
    expect(src).toContain(`"${Y_CANVAS_ELEMENTS_KEY}"`);
    expect(src).toContain(`"${Y_CANVAS_TEXTS_KEY}"`);
    // 服务端常量本身（防测试抄错）
    expect([Y_CANVAS_ORDER_KEY, Y_CANVAS_ELEMENTS_KEY, Y_CANVAS_TEXTS_KEY]).toEqual([
      "order",
      "elements",
      "texts",
    ]);
  });

  it("①-2 前端 key 拼法 `${clientId}:${businessId}` 与服务端 `${server}:${id}` 同构（单冒号拼接）", () => {
    const src = readFrontendSource();
    // 前端 elementKey：`return `${clientId}:${businessId}`;`
    const feKey = /return\s*`\$\{[^}]*clientId[^}]*\}:\$\{[^}]*businessId[^}]*\}`/.exec(src);
    if (!feKey) throw new Error("前端源码里找不到 elementKey 的 `${clientId}:${businessId}` 冒号拼接");
    // 服务端 syncBoardToY 用 `${SERVER_CLIENT_PREFIX}:${id}`
    expect(`${SERVER_CLIENT_PREFIX}:x`).toBe("server:x");
    // 同构性的行为佐证：前端用 "server" 前缀拼出的 key 必须等于服务端前缀规则
    const m = /function elementKey\([^)]*\)[^{]*\{[\s\S]*?return\s+`([^`]+)`/.exec(src);
    expect(m?.[1]).toContain("}:${");
  });

  it("①-3 前端源码十类 type 集合与服务端 KNOWN_ELEMENT_TYPES 逐项相等", () => {
    const feTypes = knownTypesOfFrontend(readFrontendSource()).sort();
    expect(feTypes).toEqual([...KNOWN_ELEMENT_TYPES].sort());
    expect(feTypes).toHaveLength(10);
  });

  /* ============================ ② 行为对拍 ============================ */

  it("②-1 正向：前端 boardToY 播种后，服务端 readBoardFromY 读出同一板", async () => {
    const fe = await loadFrontend();
    const doc = new Y.Doc();
    const handle = fe.createCollabCanvas(doc);
    fe.boardToY(handle, BOARD, { clientId: SERVER_CLIENT_PREFIX });

    const mine = readBoardFromY(doc).board; // 服务端读前端写的同一个 Y.Doc
    const theirs = fe.yToBoard(handle).elements; // 前端读回

    // 防假绿：非空、无 dropped、数量齐
    expect(theirs).toHaveLength(BOARD.length);
    expect(fe.yToBoard(handle).dropped).toBe(0);
    expect(readBoardFromY(doc).dropped).toBe(0);
    // 服务端还原 === 前端还原
    expect(mine).toEqual(theirs);
    // 两端还原 === 还原期望（裸段 t1 被补默认 type:paragraph，其余形态字面无损）
    expect(mine).toEqual(EXPECTED_BOARD);
  });

  it("②-2 反向：服务端 syncBoardToY 播种后，前端 yToBoard 读出同一板", async () => {
    const fe = await loadFrontend();
    const doc = new Y.Doc();
    syncBoardToY(doc, BOARD); // 服务端写

    const mine = readBoardFromY(doc).board;
    const theirs = fe.yToBoard(fe.createCollabCanvas(doc)).elements; // 前端读服务端写的同一个 Y.Doc

    expect(mine).toHaveLength(BOARD.length);
    expect(theirs).toHaveLength(BOARD.length);
    expect(readBoardFromY(doc).dropped).toBe(0);
    expect(theirs).toEqual(mine);
    expect(theirs).toEqual(EXPECTED_BOARD);
  });

  it("②-3 文本拆出口径一致：居中留骨架/裸段无 text 键/marks+多段整值保留", async () => {
    const fe = await loadFrontend();
    const doc = new Y.Doc();
    const handle = fe.createCollabCanvas(doc);
    fe.boardToY(handle, BOARD, { clientId: SERVER_CLIENT_PREFIX });

    // 居中图元：Y.Text 是纯文本，属性 map 留 {type,align} 骨架
    expect(handle.texts.get("server:g1")?.toString()).toBe("矩形");
    expect(handle.elements.get("server:g1")?.get("text")).toEqual({
      type: "paragraph",
      align: "center",
    });
    // 裸段：Y.Text 有值，属性 map 不含 text 键
    expect(handle.texts.get("server:t1")?.toString()).toBe("文字");
    expect(handle.elements.get("server:t1")?.has("text")).toBe(false);
    // marks（mind.topic 内）/ 多段（mind_child.topic 内）整值留在属性 map，两端 readBoard 已在 ②-1 深比
    expect(readBoardFromY(doc).board.find((e) => e["id"] === "m1")?.["topic"]).toEqual({
      text: marksText(),
    });
    expect(readBoardFromY(doc).board.find((e) => e["id"] === "mc1")?.["topic"]).toEqual({
      text: multiPara(),
    });
  });

  it("②-4 字节级：同 BOARD、同 clientID、同取句柄顺序 -> encodeStateAsUpdate 逐字节一致", async () => {
    const fe = await loadFrontend();

    // 前端独立 doc
    const feDoc = new Y.Doc();
    feDoc.clientID = PARITY_CLIENT_ID;
    const feHandle = fe.createCollabCanvas(feDoc); // 内部顺序取 order/elements/texts
    fe.boardToY(feHandle, BOARD, { clientId: SERVER_CLIENT_PREFIX });

    // 服务端独立 doc：钉同 clientID，并先按相同顺序取一遍根句柄，
    // 使冷启动根键创建顺序与 createCollabCanvas 一致（syncBoardToY 内部也是 order/elements/texts）。
    const svDoc = new Y.Doc();
    svDoc.clientID = PARITY_CLIENT_ID;
    svDoc.getArray<string>(Y_CANVAS_ORDER_KEY);
    svDoc.getMap<Y.Map<unknown>>(Y_CANVAS_ELEMENTS_KEY);
    svDoc.getMap<Y.Text>(Y_CANVAS_TEXTS_KEY);
    syncBoardToY(svDoc, BOARD);

    const feBytes = Y.encodeStateAsUpdate(feDoc);
    const svBytes = Y.encodeStateAsUpdate(svDoc);

    // 实测两端写入顺序（先对账 elements/texts、最后重排 order）与拆分规则逐字相同，
    // 在同 clientID + 同根键创建顺序下字节确定相等；若将来任一侧写入顺序调整导致不等，
    // 下方深比仍守住语义等价，但字节断言会先红，逼迫人工确认而非静默放行。
    expect(feBytes).toEqual(svBytes);
    expect(feBytes.length).toBeGreaterThan(100); // 防"两边都空"的假绿
    // 字节相等时还原必然一致（双保险）
    expect(readBoardFromY(svDoc).board).toEqual(fe.yToBoard(feHandle).elements);
  });

  it("②-5 字节级·增量第二轮：reorder/改文本/增删后仍逐字节一致且 key 不重建", async () => {
    const fe = await loadFrontend();
    const next = buildNext();

    const mkPair = (): { feDoc: Y.Doc; feHandle: FeCanvasHandle; svDoc: Y.Doc } => {
      const feDoc = new Y.Doc();
      feDoc.clientID = PARITY_CLIENT_ID;
      const feHandle = fe.createCollabCanvas(feDoc);
      const svDoc = new Y.Doc();
      svDoc.clientID = PARITY_CLIENT_ID;
      svDoc.getArray<string>(Y_CANVAS_ORDER_KEY);
      svDoc.getMap<Y.Map<unknown>>(Y_CANVAS_ELEMENTS_KEY);
      svDoc.getMap<Y.Text>(Y_CANVAS_TEXTS_KEY);
      return { feDoc, feHandle, svDoc };
    };

    const { feDoc, feHandle, svDoc } = mkPair();
    fe.boardToY(feHandle, BOARD, { clientId: SERVER_CLIENT_PREFIX });
    syncBoardToY(svDoc, BOARD);
    expect(Y.encodeStateAsUpdate(feDoc)).toEqual(Y.encodeStateAsUpdate(svDoc)); // 起点一致

    fe.boardToY(feHandle, next, { clientId: SERVER_CLIENT_PREFIX });
    syncBoardToY(svDoc, next);

    expect(Y.encodeStateAsUpdate(feDoc)).toEqual(Y.encodeStateAsUpdate(svDoc));
    expect(readBoardFromY(svDoc).board).toEqual(fe.yToBoard(feHandle).elements);
    expect(readBoardFromY(svDoc).board).toEqual(EXPECTED_NEXT);
    // 既有元素沿用 server:<id>（不重建 key），被删的 t1 在 elements/texts 双双剪枝
    expect(feHandle.order.toArray()).toEqual([
      "server:a1",
      "server:g1",
      "server:mm1",
      "server:i1",
      "server:n1",
    ]);
    expect(feHandle.elements.has("server:t1")).toBe(false);
    expect(feHandle.texts.has("server:t1")).toBe(false);
    // 改字走最小补丁后同一 key 的 Y.Text 已是新值
    expect(feHandle.texts.get("server:a1")?.toString()).toBe("箭头改字");
  });
});
