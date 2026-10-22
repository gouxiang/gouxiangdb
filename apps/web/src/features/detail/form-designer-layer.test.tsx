// 回归守卫：全屏表单设计器必须压住工作区导航 chrome（2026-10-19 真机层级倒置 bug）。
//
// 原行为（缺陷）：设计器全屏 portal 层用裸 `z-50`，而背景工作区 chrome 普遍更高——
// 浮出二级面板 gx-z-drawer(400)、二级收纳/唤回圆钮 gx-z-popover(900)。结果：
//   ① 900 的圆钮穿出浮在设计器之上（视觉穿帮）；
//   ② 中宽窗口（L2 浮出档 768–1279px）400 的二级面板整片压住设计器最左侧「字段库」，
//      HTML5 拖拽从字段库一起始就被截走，无法落到画布（拖拽失效）。
// 修法：设计器全屏底座抬到 gx-z-modal(800) 盖住一切工作区 chrome；其内部「布局版本历史」
//   抽屉用 gx-z-canvas-modal(820) 压在设计器之上，回滚二次确认 860 再上一层；
//   两个圆钮降为工作区悬浮 chrome 层 gx-z-drawer(400)，弹窗打开即被盖住。
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("表单设计器全屏层的层级（盖住工作区 chrome）", () => {
  it("全屏 portal 底座走 gx-z-modal，不再用裸 z-50", () => {
    const src = read("./FormDesigner.tsx");
    // 精确定位全屏 portal 容器那一行（portal 到 document.body 的 fixed 全屏层）
    expect(src).toContain(
      '<div className="gx-z-modal fixed inset-0 flex items-stretch justify-center p-3 sm:p-6">',
    );
    // 同一行不得残留裸 z-50
    const portalLine = src
      .split("\n")
      .find((l) => l.includes("fixed inset-0 flex items-stretch justify-center"));
    expect(portalLine).toBeTruthy();
    expect(portalLine).not.toMatch(/\bz-50\b/);
  });

  it("内部「布局版本历史」抽屉走 gx-z-canvas-modal(820)，压在设计器(800)之上", () => {
    const src = read("./form-versioning/VersionHistoryDrawer.tsx");
    expect(src).toContain('className="fixed inset-0 gx-z-canvas-modal flex justify-end"');
    expect(src).not.toContain("fixed inset-0 gx-z-drawer flex justify-end");
  });

  it("二级收/展单颗骑缝圆钮（SecondaryNav 内）降为 gx-z-drawer，不再用全局最高 gx-z-popover", () => {
    const src = read("../workspace/SecondaryNav.tsx");
    const line = src.split("\n").find((l) => l.includes('className="gx-l2-toggle gx-z-drawer"'));
    expect(line).toBeTruthy();
    expect(line).not.toContain("gx-z-popover");
    // v6 #1003：旧的独立唤回组件 SecondaryNavRail 已删除（收/展并为同一颗钮）
    expect(existsSync(new URL("../workspace/SecondaryNavRail.tsx", import.meta.url))).toBe(false);
  });

  it("层级数值顺序成立：设计器 modal(800) < 历史抽屉 canvasModal(820) < 回滚确认 modalNested(860) < popover(900)", async () => {
    const { zIndex } = await import("@gx/design-tokens");
    expect(zIndex.modal).toBe(800);
    expect(zIndex.canvasModal).toBeGreaterThan(zIndex.modal);
    expect(zIndex.modalNested).toBeGreaterThan(zIndex.canvasModal);
    expect(zIndex.popover).toBeGreaterThan(zIndex.modalNested);
    // 工作区 chrome（圆钮/浮出 L2）必须低于设计器全屏层，才不会穿出
    expect(zIndex.drawer).toBeLessThan(zIndex.modal);
  });
});
