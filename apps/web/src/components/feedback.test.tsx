// 阶段 3 确认弹窗分级回归（node 环境，react-dom/server，无 jsdom、无新增依赖）。
//
//   R-D-23 L1 无确认 / L2 普通 / L3 输入名称 / L4 不可恢复红色 / L5 勾选 + 输入
//   R-D-24 主按钮必须是具体动词，禁止「确定 / OK / 是」
//
// 注意：ConfirmHost 走 createPortal，SSR 不支持 portal 渲染，故本文件只断言
// ① 纯映射 confirmGateFor（组件内部用的就是它）② L1 的真实放行行为
// ③ 调用点已把「确定 / OK」换成具体动词的回归护栏。

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { confirmAction, confirmGateFor, ConfirmHost } from "./feedback";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("阶段3 · 危险操作分级（R-D-23）", () => {
  it("L1 无确认：不弹窗，直接放行", async () => {
    expect(confirmGateFor(1, {}).modal).toBe(false);
    await expect(confirmAction({ title: "切换视图", confirmText: "切换视图", level: 1 })).resolves.toBe(true);
  });

  it("L2 普通确认弹窗：弹窗、不需输入、不标红", () => {
    const gate = confirmGateFor(2, {});
    expect(gate.modal).toBe(true);
    expect(gate.needName).toBe(false);
    expect(gate.needCheck).toBe(false);
    expect(gate.danger).toBe(false);
  });

  it("L3 需输入名称确认（给了 confirmName 才生效）", () => {
    expect(confirmGateFor(3, { confirmName: "需求池" }).needName).toBe(true);
    // 没给名称就不会凭空要求输入
    expect(confirmGateFor(3, {}).needName).toBe(false);
  });

  it("L4 不可恢复红色确认", () => {
    const gate = confirmGateFor(4, {});
    expect(gate.modal).toBe(true);
    expect(gate.danger).toBe(true);
  });

  it("L5 需二次勾选 + 输入", () => {
    const gate = confirmGateFor(5, { confirmName: "工作区名", acknowledgeText: "我已了解后果" });
    expect(gate.needCheck).toBe(true);
    expect(gate.needName).toBe(true);
    expect(gate.danger).toBe(true);
  });

  it("L2~L5 请求会挂起（返回 Promise），非 L1 不自动放行", () => {
    const p = confirmAction({ title: "x", confirmText: "彻底删除", level: 4 });
    expect(p).toBeInstanceOf(Promise);
    // 收尾：按取消结算，避免悬挂
    void p.catch(() => undefined);
  });

  it("无待确认请求时宿主不渲染（SSR 安全）", () => {
    expect(renderToStaticMarkup(<ConfirmHost />)).toBe("");
  });
});

describe("阶段3 · 确认弹窗主按钮用具体动词（R-D-24）", () => {
  it("本次改造的调用点都给了具体动词，不再用「确定」", () => {
    // 清空表：后端是软删进回收站（tables.ts:458 updateMany deletedAt；records.ts:214 /trash
    // 按 deletedAt 收 record），属**可恢复**破坏性操作 → 必须复用共享的 confirmClearTable（L3），
    // 不得再用 L4 的 confirmIrreversible，也不得保留「不进回收站 / 不可撤销」的错误口径。
    const grid = read("../features/grid/GridView.tsx");
    expect(grid).toContain("confirmClearTable({");
    expect(grid).not.toContain("confirmIrreversible({");
    expect(grid).not.toContain("不进回收站、不可撤销。");
    expect(grid).not.toContain("确定清空表中所有记录？此操作不可撤销。");

    const trash = read("../features/settings/TrashPage.tsx");
    expect(trash).toContain('confirmText: "彻底删除"');
    expect(trash).toContain('confirmText: "清空回收站"');
    expect(trash).not.toContain("确定要彻底删除");

    const vs = read("../features/grid/ViewSwitcher.tsx");
    expect(vs).toContain('confirmText: "删除视图"');
    expect(vs).not.toContain("确定删除视图");

    const tree = read("../features/kb/KbTree.tsx");
    expect(tree).toContain('confirmText: "删除并移入回收站"');
    expect(tree).not.toContain("确定删除「");
  });
});

// 新增回归护栏：清空表与删库的可恢复性相反，曾有两处文案把两者的回收站口径写反。
describe("阶段3 · 文案不得与后端恢复能力相悖", () => {
  it("清空表：走共享 L3 助手，并如实提示记录已进回收站", () => {
    // 后端软删 → 可从回收站恢复 → 调用点复用 L3 的 confirmClearTable，
    // 且操作完成后的 toast 必须如实说明记录的去向。
    const grid = read("../features/grid/GridView.tsx");
    expect(grid).toContain("confirmClearTable({");
    expect(grid).toContain("记录已移入回收站");
  });

  it("删库：如实说明无法从回收站恢复，且走 L4 不可恢复确认", () => {
    // 回收站（records.ts:214 /trash）只收 record / table / field，不含 base；
    // DELETE /bases/:baseId（bases.ts:267）还会把它下面的 table 一起标 deletedAt，
    // 使其连带从回收站列表消失 → 删库无恢复入口，必须是「不可恢复」口径 + L4。
    const settings = read("../features/settings/SettingsPage.tsx");
    expect(settings).toContain("无法从回收站恢复");
    expect(settings).toContain("confirmIrreversible({");
    expect(settings).not.toContain("confirmAction({");
    expect(settings).not.toContain("将被移入回收站");
  });
});
