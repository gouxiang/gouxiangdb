// apps/web/src/features/kb/public-share-model.ts
// 公开分享（doc / table / base 三类）的纯函数视图模型与类型守卫。
// 不碰 React / DOM，便于 node 单测直接锁定分发与分页口径。

import type {
  FieldDTO,
  PublicShareAnyDTO,
  PublicDocShareDTO,
  PublicTableShareDTO,
  PublicBaseShareDTO,
  PublicShareTableItem,
} from "../../api/client";

/**
 * 文档族（历史 kb_doc）分享。
 * 后端 docShareResponse 实际回 `kind: "doc"`；更老的链路可能缺省该字段，
 * 故「kind 为 "doc" 或缺省且带 doc 体」即判为文档族（table/base 都是确定字面量）。
 */
export function isDocShare(d: PublicShareAnyDTO | undefined): d is PublicDocShareDTO {
  if (!d) return false;
  if (d.kind === "table" || d.kind === "base") return false;
  return (d as PublicDocShareDTO).doc != null;
}

export function isTableShare(d: PublicShareAnyDTO | undefined): d is PublicTableShareDTO {
  return !!d && d.kind === "table";
}

export function isBaseShare(d: PublicShareAnyDTO | undefined): d is PublicBaseShareDTO {
  return !!d && d.kind === "base";
}

/**
 * 渲染列：优先视图可见字段子集；后端缺省 / 空数组时回落到全量字段（与嵌入表预览同口径）。
 * 已按分享人字段权限裁剪，这里不再做二次过滤。
 */
export function shareTableColumns(payload: Pick<PublicTableShareDTO, "fields" | "visibleFields">): FieldDTO[] {
  const visible = payload.visibleFields ?? [];
  return visible.length > 0 ? visible : (payload.fields ?? []);
}

export interface SharePagerModel {
  /** 当前页首条序号（1 基；总数为 0 时为 0） */
  from: number;
  /** 当前页末条序号 */
  to: number;
  /** 用于显示的总数：筛选后计数优先（为 0 条时 `||` 会错误回落 total，故用显式判定） */
  count: number;
  canPrev: boolean;
  canNext: boolean;
  /** 翻页步长（= 后端单页上限） */
  pageSize: number;
}

/** 由当前 offset / pageSize / 总数推导分页器状态（纯函数）。 */
export function pagerModel(offset: number, pageSize: number, filteredTotal?: number, total?: number): SharePagerModel {
  const count = filteredTotal ?? total ?? 0;
  const size = pageSize > 0 ? pageSize : 50;
  const from = count === 0 ? 0 : offset + 1;
  const to = Math.min(offset + size, count);
  return {
    from,
    to,
    count,
    canPrev: offset > 0,
    canNext: offset + size < count,
    pageSize: size,
  };
}

/**
 * 库外壳里真正「点得开」的表：只保留带独立分享 token 的项。
 * 后端正在为 tables[] 增量补 token 字段；缺 token 的表绝不能渲染成可点卡片
 * （点了也会被后端 404），这里做 fail-closed 过滤。
 */
export function openableShareTables(tables: readonly PublicShareTableItem[]): PublicShareTableItem[] {
  return tables.filter((t) => typeof t.token === "string" && t.token.length > 0);
}

/** 库作用域单表路由：/s/:baseToken/t/:tableId。 */
export function baseTableHref(baseToken: string, tableId: string): string {
  return `/s/${baseToken}/t/${tableId}`;
}
