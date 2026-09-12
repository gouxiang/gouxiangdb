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
