// scripts/acceptance/seed/tableApi.mjs
// v0.1.0 HTTP 表/字段/记录低层原语（供 records 编排与各类灌行器复用）。
// 纯 HTTP：不直连数据库。

export const OPTION_COLORS = ["#D6E4FF", "#D9F7BE", "#FFF1B8", "#FFD8BF", "#E6DBFF", "#C6F6F0"];

export async function createBase(api, name) {
  const r = await api.post("/bases", { name, iconColor: "#378ADD" });
  return r.base.id;
}

export async function listTables(api, baseId) {
  const r = await api.get(`/tables?baseId=${encodeURIComponent(baseId)}`);
  // v010 tables GET 列表形态兼容
  return r.tables ?? r ?? [];
}

export async function createTable(api, baseId, name) {
  const r = await api.post(`/tables?baseId=${encodeURIComponent(baseId)}`, { name, withDefaults: false });
  return { id: r.table.id, primaryFieldId: r.table.primaryFieldId };
}

export async function createField(api, tableId, body) {
  const r = await api.post(`/fields?tableId=${encodeURIComponent(tableId)}`, body);
  return r.field;
}

export function opts(names) {
  return names.map((name, i) => ({ id: `opt_${Buffer.from(name).toString("hex").slice(0, 8)}_${i}`, name, color: OPTION_COLORS[i % OPTION_COLORS.length] }));
}

export async function loadFieldMap(api, tableId) {
  const r = await api.raw("GET", `/fields?tableId=${encodeURIComponent(tableId)}`).then((x) => x.json);
  const list = r.fields ?? [];
  return new Map(list.map((f) => [f.name, f]));
}
