// apps/web/src/features/kb/mentions.ts
// 跨文档引用 / 成员提及的 Markdown 协议：
//   成员：@[u:userId|显示名]
//   文档/画布引用：标准内部链接 [标题](/kb/:kbId/doc|canvas/:docId)（渲染器已支持跳转）
//   画布内嵌：```canvas-embed 围栏代码块（内容为 docId），预览/分享时由 React 增强为预览器
//   数据表内嵌：```table-embed 围栏代码块（第一行 tableId，可选第二行 viewId），
//     同样由 React 增强为表格预览器；预览的读写档位随宿主文档/画布的分享档位。
// 集中提供解析与构造，供编辑器插入、Markdown 渲染、预览增强共用。

export interface Mention {
  kind: "user";
  userId: string;
  label: string;
}

const USER_MENTION = /@\[u:([^|\]]+)\|([^\]]+)\]/g;

/** 构造成员提及标记 */
export function userMention(userId: string, label: string): string {
  return `@[u:${userId}|${label}]`;
}

/** 构造文档/画布内部跳转链接 */
export function docLink(kbId: string, kind: "doc" | "canvas", docId: string, title: string): string {
  return `[${title}](/kb/${kbId}/${kind}/${docId})`;
}

/** 构造画布内嵌围栏块 */
export function canvasEmbedFence(docId: string): string {
  return "```canvas-embed\n" + docId + "\n```";
}

/** 从 Markdown 提取全部画布内嵌 docId（按出现顺序、去重） */
export function extractCanvasEmbeds(src: string): string[] {
  const re = /```canvas-embed\s*\n\s*([a-zA-Z0-9]+)\s*\n?```/g;
  const ids: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const id = m[1]!.trim();
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * 构造数据表内嵌围栏块（关联插入「插入数据表」用）。
 * body：第一行 tableId，第二行可选 viewId（缺省 → 该表默认视图）。
 */
export function tableEmbedFence(tableId: string, viewId?: string | null): string {
  const body = viewId ? `${tableId}\n${viewId}` : tableId;
  return "```table-embed\n" + body + "\n```";
}

export interface TableEmbedRef {
  tableId: string;
  viewId: string | null;
}

/** 从 Markdown 提取全部数据表内嵌（按出现顺序、去重；同表不同视图算两处） */
export function extractTableEmbeds(src: string): TableEmbedRef[] {
  const re = /```table-embed[^\S\n]*\n([^\n`]*)\n[^\S\n]*([^\n`]*)\n?```/g;
  const out: TableEmbedRef[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const tableId = (m[1] ?? "").trim().replace(/[^a-zA-Z0-9]/g, "");
    const viewId = (m[2] ?? "").trim().replace(/[^a-zA-Z0-9]/g, "");
    if (!tableId) continue;
    const key = `${tableId}:${viewId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ tableId, viewId: viewId || null });
  }
  return out;
}

/** 把成员提及标记替换为安全 HTML chip（用于 Markdown 预览渲染前） */
export function renderUserMentionsToHtml(src: string): string {
  return src.replace(USER_MENTION, (_m, userId, label) => {
    const safeLabel = String(label).replace(/[<>&"]/g, "");
    const safeId = String(userId).replace(/[^a-zA-Z0-9]/g, "");
    return `<span class="md-mention" data-user-id="${safeId}">@${safeLabel}</span>`;
  });
}
