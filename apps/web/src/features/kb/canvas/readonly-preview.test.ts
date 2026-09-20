// P0-⑤ 回归：只读预览的两处保障逻辑（op 分类 / 首帧适配数学）。
//
// ① 只拦数据变更类 op —— 旧实现只放行 set_viewport，把 set_selection / set_interaction
//    这类视图态 op 也静默吞掉，plait 首帧布局绘制被中断，预览区纯白。
// ② 适配数学 —— 装得下就回到 1 倍、装不下才缩，并对 0 尺寸返回 null 让调用方重试。
import { describe, it, expect } from "vitest";
import { computeFit, isDataMutatingOp } from "./readonly-preview";

describe("isDataMutatingOp —— 视图态放行、数据变更拦截", () => {
  it("放行视图态 op（viewport / selection / interaction）", () => {
    expect(isDataMutatingOp("set_viewport")).toBe(false);
    expect(isDataMutatingOp("set_selection")).toBe(false);
    expect(isDataMutatingOp("set_interaction")).toBe(false);
  });

  it("拦截改内容的 op", () => {
    for (const t of ["insert_node", "remove_node", "set_node", "move_node", "insert_text", "set_theme"]) {
      expect(isDataMutatingOp(t)).toBe(true);
    }
  });

  it("未来新增的未知 op：名字带数据词根才拦（宁可放行，不再静默吞掉绘制依赖）", () => {
    expect(isDataMutatingOp("update_node")).toBe(true);
    expect(isDataMutatingOp("apply_theme")).toBe(true);
    expect(isDataMutatingOp("set_hover_state")).toBe(false);
    expect(isDataMutatingOp(undefined)).toBe(false);
  });
});

describe("computeFit —— 首帧适配数学", () => {
  it("装得下时回到 1 倍，并把内容中心对到视口中心", () => {
    const fit = computeFit({ x: 0, y: 0, width: 100, height: 100 }, { width: 400, height: 300 });
    expect(fit).not.toBeNull();
    expect(fit!.zoom).toBe(1);
    // 内容中心 (50,50) 应落在视口中心：origination + 视口半宽 = 50
    expect(fit!.origination[0]).toBeCloseTo(50 - 400 / 2);
    expect(fit!.origination[1]).toBeCloseTo(50 - 300 / 2);
  });

  it("装不下时按较小比例缩小（与 plait fitViewport 同口径）", () => {
    const fit = computeFit({ x: 0, y: 0, width: 1000, height: 100 }, { width: 400, height: 300 });
    // 视口留白 16*2：宽可用 368、高可用 268 → min(0.368, 2.68) = 0.368
    expect(fit!.zoom).toBeCloseTo(368 / 1000);
  });

  it("尺寸为 0（未布局）或内容包围盒为 0 时返回 null，交给调用方重试", () => {
    expect(computeFit({ x: 0, y: 0, width: 100, height: 100 }, { width: 0, height: 300 })).toBeNull();
    expect(computeFit({ x: 0, y: 0, width: 0, height: 0 }, { width: 400, height: 300 })).toBeNull();
  });

  it("极端比例夹到缩放下界，不会缩成看不见", () => {
    const fit = computeFit({ x: 0, y: 0, width: 100000, height: 100000 }, { width: 200, height: 100 });
    expect(fit!.zoom).toBeGreaterThanOrEqual(0.1);
  });
});
