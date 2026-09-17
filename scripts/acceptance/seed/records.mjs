// scripts/acceptance/seed/records.mjs
// 经 v0.1.0 真服务 HTTP 播种结构化数据：3 base x 3 表 = 9 表，每表 50 行。
//   - 每 base 一张普通表 t_plain（含草稿/空值/多字节）
//   - base#1 一张宽表 t_wide：>=20 字段，覆盖全部可落地标量 FieldType + attachment
//   - base#1 一张关联表 t_rel + 被关联表 t_target：双向 links(mm) + bt + formula + lookup + rollup + count
// 其余 base 用普通表补齐 3 表。确定性（LCG seed42），id 用固定前缀（HTTP 返回里取真实 id）。
//
// 本文件只编排：规格与灌行在 tableRows.mjs，HTTP 原语在 tableApi.mjs；
// 所有写都经旧服务 HTTP（满足"用 v0.1.0 代码建真库"），不直接写库。

import { makeRng } from "../lib/lcg.mjs";
import { createBase, listTables, createTable } from "./tableApi.mjs";
import {
  addPlainFields, insertPlainRows,
  addWideFields, insertWideRows,
  addTargetFields, insertTargetRows,
  addRelationFields, insertRelRows,
} from "./tableRows.mjs";

/**
 * @param {import("../lib/http.mjs").ApiClient} api  owner 客户端
 * @param {object} opts
 * @param {(label:string)=>void} [opts.log]
 * @param {Array<{id:string,name:string,size:number,mime:string,url:string}>} [opts.attachmentValues] 附件单元格值
 * @returns {Promise<{bases:Array, manifest:object}>}
 */
export async function seedRecords(api, { log, attachmentValues = [] } = {}) {
  const rng = makeRng(42);
  const attValues = attachmentValues;
  const bases = [];
  const tableManifest = [];

  for (let b = 0; b < 3; b++) {
    const baseName = `演练Base${b + 1}`;
    const baseId = await createBase(api, baseName);
    // 建库自带 starter table，删不掉也要保证我们自管 3 张表；先记录它（计入表数/行数快照即可）。
    const starter = await listTables(api, baseId);

    // 每个 base 的三张表
    const plain = await createTable(api, baseId, `t_plain_b${b + 1}`);
    await addPlainFields(api, plain.id);

    let wide = null;
    let rel = null;
    let target = null;
    if (b === 0) {
      wide = await createTable(api, baseId, "t_wide");
      const wideSpec = await addWideFields(api, wide.id);
      await insertWideRows(api, wide, wideSpec, rng, attValues);

      target = await createTable(api, baseId, "t_target");
      await addTargetFields(api, target.id);
      await insertTargetRows(api, target, rng);

      rel = await createTable(api, baseId, "t_rel");
      const relSpec = await addRelationFields(api, rel.id, target.id, target);
      await insertRelRows(api, rel, target, relSpec, rng);

      tableManifest.push({ base: baseId, table: wide.id, kind: "wide", fieldCount: wideSpec.all.length });
      tableManifest.push({ base: baseId, table: target.id, kind: "target" });
      tableManifest.push({ base: baseId, table: rel.id, kind: "relation" });
    }

    await insertPlainRows(api, plain, b, rng);
    tableManifest.push({ base: baseId, table: plain.id, kind: "plain" });

    // 其余两个 base 再补两张普通表，保证 3 base x 3 自管表
    if (b !== 0) {
      for (let t = 1; t <= 2; t++) {
        const extra = await createTable(api, baseId, `t_extra_b${b + 1}_${t}`);
        await addPlainFields(api, extra.id);
        await insertPlainRows(api, extra, b * 10 + t, rng);
        tableManifest.push({ base: baseId, table: extra.id, kind: "plain" });
      }
    }

    bases.push({ id: baseId, name: baseName, starterTable: starter[0]?.id ?? null, plain: plain.id, wide: wide?.id, rel: rel?.id, target: target?.id });
    log?.(`  base ${b + 1} 完成：${baseId}`);
  }

  // 汇总实际表数/行数（以服务端返回为准）
  const counts = { bases: bases.length, tables: tableManifest.length + 3, rows: 0 };
  for (const tm of tableManifest) {
    const res = await api.raw("GET", `/records?tableId=${tm.table}&limit=1000`).then((r) => r.json);
    counts.rows += res.total ?? (res.records?.length ?? 0);
  }

  return { bases, tableManifest, counts };
}
