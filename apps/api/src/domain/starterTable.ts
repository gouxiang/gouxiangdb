// 新建 Base 时的默认「数据表 1」事务体（表 + 5 字段 + 网格视图）。
// 从 routes/bases.ts 抽出，REST 与 MCP 建库共用同一真源（避免默认结构漂移）。

import type { ViewConfig } from "@gx/shared-types";
import { makeOptions } from "./fieldService.js";
import type { DbTx } from "../db.js";

/** 默认网格视图配置（与前端默认配置同构）。 */
export function starterViewConfig(): ViewConfig {
  return {
    hiddenFieldIds: [],
    fieldOrder: [],
    rowHeight: "medium",
    filters: null,
    sorts: [],
    search: "",
    groupByFieldId: null,
    collapsedGroupKeys: [],
    aggregations: {},
    rowColor: { mode: "none", conditions: [] },
    coverFieldId: null,
    cardFieldIds: [],
    kanbanFieldId: null,
    dateFieldId: null,
    treeParentFieldId: null,
    ganttStartFieldId: null,
    ganttEndFieldId: null,
    ganttProgressFieldId: null,
    ganttDependencyFieldId: null,
    ganttZoom: "day",
    formFields: [],
    formTitle: "",
    formDescription: "",
    detailFieldIds: [],
    detailLayout: null,
  };
}

/**
 * 在 base 下创建默认表（名称/数量/状态/日期/备注 5 字段 + 网格视图）。
 * 纯事务体：只用传入 tx，调用方负责入队与其余多步写。
 */
export async function createStarterTableTx(
  tx: DbTx,
  baseId: string,
  userId: string,
  name = "数据表 1",
): Promise<{ id: string }> {
  const table = await tx.table.create({
    data: { baseId, name, primaryFieldId: "", createdBy: userId },
  });

  const nameField = await tx.field.create({
    data: { tableId: table.id, name: "名称", type: "singleLineText", order: 0 },
  });
  await tx.field.create({
    data: { tableId: table.id, name: "数量", type: "number", order: 1, precision: 0 },
  });
  await tx.field.create({
    data: {
      tableId: table.id,
      name: "状态",
      type: "singleSelect",
      order: 2,
      options: JSON.stringify(makeOptions(["未开始", "进行中", "已完成"])),
    },
  });
  await tx.field.create({
    data: { tableId: table.id, name: "日期", type: "date", order: 3 },
  });
  await tx.field.create({
    data: { tableId: table.id, name: "备注", type: "longText", order: 4 },
  });

  await tx.table.update({
    where: { id: table.id },
    data: { primaryFieldId: nameField.id },
  });

  await tx.view.create({
    data: { tableId: table.id, name: "网格视图", type: "grid", order: 0, config: JSON.stringify(starterViewConfig()) },
  });

  return table;
}
