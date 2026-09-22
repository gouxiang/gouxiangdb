// apps/web/src/features/settings/role-permission/library-scope-draft.ts
// 库权限草稿的纯函数层（不碰 React）：DTO ↔ 草稿 ↔ PUT 入参。
//
// 抽出来的原因：这份数据的形状转换是「整体替换」语义的落点，最容易出错的地方
// （漏一条库 = 撤销一次授权），单独放可以直接断言，不必挂组件跑。
//
// 默认档纪律：勾了库但不做逐表设置 = 该库全部表只读可见。
// 落库时不写逐表条目即可——后端 tableAccessOf 对「可见但没配」就是回退只读，
// 前端不要替后端补一份全量只读条目，补了反而让「后来新建的表」失去默认只读。

import type {
  FieldAccess,
  LibraryKind,
  PutLibraryScopeInput,
  RoleLibraryScopeDTO,
  TableAccess,
} from "@gx/shared-types";
import { READONLY_TABLE_ACCESS } from "@gx/shared-types";
import { parseScopeKey } from "./role-permission-hooks";

export interface ScopeConfigDraft {
  /** tableId -> 四枚数据动作；**没有条目 = 这张表没勾**（走库级默认：可见即只读）。 */
  tables: Record<string, TableAccess>;
  /** tableId -> fieldId -> 三档；没有条目 = 该字段可编辑（后端同口径）。 */
  fields: Record<string, Record<string, FieldAccess>>;
}

export interface LibraryScopeDraft {
  /** 可管理库的 key（可管理隐含可见，界面上不允许单独取消可见）。 */
  manage: Set<string>;
  /** 可见库的 key。 */
  visible: Set<string>;
  /**
   * 单独授予「可分享」的库 key。
   * 后端裁决是 canToggleShare = canManage || canShare：可管理为真时已隐式带分享权，
   * 这份集合只记「显式授予」的那条独立路径——两者别混成一件事，落库时各自原样回写。
   */
  share: Set<string>;
  config: Map<string, ScopeConfigDraft>;
}

export const EMPTY_CONFIG: ScopeConfigDraft = { tables: {}, fields: {} };

export const EMPTY_DRAFT: LibraryScopeDraft = {
  manage: new Set(),
  visible: new Set(),
  share: new Set(),
  config: new Map(),
};

export function draftFromScopes(scopes: RoleLibraryScopeDTO[]): LibraryScopeDraft {
  const draft: LibraryScopeDraft = {
    manage: new Set(),
    visible: new Set(),
    share: new Set(),
    config: new Map(),
  };
  for (const s of scopes) {
    const key = `${s.libraryKind}:${s.libraryId}`;
    if (s.canManage) draft.manage.add(key);
    if (s.visible) draft.visible.add(key);
    if (s.canShare) draft.share.add(key);
    draft.config.set(key, { tables: s.tables, fields: s.fields });
  }
  return draft;
}

/** 草稿 → PUT 入参。未出现在草稿里的库不出现，后端按「整份替换」把它删掉。 */
export function draftToItems(draft: LibraryScopeDraft): PutLibraryScopeInput[] {
  // 三份集合的并集。只取 manage ∪ visible 会让「只显式勾了可分享」的库在保存时被静默丢掉
  // （整份替换 = 撤销一次授权），所以 share 也必须参与枚举；谁都没提过的库才不输出。
  const keys = new Set<string>([...draft.manage, ...draft.visible, ...draft.share]);
  const items: PutLibraryScopeInput[] = [];
  for (const key of keys) {
    const parsed = parseScopeKey(key);
    if (!parsed) continue;
    items.push({
      libraryKind: parsed.kind,
      libraryId: parsed.libraryId,
      canManage: draft.manage.has(key),
      // 可管理隐含可见：后端 visible=false 且 canManage=true 时人进不去，
      // 只会出现「管得了但看不见」这种无法解释的状态。
      visible: draft.visible.has(key) || draft.manage.has(key),
      // 只回写显式授予的分享位；可管理带来的分享权由后端 canManage||canShare 现算，不在这里重复。
      canShare: draft.share.has(key),
      config: draft.config.get(key) ?? EMPTY_CONFIG,
    });
  }
  return items;
}

/** 勾/取消一张表。勾上时默认给「只读可见」——放权必须显式再往上加。 */
export function toggleTable(cfg: ScopeConfigDraft, tableId: string, on: boolean): ScopeConfigDraft {
  const tables = { ...cfg.tables };
  const fields = { ...cfg.fields };
  if (on) {
    tables[tableId] = { ...READONLY_TABLE_ACCESS };
  } else {
    delete tables[tableId];
    // 表都不勾了，它的字段权限一并清掉，避免留一份永远读不到的配置
    delete fields[tableId];
  }
  return { tables, fields };
}

export function setTableAction(
  cfg: ScopeConfigDraft,
  tableId: string,
  action: keyof TableAccess,
  on: boolean,
): ScopeConfigDraft {
  const current = cfg.tables[tableId] ?? { ...READONLY_TABLE_ACCESS };
  return { ...cfg, tables: { ...cfg.tables, [tableId]: { ...current, [action]: on } } };
}

export function setFieldAccess(
  cfg: ScopeConfigDraft,
  tableId: string,
  fieldId: string,
  mode: FieldAccess,
): ScopeConfigDraft {
  const perTable = { ...(cfg.fields[tableId] ?? {}) };
  perTable[fieldId] = mode;
  return { ...cfg, fields: { ...cfg.fields, [tableId]: perTable } };
}

/** 库在界面上的一行：key 用于草稿寻址，kind/id 用于发请求，name 用于显示。 */
export interface LibraryRow {
  key: string;
  kind: LibraryKind;
  id: string;
  name: string;
}
