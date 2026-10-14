// apps/api/src/domain/commentThreads.ts
// 记录评论的读侧组装：裸列（attachments/mentions 存 JSON 字符串）-> CommentDTO，
// 以及两级结构的内存分组。纯函数段零 IO（parseJsonIdArray / toCommentDTO / buildCommentThreads），
// 可单测；hydrate* 段只依赖注入的 client 形状（prisma / tx 都满足），不 import Hono。
//
// 容错纪律（旧数据/脏数据绝不炸读端点）：
//   · attachments/mentions 坏 JSON 一律当空数组；
//   · 作者缺失：displayName 回退 ""、avatarUrl null；
//   · replyTo 作者缺失：replyToDisplayName 回退 null；
//   · 附件找不到/已软删：跳过该附件（map 里只放活行）；
//   · @ 的用户取不到展示名：整条 mention 丢弃（不报错）；
//   · parentId 指向的根不存在（孤儿回复）：平铺进根列表返回，避免内容消失。

import type {
  AttachmentDTO,
  CommentDTO,
  CommentMentionDTO,
} from "@gx/shared-types";

/** comments 表组装所需的最小列形状（Prisma Comment 行结构满足它）。 */
export interface CommentDataRow {
  id: string;
  recordId: string;
  userId: string;
  body: string;
  parentId: string | null;
  replyToUserId: string | null;
  attachments: string;
  mentions: string;
  createdAt: Date;
  updatedAt: Date;
}

interface UserRef {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

interface AttachmentRef {
  id: string;
  name: string;
  size: number;
  mime: string;
}

/** hydrate 所需的最小数据访问面（prisma 单例与交互事务 tx 都满足）。 */
export interface CommentHydrationClient {
  user: {
    findMany: (args: {
      where: { id: { in: string[] } };
      select: { id: true; displayName: true; avatarUrl: true };
    }) => Promise<Array<UserRef>>;
  };
  attachment: {
    findMany: (args: {
      where: { id: { in: string[] }; deletedAt: null };
    }) => Promise<Array<AttachmentRef>>;
  };
}

/** 解析存库的 JSON 字符串 id 数组。坏 JSON / 非数组 / 含非字符串元素一律容错收敛。 */
export function parseJsonIdArray(raw: string): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((x): x is string => typeof x === "string");
}

function attachmentDto(row: AttachmentRef): AttachmentDTO {
  return {
    id: row.id,
    name: row.name,
    size: row.size,
    mime: row.mime,
    url: `/api/attachments/${row.id}/content`,
  };
}

interface HydrationMaps {
  users: Map<string, UserRef>;
  attachments: Map<string, AttachmentRef>;
}

/** 单行 -> CommentDTO（不含 replies）。找不到的附件/@成员按文件头纪律丢弃/回退。 */
function toCommentDTO(row: CommentDataRow, maps: HydrationMaps): CommentDTO {
  const author = maps.users.get(row.userId);

  const attachments: AttachmentDTO[] = [];
  for (const id of parseJsonIdArray(row.attachments)) {
    const att = maps.attachments.get(id);
    if (att) attachments.push(attachmentDto(att));
  }

  const mentions: CommentMentionDTO[] = [];
  for (const userId of parseJsonIdArray(row.mentions)) {
    const u = maps.users.get(userId);
    // 取不到展示名的成员整条 mention 丢弃（不报错）。
    if (u) mentions.push({ userId, displayName: u.displayName });
  }

  const replyToDisplayName =
    row.replyToUserId !== null
      ? (maps.users.get(row.replyToUserId)?.displayName ?? null)
      : null;

  return {
    id: row.id,
    recordId: row.recordId as CommentDTO["recordId"],
    userId: row.userId,
    displayName: author?.displayName ?? "",
    avatarUrl: author?.avatarUrl ?? null,
    body: row.body,
    attachments,
    mentions,
    parentId: row.parentId,
    replyToUserId: row.replyToUserId,
    replyToDisplayName,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * 纯分组：输入一批同 record 的评论（顺序不限），输出根评论倒序、回复升序内嵌。
 * 两级封顶的合法性由写侧保证；这里只负责如实分组，并把孤儿回复平铺进根列表。
 */
export function buildCommentThreads(
  rows: readonly CommentDataRow[],
  maps: HydrationMaps,
): CommentDTO[] {
  const rootRows = rows.filter((r) => r.parentId === null);
  const rootIds = new Set(rootRows.map((r) => r.id));

  const repliesByParent = new Map<string, CommentDataRow[]>();
  const orphans: CommentDataRow[] = [];
  for (const r of rows) {
    if (r.parentId === null) continue;
    if (rootIds.has(r.parentId)) {
      const list = repliesByParent.get(r.parentId) ?? [];
      list.push(r);
      repliesByParent.set(r.parentId, list);
    } else {
      orphans.push(r);
    }
  }

  // 时间相同用 id 做稳定决胜，保证输出确定性（同毫秒批量写入时不随机）。
  const asc = (a: CommentDataRow, b: CommentDataRow): number =>
    a.createdAt.getTime() - b.createdAt.getTime() ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const desc = (a: CommentDataRow, b: CommentDataRow): number =>
    b.createdAt.getTime() - a.createdAt.getTime() ||
    (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

  // 根（含内嵌回复，回复升序）+ 孤儿回复（不带 replies）统一按时间倒序平铺。
  const topLevel = [...rootRows, ...orphans].sort(desc);

  return topLevel.map((row) => {
    const dto = toCommentDTO(row, maps);
    if (row.parentId === null) {
      const replies = (repliesByParent.get(row.id) ?? [])
        .sort(asc)
        .map((reply) => toCommentDTO(reply, maps));
      return { ...dto, replies };
    }
    return dto;
  });
}

/** 批量拉取组装所需的作者与活附件 map（一次 user 查询 + 一次 attachment 查询，杜绝 N+1）。 */
async function loadMaps(
  client: CommentHydrationClient,
  rows: readonly CommentDataRow[],
): Promise<HydrationMaps> {
  const userIds = new Set<string>();
  const attachmentIds = new Set<string>();
  for (const r of rows) {
    userIds.add(r.userId);
    if (r.replyToUserId) userIds.add(r.replyToUserId);
    for (const id of parseJsonIdArray(r.mentions)) userIds.add(id);
    for (const id of parseJsonIdArray(r.attachments)) attachmentIds.add(id);
  }

  const users = new Map<string, UserRef>();
  if (userIds.size > 0) {
    const list = await client.user.findMany({
      where: { id: { in: [...userIds] } },
      select: { id: true, displayName: true, avatarUrl: true },
    });
    for (const u of list) users.set(u.id, u);
  }

  const attachments = new Map<string, AttachmentRef>();
  if (attachmentIds.size > 0) {
    const list = await client.attachment.findMany({
      where: { id: { in: [...attachmentIds] }, deletedAt: null },
    });
    for (const a of list) attachments.set(a.id, a);
  }

  return { users, attachments };
}

/** 组装一条记录的整棵评论树（根倒序、回复升序）。 */
export async function hydrateCommentThreads(
  client: CommentHydrationClient,
  rows: readonly CommentDataRow[],
): Promise<CommentDTO[]> {
  if (rows.length === 0) return [];
  const maps = await loadMaps(client, rows);
  return buildCommentThreads(rows, maps);
}

/** 组装单条评论（POST 后返回；不给 replies，前端按根处理）。 */
export async function hydrateSingleComment(
  client: CommentHydrationClient,
  row: CommentDataRow,
): Promise<CommentDTO> {
  const maps = await loadMaps(client, [row]);
  return toCommentDTO(row, maps);
}
