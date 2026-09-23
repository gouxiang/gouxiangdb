// 表名同库唯一：输入侧即时校验回归（node 环境，无 jsdom、无新增依赖）。
//
// 分两层锁：
//   ① 判重是纯函数（lib/table-name.ts）——直接 import 跑真实逻辑，能证伪；
//   ② 接线在 SecondaryNavTableOps.tsx ——源码断言（本仓库既有口径，见 nav-library-create.test.ts），
//      锁「禁用 / title 原因 / 红字」三件事确实挂上去了，不是只在纯函数里算对。
//
// 最关键的一条是「排除自己」：用户打开重命名弹窗不改内容直接保存、或只改了个空格，
// 命中的是自己那一行 —— 必须放行。后端 assertTableNameFree 的 excludeTableId 同口径。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { findTableNameConflict, tableNameConflictMessage } from "./lib/table-name";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
/** 只取代码本体：注释里必然提到被断言的文案，不剥掉会让断言永远为真。 */
const codeOf = (s: string) =>
  s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

const TABLES = [
  { id: "t1", name: "客户主表" },
  { id: "t2", name: "订单明细" },
  { id: "t3", name: "回款台账" },
];

describe("① 判重纯函数（lib/table-name）", () => {
  it("建表：与已有表同名 → 命中冲突", () => {
    expect(findTableNameConflict(TABLES, "订单明细")).toBe("订单明细");
  });

  it("建表：没同名 → 放行", () => {
    expect(findTableNameConflict(TABLES, "供应商名录")).toBeNull();
  });

  it("建表：前后空格不算新名字（trim 后比较，返回 trim 后的名字）", () => {
    expect(findTableNameConflict(TABLES, "  客户主表  ")).toBe("客户主表");
  });

  it("建表：空输入不报冲突（交给「未填名」那条禁用理由，不叠加红字）", () => {
    expect(findTableNameConflict(TABLES, "")).toBeNull();
    expect(findTableNameConflict(TABLES, "   ")).toBeNull();
  });

  it("列表还没取到（undefined / null）时不误报", () => {
    expect(findTableNameConflict(undefined, "客户主表")).toBeNull();
    expect(findTableNameConflict(null, "客户主表")).toBeNull();
    expect(findTableNameConflict([], "客户主表")).toBeNull();
  });

  it("改名：撞到别的已存在表 → 命中冲突", () => {
    expect(findTableNameConflict(TABLES, "回款台账", "t1")).toBe("回款台账");
  });

  // —— 回归锁：排除自己 ——
  it("改名：改成自己现在的名字 → 放行（不排除自己就会连「只改图标」都保存不了）", () => {
    expect(findTableNameConflict(TABLES, "客户主表", "t1")).toBeNull();
  });

  it("改名：只加了个前后空格也算自己 → 放行", () => {
    expect(findTableNameConflict(TABLES, " 客户主表 ", "t1")).toBeNull();
  });

  it("改名：不加 excludeId 时自己照样算冲突（建表口径）", () => {
    expect(findTableNameConflict(TABLES, "客户主表")).toBe("客户主表");
  });

  it("精确匹配：不做大小写/全半角归一化（与后端精确判重同口径）", () => {
    expect(findTableNameConflict(TABLES, "订单明细 ")).toBe("订单明细");
    expect(findTableNameConflict(TABLES, "回款台帐")).toBeNull();
  });

  it("提示文案与后端 409 同一句，只补可执行的下一步", () => {
    expect(tableNameConflictMessage("订单明细")).toBe("表名「订单明细」已存在，请换一个");
  });
});

describe("② 接线（SecondaryNavTableOps.tsx 源码断言）", () => {
  const ops = codeOf(read("./SecondaryNavTableOps.tsx"));

  it("表列表走既有 useTables(baseId)（不裸 fetch、不新造查询）", () => {
    expect(ops).toContain("useTables(baseId)");
    expect(ops).not.toContain("fetch(");
  });

  it("建表：同名时「创建」按钮 disabled，且 title 挂禁用原因（R-D-09）", () => {
    expect(ops).toContain("disabled={!newName.trim() || !!newConflict}");
    expect(ops).toContain('title={newConflict ? tableNameConflictMessage(newConflict) : "创建（Enter）"}');
  });

  it("改名：同名（非自己）时「保存」按钮 disabled，且 title 挂禁用原因（R-D-09）", () => {
    expect(ops).toContain("disabled={!renaming?.name.trim() || !!renameConflict}");
    expect(ops).toContain("title={renameConflict ? tableNameConflictMessage(renameConflict) : undefined}");
  });

  it("改名判重必须传 excludeId（renaming.id）——不排除自己就是回归事故", () => {
    expect(ops).toContain("findTableNameConflict(tablesQ.data, renaming.name, renaming.id)");
  });

  it("两处都渲染红字提示，class 与仓库既有行内报错同口径（text-gx-12 text-gx-danger）", () => {
    expect(ops).toContain("text-gx-12 text-gx-danger");
    expect(ops.match(/text-gx-12 text-gx-danger/g)?.length).toBe(2);
  });

  it("Enter 提交不经过按钮的 disabled → createTable / renameTable 内部各挡一次", () => {
    expect(ops).toContain("if (newConflict) return;");
    expect(ops).toContain("if (renameConflict) return;");
  });

  it("没有硬编码色值（红字走 gx-danger 令牌）", () => {
    expect(ops).not.toMatch(/#[0-9a-fA-F]{3,6}/);
  });
});
