// apps/web/src/features/detail/drop-target.test.tsx
// 选项卡禁放回归（node 环境，react-dom/server，无 jsdom、无新增依赖）
//
// 锁的是 P2「落点高亮与实际落点不一致」修复：
//   ① 判定发生在**计算落点**那一层，产出 allowed / rejected（不是松手后才改主意）
//   ② tabs 容器拖向选项卡内 → rejected + 可读原因「选项卡内不能再放选项卡」
//   ③ 普通字段（含 subtable 宽字段）拖进选项卡 → allowed（不能误伤）
//   ④ 行间带与选项卡内容区都能渲染「禁放」视觉（红色 + 原因 + 禁止光标）
//   ⑤ 松手时禁放区**不移动**字段（源码回归：不再有静默改写落点的 safeTarget）

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import { readFileSync } from "node:fs";
import type { FieldIdT, FieldType } from "@gx/shared-types";
import { TABS_NEST_MESSAGE, evaluateDrop, isTabDrop, targetKey } from "./drop-target";
import { RowGap } from "./FormDesigner";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const fid = (s: string) => s as FieldIdT;

const tabTarget = { kind: "tab" as const, containerFieldId: fid("c1"), tabId: "t1", rowIndex: 0, beforeIndex: 0 };
const tabLineTarget = { kind: "tabLine" as const, containerFieldId: fid("c1"), tabId: "t1", rowIndex: 0 };
const topLine = { kind: "line" as const, rowIndex: 0 };
const topRow = { kind: "row" as const, rowIndex: 0, beforeIndex: 0 };

describe("isTabDrop / targetKey", () => {
  it("只有 tab / tabLine 属于选项卡落点", () => {
    expect(isTabDrop(tabTarget)).toBe(true);
    expect(isTabDrop(tabLineTarget)).toBe(true);
    expect(isTabDrop(topLine)).toBe(false);
    expect(isTabDrop(topRow)).toBe(false);
    expect(isTabDrop(null)).toBe(false);
  });

  it("targetKey 对落点唯一且稳定（dragover 浅比较靠它消抖）", () => {
    expect(targetKey(topLine)).toBe("line:0");
    expect(targetKey(topRow)).toBe("row:0:0");
    expect(targetKey(tabLineTarget)).toBe("tabLine:c1:t1:0");
    expect(targetKey(tabTarget)).toBe("tab:c1:t1:0:0");
    expect(targetKey(null)).toBe("");
  });
});

describe("evaluateDrop：选项卡不能套选项卡", () => {
  it("tabs 容器拖进选项卡行 / 行间带 → 禁放 + 可读原因", () => {
    for (const t of [tabTarget, tabLineTarget]) {
      const v = evaluateDrop("tabs", t);
      expect(v.allowed).toBe(false);
      expect(v.reason).toBe(TABS_NEST_MESSAGE);
      expect(v.reason).toBe("选项卡内不能再放选项卡");
    }
  });

  it("tabs 容器拖到顶层行 / 顶层行间带 → 可放", () => {
    expect(evaluateDrop("tabs", topLine)).toEqual({ allowed: true, reason: null });
    expect(evaluateDrop("tabs", topRow)).toEqual({ allowed: true, reason: null });
  });

  it("普通字段与 subtable 拖进选项卡 → 可放（不能误伤）", () => {
    for (const type of ["text", "number", "subtable", "longText", "attachment"] as FieldType[]) {
      expect(evaluateDrop(type, tabTarget).allowed).toBe(true);
      expect(evaluateDrop(type, tabLineTarget).allowed).toBe(true);
    }
  });

  it("拖动类型未知 / 无落点 → 可放（交由调用方兜底，不误报禁放）", () => {
    expect(evaluateDrop(null, tabTarget).allowed).toBe(true);
    expect(evaluateDrop(undefined, tabTarget).allowed).toBe(true);
    expect(evaluateDrop("tabs", null).allowed).toBe(true);
  });
});

describe("RowGap 落点视觉：可放高亮 / 禁放禁止", () => {
  it("未命中：没有任何提示层", () => {
    const html = render(<RowGap rowIndex={0} />);
    expect(html).not.toContain("data-drop-rejected");
    expect(html).not.toContain("放到此处新建一行");
  });

  it("可放：渲染插入线提示", () => {
    const html = render(<RowGap rowIndex={0} state="allowed" />);
    expect(html).toContain("放到此处新建一行");
    expect(html).toContain('data-drop-state="allowed"');
    expect(html).not.toContain("data-drop-rejected");
  });

  it("禁放：渲染红色禁放条 + 原因，且不出现「放到此处新建一行」", () => {
    const html = render(<RowGap rowIndex={0} state="rejected" rejectReason={TABS_NEST_MESSAGE} />);
    expect(html).toContain("data-drop-rejected");
    expect(html).toContain('data-drop-state="rejected"');
    expect(html).toContain("选项卡内不能再放选项卡");
    expect(html).toContain("border-gx-danger");
    // 禁放区绝不能同时显示「可以放到这里」
    expect(html).not.toContain("放到此处新建一行");
  });

  it("禁放且无原因时也有兜底文案，不留空白条", () => {
    const html = render(<RowGap rowIndex={0} state="rejected" />);
    expect(html).toContain("此处不可放置");
  });
});

describe("接线回归：禁放在松手前就成立，且不再静默改写落点", () => {
  const src = read("./FormDesigner.tsx");

  it("落点判定发生在计算落点那一层（dragover 阶段产出 allowed/rejected）", () => {
    expect(src).toContain("evaluateDrop(");
    expect(src).toContain("dropRejectRef");
    expect(src).toContain("applyDropEffect");
    // 禁放时把光标改成禁止（dropEffect=none），用户松手前就能看出来
    expect(src).toMatch(/dropEffect\s*=\s*dropRejectRef\.current\s*\n\s*\?\s*"none"/);
  });

  it("行拖拽落点不再静默改写成「顶层末尾」", () => {
    // 旧实现：safeTarget = isTabTarget && type==="tabs" ? { kind:"line", rowIndex: rowsRef.current.length } : target
    expect(src).not.toContain("safeTarget");
    expect(src).not.toMatch(/isTabTarget/);
  });

  it("松手落在禁放区：提示原因且直接 return，不调用 placeField", () => {
    const dropBody = src.slice(src.indexOf("const handleDrop ="), src.indexOf("const endDrag ="));
    expect(dropBody).toContain("evaluateDrop(");
    expect(dropBody).toContain("toast(verdict.reason ?? TABS_NEST_MESSAGE, \"error\")");
    expect(dropBody).toContain("endDrag();\n        return;");
    // return 之后才允许 placeField，且 placeField 只出现一次（成功分支）
    expect(dropBody.match(/placeField\(/g)?.length).toBe(1);
    expect(dropBody.indexOf("endDrag();\n        return;")).toBeLessThan(dropBody.indexOf("placeField("));
  });

  it("从字段库拖出 tabs 时也在建字段之前拒绝（不会先落库再挪位）", () => {
    const fn = src.slice(src.indexOf("const createFieldFromPalette"), src.indexOf("const computeDropTarget"));
    expect(fn).toContain("evaluateDrop(type, target)");
    expect(fn).toContain("createField.mutateAsync");
    expect(fn.indexOf("evaluateDrop(type, target)")).toBeLessThan(fn.indexOf("createField.mutateAsync"));
  });
});
