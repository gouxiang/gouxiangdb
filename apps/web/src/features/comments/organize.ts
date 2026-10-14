// apps/web/src/features/comments/organize.ts
// 两级评论的规整与计数（从 logic.ts 拆出，守住单文件行数）：
//   · 入参可能是「根带 replies」或「含回复的扁平数组」，统一归一；
//   · 根评论按 createdAt 倒序（拷贝后排序，不 reverse），回复按时间升序；
//   · 回复只能挂根评论：找不到根的回复不丢弃，并入根池按时间排序，保证不静默吞数据。

import type { CommentDTO } from "@gx/shared-types";

export function organizeComments(
  list: readonly CommentDTO[] | undefined | null,
): CommentDTO[] {
  const all = Array.isArray(list) ? list : [];
  const roots = new Map<string, CommentDTO>();
  // 根上自带的嵌套回复先单独留存：建根时把 replies 重置为空数组再统一归集，
  // 不能重置之后再读 root.replies（读到的是空，嵌套回复会凭空丢失）。
  const nestedReplies: CommentDTO[] = [];
  const orphans: CommentDTO[] = [];

  for (const c of all) {
    if (!c) continue;
    if (c.parentId == null) {
      roots.set(c.id, { ...c, replies: [] });
      for (const r of c.replies ?? []) if (r) nestedReplies.push(r);
    }
  }
  // 顶层出现的回复（扁平形态）。
  for (const c of all) {
    if (!c || c.parentId == null) continue;
    if (roots.has(c.parentId)) nestedReplies.push(c);
    else orphans.push(c);
  }

  const repliesByRoot = new Map<string, CommentDTO[]>();
  const seenReply = new Set<string>();
  for (const r of nestedReplies) {
    if (seenReply.has(r.id)) continue; // 嵌套与扁平两形态同时出现时按 id 去重
    seenReply.add(r.id);
    const pid = r.parentId!;
    const arr = repliesByRoot.get(pid) ?? [];
    arr.push(r);
    repliesByRoot.set(pid, arr);
  }
  const byTimeAsc = (a: CommentDTO, b: CommentDTO) =>
    String(a.createdAt).localeCompare(String(b.createdAt));

  // 孤儿回复（父评论被删等）按根评论展示并并入根池，与正常根一起按时间倒序，
  // 避免「回复凭空消失」，也不把它们一律沉到列表尾部。
  const orphanRoots = orphans.map((c) => ({
    ...c,
    parentId: null,
    replies: [] as CommentDTO[],
  }));
  const rootList = [...roots.values(), ...orphanRoots].sort((a, b) =>
    String(b.createdAt).localeCompare(String(a.createdAt)),
  );
  for (const root of rootList) {
    root.replies = (repliesByRoot.get(root.id) ?? []).sort(byTimeAsc);
  }
  return rootList;
}

/** 评论总数 = 根 + 回复（抽屉头部计数用「总数」）。兼容嵌套与扁平两种形态。 */
export function totalComments(
  list: readonly CommentDTO[] | undefined | null,
): number {
  const all = Array.isArray(list) ? list : [];
  let n = 0;
  for (const c of all) {
    if (!c) continue;
    n += 1;
    if (Array.isArray(c.replies)) n += c.replies.length;
  }
  return n;
}
