// apps/web/src/features/collab/collab-presence.ts
// 阶段 1 · 在线名单裁剪：awareness 载荷是**远端不可信输入**（可能来自匿名访客、
// 旧版本客户端，或被中间/share 链路伪造），进 UI 之前一律按白名单裁剪。
//
// 契约 packages/shared-types/src/collab.ts 的 CollabPresenceEntry 是本文件的输出形状；
// DESIGN.md §5.1/§5.2（光标与租约都借 awareness 承载）。

import type {
  CollabLease,
  CollabPresenceEntry,
  CollabSelection,
} from "@gx/shared-types";

/** awareness states 的原始形状：clientID → 任意 JSON（lib0 Awareness 的类型是 any）。 */
export type CollabAwarenessStates = ReadonlyMap<number, Record<string, unknown>>;

/** nick 白名单裁剪上限。 */
export const MAX_NICK_LEN = 32;
/** 单条 presence 最多接受多少个租约，防止远端塞爆渲染层。 */
const MAX_LEASES = 64;
/** color 会被直接写进样式（inline style），只认严格 6 位十六进制。 */
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * awareness states → 在线名单，裁剪规则：
 * - nick 截断到 32 字符；
 * - color 不合法（非 `#RRGGBB`）或缺失 → **整条丢弃**（宁可少一个人，也不接受未校验的颜色进样式）；
 * - id 缺失 / kind 非法 / 无 user 对象 → 丢弃；
 * - selection 形状非法 → null；leases 形状非法 → 空数组。
 */
export function toPresenceEntries(states: CollabAwarenessStates): CollabPresenceEntry[] {
  const out: CollabPresenceEntry[] = [];
  for (const state of states.values()) {
    if (!isRecord(state)) continue;
    const user = state.user;
    if (!isRecord(user)) continue;
    const id = isNonEmptyString(user.id) ? user.id : null;
    const kind = user.kind === "user" || user.kind === "guest" ? user.kind : null;
    const color = typeof user.color === "string" && COLOR_RE.test(user.color) ? user.color : null;
    if (!id || !kind || !color) continue;
    const rawNick =
      typeof user.nick === "string" ? user.nick : kind === "guest" ? "匿名" : "协作者";
    out.push({
      id,
      kind,
      userId: typeof user.userId === "string" ? user.userId : null,
      nick: rawNick.slice(0, MAX_NICK_LEN),
      color,
      selection: parseSelection(state.selection),
      leases: parseLeases(state.leases),
      role: user.role === "viewer" ? "viewer" : "editor",
    });
  }
  return out;
}

/** 三类内容的选区形状见契约的 CollabSelection；任一字段不合形状即退回 null。 */
function parseSelection(raw: unknown): CollabSelection | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "doc") {
    return isNonEmptyString(raw.blockId) && Number.isFinite(raw.offset) && Number.isFinite(raw.length)
      ? {
          kind: "doc",
          blockId: raw.blockId,
          offset: Number(raw.offset),
          length: Number(raw.length),
        }
      : null;
  }
  if (raw.kind === "canvas") {
    return Array.isArray(raw.elementIds) && raw.elementIds.every(isNonEmptyString)
      ? { kind: "canvas", elementIds: (raw.elementIds as string[]).slice(0, 200) }
      : null;
  }
  if (raw.kind === "table") {
    return isNonEmptyString(raw.rowId)
      ? {
          kind: "table",
          rowId: raw.rowId,
          fieldId: typeof raw.fieldId === "string" ? raw.fieldId : null,
        }
      : null;
  }
  return null;
}

/** 租约的可信度要求同上：unit 非空串 + since/expiresAt 为有限数字。 */
function parseLeases(raw: unknown): CollabLease[] {
  if (!Array.isArray(raw)) return [];
  const out: CollabLease[] = [];
  for (const item of raw) {
    if (out.length >= MAX_LEASES) break;
    if (
      isRecord(item) &&
      isNonEmptyString(item.unit) &&
      Number.isFinite(item.since) &&
      Number.isFinite(item.expiresAt)
    ) {
      out.push({ unit: item.unit, since: Number(item.since), expiresAt: Number(item.expiresAt) });
    }
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}
