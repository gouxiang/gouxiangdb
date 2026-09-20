// 数据表「图标 + 颜色」入口回归（node 环境，纯源码断言，无 jsdom、无新增依赖）。
//
// 锁的是：五类实体自定义图标里「数据表」这一类必须有可达入口。
// 旧入口只在旧壳 Sidebar 的重命名弹窗里，而 Sidebar 只被 AppShell（flag off 回退壳）挂载，
// 默认布局走 WorkspaceShell → 真机进表页 [data-entity-icon-trigger] 数量为 0，功能等于没交付。
// 入口因此落在网格工具栏最左侧（唯一稳定存在的表页位置），并复用统一 EntityIconPicker。
//
// 2026-09-21：工具栏上提成统一外壳 ViewShell 后，这个入口随之上提——六类视图（不只是网格）
// 都能改数据表图标，故断言改对外壳文件生效，语义一字未变（仍是「表页可达 + 无权限不渲染」）。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("数据表图标与颜色入口（表页可达性）", () => {
  const grid = read("../views/ViewShell.tsx");

  it("表页工具栏挂载统一 EntityIconPicker，defaultIcon 为 table", () => {
    expect(grid).toContain('from "../../components/EntityIconPicker"');
    expect(grid).toContain("defaultIcon=\"table\"");
    // 触发器自带 resolved 图标预览 → 同时是本表页的展示位，不需要另找一处渲染
    expect(grid).toContain("ariaLabel=\"数据表图标与颜色\"");
  });

  it("无表结构管理权限即不渲染入口（不是 disabled 假装禁用）", () => {
    expect(grid).toContain("permissions.canManageSchema ? (");
  });

  it("选图标/选色走 updateTable 且两键都透传（nullable 语义不被吞）", () => {
    expect(grid).toContain("m.updateTable.mutateAsync");
    expect(grid).toContain("data: { icon: next.icon, iconColor: next.iconColor }");
  });

  it("入口不落在导航层（导航即将重构，避免白做一遍）", () => {
    const nav = read("../workspace/SecondaryNav.tsx") + read("../workspace/PrimaryNav.tsx");
    expect(nav).not.toContain("defaultIcon=\"table\"");
  });
});
