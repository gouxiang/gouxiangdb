// apps/web/src/features/sync/fieldCompare.ts
// 双栏冲突弹窗把「我的值 / 服务器值」两个 payload 对象拍平为可并排渲染的字段行（纯函数）。
// 不引入新依赖：值统一 JSON 串化展示（标量原样，对象/数组缩进），未知形状也不崩。

export interface FieldRow {
  key: string;
  mine: string;
  theirs: string;
  /** 两侧是否不同（用于行高亮）。 */
  changed: boolean;
  /** 该键是否仅一侧存在。 */
  onlyIn: "mine" | "theirs" | null;
}

/** 把任意值转为可展示字符串：null/undefined → 占位；对象/数组 → 紧凑 JSON；其余去空白字符串。 */
export function displayValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v.length > 0 ? v : "—";
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  try {
    return JSON.stringify(v, null, 0);
  } catch {
    return String(v);
  }
}

/**
 * 纯函数：合并 mine/theirs 的键并集，逐键产出字段行。
 * 键顺序：先 mine 的键（按出现序），再 theirs 独有键，稳定可测。
 * 入参为 null（缺快照）时，theirs 全部以「—」呈现（弹窗据此降级、禁用 custom）。
 */
export function buildFieldRows(
  mine: Record<string, unknown> | null,
  theirs: Record<string, unknown> | null,
): FieldRow[] {
  const a = mine ?? {};
  const b = theirs ?? {};
  const rows: FieldRow[] = [];
  const seen = new Set<string>();

  for (const key of Object.keys(a)) {
    if (seen.has(key)) continue;
    seen.add(key);
    const inB = Object.prototype.hasOwnProperty.call(b, key);
    const mv = displayValue(a[key]);
    const tv = inB ? displayValue(b[key]) : "—";
    rows.push({
      key,
      mine: mv,
      theirs: tv,
      changed: mv !== tv,
      onlyIn: !inB ? "mine" : null,
    });
  }
  for (const key of Object.keys(b)) {
    if (seen.has(key)) continue;
    seen.add(key);
    const mv = "—";
    const tv = displayValue(b[key]);
    rows.push({ key, mine: mv, theirs: tv, changed: mv !== tv, onlyIn: "theirs" });
  }
  return rows;
}

/** 是否存在任意差异（无差异时提示「内容相同，可能只是版本/结构冲突」）。 */
export function hasAnyDifference(rows: FieldRow[]): boolean {
  return rows.some((r) => r.changed);
}
