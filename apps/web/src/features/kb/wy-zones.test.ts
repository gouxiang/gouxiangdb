// P0-① 回归：富文本「行间插入热区」判定。
//
// 原行为（缺陷）：热区只在「邻块也是占用型/原子型」或「首/尾块」时渲染 ——
// 嵌入块（图片 / 画布 / 代码块 / callout…）紧邻普通段落时上下热区全被抑制，
// insertParagraphBefore/After 永远触发不到，表现为「内容上/下没有空行就插不进去」。
// 新判据：只有邻块「可编辑且为空」（等于已经有一个空行）才省掉那一侧热区。
import { describe, it, expect } from "vitest";
import type { Block } from "@gx/blocks";
import { hasTypingRoom, needsEmptyPair, zoneFlags } from "./wy-zones";

const p = (text: string): Block => ({ id: `p-${text || "empty"}`, type: "p", text } as Block);
const img: Block = { id: "img-1", type: "image", text: "" } as Block;
const h2 = (text: string): Block => ({ id: `h-${text}`, type: "h2", text } as Block);

describe("needsEmptyPair：占用型/原子型块才需要热区", () => {
  it("图片/代码/callout/表格需要，普通段落与标题不需要", () => {
    expect(needsEmptyPair("image")).toBe(true);
    expect(needsEmptyPair("code")).toBe(true);
    expect(needsEmptyPair("callout")).toBe(true);
    expect(needsEmptyPair("table")).toBe(true);
    expect(needsEmptyPair("p")).toBe(false);
    expect(needsEmptyPair("h2")).toBe(false);
  });
});

describe("hasTypingRoom：只有「可编辑且为空」的邻块才算已经有空位", () => {
  it("空段落 / 空标题算有空位，有内容的与占用型都不算", () => {
    expect(hasTypingRoom(p(""))).toBe(true);
    expect(hasTypingRoom(p("   "))).toBe(true);
    expect(hasTypingRoom(h2(""))).toBe(true);
    expect(hasTypingRoom(p("正文"))).toBe(false);
    // 占用型哪怕 text 为空也不算空位：它不含光标，点不进去
    expect(hasTypingRoom(img)).toBe(false);
    expect(hasTypingRoom(undefined)).toBe(false);
  });
});

describe("zoneFlags：嵌入块紧邻正文时两侧热区必须可命中（P0-①）", () => {
  it("正文段落 ↔ 嵌入块：上下热区都在（这是缺陷现场）", () => {
    const up = zoneFlags({ prev: p("上文"), next: p("下文"), isFirst: false, isLast: false });
    expect(up).toEqual({ showPrev: true, showNext: true });
  });

  it("已经存在空行（空段落）的那一侧不再包热区，避免视觉噪音", () => {
    const flags = zoneFlags({ prev: p(""), next: p(""), isFirst: false, isLast: false });
    expect(flags).toEqual({ showPrev: false, showNext: false });
  });

  it("两个嵌入块相邻：两侧都保留（原行为保留不变）", () => {
    const flags = zoneFlags({ prev: img, next: img, isFirst: false, isLast: false });
    expect(flags).toEqual({ showPrev: true, showNext: true });
  });

  it("首块 / 末块：没有邻块的那一侧恒给热区", () => {
    expect(zoneFlags({ prev: undefined, next: p("x"), isFirst: true, isLast: false }).showPrev).toBe(true);
    expect(zoneFlags({ prev: p("x"), next: undefined, isFirst: false, isLast: true }).showNext).toBe(true);
    // 末块之后即使是空段落也要给：末尾没有别处可落点
    expect(zoneFlags({ prev: p("x"), next: p(""), isFirst: false, isLast: true }).showNext).toBe(true);
  });

  it("误触控制：热区只出现在组件紧邻侧，随块存在而存在，不随段落数量膨胀", () => {
    // 三段普通正文之间不存在任何占用型块 → 调用方根本不会走到 zoneFlags（needsEmptyPair 已拦）
    expect(needsEmptyPair(p("a").type)).toBe(false);
  });
});
