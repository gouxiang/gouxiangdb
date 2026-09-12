// apps/api/src/domain/__tests__/hydrate.test.ts
// hydration 核心链路测试（内存 deps，不依赖数据库）
//
// 覆盖 v1 Tests/reverse_link_test.swift 的全部场景 + 扩展：
//   正向关联 / 反向关联 / 显示字段 / Lookup / Rollup / Count /
//   双向关联防递归 / 公式点引用 / autoNumber / 系统字段

import { describe, it, expect } from "vitest";
import { hydrateRecords, type HydrateDeps, type LinkRowRef } from "../hydrate.js";
import type { FieldMeta, RawRecord, FieldValue } from "../types.js";

// ============ 测试夹具 ============

const FIELD = {
  // 任务表
  taskName: "f_task_name",
  taskHours: "f_task_hours",
  taskOwner: "f_task_owner", // links → members（正向，mm）
  taskOwnerLevel: "f_task_owner_level", // lookup
  taskCost: "f_task_cost", // rollup sum
  taskOwnerCount: "f_task_owner_count", // count
  taskSeq: "f_task_seq", // autoNumber
  taskCreated: "f_task_created", // createdTime
  taskLabel: "f_task_label", // formula: {名称} + 负责人
  taskLevel: "f_task_level", // formula 点引用: {负责人.职级}

  // 成员表
  memberName: "f_member_name",
  memberLevel: "f_member_level",
  memberRate: "f_member_rate",
  memberTasks: "f_member_tasks", // links → tasks（反向）
} as const;

const TABLE = { tasks: "t_tasks", members: "t_members" } as const;

function field(p: Partial<FieldMeta> & Pick<FieldMeta, "id" | "tableId" | "name" | "type" | "order">): FieldMeta {
  return {
    description: "",
    required: false,
    unique: false,
    options: null,
    precision: null,
    maxLength: null,
    defaultNow: false,
    recordFilter: null,
    linkFieldId: null,
    relatedTableId: null,
    relationKind: null,
    isReverse: false,
    reverseFieldId: null,
    linkDisplayFieldId: null,
    lookupFieldId: null,
    rollupFunction: null,
    formula: null,
    tabsConfig: null,
    displayedFieldIds: null,
    visibleFieldIds: null,
    defaultConfig: null,
    numberRule: null,
    ...p,
  };
}

const taskFields: FieldMeta[] = [
  field({ id: FIELD.taskName, tableId: TABLE.tasks, name: "名称", type: "singleLineText", order: 0 }),
  field({ id: FIELD.taskHours, tableId: TABLE.tasks, name: "工时", type: "number", order: 1, precision: 0 }),
  field({
    id: FIELD.taskOwner,
    tableId: TABLE.tasks,
    name: "负责人",
    type: "links",
    order: 2,
    relatedTableId: TABLE.members,
    relationKind: "mm",
    linkFieldId: FIELD.memberTasks,
    linkDisplayFieldId: FIELD.memberName,
  }),
  field({
    id: FIELD.taskOwnerLevel,
    tableId: TABLE.tasks,
    name: "负责人职级",
    type: "lookup",
    order: 3,
    linkFieldId: FIELD.taskOwner,
    lookupFieldId: FIELD.memberLevel,
  }),
  field({
    id: FIELD.taskCost,
    tableId: TABLE.tasks,
    name: "人力成本",
    type: "rollup",
    order: 4,
    linkFieldId: FIELD.taskOwner,
    lookupFieldId: FIELD.memberRate,
    rollupFunction: "sum",
  }),
  field({
    id: FIELD.taskOwnerCount,
    tableId: TABLE.tasks,
    name: "参与人数",
    type: "count",
    order: 5,
    linkFieldId: FIELD.taskOwner,
  }),
  field({ id: FIELD.taskSeq, tableId: TABLE.tasks, name: "序号", type: "autoNumber", order: 6 }),
  field({ id: FIELD.taskCreated, tableId: TABLE.tasks, name: "创建时间", type: "createdTime", order: 7 }),
  field({
    id: FIELD.taskLabel,
    tableId: TABLE.tasks,
    name: "标签",
    type: "formula",
    order: 8,
    formula: "CONCAT({名称}, ' / ', {负责人})",
  }),
  field({
    id: FIELD.taskLevel,
    tableId: TABLE.tasks,
    name: "职级汇总",
    type: "formula",
    order: 9,
    formula: "{负责人.职级}",
  }),
];

const memberFields: FieldMeta[] = [
  field({ id: FIELD.memberName, tableId: TABLE.members, name: "姓名", type: "singleLineText", order: 0 }),
  field({ id: FIELD.memberLevel, tableId: TABLE.members, name: "职级", type: "singleLineText", order: 1 }),
  field({ id: FIELD.memberRate, tableId: TABLE.members, name: "时薪", type: "number", order: 2, precision: 0 }),
  field({
    id: FIELD.memberTasks,
    tableId: TABLE.members,
    name: "任务（反向）",
    type: "links",
    order: 3,
    relatedTableId: TABLE.tasks,
    relationKind: "mm",
    isReverse: true,
    reverseFieldId: FIELD.taskOwner,
    linkFieldId: FIELD.taskOwner,
    linkDisplayFieldId: FIELD.taskName,
  }),
];

function rec(id: string, tableId: string, fields: Record<string, FieldValue>): RawRecord {
  return {
    id,
    tableId,
    fields,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    createdBy: "u_admin",
    updatedBy: "u_admin",
  };
}

const records: RawRecord[] = [
  rec("r_task1", TABLE.tasks, { [FIELD.taskName]: "登录页改版", [FIELD.taskHours]: 12 }),
  rec("r_task2", TABLE.tasks, { [FIELD.taskName]: "数据迁移", [FIELD.taskHours]: 8 }),
  rec("r_member1", TABLE.members, {
    [FIELD.memberName]: "张三",
    [FIELD.memberLevel]: "P7",
    [FIELD.memberRate]: 200,
  }),
  rec("r_member2", TABLE.members, {
    [FIELD.memberName]: "李四",
    [FIELD.memberLevel]: "P6",
    [FIELD.memberRate]: 150,
  }),
];

// 数据挂在正向字段（taskOwner）上
const linkRows: LinkRowRef[] = [
  { id: "l1", linkFieldId: FIELD.taskOwner, parentRowId: "r_task1", childRowId: "r_member1", ord: 0 },
  { id: "l2", linkFieldId: FIELD.taskOwner, parentRowId: "r_task1", childRowId: "r_member2", ord: 1 },
  { id: "l3", linkFieldId: FIELD.taskOwner, parentRowId: "r_task2", childRowId: "r_member2", ord: 0 },
];

function makeDeps(): HydrateDeps {
  const ordinals = new Map<string, string[]>([
    [TABLE.tasks, ["r_task1", "r_task2"]],
    [TABLE.members, ["r_member1", "r_member2"]],
  ]);
  return {
    async getFields(tableId) {
      return tableId === TABLE.tasks ? taskFields : memberFields;
    },
    async getRecordsByIds(ids) {
      return records.filter((r) => ids.includes(r.id));
    },
    async getLinkRows(q) {
      return linkRows.filter(
        (l) =>
          (!q.linkFieldId || l.linkFieldId === q.linkFieldId) &&
          (!q.parentRowId || l.parentRowId === q.parentRowId) &&
          (!q.childRowId || l.childRowId === q.childRowId),
      );
    },
    async countLinkRows(q) {
      return linkRows.filter(
        (l) =>
          (!q.linkFieldId || l.linkFieldId === q.linkFieldId) &&
          (!q.parentRowId || l.parentRowId === q.parentRowId) &&
          (!q.childRowId || l.childRowId === q.childRowId),
      ).length;
    },
    async getRecordOrdinal(tableId, recordId) {
      return (ordinals.get(tableId) ?? []).indexOf(recordId) + 1;
    },
    async resolveUserName(userId) {
      return userId === "u_admin" ? "管理员" : userId;
    },
  };
}

async function hydrateTasks() {
  const deps = makeDeps();
  return await hydrateRecords(
    records.filter((r) => r.tableId === TABLE.tasks),
    taskFields,
    deps,
  );
}

async function hydrateMembers() {
  const deps = makeDeps();
  return await hydrateRecords(
    records.filter((r) => r.tableId === TABLE.members),
    memberFields,
    deps,
  );
}

// ============ 断言 ============

describe("正向关联（links）", () => {
  it("任务 A 关联到两个成员，按 ord 排序", async () => {
    const [task1] = await hydrateTasks();
    const links = task1!.fields[FIELD.taskOwner] as { recordId: string; title: string }[];
    expect(links).toHaveLength(2);
    expect(links[0]!.recordId).toBe("r_member1");
    expect(links[0]!.title).toBe("张三");
    expect(links[1]!.title).toBe("李四");
  });

  it("无关联的记录返回空数组", async () => {
    const rec3 = rec("r_task3", TABLE.tasks, { [FIELD.taskName]: "无主任务" });
    records.push(rec3);
    const deps = makeDeps();
    const [out] = await hydrateRecords([rec3], taskFields, deps);
    expect(out!.fields[FIELD.taskOwner]).toEqual([]);
    records.pop();
  });

  it("linkDisplayFieldId 决定胶囊标题", async () => {
    const withDisplay = taskFields.map((f) =>
      f.id === FIELD.taskOwner ? { ...f, linkDisplayFieldId: FIELD.memberLevel } : f,
    );
    const deps = makeDeps();
    const [task1] = await hydrateRecords(
      [records[0]!],
      withDisplay,
      deps,
    );
    const links = task1!.fields[FIELD.taskOwner] as { title: string }[];
    expect(links[0]!.title).toBe("P7"); // 职级而不是姓名
  });
});

describe("反向关联（v1 核心场景）", () => {
  it("成员能看到自己参与的任务", async () => {
    const members = await hydrateMembers();
    const zhangsan = members.find((m) => m.id === "r_member1")!;
    const tasks = zhangsan.fields[FIELD.memberTasks] as { recordId: string; title: string }[];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.recordId).toBe("r_task1");
    expect(tasks[0]!.title).toBe("登录页改版");
  });

  it("李四参与两个任务", async () => {
    const members = await hydrateMembers();
    const lisi = members.find((m) => m.id === "r_member2")!;
    const tasks = lisi.fields[FIELD.memberTasks] as { recordId: string }[];
    expect(tasks.map((t) => t.recordId).sort()).toEqual(["r_task1", "r_task2"]);
  });

  it("双向关联不会无限递归（v1 真 bug：栈溢出）", async () => {
    // tasks 表同时含正向字段与成员表的反向字段引用；
    // 若防护失效，这里会栈溢出或超时
    const start = Date.now();
    const tasks = await hydrateTasks();
    const members = await hydrateMembers();
    expect(tasks).toHaveLength(2);
    expect(members).toHaveLength(2);
    expect(Date.now() - start).toBeLessThan(3000);
  });
});

describe("Lookup / Rollup / Count", () => {
  it("lookup 取关联记录的职级", async () => {
    const [task1] = await hydrateTasks();
    expect(task1!.fields[FIELD.taskOwnerLevel]).toEqual(["P7", "P6"]);
  });

  it("rollup sum 求时薪之和", async () => {
    const [task1] = await hydrateTasks();
    expect(task1!.fields[FIELD.taskCost]).toBe(350); // 200 + 150
  });

  it("count 统计关联数量", async () => {
    const tasks = await hydrateTasks();
    expect(tasks[0]!.fields[FIELD.taskOwnerCount]).toBe(2);
    expect(tasks[1]!.fields[FIELD.taskOwnerCount]).toBe(1);
  });

  it("rollup 无关联时 count 返回 0，sum 返回 null", async () => {
    const noLink = rec("r_task9", TABLE.tasks, { [FIELD.taskName]: "无人任务" });
    records.push(noLink);
    const deps = makeDeps();
    const [out] = await hydrateRecords([noLink], taskFields, deps);
    expect(out!.fields[FIELD.taskOwnerCount]).toBe(0);
    expect(out!.fields[FIELD.taskCost]).toBe(null);
    records.pop();
  });
});

describe("系统字段", () => {
  it("autoNumber 按记录顺序生成序号", async () => {
    const tasks = await hydrateTasks();
    expect(tasks[0]!.fields[FIELD.taskSeq]).toBe(1);
    expect(tasks[1]!.fields[FIELD.taskSeq]).toBe(2);
  });

  it("createdTime 取记录创建时间", async () => {
    const [task1] = await hydrateTasks();
    expect(task1!.fields[FIELD.taskCreated]).toBe("2026-01-01T00:00:00.000Z");
  });

  it("createdBy 解析为用户显示名", async () => {
    const withUser = [
      ...taskFields,
      field({ id: "f_cb", tableId: TABLE.tasks, name: "创建人", type: "createdBy", order: 10 }),
    ];
    const deps = makeDeps();
    const [out] = await hydrateRecords([records[0]!], withUser, deps);
    expect(out!.fields["f_cb"]).toBe("管理员");
  });
});

describe("公式（含关联点引用）", () => {
  it("{关联字段} 展开为 title 拼接", async () => {
    const [task1] = await hydrateTasks();
    expect(task1!.fields[FIELD.taskLabel]).toBe("登录页改版 / 张三, 李四");
  });

  it("{关联字段.子字段} 多条关联记录注入为列表（不再静默 join 成字符串）", async () => {
    const [task1] = await hydrateTasks();
    // 新契约：0 条→null、1 条→标量、多条→list；拼接/聚合由 SUM/CONCAT 等常规函数显式完成
    expect(task1!.fields[FIELD.taskLevel]).toEqual(["P7", "P6"]);
  });

  it("点引用多值可显式 CONCAT 拼接 / 单条关联为标量", async () => {
    const concatFields = taskFields.map((f) =>
      f.id === FIELD.taskLevel ? { ...f, formula: "CONCAT({负责人.职级})" } : f,
    );
    const deps = makeDeps();
    const [out] = await hydrateRecords([records[0]!], concatFields, deps);
    expect(out!.fields[FIELD.taskLevel]).toBe("P7P6");

    // 只关联一个成员的任务（record2 → member2，职级 P6）→ 标量字符串
    const [out2] = await hydrateRecords([records[1]!], concatFields, deps);
    expect(out2!.fields[FIELD.taskLevel]).toBe("P6");
  });

  it("引用不存在的点字段返回空串", async () => {
    const bad = taskFields.map((f) =>
      f.id === FIELD.taskLevel ? { ...f, formula: "{负责人.不存在}" } : f,
    );
    const deps = makeDeps();
    const [out] = await hydrateRecords([records[0]!], bad, deps);
    expect(out!.fields[FIELD.taskLevel]).toBe(null);
  });

  it("公式自引用不会死循环，返回 null", async () => {
    const self = taskFields.map((f) =>
      f.id === FIELD.taskLabel ? { ...f, formula: "CONCAT({标签}, 'x')" } : f,
    );
    const deps = makeDeps();
    const [out] = await hydrateRecords([records[0]!], self, deps);
    expect(out!.fields[FIELD.taskLabel]).toBe("x");
  });

  it("公式错误不炸整表，字段值为 null", async () => {
    const bad = taskFields.map((f) => (f.id === FIELD.taskLabel ? { ...f, formula: "FOO(1)" } : f));
    const deps = makeDeps();
    const [out] = await hydrateRecords([records[0]!], bad, deps);
    expect(out!.fields[FIELD.taskLabel]).toBe(null);
  });

  it("公式链式依赖按拓扑序求解", async () => {
    const chain: FieldMeta[] = [
      ...taskFields,
      field({
        id: "f_chain2",
        tableId: TABLE.tasks,
        name: "链式2",
        type: "formula",
        order: 11,
        formula: "{标签} & '!'", // 依赖 f_taskLabel
      }),
    ];
    const deps = makeDeps();
    const [out] = await hydrateRecords([records[0]!], chain, deps);
    expect(out!.fields["f_chain2"]).toBe("登录页改版 / 张三, 李四!");
  });
});

describe("物理与计算字段分离", () => {
  it("计算字段不回写 records.fields，只在 hydration 结果里", async () => {
    const [task1] = await hydrateTasks();
    // 物理字段存在
    expect(task1!.fields[FIELD.taskName]).toBe("登录页改版");
    // 计算字段也有值
    expect(task1!.fields[FIELD.taskOwnerCount]).toBe(2);
    // 原始记录未被污染
    expect(records[0]!.fields).not.toHaveProperty(FIELD.taskOwnerCount);
  });
});
