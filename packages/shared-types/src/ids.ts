// packages/shared-types/src/ids.ts
// 跨端 ID 类型（前后端共用，避免字符串裸用）

export type ID<T extends string> = string & { readonly __brand: T };

export const BaseId = "base" as const;
export const TableId = "table" as const;
export const FieldId = "field" as const;
export const RecordId = "record" as const;
export const ViewId = "view" as const;
export const MemberId = "member" as const;

export type BaseIdT = ID<typeof BaseId>;
export type TableIdT = ID<typeof TableId>;
export type FieldIdT = ID<typeof FieldId>;
export type RecordIdT = ID<typeof RecordId>;
export type ViewIdT = ID<typeof ViewId>;
export type MemberIdT = ID<typeof MemberId>;

export const asBaseId = (s: string): BaseIdT => s as BaseIdT;
export const asTableId = (s: string): TableIdT => s as TableIdT;
export const asFieldId = (s: string): FieldIdT => s as FieldIdT;
export const asRecordId = (s: string): RecordIdT => s as RecordIdT;
export const asViewId = (s: string): ViewIdT => s as ViewIdT;
export const asMemberId = (s: string): MemberIdT => s as MemberIdT;