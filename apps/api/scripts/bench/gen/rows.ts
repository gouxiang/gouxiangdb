// apps/api/scripts/bench/gen/rows.ts
// M1/S9：按字段类型确定性生成一条记录的 fields JSON（同 seed 逐次复现）。
// 存储格式严格对齐生产 coerce/hydrate：number 族存 number、checkbox 存 boolean、
// 日期存字符串、单选取 optionId、多选取 optionId[]、附件为 1KB 占位对象数组。
// 计算字段（lookup/rollup/count/formula/links/autoNumber）不落 fields（hydrate 现算）。
//
// 刻意掺【脏值/边界值】（真实数据会有，压测要覆盖回退路径）：
//   - number 列约 0.5% 写非数字串 "N/A"（S6 sortNumericClean/脏值排序探针场景）；
//   - rating 小概率 0 星（边界，区别于空值）；
//   - multiSelect 一部分为空数组 []（区别于缺键/null）；
//   - 各物理字段按比例掺空值（null/缺键）。
// 同毫秒 createdAt 由 insert.ts 按时间桶生成（压 keyset id tie-break）。

import type { Rng } from "./prng.js";
import type { Shape } from "./schema.js";

const PAD = (n: number, w = 2) => String(n).padStart(w, "0");

/** 确定性日期：2026 年内由序号推导出某天，形态 yyyy-MM-dd。 */
function dateFor(i: number): string {
  const month = (i % 12) + 1;
  const day = (i % 27) + 1;
  return `2026-${PAD(month)}-${PAD(day)}`;
}

function datetimeFor(i: number, hour: number): string {
  return `${dateFor(i)}T${PAD(hour)}:${PAD((i * 7) % 60)}`;
}

function wordFor(i: number): string {
  const words = ["项目", "任务", "合同", "工单", "客户", "订单", "缺陷", "需求", "报表", "对账"];
  return words[i % words.length]!;
}

export interface GenOptions {
  /** 软删比例（0..1），默认 0.05。 */
  softDeleteRate: number;
  /** longText 有值比例（plan：小比例），默认 0.1。 */
  longTextRate: number;
  /** 脏值比例：number 列写非数字串的概率，默认 0.005。 */
  dirtyRate: number;
}

export interface RowSpec {
  fields: Record<string, unknown>;
  softDelete: boolean;
}

/** main 宽表一条记录。i 为 0..rows-1 稳定序号。 */
export function genMainRow(s: Shape, rng: Rng, i: number, opts: GenOptions): RowSpec {
  const F = s.main;
  const o: Record<string, unknown> = {};
  const f = (key: string) => F[key]!.id;
  // 数值列：正常 number，少量写非数字串（脏值）。
  const numCell = (): unknown => (rng.bool(opts.dirtyRate) ? "N/A" : rng.int(0, 100000));

  o[f("title")] = `${wordFor(i)}-${PAD(i % 1000, 4)}-${i}`;
  if (rng.bool(opts.longTextRate)) {
    o[f("note")] = `备注 ${i}：这是一段用于测量 longText hydration 的确定性文本。`;
  }
  if (rng.bool(0.92)) o[f("num")] = numCell();
  if (rng.bool(0.9)) o[f("money")] = rng.bool(opts.dirtyRate) ? "待定" : Math.round(rng.float() * 1_000_000) / 100;
  if (rng.bool(0.9)) o[f("rate")] = Math.round(rng.float() * 1000) / 10; // 0..100.0
  if (rng.bool(0.85)) o[f("dur")] = rng.int(0, 10000); // 分钟
  // rating：90% 有值，其中约 8% 为 0 星边界；其余缺键（空）。
  if (rng.bool(0.9)) o[f("score")] = rng.bool(0.08) ? 0 : rng.int(1, 5);
  if (rng.bool(0.93)) o[f("date")] = dateFor(i);
  if (rng.bool(0.9)) o[f("datetime")] = datetimeFor(i, rng.int(0, 23));
  if (rng.bool(0.85)) o[f("enabled")] = rng.bool(0.4);

  // 单选：80% 有值（固定 optionId stat_opt_k）。
  if (rng.bool(0.8)) o[f("status")] = `stat_opt_${rng.int(0, 7)}`;
  // 多选：55% 选 1..5 项（去重），10% 显式空数组 []，35% 缺键（空）。
  const tagR = rng.float();
  if (tagR < 0.55) {
    const k = rng.int(1, 5);
    o[f("tags")] = Array.from(new Set(Array.from({ length: k }, (_, t) => `tag_opt_${(i + t) % 8}`)));
  } else if (tagR < 0.65) {
    o[f("tags")] = [];
  }
  if (rng.bool(0.85)) o[f("email")] = `user${i}@example.com`;
  if (rng.bool(0.7)) o[f("url")] = `https://example.com/items/${i}`;
  if (rng.bool(0.6)) o[f("phone")] = `1${PAD(rng.int(30, 39))}${PAD(rng.int(0, 99999999), 8)}`;
  if (rng.bool(0.9)) o[f("city")] = ["深圳", "广州", "北京", "上海", "杭州", "成都"][rng.int(0, 5)];

  if (rng.bool(0.85)) o[f("heat")] = numCell();
  if (rng.bool(0.8)) o[f("progress")] = Math.round(rng.float() * 1000) / 10;
  if (rng.bool(0.85)) o[f("priority")] = `prio_opt_${rng.int(0, 3)}`;
  if (rng.bool(0.8)) o[f("updatedOn")] = datetimeFor(i, rng.int(0, 23));

  // 附件：15% 记录挂 1 个 1KB 小占位（不灌 2MB dataURL，附件外置属 M2）。
  if (rng.bool(0.15)) {
    o[f("attach")] = [{
      id: `att_${PAD(i, 8)}`,
      name: `file-${i}.txt`,
      size: 1024,
      mime: "text/plain",
      url: `/uploads/bench/att_${PAD(i, 8)}.txt`,
    }];
  }

  return { fields: o, softDelete: rng.bool(opts.softDeleteRate) };
}

/** peer 窄表一条记录（关联对端，4 字段）。 */
export function genPeerRow(s: Shape, rng: Rng, i: number, _opts: GenOptions): RowSpec {
  const F = s.peer;
  const f = (key: string) => F[key]!.id;
  const o: Record<string, unknown> = {
    [f("title")]: `子项-${PAD(i % 1000, 4)}-${i}`,
    [f("num")]: rng.int(0, 50000),
    [f("cat")]: `pcat_opt_${rng.int(0, 3)}`,
    [f("date")]: dateFor(i),
  };
  return { fields: o, softDelete: rng.bool(_opts.softDeleteRate) };
}

/** 窄表（--shape narrow）一条记录：标题/备注/数量/状态。 */
export function genNarrowRow(s: Shape, rng: Rng, i: number, opts: GenOptions): RowSpec {
  const F = s.main;
  const f = (key: string) => F[key]!.id;
  const o: Record<string, unknown> = {
    [f("title")]: `${wordFor(i)}-${i}`,
    [f("num")]: rng.bool(opts.dirtyRate) ? "N/A" : rng.int(0, 100000),
    [f("status")]: `stn_opt_${rng.int(0, 3)}`,
  };
  if (rng.bool(opts.longTextRate)) o[f("note")] = `备注 ${i}`;
  return { fields: o, softDelete: rng.bool(opts.softDeleteRate) };
}
