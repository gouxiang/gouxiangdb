// apps/api/scripts/bench/scenarios.ts
// M1/S9 压测场景矩阵（纯定义、无 IO，可单测）：把 plan §8 的读/写场景落成
// ViewConfig 片段（filter/sort/aggregation/group 全部经预置 view 下发，与真实前端一致）
// 或 query 参数（home/search）。
//
// 场景刻意覆盖三条 keyset 路径（见 S7 paginate）：
//   T1 keyset-created：无排序、过滤全物理（home / eq / range / isAnyOf / 物理 OR）
//   T2 keyset-sorted ：valueNum 物理排序（number/date/checkbox 排序）
//   T3 keyset-wide   ：残余过滤 / 文本或单选排序 / 搜索 / 分组（分页前全量精修）
// 字段 id 全部来自 gen manifest（fieldIds/peerFieldIds），本模块只组装，不造 id。

import type { FilterNode, SortSpec, ViewConfig } from "@gx/shared-types";

/** manifest.tableReports[].fieldIds 的元素形态。 */
export interface FieldRef {
  id: string;
  name: string;
  type: string;
}
export type FieldCatalog = Record<string, FieldRef>;

export type SceneKind = "view" | "home" | "search" | "write" | "mixed";

export interface SceneDef {
  name: string;
  kind: SceneKind;
  /** 人类可读说明（进报告），写清预期 keyset 档位与下推/残余。 */
  desc: string;
  /** kind=view 时写入预置 view 的配置（parseViewConfig 缺省其余键）。 */
  config?: Partial<ViewConfig>;
  /** kind=search 时的搜索词（走列表 search 参数，T3）。 */
  search?: string;
  /** 深页场景：采样前顺序翻到第 N 页取 cursor，采样恒打该 cursor（测稳定深页延迟）。 */
  cursorPage?: number;
  /** kind=write：每请求创建一条记录时写入的主字段标题前缀（POST /api/records）。 */
  writeTitlePrefix?: string;
}

type Fields = FieldCatalog;

function cond(fieldId: string, op: string, value = ""): FilterNode {
  return { kind: "condition", fieldId, op: op as never, value } as FilterNode;
}
function and(children: FilterNode[]): FilterNode {
  return { kind: "and", children };
}
function or(children: FilterNode[]): FilterNode {
  return { kind: "or", children };
}
function sort(fieldId: string, direction: "asc" | "desc"): SortSpec[] {
  return [{ fieldId, direction }];
}

/**
 * 由 manifest 字段目录构造场景矩阵。wide 形态字段齐全；narrow 缺字段的数值/分组类
 * 场景由调用方按 available 标记裁剪（run-gate 只跑 catalog 里存在的场景）。
 */
export function buildSceneDefs(F: Fields, rows: number, pageLimit: number): SceneDef[] {
  const has = (k: string): boolean => Boolean(F[k]);
  const id = (k: string): string => F[k]!.id;
  const scenes: SceneDef[] = [];

  // ---- T1：无排序首页（物理全表 + createdAt keyset）----
  scenes.push({ name: "home_first", kind: "home", desc: "首页无过滤无排序（T1 keyset-created，覆盖索引）" });
  // 深页取总页数约 80% 处（team-lead 口径"深页 80%"），至少第 2 页。
  const totalPages = Math.max(1, Math.floor(rows / pageLimit));
  const deepPage = Math.max(2, Math.min(99, Math.floor(totalPages * 0.8)));
  scenes.push({
    name: "home_deep", kind: "home", cursorPage: deepPage,
    desc: `深页（固定第 ${deepPage}/${totalPages} 页≈80% 处，T1 索引 seek 快进，无 SQL OFFSET）`,
  });
  // ---- 深翻窗口边缘：offset 顶到 limit×5 窗口外一页。on 档必须 400（引导改 cursor），
  //      off/shadow 档仍走 offset slice 返 200（慢但正确）；load.ts 按期望状态码判成功。 ----
  scenes.push({
    name: "deep_window_edge", kind: "home",
    desc: `offset=${pageLimit}×5+${pageLimit} 超窗边缘（keyset-on 期望 400；off/shadow 期望 200）`,
  });

  // ---- T1：物理等值（单选 is）----
  if (has("status")) {
    scenes.push({
      name: "filter_eq_select", kind: "view",
      desc: "单选等值 status=固定项（T1，valueText 物理 EXISTS）",
      config: { filters: cond(id("status"), "is", "stat_opt_2") },
    });
  }

  // ---- T1：物理数值范围 AND ----
  if (has("money")) {
    scenes.push({
      name: "filter_range_num", kind: "view",
      desc: "金额范围 1000..8000 AND（T1，valueNum 双边界物理）",
      config: { filters: and([cond(id("money"), "gte", "1000"), cond(id("money"), "lte", "8000")]) },
    });
  }

  // ---- T1：物理 isAnyOf（单选 IN）----
  if (has("status")) {
    scenes.push({
      name: "filter_isanyof", kind: "view",
      desc: "单选 isAnyOf 三项（T1，valueText IN 物理）",
      config: { filters: cond(id("status"), "isAnyOf", "stat_opt_0,stat_opt_3,stat_opt_6") },
    });
  }

  // ---- T1：全物理 OR（同字段数值）----
  if (has("money")) {
    scenes.push({
      name: "filter_or_physical", kind: "view",
      desc: "金额 OR（>9000 或 <500，全数值可下推，T1 物理 OR）",
      config: { filters: or([cond(id("money"), "gt", "9000"), cond(id("money"), "lt", "500")]) },
    });
  }

  // ---- T2：valueNum 物理排序（数值/日期）----
  if (has("money")) {
    scenes.push({
      name: "sort_number_desc", kind: "view",
      desc: "金额降序（T2 keyset-sorted，valueNum 物理排序 + 物化序列续点）",
      config: { sorts: sort(id("money"), "desc") },
    });
  }
  if (has("date")) {
    scenes.push({
      name: "sort_date_asc", kind: "view",
      desc: "日期升序（T2，日期 valueNum 毫秒物理排序）",
      config: { sorts: sort(id("date"), "asc") },
    });
  }

  // ---- T3：单选 valueText 排序（M1 保守不下推 → 内存排序）----
  if (has("status")) {
    scenes.push({
      name: "sort_select_text", kind: "view",
      desc: "单选排序（T3，valueText 因 BINARY/zh-CN 差异保守内存排序）",
      config: { sorts: sort(id("status"), "asc") },
    });
  }

  // ---- T3：混合 AND-OR（OR 内含不可下推叶 → 整 OR 回退内存）----
  if (has("money") && has("enabled") && has("note")) {
    scenes.push({
      name: "filter_and_or_residual", kind: "view",
      desc: "启用 checked AND (金额>5000 OR 备注包含) ；OR 含 longText 残余（T3 宽口径）",
      config: {
        filters: and([
          cond(id("enabled"), "checked"),
          or([cond(id("money"), "gt", "5000"), cond(id("note"), "contains", "备注")]),
        ]),
      },
    });
  }

  // ---- 聚合：数值 sum/avg + 计数（全物理聚合）----
  if (has("money") && has("num") && has("score")) {
    scenes.push({
      name: "aggregations", kind: "view",
      desc: "金额求和/均值 + 评分非空计数（物理聚合，分页前全量）",
      config: {
        aggregations: { [id("money")]: "sum", [id("num")]: "avg", [id("score")]: "countFilled" } as Record<string, "sum" | "avg" | "countFilled">,
      },
    });
  }

  // ---- T3：分组（单选 groupBy，分页前全量分桶）----
  if (has("status")) {
    scenes.push({
      name: "group_by_select", kind: "view",
      desc: "按状态分组（T3，groups 分页前全量分桶 + 桶聚合）",
      config: { groupByFieldId: id("status") },
    });
  }

  // ---- T3：列表搜索（短词宽命中 / ≥3字窄命中）----
  scenes.push({ name: "search_short", kind: "search", search: "项", desc: "搜索单字“项”（T3，宽命中，几乎全表）" });
  scenes.push({ name: "search_word3", kind: "search", search: "确定性", desc: "搜索三字“确定性”（T3，命中 longText 备注，窄结果）" });

  // ---- 写：每请求建一条（经写队列 + sidecar 同事务维护）----
  scenes.push({
    name: "write_create", kind: "write", writeTitlePrefix: "bench-write",
    desc: "创建记录（POST，经串行写队列 + sidecar 同事务写维护）",
  });

  // ---- 混合读写：写并发下读首页（压 BUSY/锁竞争与读稳定性；写后 drift 由 run-gate 对拍）----
  scenes.push({
    name: "mixed_home_write", kind: "mixed", writeTitlePrefix: "bench-mix",
    desc: "读首页与创建写 1:1 交替并发（写队列串行化 + 读已提交，检验锁竞争不产生失败）",
  });

  return scenes;
}
