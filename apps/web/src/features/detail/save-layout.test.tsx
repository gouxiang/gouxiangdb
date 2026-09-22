// apps/web/src/features/detail/save-layout.test.ts
// 「保存布局」失败链路回归（node 环境，react-dom/server，无 jsdom、无新增依赖）
//
// 锁的是 P1 静默数据丢失修复：
//   ① 保存失败 → onSuccess 一次都不调用（面板**不关闭**）+ onError 拿到可读原因
//   ② 保存成功 → onError 一次都不调用（不会同时弹成功和失败）
//   ③ 错误文案优先级：后端信封 message → 信封 error → 错误对象 message → 兜底
//   ④ 保存端点的调用方一律 mutateAsync（mutate 不返回 Promise、失败不抛错）
//      —— 保存路径已收口到事务端点 POST /api/views/:viewId/detail-layout，
//         「三个 onSave 调用方」降级为无 viewId 时的兜底路径，两条都要守住。

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

describe("回退接线回归：备份失败必须中止，且说清「没回退」", () => {
  /**
   * 回退第①步是「先把当前草稿存成版本」，失败就整体中止。这里锁两件事：
   *   ① 文案必须带「回退已中止 / 草稿未改动」—— 只抛后端原因（如「字段不存在或已删除」）
   *      用户会以为回退已经做完了，实际草稿一行没动；
   *   ② 备份失败后必须 return，绝不能继续往下覆盖草稿区。
   */
  it("备份失败：文案说清「已取消回退」，且 return 不再覆盖草稿", () => {
    const src = read("./FormDesigner.tsx");
    // 备份失败 = 这次回退不可撤销，必须是"没回退"，不能说成"回退了只是备份没成"
    expect(src).toContain("未能创建回退前的备份，已取消本次回退");
    expect(src).toContain("草稿未改动");
    expect(src).toMatch(/toast\(msg, "error"\);\s*\n\s*return;/);
  });

  /**
   * 无 viewId 时保留老的 PATCH 兜底（不因为拿不到视图 id 就整个存不了），但版本功能
   * 必须**显式不可用**并说明原因（R-D-09）：静默隐藏会让用户以为"这功能没了"。
   */
  /**
   * 预览与真实回退必须共用同一道 0 页闸门：预览少了它，会渲染成"一个页都没有"，
   * 而真实回退是保留原样 + 提示不可清空 —— 用户照着预览点回退，结果和看到的不一样。
   * 两侧同一行判据，用字符串对拍钉住，防止改一边漏一边。
   */
  it("预览与真实回退共用同一道 0 页闸门（抽屉里也要带）", () => {
    const guard = /isEmptyTabsEntry\(entry\) && !TABS_CLEAR_SUPPORTED/;
    expect(read("./FormDesigner.tsx")).toMatch(guard); // 真实回退
    expect(read("./form-versioning/VersionHistoryDrawer.tsx")).toMatch(guard); // 预览
  });

  it("无 viewId：历史入口显式禁用 + title 给出原因，不静默隐藏", () => {
    const src = read("./FormDesigner.tsx");
    expect(src).toContain("historyBlockReason(viewId)");
    expect(src).toContain("disabled={!!historyReason}");
    expect(src).toContain("disabledReason={historyReason");
  });

  it("回退只填草稿：handleRollback 内不得调用 doSave / onSave（落库只由保存布局触发）", () => {
    const src = read("./FormDesigner.tsx");
    const body = src.slice(src.indexOf("const handleRollback"), src.indexOf("const handleSave"));
    expect(body).not.toContain("doSave(");
    expect(body).not.toContain("onSave(");
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

  it("三个 onSave 调用方一律 mutateAsync（mutate 不返回 Promise、失败不抛错）", () => {
    for (const p of ["../views/ViewRouter.tsx", "../views/DetailView.tsx", "../drawer/RecordDrawer.tsx"]) {
      const src = read(p);
      expect(src).toContain("updateView.mutateAsync");
      // 行内编辑布局的保存不得残留同步 mutate
      expect(src).not.toMatch(/updateView\.mutate\(\{/);
    }
  });

  /**
   * 保存路径换端点后，这条守卫跟着换对象：现在真正落库的是事务端点
   * `POST /api/views/:viewId/detail-layout`，它的调用方同样必须 mutateAsync。
   * 精神不变 —— 退化成同步 `mutate` 的话，请求失败既不返回 Promise 也不抛错，
   * runSaveLayout 会当成"成功"，于是 toast「已保存布局」并关闭面板（P1 静默数据丢失）。
   */
  it("事务端点 detail-layout 的调用方一律 mutateAsync（保存失败不得静默谎报成功）", () => {
    const src = read("./FormDesigner.tsx");
    expect(src).toContain("saveDetailLayout.mutateAsync");
    // 同步 mutate 不抛错、不返回 Promise，是当年 P1 的根因，绝不能出现
    expect(src).not.toMatch(/saveDetailLayout\.mutate\(\{/);
    // 端点必须走 api/client.ts 的类型化方法（JWT 注入 + 超时 + 401 处理），不能裸 fetch
    const client = read("../../api/client.ts");
    expect(client).toContain("/detail-layout");
    expect(client).not.toMatch(/fetch\([^)]*detail-layout/);
  });

  it("响应 version 为 null（判重未留新版本）不算失败，前端不据此报错", () => {
    const client = read("../../api/client.ts");
    // 契约里 version 可空，保存成功与否只看请求是否 2xx（apiFetch 非 2xx 会抛），
    // 故这里锁死：客户端只是声明类型，不把 version 当成功判据去分支报错。
    expect(client).toContain("version: number | null");
    const src = read("./FormDesigner.tsx");
    expect(src).not.toMatch(/version\s*===\s*null/);
  });

  /**
   * 服务端会在落库前剔除「布局里引用了、表里已删除」的字段。这是**真实的数据丢失**，
   * 静默掉等于骗用户「字段还在，只是没渲染出来」。契约里既然给了 removedFieldIds，
   * 前端就必须把它读出来并说给用户听。
   */
  it("服务端剔除的已删字段必须提示出来，不得静默丢失", () => {
    const client = read("../../api/client.ts");
    expect(client).toContain("removedFieldIds: string[]");
    const src = read("./FormDesigner.tsx");
    // 只读 mutateAsync 不接返回值 = 剔除信息被吞掉
    expect(src).toContain("res.removedFieldIds");
    expect(src).toMatch(/removed\.length > 0/);
  });

  /**
   * `skipped` = 发了但服务端没写进去的容器键。这是同一类"静默 no-op"的另一种形态：
   * 请求 200、布局存了、只有这几个选项卡容器没生效。不提示 = 用户以为全存了。
   */
  it("发了但没写进去的容器（skipped）同样必须提示，不得静默", () => {
    const client = read("../../api/client.ts");
    // 契约上恒存在（没跳过时是 []），前端按真值消费，不留"永远空"的假接口
    expect(client).toContain("skipped: string[]");
    const src = read("./FormDesigner.tsx");
    expect(src).toContain("res.skipped");
    expect(src).toMatch(/skipped\.length > 0/);
  });

  it("成功文案与失败文案互斥存在（成功只在 await 成功后出现）", () => {
    expect(SAVE_OK_TEXT).toBe("已保存布局");
    expect(SAVE_FAILED_TEXT).toBe("保存失败，请重试");
    const src = read("./FormDesigner.tsx");
    expect(src).toContain("SAVE_OK_TEXT");
  });
});
