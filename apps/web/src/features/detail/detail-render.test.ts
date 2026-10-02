// apps/web/src/features/detail/detail-render.test.ts
// 详情抽屉两个缺陷的接线守卫（node 环境，无 jsdom，只做纯函数 + 源码顺序断言）：
//   ① 公式 NOW() 取当前时间的字段显示成原始 ISO 串 —— 根因是渲染层没有日期格式化分支，
//      一旦有人把分支删掉/挪到 Array 兜底之后，界面会静默回到直出原串（单测看不见）。
//   ② 字段卡片标签左置导致同行多字段时值区被挤压 —— 用源码断言锁住「标签上置」。
//
// 注：ReadValue / DetailCell 是 DetailLayout.tsx 内部组件（未导出），无法在 node 环境
// 渲染；故这里锁的是「接线与顺序」，显示口径本身由 cells/format.test.ts 的纯函数用例覆盖。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CellValue, FieldDTO, FieldIdT, TableIdT } from "@gx/shared-types";
import { formatCell, isIsoDatetimeLike } from "../cells/format";

const SRC = readFileSync(new URL("./DetailLayout.tsx", import.meta.url), "utf8");

/** 抽取某个具名函数的源码区间（到下一个顶层 function 为止），避免全局 indexOf 误命中。 */
function sliceFn(name: string): string {
  const start = SRC.indexOf(`function ${name}(`);
  expect(start, `DetailLayout 里必须存在 ${name}`).toBeGreaterThan(-1);
  const rest = SRC.slice(start + name.length);
  const next = rest.search(/\nfunction [A-Za-z]/);
  return next === -1 ? SRC.slice(start) : SRC.slice(start, start + name.length + next);
}

describe("详情抽屉 ReadValue：日期/时间分支接线", () => {
  it("抽屉已接入 format 的时间口径（date / datetime / 系统时间 / formula / lookup）", () => {
    const rv = sliceFn("ReadValue");
    for (const t of ["date", "datetime", "createdTime", "lastModifiedTime", "formula", "lookup"]) {
      expect(rv, `ReadValue 缺 ${t} 分支`).toContain(`field.type === "${t}"`);
    }
    expect(SRC).toContain('from "../cells/format"');
  });

  it("日期分支必须早于 Array 兜底，且不得挤掉既有的 attachment 优先顺序", () => {
    const rv = sliceFn("ReadValue");
    const arrAt = rv.indexOf("if (Array.isArray(value))");
    const dateAt = rv.indexOf('field.type === "date"');
    const timeAt = rv.indexOf('field.type === "lastModifiedTime"');
    const formulaAt = rv.indexOf('field.type === "formula"');
    const attAt = rv.indexOf('field.type === "attachment"');
    expect(arrAt).toBeGreaterThan(-1);
    // 新增分支若落在兜底之后，数组以外的日期值仍会走 String(value) 直出原串
    expect(dateAt, "date 分支必须早于 Array 兜底").toBeLessThan(arrAt);
    expect(timeAt, "datetime/系统时间分支必须早于 Array 兜底").toBeLessThan(arrAt);
    expect(formulaAt, "formula/lookup 分支必须早于 Array 兜底").toBeLessThan(arrAt);
    // attachment-links.test.tsx 的同款不变式：附件要在兜底之前，也在日期分支之前
    expect(attAt).toBeLessThan(arrAt);
    expect(attAt).toBeLessThan(dateAt);
  });

  it("抽屉只读态的附件也接了在线预览（与网格/看板画廊同口径）", () => {
    const rv = sliceFn("ReadValue");
    // 不传 onPreview 时 AttachmentLinks 退化成纯下载链接，预览能力会在抽屉静默缺席
    expect(rv).toContain("onPreview=");
    expect(SRC).toContain('from "../attachments/preview-opener"');
    expect(SRC).toContain('from "../attachments/policy"');
  });
});

describe("详情抽屉 DetailCell：标签上置（R-F-06）", () => {
  it("卡片是纵向两行，且不再用内联像素宽度约束字段名", () => {
    const cell = sliceFn("DetailCell");
    expect(cell).toContain("flex-col");
    // 旧实现：内联的 5rem 宽度上限（style={{ maxWidth: "5rem" }}），绕开间距令牌
    expect(cell).not.toContain("maxWidth");
    expect(cell).not.toContain("5rem");
    expect(cell).not.toContain("style={{");
    // 长字段名靠容器 min-w-0 + 文本 truncate 收口
    expect(cell).toContain("min-w-0");
    expect(cell).toContain("truncate");
  });
});

describe("抽屉显示口径：时间串不再直出（与 formatCell 同源）", () => {
  const field = (type: FieldDTO["type"]): FieldDTO =>
    ({
      id: "f1" as FieldIdT,
      tableId: "t1" as TableIdT,
      name: type,
      type,
    }) as FieldDTO;

  it("NOW() 的 ISO 输出形态被格式化，不再含 T/毫秒/Z 原串", () => {
    const iso = "2026-10-02T13:38:39.086Z";
    const out = formatCell(iso as CellValue, field("formula"));
    expect(isIsoDatetimeLike(iso)).toBe(true);
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(out).not.toContain("T");
  });

  it("普通文本 / 纯日期不被误格式化（宁可不格式化，也不能编造时间）", () => {
    expect(formatCell("已完成" as CellValue, field("formula"))).toBe("已完成");
    expect(formatCell("2026-10-02" as CellValue, field("formula"))).toBe("2026-10-02");
  });
});
