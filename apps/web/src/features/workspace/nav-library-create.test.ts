// 一级导航「新建库」入口收敛回归（源码断言，无 jsdom、无新增依赖）。
//
// 锁的是主理人 2026-09-20 的要求：一级导航**只保留一个**「新建库」按钮，
// 去掉原先的「新建数据库」「新建知识库」两个按钮 —— 库类型改为在弹窗内二选一。
//
// 断言口径：先剥掉注释再判代码本体。因为文件头注释里保留了「形态沿革」说明
// （必然提到旧的两个按钮文案），不剥注释会永远命中旧文案、断言失去意义。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
/** 只取代码本体：行注释与块注释都不参与判定。 */
const codeOf = (s: string) =>
  s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

describe("一级导航：两个建库按钮收敛为一个「新建库」", () => {
  it("代码本体里不再出现「新建数据库」「新建知识库」两个入口文案", () => {
    const code = codeOf(read("./NavLibraryBlock.tsx"));
    expect(code).not.toContain("新建数据库");
    expect(code).not.toContain("新建知识库");
    expect(code).toContain("新建库");
  });

  it("单一入口渲染一个按钮（不再按类型 map 出多个），并保留折叠档只留图标的形态", () => {
    const code = codeOf(read("./NavLibraryBlock.tsx"));
    // 旧实现是 CREATE_ENTRIES.map 渲染两个按钮
    expect(code).not.toContain("CREATE_ENTRIES");
    expect(code).toContain('data-nav-row="library-create"');
    expect(code).toContain("collapsed ? null : <span");
  });

  it("弹窗不再锁死类型（不传 fixedType），库类型在弹窗内二选一", () => {
    const code = codeOf(read("./NavLibraryBlock.tsx"));
    expect(code).not.toContain("fixedType");
    // 两条创建流程仍由 CreateLibraryModal 内部按 type 分派，未被改写
    const modal = codeOf(read("../../components/CreateLibraryModal.tsx"));
    expect(modal).toContain('type === "base"');
    expect(modal).toContain("createKb.mutateAsync");
    expect(modal).toContain("TYPE_OPTIONS");
  });
});
