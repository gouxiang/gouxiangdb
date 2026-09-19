// apps/web/src/features/detail/save-layout.test.ts
// 「保存布局」失败链路回归（node 环境，react-dom/server，无 jsdom、无新增依赖）
//
// 锁的是 P1 静默数据丢失修复：
//   ① 保存失败 → onSuccess 一次都不调用（面板**不关闭**）+ onError 拿到可读原因
//   ② 保存成功 → onError 一次都不调用（不会同时弹成功和失败）
//   ③ 错误文案优先级：后端信封 message → 信封 error → 错误对象 message → 兜底
//   ④ 三个 onSave 调用方一律 mutateAsync（mutate 不返回 Promise、失败不抛错）

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import { readFileSync } from "node:fs";
import { errorMessageOf, runSaveLayout, SAVE_FAILED_TEXT, SAVE_OK_TEXT } from "./save-layout";
import { FormDesignerToolbar } from "./FormDesigner";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

/** 后端错误信封形态（与 apiFetch 抛出的 ApiError 结构一致：{ status, body }） */
const apiErr = (status: number, body: Record<string, unknown>) =>
  Object.assign(new Error(`API ${status}: ${String(body.error ?? "")}`), { status, body });

describe("errorMessageOf：错误原因优先级", () => {
  it("后端信封 message 优先", () => {
    expect(errorMessageOf(apiErr(409, { message: "视图已锁定，当前角色无权修改" }))).toBe(
      "视图已锁定，当前角色无权修改",
    );
  });

  it("无 message 时回落信封 error", () => {
    expect(errorMessageOf(apiErr(500, { error: "内部错误" }))).toBe("内部错误");
  });

  it("无信封时回落错误对象自身 message（断网等）", () => {
    expect(errorMessageOf(new Error("Failed to fetch"))).toBe("Failed to fetch");
  });

  it("空白/无原因一律走兜底「保存失败，请重试」", () => {
    expect(errorMessageOf(new Error("   "))).toBe(SAVE_FAILED_TEXT);
    expect(errorMessageOf(undefined)).toBe(SAVE_FAILED_TEXT);
    expect(errorMessageOf(apiErr(500, {}))).toBe(SAVE_FAILED_TEXT);
  });
});

describe("runSaveLayout：失败不谎报成功", () => {
  it("成功：persist 收到布局 → onSuccess 调一次，onError 不调", async () => {
    const seen: unknown[] = [];
    let ok = 0;
    let err = 0;
    const done = await runSaveLayout({ rows: [] }, {
      persist: async (layout) => { seen.push(layout); return { ok: true }; },
      onSuccess: () => { ok += 1; },
      onError: () => { err += 1; },
    });
    expect(done).toBe(true);
    expect(seen).toEqual([{ rows: [] }]);
    expect(ok).toBe(1);
    expect(err).toBe(0);
  });

  it("失败（500）：面板不关闭（onSuccess 零次）+ 展示后端真实原因", async () => {
    let ok = 0;
    const errors: string[] = [];
    const done = await runSaveLayout({ rows: [] }, {
      persist: async () => { throw apiErr(500, { error: "内部错误" }); },
      onSuccess: () => { ok += 1; },
      onError: (m) => { errors.push(m); },
    });
    expect(done).toBe(false);
    // 关键断言：失败时绝不能触发「toast 成功 + 关闭面板」
    expect(ok).toBe(0);
    expect(errors).toEqual(["内部错误"]);
  });

  it("失败（断网 / 无原因）：展示兜底文案，面板不关闭", async () => {
    let ok = 0;
    const errors: string[] = [];
    const done = await runSaveLayout({ rows: [] }, {
      persist: async () => { throw new Error(""); },
      onSuccess: () => { ok += 1; },
      onError: (m) => { errors.push(m); },
    });
    expect(done).toBe(false);
    expect(ok).toBe(0);
    expect(errors).toEqual([SAVE_FAILED_TEXT]);
  });
});

describe("FormDesignerToolbar：失败原因常驻面板内", () => {
  const baseProps = {
    activeTab: "design" as const,
    onTabChange: () => {},
    device: "desktop" as const,
    onDeviceChange: () => {},
    onClose: () => {},
    onSave: () => {},
  };

  it("saveError 为空：无错误条，按钮为「保存布局」", () => {
    const html = render(<FormDesignerToolbar {...baseProps} />);
    expect(html).not.toContain("data-save-error");
    expect(html).toContain("保存布局");
  });

  it("saveError 非空：渲染 role=alert 错误条 + 后端真实原因 + 未保存提示", () => {
    const html = render(
      <FormDesignerToolbar {...baseProps} saveError="视图已锁定，当前角色无权修改" />,
    );
    expect(html).toContain("data-save-error");
    expect(html).toContain('role="alert"');
    expect(html).toContain("视图已锁定，当前角色无权修改");
    expect(html).toContain("布局未保存，可修改后重试");
  });

  it("saving：按钮转 loading 并禁用（防连点重复提交）", () => {
    const html = render(<FormDesignerToolbar {...baseProps} saving />);
    expect(html).toContain("保存中");
    expect(html).toContain("disabled");
    expect(html).toContain('aria-busy="true"');
  });
});

describe("接线回归：onSave 契约已是「返回 Promise、失败 reject」", () => {
  it("FormDesigner 不再无条件 toast 成功 + 关闭面板，改走 runSaveLayout", () => {
    const src = read("./FormDesigner.tsx");
    // 旧的静默成功：onSave(...); toast("已保存布局"); onClose(); —— 必须消失
    expect(src).not.toMatch(/onSave\(toSaved\(rows\)\);\s*\n\s*toast\("已保存布局"/);
    expect(src).toContain("runSaveLayout(");
    expect(src).toContain("onSave: (next: DetailLayout) => Promise<void>");
  });

  it("三个调用方一律 mutateAsync（mutate 不返回 Promise、失败不抛错）", () => {
    for (const p of ["../views/ViewRouter.tsx", "../views/DetailView.tsx", "../drawer/RecordDrawer.tsx"]) {
      const src = read(p);
      expect(src).toContain("updateView.mutateAsync");
      // 行内编辑布局的保存不得残留同步 mutate
      expect(src).not.toMatch(/updateView\.mutate\(\{/);
    }
  });

  it("成功文案与失败文案互斥存在（成功只在 await 成功后出现）", () => {
    expect(SAVE_OK_TEXT).toBe("已保存布局");
    expect(SAVE_FAILED_TEXT).toBe("保存失败，请重试");
    const src = read("./FormDesigner.tsx");
    expect(src).toContain("SAVE_OK_TEXT");
  });
});
