// 回收站「双选项卡」回归（纯函数 + 源码断言，无 jsdom、无新增依赖）。
//
// 锁的是主理人要求的两条：
//   ① 选项卡 A「数据表删除与恢复」= 结构类（表 / 字段）；选项卡 B「数据删除与恢复」= 记录。
//      后端 record 恢复分支一直存在，本轮只是把三种 kind 从「混在一个列表」拆成两个选项卡。
//   ② 「清空回收站」只清**当前选项卡**的项，不牵连另一个选项卡。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import type { TrashItemDTO } from "@gx/shared-types";
import { filterTrashByTab } from "./TrashPage";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

const item = (kind: TrashItemDTO["kind"], id: string): TrashItemDTO =>
  ({ id, kind, name: id, deletedAt: new Date().toISOString() }) as unknown as TrashItemDTO;

const ALL = [item("table", "t1"), item("field", "f1"), item("record", "r1")];
const ids = (list: TrashItemDTO[]) => list.map((i) => i.id);

describe("① 双选项卡按 kind 分流", () => {
  it("选项卡 A：只留数据表与字段，记录不出现", () => {
    expect(ids(filterTrashByTab(ALL, "schema"))).toEqual(["t1", "f1"]);
  });

  it("选项卡 B：只留记录，表与字段不出现", () => {
    expect(ids(filterTrashByTab(ALL, "record"))).toEqual(["r1"]);
  });

  it("两个选项卡的并集＝全部项，且互不重叠（不漏项也不重复）", () => {
    const a = ids(filterTrashByTab(ALL, "schema"));
    const b = ids(filterTrashByTab(ALL, "record"));
    expect([...a, ...b].sort()).toEqual(["f1", "r1", "t1"]);
    expect(a.filter((x) => b.includes(x))).toEqual([]);
  });

  it("空列表两个选项卡都为空（不报空指针）", () => {
    expect(filterTrashByTab([], "schema")).toEqual([]);
    expect(filterTrashByTab([], "record")).toEqual([]);
  });
});

describe("② 页面接线：选项卡文案与清空范围", () => {
  it("两个选项卡文案与要求逐字一致", () => {
    const src = read("./TrashPage.tsx");
    expect(src).toContain("数据表删除与恢复");
    expect(src).toContain("数据删除与恢复");
  });

  it("列表与空态都按当前选项卡渲染（不再直接用完整 items）", () => {
    const src = read("./TrashPage.tsx");
    expect(src).toContain("const visible = filterTrashByTab(items ?? [], tab)");
    expect(src).toContain("visible.length === 0");
    expect(src).toContain("visible.map((it) =>");
  });

  it("「清空回收站」只清当前选项卡：循环与条数都走 visible，不再是 items", () => {
    const src = read("./TrashPage.tsx");
    const body = src.slice(src.indexOf("async function purgeAll"), src.indexOf("return ("));
    expect(body).toContain("for (const it of visible)");
    expect(body).toContain("${visible.length}");
    expect(body).toContain("${activeTab.label}");
    expect(body).not.toContain("items.length");
  });
});
