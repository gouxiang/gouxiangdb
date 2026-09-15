// M4/S4 visible-scope 的 SQL 物化契约（纯函数，供 M5 召回/派生库消费，M4 不建 search.db）。
//
// 见 M4 计划 §4.7：召回前把 scope 物化为 search.db ATTACH 临时表或分批 IN（≤499 个/批，
// SQLite 变量上限 999 留余量）；超预算时 M5 必须物化临时表，禁止把超长 IN 直接拼进 SQL。
// 本模块只产出"可拼进 WHERE node_id IN (...) 的占位符片段 + 有序参数"或"必须临时表"信号，
// 不含 IO、不碰 Prisma，便于表驱动单测与 M5 直接消费。

/** 单批 IN 列表上限（SQLite 默认 999 变量留余量；§4.7 行368 取 499）。 */
export const SCOPE_IN_BATCH = 499;

/** 默认可见节点预算（§4.7：默认 5000）。 */
export const DEFAULT_SCOPE_BUDGET = 5000;
/** 预算硬上限（§4.7：硬上限 20000）。调用方传更大值也被收敛到此。 */
export const MAX_SCOPE_BUDGET = 20000;

/** 归一 budget：非法/缺省回落默认，超过硬上限截断到硬上限。 */
export function clampBudget(raw: number | undefined): number {
  if (raw === undefined || !Number.isInteger(raw) || raw <= 0) return DEFAULT_SCOPE_BUDGET;
  return Math.min(raw, MAX_SCOPE_BUDGET);
}

export interface VisibleScopeSql {
  /**
   * 可直接拼进 `WHERE x IN (<sql>)` 的占位符片段（如 "?,?,?"）；expectsTempTable=true 时为空串。
   * 占位符与 params 严格按序对应，不内插任何字面量，杜绝注入（值全部走绑定参数）。
   */
  sql: string;
  /** 与 sql 占位符一一对应的有序节点 id。 */
  params: string[];
  /**
   * true = 结果超单批 IN 上限或被截断，M5 必须把 nodeIds 物化为临时表后 JOIN 收敛，
   * 禁止把超长 IN 直拼进召回 SQL（AC-M5-2 零泄漏的工程约束）。
   */
  expectsTempTable: boolean;
  /** 分批切好的 IN 批次（每批 ≤499）；expectsTempTable=true 时为空，改由临时表承载。 */
  batches: string[][];
}

/**
 * 由有序可见节点 id 构建参数化 IN 片段/临时表信号。
 * 截断由调用方在预算阶段完成并通过 truncated 告知；本函数据节点数决定形态：
 *   - 0 个      -> sql=""（永假片段由消费方按空集处理），batches=[]，expectsTempTable=false；
 *   - 1..499 个 -> 单批 "?,?.."，params=ids，expectsTempTable=false；
 *   - >499 个或 truncated=true -> expectsTempTable=true（M5 物化临时表），sql=""。
 */
export function buildVisibleScopeSql(nodeIds: readonly string[], truncated: boolean): VisibleScopeSql {
  if (nodeIds.length === 0) {
    return { sql: "", params: [], expectsTempTable: false, batches: [] };
  }
  if (truncated || nodeIds.length > SCOPE_IN_BATCH) {
    return { sql: "", params: [], expectsTempTable: true, batches: [] };
  }
  return {
    sql: nodeIds.map(() => "?").join(","),
    params: [...nodeIds],
    expectsTempTable: false,
    batches: [[...nodeIds]],
  };
}

/** 空可见集的永假条件（M5 拼 WHERE 时用，避免空 IN 语法错误）。 */
export const EMPTY_SCOPE_PREDICATE = "1=0";
