// 库名 / 知识库名全局唯一：输入侧即时校验回归（node 环境，无 jsdom、无新增依赖）。
//
// 后端口径：数据库与知识库【全局】唯一 —— 两类必须合并判重，跨类型撞名也要拦下。
// 最关键的回归锁是「排除自己」：改名弹窗打开不改名直接保存、或只改了个空格，
// 命中的是自己那一行，必须放行。

import { describe, it, expect } from "vitest";
import {
  findLibraryNameConflict,
  libraryNameConflictMessage,
} from "./lib/library-name";

const BASES = [
  { id: "b1", name: "客户管理" },
  { id: "b2", name: "订单中心" },
];
const KBS = [
  { id: "k1", name: "产品资料库" },
  { id: "k2", name: "研发知识库" },
];

describe("判重纯函数（lib/library-name）", () => {
  it("base 与 base 重名 → 命中冲突", () => {
    expect(findLibraryNameConflict(BASES, KBS, "订单中心")).toBe("订单中心");
  });

  it("kb 与 kb 重名 → 命中冲突", () => {
    expect(findLibraryNameConflict(BASES, KBS, "研发知识库")).toBe("研发知识库");
  });

  it("跨类型互斥：输入名撞另一类（base 名撞 kb 名）→ 命中", () => {
    expect(findLibraryNameConflict(BASES, KBS, "产品资料库")).toBe("产品资料库");
  });

  it("跨类型互斥（反向）：kb 起的名撞已有 base 名 → 命中", () => {
    expect(findLibraryNameConflict(BASES, KBS, "客户管理")).toBe("客户管理");
  });

  it("没同名 → 放行", () => {
    expect(findLibraryNameConflict(BASES, KBS, "供应商名录")).toBeNull();
  });

  it("trim 后同名 → 命中，返回 trim 后的名字", () => {
    expect(findLibraryNameConflict(BASES, KBS, "  客户管理  ")).toBe("客户管理");
    expect(findLibraryNameConflict(BASES, KBS, " 产品资料库 ")).toBe("产品资料库");
  });

  it("空 / 纯空格不报冲突（交给「未填名」那条禁用理由）", () => {
    expect(findLibraryNameConflict(BASES, KBS, "")).toBeNull();
    expect(findLibraryNameConflict(BASES, KBS, "   ")).toBeNull();
  });

  it("列表还没取到（undefined / null / 空）时不误报", () => {
    expect(findLibraryNameConflict(undefined, undefined, "客户管理")).toBeNull();
    expect(findLibraryNameConflict(null, null, "客户管理")).toBeNull();
    expect(findLibraryNameConflict([], [], "客户管理")).toBeNull();
  });

  it("改名：改成自己现在的名字 → 放行（excludeId 排除自己）", () => {
    expect(findLibraryNameConflict(BASES, KBS, "客户管理", "b1")).toBeNull();
    expect(findLibraryNameConflict(BASES, KBS, "产品资料库", "k1")).toBeNull();
  });

  it("改名：只加了个前后空格也算自己 → 放行", () => {
    expect(findLibraryNameConflict(BASES, KBS, " 客户管理 ", "b1")).toBeNull();
  });

  it("excludeId 只排除对应 id：撞到别的名字仍命中（含跨类型 id 不误排）", () => {
    expect(findLibraryNameConflict(BASES, KBS, "订单中心", "b1")).toBe("订单中心");
    expect(findLibraryNameConflict(BASES, KBS, "研发知识库", "k1")).toBe("研发知识库");
    expect(findLibraryNameConflict(BASES, KBS, "客户管理", "k1")).toBe("客户管理");
  });

  it("精确匹配：不做大小写/全半角归一化（与后端精确判重同口径）", () => {
    expect(findLibraryNameConflict(BASES, KBS, "订单中心 ")).toBe("订单中心");
    expect(findLibraryNameConflict(BASES, KBS, "客户管理 ")).toBe("客户管理");
    expect(findLibraryNameConflict(BASES, KBS, "订单中芯")).toBeNull();
  });

  it("提示文案", () => {
    expect(libraryNameConflictMessage("客户管理")).toBe("库名「客户管理」已存在，请换一个");
  });
});
