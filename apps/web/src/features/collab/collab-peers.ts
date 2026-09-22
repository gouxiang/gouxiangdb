// apps/web/src/features/collab/collab-peers.ts
// 在线名单的纯函数层：把 awareness 名单切成「自己 / 他人」，并给出统一的展示名与头像首字。
//
// 为什么单独抽一层：头像列表、协同光标、块级占用三处都要做「剔除自己」这一步，
// 各自实现必然漂移（尤其是「按 userId 还是按连接 id 判自己」这个容易错的细节），
// 且它是纯函数 —— 在本仓无 jsdom 的环境下是少数能被完整单测的部分。
//
// 依据 docs/design/2026-09-collab/DESIGN.md §5.1。

import type { CollabPresenceEntry } from "@gx/shared-types";

/** 匿名访客的展示名（DESIGN.md §5.1 / 决策 D4）。服务端已下发，这里兜 nick 为空的情况。 */
export const GUEST_DISPLAY_NAME = "匿名";
/** 登录用户在 nick 缺失时的兜底名。 */
export const MEMBER_DISPLAY_NAME = "协作者";

export interface SplitPresence {
  self: CollabPresenceEntry | null;
  peers: CollabPresenceEntry[];
}

/**
 * 切分自己与他人。
 *
 * 必须按 `id`（连接级 id）而不是 `userId` 判定 —— DESIGN.md §5.1 明确：
 * 「同账号两个标签页 awareness clientID 不同，显示为两个光标（符合预期）」。
 * 若改成按 userId 剔除，同一人的第二个标签页会被自己的第一个标签页吞掉，光标与占用双双消失。
 * 同理，访客的 userId 恒为 null，按 userId 判会把所有匿名访客折叠成一个人。
 *
 * selfId 为 null（尚未连上 / 未启用协同）时，全员按他人处理：
 * 此时也没有可信的本地身份，宁可多显示也不误删。
 */
export function splitPresence(
  entries: readonly CollabPresenceEntry[],
  selfId: string | null,
): SplitPresence {
  if (selfId === null) return { self: null, peers: [...entries] };
  let self: CollabPresenceEntry | null = null;
  const peers: CollabPresenceEntry[] = [];
  // 单次遍历且保持原顺序：awareness 的 Map 迭代序稳定，UI 顺序不该随重渲染跳动。
  for (const e of entries) {
    if (self === null && e.id === selfId) self = e;
    else peers.push(e);
  }
  return { self, peers };
}

/**
 * 展示名：trim 后为空时按身份回落。
 * 裁剪层（collab-presence.ts）已保证 nick 是字符串，但空串 / 全空白仍可能出现
 * （旧客户端、guest 未下发昵称），这里统一兜住，避免出现空白头像行。
 */
export function displayNameOf(entry: CollabPresenceEntry): string {
  const trimmed = entry.nick.trim();
  if (trimmed) return trimmed;
  return entry.kind === "guest" ? GUEST_DISPLAY_NAME : MEMBER_DISPLAY_NAME;
}

/**
 * 头像里的首个字符。
 * 用 Array.from 取第一个**码点**而不是 charAt(0)：后者会把代理对（如 U+20BB7「𠮷」）
 * 劈成半个字符，渲染出一个乱码方块。拉丁字母转大写沿用既有做法
 * （参照 DocAclModal.tsx:131 的 `.charAt(0).toUpperCase()`），只是把取值方式换成了码点安全版。
 */
export function initialOf(name: string): string {
  const first = Array.from(name.trim())[0];
  if (!first) return "?";
  return first.toUpperCase();
}
