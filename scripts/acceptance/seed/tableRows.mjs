// scripts/acceptance/seed/tableRows.mjs
// 三类自管表（普通/宽表/关联对）的字段规格与确定性灌行。
// 每表 50 行：宽表打满可落地标量类型 + attachment，含草稿/必填空值/多字节/软删边界。
// 纯 HTTP 写（经旧服务），确定性 LCG，无直连库。

import { randInt } from "../lib/lcg.mjs";
import { opts, createField, loadFieldMap } from "./tableApi.mjs";

// ---------- 普通表：主键(单行文本) + 标量字段；50 行（草稿/空值/多字节/末行软删） ----------
export async function addPlainFields(api, tableId) {
  await createField(api, tableId, { name: "数量", type: "number", precision: 0 });
  await createField(api, tableId, { name: "状态", type: "singleSelect", options: opts(["待办", "进行中", "完成"]) });
  await createField(api, tableId, { name: "备注", type: "longText" });
  await createField(api, tableId, { name: "完成", type: "checkbox" });
}

export async function insertPlainRows(api, table, group, rng) {
  const fields = await loadFieldMap(api, table.id);
  const statusOpt = fields.get("状态")?.options ?? [];
  for (let i = 1; i <= 50; i++) {
    const body = { fields: {} };
    // 草稿行：1 条
    if (i === 47) body.draft = true;
    const primary = fields.get("名称");
    if (primary) body.fields[primary.id] = `${group}-${i} 行 多字节测试 🍎${"甲乙丙"[i % 3]}`;
    const num = fields.get("数量");
    if (num) body.fields[num.id] = randInt(rng, 0, 9999);
    const st = fields.get("状态");
    if (st && statusOpt.length) body.fields[st.id] = statusOpt[i % statusOpt.length].id;
    const note = fields.get("备注");
    // 必填空值边界：1 条不给备注（备注非必填）；1 条多字节长文本
    if (note && i !== 48) body.fields[note.id] = i === 49 ? "长备注 ".repeat(40) : `备注 ${i}`;
    const done = fields.get("完成");
    if (done) body.fields[done.id] = i % 2 === 0;
    await api.post(`/records?tableId=${encodeURIComponent(table.id)}`, body);
  }
  // 软删 1 行（第 50 行）
  const list = await api.raw("GET", `/records?tableId=${table.id}&limit=1000`).then((r) => r.json);
  const last = list.records[list.records.length - 1];
  if (last) await api.del(`/records/${last.id}`);
}

// ---------- 宽表：主键 + >=20 字段（打满标量 FieldType + attachment） ----------
const WIDE_SPECS = [
  { name: "长文本", type: "longText" },
  { name: "富文本", type: "richText" },
  { name: "整数", type: "number", precision: 0 },
  { name: "小数", type: "number", precision: 4 },
  { name: "金额", type: "currency", precision: 2, numberRule: { currencyCode: "CNY" } },
  { name: "百分比", type: "percent", precision: 2 },
  { name: "时长", type: "duration", precision: 0 },
  { name: "日期", type: "date" },
  { name: "日期时间", type: "datetime" },
  { name: "勾选", type: "checkbox" },
  { name: "单选", type: "singleSelect", options: opts(["红", "黄", "蓝"]) },
  { name: "多选", type: "multiSelect", options: opts(["标签A", "标签B", "标签C", "标签D"]) },
  { name: "邮箱", type: "email" },
  { name: "网址", type: "url" },
  { name: "电话", type: "phone" },
  { name: "评分", type: "rating", numberRule: { max: 5 } },
  { name: "自动编号", type: "autoNumber" },
  { name: "JSON", type: "json" },
  { name: "附件", type: "attachment" },
  { name: "创建时间", type: "createdTime" },
  { name: "修改时间", type: "lastModifiedTime" },
  { name: "创建人", type: "createdBy" },
  { name: "修改人", type: "lastModifiedBy" },
];

export async function addWideFields(api, tableId) {
  const all = [];
  for (const s of WIDE_SPECS) {
    try {
      const f = await createField(api, tableId, s);
      all.push({ ...s, id: f.id, options: f.options ?? s.options ?? null });
    } catch (e) {
      // 某些类型若旧版拒收，记录但不致命（宽表目标是 >=20 字段，多数标量必过）
      all.push({ ...s, id: null, failed: String(e.message ?? e).slice(0, 160) });
    }
  }
  return { all };
}

export async function insertWideRows(api, table, spec, rng, attValues) {
  const fields = await loadFieldMap(api, table.id);
  const singleOpt = spec.all.find((s) => s.name === "单选")?.options ?? [];
  const multiOpt = spec.all.find((s) => s.name === "多选")?.options ?? [];
  for (let i = 1; i <= 50; i++) {
    const v = {};
    const put = (name, val) => {
      const f = fields.get(name);
      if (f && val !== undefined) v[f.id] = val;
    };
    put("名称", `宽表行 ${i} 数据 数据`);
    put("长文本", i === 3 ? null : `长文本内容 第${i}行 🍜`);
    put("富文本", `**粗体** 第${i}行 与 [链接](https://x.com/${i})`);
    put("整数", randInt(rng, -1000, 1000));
    put("小数", Math.round(rng() * 100000) / 10000);
    put("金额", Math.round(rng() * 1000000) / 100);
    put("百分比", Math.round(rng() * 10000) / 10000);
    put("时长", randInt(rng, 0, 86400));
    put("日期", "2026-09-01");
    put("日期时间", `2026-09-${String((i % 28) + 1).padStart(2, "0")}T10:30`);
    put("勾选", i % 3 === 0);
    if (singleOpt.length) put("单选", singleOpt[i % singleOpt.length].id);
    if (multiOpt.length) put("多选", [multiOpt[i % multiOpt.length].id, multiOpt[(i + 1) % multiOpt.length].id]);
    put("邮箱", `row${i}@example.com`);
    put("网址", `https://example.com/items/${i}`);
    put("电话", `139${String(10000000 + i).padStart(8, "0")}`);
    put("评分", (i % 5) + 1);
    put("JSON", JSON.stringify({ idx: i, nested: { a: i * 2, tags: ["x", "y"] } }));
    // 附件引用：前 10 行各挂 1~2 个，覆盖全部 10 个被引用附件（attValues 已按真实 {id,name,...} 给）
    if (i <= 10 && attValues.length) {
      const a = attValues[(i - 1) % attValues.length];
      const b2 = attValues[(i + 2) % attValues.length];
      put("附件", i % 4 === 0 ? [a, b2] : [a]);
    }
    const body = { fields: v };
    if (i === 47) body.draft = true;
    await api.post(`/records?tableId=${encodeURIComponent(table.id)}`, body);
  }
}

// ---------- 被关联表：主键 + 数值 + 文本（供 rollup/lookup/display） ----------
export async function addTargetFields(api, tableId) {
  await createField(api, tableId, { name: "目标数值", type: "number", precision: 2 });
  await createField(api, tableId, { name: "目标名称", type: "singleLineText" });
}

export async function insertTargetRows(api, table, rng) {
  const fields = await loadFieldMap(api, table.id);
  for (let i = 1; i <= 50; i++) {
    const v = {};
    if (fields.get("名称")) v[fields.get("名称").id] = `目标 ${i}`;
    if (fields.get("目标数值")) v[fields.get("目标数值").id] = Math.round(rng() * 10000) / 10;
    if (fields.get("目标名称")) v[fields.get("目标名称").id] = `名-${i}-甲乙`;
    await api.post(`/records?tableId=${encodeURIComponent(table.id)}`, { fields: v });
  }
}

// ---------- 关联表：双向 mm + bt，formula/lookup/rollup/count ----------
export async function addRelationFields(api, tableId, targetTableId, targetTable) {
  // 多对多（双向自动）
  const mm = await createField(api, tableId, {
    name: "多目标", type: "links", relatedTableId: targetTableId, relationKind: "mm",
    linkDisplayFieldId: targetTable.primaryFieldId,
  });
  // 多对一 bt（双向自动）
  const bt = await createField(api, tableId, {
    name: "单目标", type: "links", relatedTableId: targetTableId, relationKind: "bt",
    linkDisplayFieldId: targetTable.primaryFieldId,
  });
  const targetFields = await loadFieldMap(api, targetTableId);
  const tNum = targetFields.get("目标数值");
  const tName = targetFields.get("目标名称");

  // lookup：经 mm 关联取目标名称
  let lookup = null;
  try {
    lookup = await createField(api, tableId, {
      name: "查阅目标名", type: "lookup", linkFieldId: mm.id, lookupFieldId: tName?.id,
    });
  } catch { lookup = { id: null }; }

  // rollup sum：经 mm 聚合目标数值
  let rollup = null;
  try {
    rollup = await createField(api, tableId, {
      name: "聚合目标和", type: "rollup", linkFieldId: mm.id,
      lookupFieldId: tNum?.id, rollupFunction: "sum",
    });
  } catch { rollup = { id: null }; }

  // count：经 mm 计数（count 类型只需关联字段）
  let count = null;
  try {
    count = await createField(api, tableId, { name: "目标计数", type: "count", linkFieldId: mm.id });
  } catch { count = { id: null }; }

  // formula：引用本表数值字段做计算
  await createField(api, tableId, { name: "公式倍乘", type: "formula", formula: "{名称} & \"-F\"" });

  return { mm, bt, lookup, rollup, count };
}

export async function insertRelRows(api, table, targetTable, spec, rng) {
  const targetList = await api.raw("GET", `/records?tableId=${targetTable.id}&limit=1000`).then((r) => r.json);
  const tIds = targetList.records.map((r) => r.id);
  for (let i = 1; i <= 50; i++) {
    const body = { fields: {} };
    // mm：挂 1~3 个目标；bt：挂 1 个
    const mmCount = (i % 3) + 1;
    const mmIds = [];
    for (let k = 0; k < mmCount; k++) mmIds.push(tIds[(i + k) % tIds.length]);
    body.fields[spec.mm.id] = mmIds.map((id) => ({ recordId: id }));
    body.fields[spec.bt.id] = [{ recordId: tIds[(i * 2) % tIds.length] }];
    await api.post(`/records?tableId=${encodeURIComponent(table.id)}`, body);
  }
}
