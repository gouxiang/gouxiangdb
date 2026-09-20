// apps/web/src/lib/file-name.ts
// 导出落盘文件名的单一真源：网格视图（GridView）与顶栏（TopBar）的 CSV 导出共用同一套
// 命名与兜底规则，避免同一张表在不同入口导出得到两种文件名。
//
// 规则：
//   1. 用真实业务名（表名/视图名），不把内部 id 抛给用户；
//   2. 业务名缺清洗后为空时，才退回 id 前缀（table-<tableId> / viewId）；
//   3. 清洗掉文件系统不安全字符，避免落盘失败或写进意外路径。

/** 落盘名片段清洗：去掉文件系统不安全字符（/ \ : * ? " < > |），压缩空白并去掉首尾点。 */
export function safeFilePart(raw: string | null | undefined): string {
  return (raw ?? "")
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "");
}

/**
 * 构造 CSV 导出落盘名：`表名.csv`；传了 view 时追加视图名 → `表名-视图名.csv`。
 * 表名/视图名为空时分别退回 `table-<tableId>` / viewId，保证文件名不会退化成 ".csv"。
 */
export function csvFileName(
  tableName: string | null | undefined,
  tableId: string,
  view?: { name?: string | null; id?: string | null } | null,
): string {
  const safeTable = safeFilePart(tableName) || `table-${tableId}`;
  if (!view?.id) return `${safeTable}.csv`;
  const safeView = safeFilePart(view.name) || view.id;
  return `${safeTable}-${safeView}.csv`;
}
