// apps/web/src/features/kb/canvas/gx-ref-target.ts
// 关联目标的「站内跳转地址」单一真源。
//
//   - doc / canvas：/kb/:kbId/(doc|canvas)/:docId —— 旧形，未变
//   - table：/base/:baseId/table/:tableId[/view/:viewId] —— 数据表在数据表侧路由
//
// 数据表的 URL 带 baseId 段，而 GxDocRef.docId 承载的是 tableId，推不出 baseId，
// 因此 table 关联必须靠插入时快照的 baseId（GxDocRef.baseId）。老数据没有该快照 →
// 返回 null，调用方据此不出跳转入口（而不是拼一个必然 404 的地址）。

import type { GxDocRef } from "./types";

export function gxRefNavTarget(ref: GxDocRef, kbId?: string): string | null {
  if (ref.kind === "table") {
    if (!ref.baseId) return null;
    return ref.viewId
      ? `/base/${ref.baseId}/table/${ref.docId}/view/${ref.viewId}`
      : `/base/${ref.baseId}/table/${ref.docId}`;
  }
  // doc/canvas 的站内路由带 kbId 段：拿不到 kbId（公开分享页 / 无库上下文）时不提供跳转，
  // 否则会拼出 /kb//doc/xxx 这种必然 404 的地址（与改动前 jumpEnabled={!!kbId} 一致）。
  if (!kbId) return null;
  return `/kb/${kbId ?? ""}/${ref.kind}/${ref.docId}`;
}
