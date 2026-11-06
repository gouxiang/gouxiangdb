// 修复 B（P0 数据丢失）：远端结构回放防丢兜底 reconcileRemoteBlocks 的单测。
//
// 覆盖任务书要求的三场景 + 键编码/损坏围栏边界：
//   1. 本地有、Y 回放缺失的嵌入块被克隆补回（recovered 含稳定键，docId/tableId 可找回）；
//   2. 两端嵌入集合相同 → 原样返回 incoming 引用、recovered 为空（不触发无谓重渲染）；
//   3. 本地已删除的嵌入不会被复活（本地键集合已无此键，reconcile 无从恢复）。
//
// 纯函数、不依赖 React/DOM，默认 node 环境即可运行。

import { describe, expect, it } from "vitest";
import { mdToBlocks, type Block } from "@gx/blocks";
import { collectEmbedKeys, embedKeyOf, reconcileRemoteBlocks } from "../embed-reconcile";

/** 用真实解析链路构造一个 code 型围栏块，避免手填 Block 的必填字段。 */
function fenceBlock(lang: string, body: string): Block {
  const blocks = mdToBlocks("```" + lang + "\n" + body + "\n```\n");
  const found = blocks.find((b) => b.type === "code");
  if (!found) throw new Error(`夹具构造失败：未解析出 ${lang} 围栏块`);
  return found;
}

/** 普通段落块，用于模拟嵌入块之外的文字内容（Y 中齐全、应原样保留）。 */
function paragraphBlock(): Block {
  const blocks = mdToBlocks("普通段落文字\n");
  const found = blocks.find((b) => b.type === "p");
  if (!found) throw new Error("夹具构造失败：未解析出段落块");
  return found;
}

describe("embedKeyOf / collectEmbedKeys：稳定身份键编码", () => {
  it("画布围栏编码为 canvas:docId", () => {
    expect(embedKeyOf(fenceBlock("canvas-embed", "docAbC123"))).toBe("canvas:docAbC123");
  });

  it("数据表围栏：含 viewId 用冒号连接两段，缺 viewId 仅 table:tableId", () => {
    expect(embedKeyOf(fenceBlock("table-embed", "tblXy01\nvewZ9"))).toBe("table:tblXy01:vewZ9");
    expect(embedKeyOf(fenceBlock("table-embed", "tblOnly7"))).toBe("table:tblOnly7");
  });

  it("非嵌入块与空 body 损坏围栏返回 null（不参与对账）", () => {
    expect(embedKeyOf(paragraphBlock())).toBeNull();
    expect(embedKeyOf(fenceBlock("canvas-embed", "   "))).toBeNull();
    expect(embedKeyOf(fenceBlock("table-embed", ""))).toBeNull();
  });

  it("collectEmbedKeys 去重并按首次出现顺序收集", () => {
    const keys = collectEmbedKeys([
      fenceBlock("canvas-embed", "docA"),
      fenceBlock("canvas-embed", "docA"), // 同键重复，只收一次
      fenceBlock("table-embed", "tbl1\nvew1"),
      paragraphBlock(),
    ]);
    expect([...keys]).toEqual(["canvas:docA", "table:tbl1:vew1"]);
  });
});

describe("reconcileRemoteBlocks：远端回放防丢", () => {
  it("场景1：本地有、incoming 缺失的画布围栏被克隆补回，且换发新块 id", () => {
    const localCanvas = fenceBlock("canvas-embed", "docA");
    const localTable = fenceBlock("table-embed", "tbl1\nvew1");
    const local: Block[] = [paragraphBlock(), localCanvas, localTable];
    // 模拟重连回放：Y 里此刻还没有本地刚插入的画布围栏，表格围栏已同步齐全。
    const incoming: Block[] = [paragraphBlock(), fenceBlock("table-embed", "tbl1\nvew1")];

    const { blocks, recovered } = reconcileRemoteBlocks(local, incoming);

    expect(recovered).toEqual(["canvas:docA"]);
    // incoming 既有块原样保留，缺失的画布块以克隆形式补在末尾。
    expect(blocks).toHaveLength(incoming.length + 1);
    const recoveredCanvas = blocks.find((b) => b.lang === "canvas-embed");
    expect(recoveredCanvas?.code).toBe("docA");
    // 浅克隆换发新 uid，避免与本地原块/ incoming 块撞键。
    expect(recoveredCanvas?.id).not.toBe(localCanvas.id);
    // 已在 incoming 中的表格围栏不重复恢复。
    expect(recovered).not.toContain("table:tbl1:vew1");
  });

  it("场景1b：同一稳定键本地重复出现多次，也只恢复一次（绝不整片丢失，也不膨胀）", () => {
    const local: Block[] = [
      fenceBlock("canvas-embed", "dupDoc"),
      fenceBlock("canvas-embed", "dupDoc"),
    ];
    const incoming: Block[] = [paragraphBlock()];

    const { blocks, recovered } = reconcileRemoteBlocks(local, incoming);

    expect(recovered).toEqual(["canvas:dupDoc"]);
    expect(blocks.filter((b) => b.lang === "canvas-embed")).toHaveLength(1);
  });

  it("场景2：两端嵌入集合相同 → 原样返回 incoming 引用且 recovered 为空", () => {
    const local: Block[] = [fenceBlock("canvas-embed", "docA"), fenceBlock("table-embed", "tbl1")];
    // 跨端块 id 天然不同，但稳定键一致；用全新解析结果模拟对端身份。
    const incoming: Block[] = [fenceBlock("canvas-embed", "docA"), fenceBlock("table-embed", "tbl1")];

    const { blocks, recovered } = reconcileRemoteBlocks(local, incoming);

    expect(recovered).toEqual([]);
    // 无缺失时必须是同一个引用，避免编辑器无谓重渲染/光标跳动。
    expect(blocks).toBe(incoming);
  });

  it("场景3：本地已删除的嵌入不会被复活（本地键集合已无此键）", () => {
    // 用户已删除画布围栏：本地 blocks 只剩段落；Y 也已收敛为不含该围栏。
    const local: Block[] = [paragraphBlock()];
    const incoming: Block[] = [paragraphBlock()];

    const { blocks, recovered } = reconcileRemoteBlocks(local, incoming);

    expect(recovered).toEqual([]);
    expect(blocks).toBe(incoming);
    expect(blocks.some((b) => b.lang === "canvas-embed")).toBe(false);
  });

  it("场景3b：即便 incoming 仍携带该围栏，reconcile 也只依据本地键集合、绝不凭空复制", () => {
    // 本地已删除（blocks 无该键）；incoming 仍带一份——reconcile 不应再追加任何克隆。
    const local: Block[] = [paragraphBlock()];
    const incoming: Block[] = [paragraphBlock(), fenceBlock("canvas-embed", "docA")];

    const { blocks, recovered } = reconcileRemoteBlocks(local, incoming);

    expect(recovered).toEqual([]);
    expect(blocks).toBe(incoming);
    expect(blocks.filter((b) => b.lang === "canvas-embed")).toHaveLength(1);
  });

  it("边界：空 body 的损坏围栏不参与恢复（交由渲染层失效卡处理）", () => {
    const local: Block[] = [fenceBlock("canvas-embed", "  ")];
    const incoming: Block[] = [paragraphBlock()];

    const { recovered } = reconcileRemoteBlocks(local, incoming);

    expect(recovered).toEqual([]);
  });
});
