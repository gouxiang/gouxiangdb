// 字段名同表唯一：输入侧即时校验回归（node 环境，无 jsdom、无新增依赖）。
//
// 后端口径：同 tableId 内 trim 后精确唯一，改名排除自己；纯空格交 400。
// 最关键的回归锁是「排除自己」：编辑抽屉打开不改名直接保存、或只改了个空格，
// 命中的是自己那一行，必须放行。

import { describe, it, expect } from "vitest";
import {
  findFieldNameConflict,
  fieldNameConflictMessage,
} from "./lib/field-name";

const FIELDS = [
  { id: "f1", name: "任务名称" },
  { id: "f2", name: "负责人" },
  { id: "f3", name: "截止日期" },
];

describe("判重纯函数（lib/field-name）", () => {
  it("重名命中", () => {
    expect(findFieldNameConflict(FIELDS, "负责人")).toBe("负责人");
  });

  it("没同名 → 放行", () => {
    expect(findFieldNameConflict(FIELDS, "优先级")).toBeNull();
  });

  it("trim 后同名 → 命中，返回 trim 后的名字", () => {
    expect(findFieldNameConflict(FIELDS, "  任务名称  ")).toBe("任务名称");
    expect(findFieldNameConflict(FIELDS, " 截止日期 ")).toBe("截止日期");
  });

  it("空 / 纯空格不报冲突", () => {
    expect(findFieldNameConflict(FIELDS, "")).toBeNull();
    expect(findFieldNameConflict(FIELDS, "   ")).toBeNull();
  });

  it("列表还没取到（undefined / null / 空）时不误报", () => {
    expect(findFieldNameConflict(undefined, "任务名称")).toBeNull();
    expect(findFieldNameConflict(null, "任务名称")).toBeNull();
    expect(findFieldNameConflict([], "任务名称")).toBeNull();
  });

  it("改名：改成自己现在的名字 → 放行（excludeId 排除自己）", () => {
    expect(findFieldNameConflict(FIELDS, "任务名称", "f1")).toBeNull();
  });

  it("改名：只加了个前后空格也算自己 → 放行", () => {
    expect(findFieldNameConflict(FIELDS, " 负责人 ", "f2")).toBeNull();
  });

  it("excludeId 只排除对应 id：撞到别的字段仍命中", () => {
    expect(findFieldNameConflict(FIELDS, "截止日期", "f1")).toBe("截止日期");
  });

  it("新建：不加 excludeId 时同名照样算冲突", () => {
    expect(findFieldNameConflict(FIELDS, "任务名称")).toBe("任务名称");
  });

  it("精确匹配：不做大小写/全半角归一化（与后端精确判重同口径）", () => {
    expect(findFieldNameConflict(FIELDS, "任务名称 ")).toBe("任务名称");
    expect(findFieldNameConflict(FIELDS, "负责任")).toBeNull();
  });

  it("提示文案", () => {
    expect(fieldNameConflictMessage("负责人")).toBe("字段名「负责人」已存在，请换一个");
  });
});
