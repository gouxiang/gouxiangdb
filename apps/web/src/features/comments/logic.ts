// apps/web/src/features/comments/logic.ts
// 评论增强的纯函数决策层：@ 提及解析 / 附件内联判定 / 拖放粘贴取文件 /
// 两级评论排序计数 / 发送载荷构造 / 正文安全分段。
//
// 为什么全部抽成纯函数：web 侧 vitest 跑 node 环境（无 jsdom / testing-library），
// 交互（@ 选择、payload、发送门控、排序）必须能不依赖 DOM 直接断言；
// 组件层只做「接线 + 渲染」，不在这里之外再写第二套规则。
//
// 纪律：不裸 fetch、不引第三方依赖；颜色/圆角一律走组件 class。

import type { CommentDTO, CreateCommentRequest } from "@gx/shared-types";
import type { RosterMember } from "../contacts/member-roster";
import { extOfName, resolvePreviewKind } from "../attachments/policy";

// ============================= @ 提及 =============================

/** 光标处正激活的 @ 输入：start = '@' 的下标，query = '@' 后到光标之间已输入的字。 */
export interface ActiveMention {
  start: number;
  query: string;
}

/**
 * 判断 (text, caret) 处是否处于「@ 搜索中」。
 * 规则：@ 必须位于行首或空白/括号之后（避免邮箱 a@b 误触发），且 @ 与光标间无空白、无第二个 @。
 */
export function activeMention(
  text: string,
  caret: number,
): ActiveMention | null {
  const t = String(text ?? "");
  const pos = Math.max(
    0,
    Math.min(Number.isFinite(caret) ? caret : t.length, t.length),
  );
  const prefix = t.slice(0, pos);
  const m = /(^|[\s(（])@([^\s@]*)$/.exec(prefix);
  if (!m) return null;
  // m.index 指向「前导字符」（或串首），'@' 在其右侧一位；串首时 m[1] 为 ""。
  const at = m.index + (m[1] ? m[1].length : 0);
  return { start: at, query: m[2] ?? "" };
}

/** 成员候选：按展示名/邮箱本地名/邮箱包含 query（忽略大小写），稳定截断到 limit 条。 */
export function mentionCandidates(
  members: readonly RosterMember[],
  query: string,
  limit = 8,
): RosterMember[] {
  const q = String(query ?? "")
    .trim()
    .toLowerCase();
  const all =
    q === ""
      ? [...members]
      : members.filter((m) => {
          const name = m.displayName.toLowerCase();
          const email = m.email.toLowerCase();
          return (
            name.includes(q) ||
            email.includes(q) ||
            email.split("@")[0]?.includes(q)
          );
        });
  return all.slice(0, limit);
}

/** 把选中的成员写进正文：用 `@展示名 ` 替换 `@query`，返回新正文与光标位。 */
export function applyMention(
  text: string,
  caret: number,
  start: number,
  displayName: string,
): { text: string; caret: number } {
  const t = String(text ?? "");
  const before = t.slice(0, start);
  const after = t.slice(caret);
  const insert = `@${displayName} `;
  const next = before + insert + after;
  return { text: next, caret: before.length + insert.length };
}

/** 已选中的提及（id → 发送时仍以 `@展示名` 出现在正文里为准，允许用户删掉文字即取消提及）。 */
export interface PickedMention {
  id: string;
  name: string;
}

/** 从最终正文反推仍存在的提及 id：只保留「@展示名」整串仍在正文里的已选成员，去重保序。 */
export function mentionIdsFromPicked(
  body: string,
  picked: readonly PickedMention[],
): string[] {
  const ids: string[] = [];
  for (const p of picked) {
    if (!p.id || !p.name) continue;
    if (body.includes(`@${p.name}`) && !ids.includes(p.id)) ids.push(p.id);
  }
  return ids;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 正文分段：把 @展示名 切成可高亮的 mention 段，其余为 text 段（React 渲染自动转义，禁 dangerouslySetInnerHTML）。 */
export interface BodySegment {
  type: "text" | "mention";
  text: string;
  userId?: string;
}

export function bodySegments(
  body: string,
  mentions: readonly { userId: string; displayName: string }[],
): BodySegment[] {
  const text = String(body ?? "");
  const valid = mentions.filter(
    (m) => m.displayName && m.displayName.trim() !== "",
  );
  if (text === "" || valid.length === 0)
    return text === "" ? [] : [{ type: "text", text }];
  // 长名字优先，避免「张」抢先匹配「张三」。
  const ordered = [...valid].sort(
    (a, b) => b.displayName.length - a.displayName.length,
  );
  const re = new RegExp(
    "(" + ordered.map((m) => `@${escapeRegExp(m.displayName)}`).join("|") + ")",
    "g",
  );
  const byName = new Map(ordered.map((m) => [`@${m.displayName}`, m.userId]));
  const out: BodySegment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last)
      out.push({ type: "text", text: text.slice(last, m.index) });
    const token = m[0];
    out.push({ type: "mention", text: token, userId: byName.get(token) });
    last = m.index + token.length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out;
}

// ============================= 附件 =============================

/**
 * 评论内联图片判定：在通用预览分派（扩展名优先）基础上额外排除 svg。
 * 后端对 svg 是 FORCE_DOWNLOAD 语义（可内嵌脚本，不能当 <img> 内联信任），
 * policy.resolvePreviewKind 把 svg 归为 image，故评论层必须自己再挡一道。
 */
export function isInlineImageAttachment(a: {
  name: string;
  mime?: string;
}): boolean {
  const name = String(a.name ?? "");
  const mime = String(a.mime ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (extOfName(name) === "svg" || mime === "image/svg+xml") return false;
  return resolvePreviewKind(name, mime) === "image";
}

/** 拖放 / 粘贴载体的最小结构（浏览器里是 DataTransfer / ClipboardEvent）。 */
export interface FileCarrier {
  files?: ArrayLike<File> | null;
  items?: ArrayLike<{ kind?: string; getAsFile?: () => File | null }> | null;
}

/**
 * 从拖放/粘贴载体取 File[]：优先 items（粘贴图片只在 items 里、files 常为空），
 * 退化到 files。任一通道缺失都不抛错（node/老浏览器）。
 */
export function collectFiles(carrier: FileCarrier | null | undefined): File[] {
  if (!carrier) return [];
  const out: File[] = [];
  const items = carrier.items;
  if (items && typeof items.length === "number") {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it && it.kind === "file" && typeof it.getAsFile === "function") {
        const f = it.getAsFile();
        if (f) out.push(f);
      }
    }
  }
  if (
    out.length === 0 &&
    carrier.files &&
    typeof carrier.files.length === "number"
  ) {
    for (let i = 0; i < carrier.files.length; i++) {
      const f = carrier.files[i];
      if (f) out.push(f);
    }
  }
  return out;
}

/** 粘贴时只收图片（产品要求「粘贴图片」直接附图；粘贴普通文件多数浏览器不暴露）。 */
export function collectPastedImages(
  carrier: FileCarrier | null | undefined,
): File[] {
  return collectFiles(carrier).filter((f) =>
    isInlineImageAttachment({ name: f.name, mime: f.type }),
  );
}

// ============================= 两级评论排序 / 计数 =============================
// 实现拆到 organize.ts（守单文件行数）；这里统一再导出，调用方一律从 "./logic" 取。
export { organizeComments, totalComments } from "./organize";

// ============================= 发送 =============================

export interface BuildPayloadInput {
  body?: string;
  attachmentIds?: readonly string[];
  mentionIds?: readonly string[];
  parentId?: string | null;
  replyToUserId?: string | null;
}

/** 构造创建评论载荷：trim 正文、去空字段；回复同时带 parentId + replyToUserId。 */
export function buildCommentPayload(
  input: BuildPayloadInput,
): CreateCommentRequest {
  const body = String(input.body ?? "").trim();
  const attachmentIds = (input.attachmentIds ?? []).filter(Boolean);
  const mentionIds = (input.mentionIds ?? []).filter(Boolean);
  const payload: CreateCommentRequest = {};
  if (body !== "") payload.body = body;
  if (attachmentIds.length) payload.attachmentIds = [...attachmentIds];
  if (mentionIds.length) payload.mentionIds = [...mentionIds];
  if (input.parentId) {
    payload.parentId = input.parentId;
    if (input.replyToUserId) payload.replyToUserId = input.replyToUserId;
  }
  return payload;
}

/** 发送门控：正文非空或有已就绪附件才允许发；尚有附件上传中禁止发（空内容禁发）。 */
export function canSubmit(
  body: string,
  readyCount: number,
  uploadingCount: number,
): boolean {
  if (uploadingCount > 0) return false;
  return String(body ?? "").trim() !== "" || readyCount > 0;
}

/** 回复目标：永远挂到根评论，replyToUserId 为被回复人（根或某条回复的作者）。 */
export interface ReplyTarget {
  rootId: string;
  userId: string;
  displayName: string;
}

/** 从被点击的评论求回复目标（点回复 = rootId/被回复人；点根评论 = 其本人）。 */
export function replyTargetOf(comment: CommentDTO): ReplyTarget {
  return {
    rootId: comment.parentId ?? comment.id,
    userId: comment.userId,
    displayName: comment.displayName,
  };
}
