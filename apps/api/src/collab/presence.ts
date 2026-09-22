// apps/api/src/collab/presence.ts
// 在线名单（presence）的组装与【不可信输入裁剪】。
//
// awareness 载荷是客户端自由写入的 JSON（服务端从不解析 Y.Doc 内容，但 presence 是
// 结构化数据、要进 UI 渲染），因此一律按不可信输入处理：
//   - nick：截断 32 字符，空串回落服务端值；
//   - color：必须严格匹配 ^#[0-9A-Fa-f]{6}$，否则改用服务端分配值（防 CSS 注入/脏色值）；
//   - selection / leases：zod 校验形状，非法即丢弃该字段（不因一处非法丢掉整条在线状态，
//     否则一个坏光标会让整份名单消失）。
// 客户端不得自行生成颜色——配色恒由服务端按 userId 确定性哈希到调色板（DESIGN §5.1）。

import { z } from "zod";
import type { CollabLease, CollabPresenceEntry, CollabRole, CollabSubjectKind } from "@gx/shared-types";

/** 8 色调色板（服务端唯一分配方）。 */
export const COLLAB_PALETTE: readonly string[] = [
  "#2563EB",
  "#0891B2",
  "#16A34A",
  "#CA8A04",
  "#DC2626",
  "#7C3AED",
  "#DB2777",
  "#0D9488",
];

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
const MAX_NICK_LEN = 32;
const MAX_LEASES = 64;
const MAX_ELEMENT_IDS = 256;
const MAX_ID_LEN = 128;

/** 按 seed（userId 或连接 id）确定性哈希取色：同一人每次进来颜色一致。 */
export function colorForId(seed: string): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return COLLAB_PALETTE[(h >>> 0) % COLLAB_PALETTE.length];
}

/** 昵称白名单：非字符串/空串一律回落服务端下发值。 */
export function sanitizeNick(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim().slice(0, MAX_NICK_LEN);
  return trimmed.length > 0 ? trimmed : fallback;
}

/** 颜色白名单：严格 6 位十六进制，否则回落服务端分配值。 */
export function sanitizeColor(raw: unknown, fallback: string): string {
  return typeof raw === "string" && HEX_COLOR.test(raw) ? raw : fallback;
}

const idString = z.string().min(1).max(MAX_ID_LEN);

const selectionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("doc"),
    blockId: idString,
    offset: z.number().int().min(0).max(10_000_000),
    length: z.number().int().min(0).max(10_000_000),
  }),
  z.object({
    kind: z.literal("canvas"),
    elementIds: z.array(idString).max(MAX_ELEMENT_IDS),
  }),
  z.object({
    kind: z.literal("table"),
    rowId: idString,
    fieldId: idString.nullable(),
  }),
]);

const leaseSchema = z.object({
  unit: z.string().min(1).max(MAX_ID_LEN),
  since: z.number().finite(),
  expiresAt: z.number().finite(),
});

/** 光标位置：形状非法即丢弃（返回 null），不连带丢掉整条在线状态。 */
export function sanitizeSelection(raw: unknown): CollabPresenceEntry["selection"] {
  const parsed = selectionSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** 占用租约：逐条校验，非法条目丢弃，总量封顶（防超大数组）。 */
export function sanitizeLeases(raw: unknown): CollabLease[] {
  if (!Array.isArray(raw)) return [];
  const out: CollabLease[] = [];
  for (const item of raw.slice(0, MAX_LEASES)) {
    const parsed = leaseSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/** 服务端权威的连接身份（来自票据，不来自客户端自报）。 */
export interface CollabIdentity {
  subject: CollabSubjectKind;
  userId: string | null;
  nick: string;
  color: string;
  role: CollabRole;
}

/**
 * 把一个 awareness state 裁成一条 presence 条目。
 * `identity` 为该连接的票据身份；传 null（尚未识别到归属连接）时按最窄口径回落：
 * 只读 + 匿名不可信昵称/颜色一律按 clientId 确定性取色。
 */
export function buildPresenceEntry(
  clientId: number,
  rawState: unknown,
  identity: CollabIdentity | null,
): CollabPresenceEntry {
  const state: Record<string, unknown> =
    typeof rawState === "object" && rawState !== null ? (rawState as Record<string, unknown>) : {};
  const fallbackColor = colorForId(identity?.userId ?? `guest:${clientId}`);
  const subject: CollabSubjectKind = identity?.subject ?? "user";
  return {
    id: String(clientId),
    kind: subject,
    userId: identity?.userId ?? null,
    nick: sanitizeNick(state.nick, identity?.nick ?? "匿名"),
    color: sanitizeColor(state.color, identity?.color ?? fallbackColor),
    selection: sanitizeSelection(state.selection),
    leases: sanitizeLeases(state.leases),
    role: identity?.role ?? "viewer",
  };
}
