// 「更多 → 清空表」的权限红线（node 环境：react-dom/server + 源码断言，无 jsdom、无新增依赖）。
//
// 锁的是 WALK-权限组合-2026-09-20 · PERM-02：走查发现阅读者在表格工具栏「更多」里能看到红色的
// 「清空表」，还能走完 L3 输入表名确认，直到提交才被后端 403 打回——典型的「先给你一个入口，
// 再告诉你没权限」。
//
// 项目口径（与 settings/perm-hide-gating.test.ts 同一条红线）：
//   **破坏性 / 管理配置类**入口，无权限时根本不渲染，而不是渲染成灰色 disabled。
//   （数据编辑类的「新建记录」「回收站恢复」才走 disabled + 原因，本文件不涉及。）
//
// 为什么这里用源码断言而不是点击测试：溢出菜单要点开「更多」才会挂载 <Menu>，
// 而 apps/web 没有 jsdom（sanitize-html.test.ts 明确写了：禁止为测试新增依赖），
// renderToStaticMarkup 只能拿到 open=null 的首屏。因此这两条用**结构化正则**把
// 「清空表菜单项必须在 canEditData 门里」钉死，并配一条 SSR 冒烟保证门控本身不炸。

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import { readFileSync } from "node:fs";
import type { ViewConfig } from "@gx/shared-types";
import { GridToolbar } from "./GridToolbar";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const countOf = (s: string, needle: string) => s.split(needle).length - 1;

const config: ViewConfig = {
  hiddenFieldIds: [],
  fieldOrder: [],
  rowHeight: "medium",
  filters: null,
  sorts: [],
  search: "",
  groupByFieldId: null,
  collapsedGroupKeys: [],
  aggregations: {},
  rowColor: { mode: "none", fieldId: null, rules: [] },
  coverFieldId: null,
} as unknown as ViewConfig;

const noop = () => undefined;

function renderToolbar(permissions: { canEditData: boolean; canManageSchema: boolean }) {
  return render(
    <GridToolbar
      config={config}
      permissions={permissions}
      onUpdateConfig={noop}
      onNewRecord={noop}
      onImport={noop}
      onExport={noop}
      onCopyView={noop}
      onClearTable={noop}
    />,
  );
}

describe("PERM-02：清空表入口受 canEditData 门控，且是「不渲染」而非「置灰」", () => {
  it("源码里「清空表」菜单项唯一，且落在 permissions.canEditData && 门内", () => {
    const src = read("./GridToolbar.tsx");
    // 唯一：全仓只允许这一个清空表入口，防止有人另开一个无门控的（历史上的 PERM-02 就是这么来的）
    expect(countOf(src, 'label="清空表"')).toBe(1);
    // 必须在门内：拆掉 permissions.canEditData && 这层括号，正则立即失配。
    expect(src).toMatch(
      /permissions\.canEditData\s*&&\s*\(\s*<MenuItem[\s\S]{0,200}?label="清空表"/,
    );
  });

  it("不允许把清空表做成 disabled 假入口（改 Tier 也不能偷换实现方式）", () => {
    const src = read("./GridToolbar.tsx");
    // 红线要求「不渲染」，所以源码里不许出现给清空表挂 disabled 的写法。
    expect(src).not.toMatch(/disabled=\{!permissions\.canEditData\}[\s\S]{0,200}?清空表/);
    expect(src).not.toMatch(/清空表[\s\S]{0,200}?disabled=\{!permissions\.canEditData\}/);
  });

  it("SSR 冒烟：三种权限组合都能渲染，门控本身不抛错", () => {
    for (const p of [
      { canEditData: true, canManageSchema: true }, // owner / creator
      { canEditData: true, canManageSchema: false }, // editor：后端放行清空
      { canEditData: false, canManageSchema: false }, // commenter / viewer
    ]) {
      const html = renderToolbar(p);
      // 首屏 open=null，溢出菜单未挂载：这里保证的是门控读取 permissions 不会炸。
      expect(html).toContain("新建记录");
      expect(html).toContain("更多");
    }
  });

  it("工具栏的权限入参类型仍只依赖 canEditData / canManageSchema（不引入新权限源）", () => {
    const src = read("./GridToolbar.tsx");
    expect(src).toContain("permissions: { canEditData: boolean; canManageSchema: boolean };");
  });
});
