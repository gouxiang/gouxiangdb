// apps/api/src/domain/recordChanges/types.ts
// 记录变更历史（数据日志）的共享类型。单列一个文件：diff（纯）/store（写）/query（读）
// 三处共用同一份字面量，避免 DTO 形状在三处各写一遍后漂移。

/** 一次操作的类型。delete=进回收站，restore=从回收站捞回，两者不可合并。 */
export type RecordChangeOp = "create" | "update" | "delete" | "restore";

export const RECORD_CHANGE_OPS: readonly RecordChangeOp[] = ["create", "update", "delete", "restore"];

/** 落库/出参的字段级前后值。fieldName 是**快照**（字段被删后前端无法映射 id）。 */
export interface FieldChange {
  fieldId: string;
  fieldName: string;
  before: unknown;
  after: unknown;
}

/** 读端点出参的单条日志。actorId/actorName 为 null 表示系统写（读侧不回填空串）。 */
export interface RecordChangeDTO {
  id: string;
  op: RecordChangeOp;
  actorId: string | null;
  actorName: string | null;
  /** ISO-8601 串。 */
  changedAt: string;
  changes: FieldChange[];
}

/** 读端点出参（分页形态，与前端 client.ts 的 RecordChangesResponse 对齐）。 */
export interface RecordChangesPage {
  items: RecordChangeDTO[];
  nextCursor: string | null;
  hasMore: boolean;
}
