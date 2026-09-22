// apps/api/src/collab/__tests__/docYjs-parity.test.ts
// **防漂移红线**：服务端 apps/api/src/collab/docYjs.ts 是前端 Y 结构的镜像，两处一旦不同步，
// 冷归结就会把用户的协同编辑序列化成另一套 Markdown（静默错内容，不可回放）。
//
// 两条防线，任一条不同步即红：
//   1) 静态：拿前端 blocksYjsState.ts 的**源码**比对三处契约 —— Y 顶层键名、CONTENT_FIELD、
//      META_KEYS（这两张表决定"正文落在 Block 的哪个字段"与"哪些字段进 Y"）。
//   2) 行为：动态 import 前端实现（不 import 类型，故 tsc 不牵连前端 DOM 依赖），
//      用同一份 Block 夹具对拍 seed/hydrate 的结果。
//
// 本文件只读前端、不改前端；Markdown 序列化本身不在此列（两端都调 @gx/blocks，天然同源）。

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Block } from "@gx/blocks";
import {
  CONTENT_FIELD,
  META_KEYS,
  Y_BLOCKS_KEY,
  Y_ORDER_KEY,
  Y_TEXTS_KEY,
  docBlocksOf,
  hydrateDocBlocks,
} from "../docYjs.js";

/** 前端绑定层叶子模块（服务端镜像的对象）。路径常量化，缺失即红（不许静默跳过）。 */
const FE_SRC = path.resolve(
  __dirname,
  "../../../../web/src/features/kb/collab/blocksYjsState.ts",
);

/** 只声明要用的三个函数，避免 any 逃逸（动态 import 的模块拿不到类型）。 */
interface FeModule {
  createCollabBlocks(doc: Y.Doc): unknown;
  seedBlocks(b: unknown, blocks: Block[]): unknown;
  hydrateBlocks(b: unknown): Block[];
}

async function loadFrontend(): Promise<FeModule> {
  // 用运行时字符串 import：tsc 不解析该路径，故不会把前端的 DOM 依赖拖进 api 的类型检查。
  return (await import(pathToFileURL(FE_SRC).href)) as unknown as FeModule;
}

function readFrontendSource(): string {
  return fs.readFileSync(FE_SRC, "utf8");
}

/** 从源码里抠 `doc.getArray<...>("order")` 一类的键名。 */
function yKeyOf(src: string, method: "getArray" | "getMap", field: string): string {
  // 泛型里还有嵌套尖括号（doc.getMap<Y.Map<MetaValue>>），故用非贪婪跨到最后一个 ">" 再吃 ("key")。
  const re = new RegExp(`${field}:\\s*doc\\.${method}<[\\s\\S]*?>\\(\\s*"([^"]+)"\\s*\\)`);
  const m = re.exec(src);
  if (!m) throw new Error(`前端源码里找不到 ${field}: doc.${method}(...) —— 结构已变，需同步 docYjs.ts`);
  return m[1];
}

/** 从源码里抠 `const META_KEYS = [...] as const;`。 */
function metaKeysOf(src: string): string[] {
  const m = /const META_KEYS = \[([^\]]*)\] as const;/.exec(src);
  if (!m) throw new Error("前端源码里找不到 META_KEYS —— 需同步 docYjs.ts");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/** 从源码里抠 CONTENT_FIELD 的 `类型: "字段"` 映射。 */
function contentFieldOf(src: string): Record<string, string> {
  const m = /const CONTENT_FIELD[^=]*=\s*\{([\s\S]*?)\n\};/.exec(src);
  if (!m) throw new Error("前端源码里找不到 CONTENT_FIELD —— 需同步 docYjs.ts");
  const out: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = /^\s*([a-z0-9]+):\s*"([a-z]+)",\s*$/.exec(line);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}

/** 覆盖全部有正文的块类型 + 元数据白名单的夹具（缺一类就少一道防线）。 */
const FIXTURE: Block[] = [
  { id: "b1", type: "h1", text: "一级标题" },
  { id: "b2", type: "p", text: "正文段落" },
  { id: "b3", type: "ul", text: "无序项" },
  { id: "b4", type: "ol", text: "有序项" },
  { id: "b5", type: "task", text: "待办项", checked: true },
  { id: "b6", type: "quote", text: "引用" },
  { id: "b7", type: "callout", text: "提示正文", variant: "warning" },
  { id: "b8", type: "toggle", text: "折叠标题", summary: "摘要" },
  { id: "b9", type: "code", lang: "ts", code: "const a = 1;\nconst b = 2;" },
  { id: "b10", type: "math", formula: "E = mc^2" },
  { id: "b11", type: "raw", raw: "<div>原样透传</div>" },
  { id: "b12", type: "p", text: "居中段落", align: "center" },
];

describe("服务端 Y 结构镜像 vs 前端实现（漂移即红）", () => {
  it("① Y 顶层键名与前端 createCollabBlocks 逐字一致", () => {
    const src = readFrontendSource();
    expect([Y_ORDER_KEY, Y_BLOCKS_KEY, Y_TEXTS_KEY]).toEqual([
      yKeyOf(src, "getArray", "order"),
      yKeyOf(src, "getMap", "blocks"),
      yKeyOf(src, "getMap", "texts"),
    ]);
  });

  it("② 正文落哪个 Block 字段（CONTENT_FIELD）与前端逐项一致", () => {
    const fe = contentFieldOf(readFrontendSource());
    expect(Object.keys(fe).length).toBeGreaterThan(10);
    expect({ ...CONTENT_FIELD }).toEqual(fe);
  });

  it("③ 元数据白名单（META_KEYS）与前端逐项一致", () => {
    expect([...META_KEYS]).toEqual(metaKeysOf(readFrontendSource()));
  });

  it("④ 前端播种的 Y.Doc，服务端 hydrate 出的 Block[] 与前端一致", async () => {
    const fe = await loadFrontend();
    const doc = new Y.Doc();
    fe.seedBlocks(fe.createCollabBlocks(doc), FIXTURE);
    const mine = hydrateDocBlocks(docBlocksOf(doc));
    const theirs = fe.hydrateBlocks(fe.createCollabBlocks(doc));
    expect(mine).toEqual(theirs);
    // 顺带确认夹具真的被解析出来了（防止"两边都空"的假绿）
    expect(mine.map((b) => b.type)).toEqual(FIXTURE.map((b) => b.type));
    expect(mine[8]?.code).toBe("const a = 1;\nconst b = 2;");
    expect(mine[9]?.formula).toBe("E = mc^2");
    expect(mine[10]?.raw).toBe("<div>原样透传</div>");
  });

  it("⑤ 服务端播种的 Y.Doc，前端 hydrate 出的 Block[] 与服务端一致", async () => {
    const fe = await loadFrontend();
    const doc = new Y.Doc();
    const b = docBlocksOf(doc);
    // 走服务端自己的写入路径（冷归结的三方归并也复用它）
    const { syncDocBlocksToY } = await import("../docMerge.js");
    doc.transact(() => syncDocBlocksToY(b, FIXTURE));
    expect(hydrateDocBlocks(b)).toEqual(fe.hydrateBlocks(fe.createCollabBlocks(doc)));
  });
});
