// apps/web/src/features/kb/draft.ts
// 内容持久化兜底：本地草稿（localStorage）。
// 职责：在"防抖自动保存到后端"之外增加一层崩溃/刷新/断网保护。
//  - 编辑中实时写草稿（节流）；成功保存到后端后清除对应草稿。
//  - 加载时若发现比服务端更新的草稿，提示用户恢复（由调用方决定 UI）。
// 数据自包含在浏览器本地，key 按 docId 隔离；画布与文档共用。

const PREFIX = "gx-kb-draft:";

export interface Draft {
  content: string;
  title?: string;
  savedAt: number; // 草稿写入时间（ms）
  baseContent: string; // 草稿所基于的服务端内容，用于判断是否有差异
  /**
   * 源码（source）模式编辑标记（P1-2）：true 表示这份草稿来自无 Y 绑定的 SourceEditor
   * textarea，其改动只走 onChange→markDirty 写整篇草稿、尚未回流 Y.Doc。Y 接管期据此：
   *   1) 仍保留「恢复草稿」入口（普通 Y 回放残留草稿不弹条，带此标记的除外）；
   *   2) 不被 gx-y 合并确认（localMergedTick → clearDraftUnlessSourceUnmerged）误清。
   * 非 source 的 markDirty 不带此标记，同 key 再次写入即自然解除。
   */
  sourceUnmerged?: boolean;
}

function key(docId: string): string {
  return PREFIX + docId;
}

/** 写入/刷新本地草稿（content 与服务端一致时可直接清草稿） */
export function saveDraft(docId: string, draft: Omit<Draft, "savedAt">): void {
  try {
    if (draft.content === draft.baseContent) {
      clearDraft(docId);
      return;
    }
    const full: Draft = { ...draft, savedAt: Date.now() };
    localStorage.setItem(key(docId), JSON.stringify(full));
  } catch {
    // localStorage 配额满或被禁用：静默降级（仍有后端自动保存）
  }
}

/** 读取草稿；无/损坏返回 null */
export function loadDraft(docId: string): Draft | null {
  try {
    const raw = localStorage.getItem(key(docId));
    if (!raw) return null;
    const d = JSON.parse(raw) as Draft;
    if (typeof d.content !== "string") return null;
    return d;
  } catch {
    return null;
  }
}

export function clearDraft(docId: string): void {
  try {
    localStorage.removeItem(key(docId));
  } catch {
    /* ignore */
  }
}

/** 是否存在相对服务端内容有差异的草稿（供加载时判断是否提示恢复） */
export function hasRecoverableDraft(docId: string, serverContent: string): Draft | null {
  const d = loadDraft(docId);
  if (!d) return null;
  if (d.content === serverContent) return null; // 草稿与服务端一致，无需恢复
  if (d.content === d.baseContent && d.baseContent === serverContent) return null;
  return d;
}

/**
 * 条件清理（P1-2）：gx-y 合并确认后调用。
 * - 草稿带 sourceUnmerged 标记（源码模式改动尚未回流 Y.Doc）→ 保留，返回 false。
 *   合并确认只代表 gx-y 通道的更新已上线，不能据此抹掉从没进过 Y 的 source 草稿，否则用户
 *   在 source 模式的编辑会被静默清空且无恢复入口。
 * - 其余情况（普通 Y 回放残留草稿 / 无草稿）→ 与 clearDraft 等价地移除，返回 true。
 * 纯读判 + 既有 clearDraft，node 环境可直接单测。
 * @returns 是否执行了清理（true=已清除或本就没有；false=因 sourceUnmerged 而保留）
 */
export function clearDraftUnlessSourceUnmerged(docId: string): boolean {
  const d = loadDraft(docId);
  if (d?.sourceUnmerged) return false;
  clearDraft(docId);
  return true;
}
