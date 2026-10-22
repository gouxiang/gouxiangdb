// apps/api/src/domain/share/shareLinkLookup.ts
// 分享令牌 -> 分享对象的唯一解析入口。
//
// 令牌有两处来源，本文件把它们收敛成一个 ShareTarget，路由层不再各自查表：
//   A. share_links.token（对象化分享链接）：base / table / kb_doc 三种对象族。
//   B. kb_docs.share_token（知识库文档与画布的历史分享令牌）：等价于 objectType=kb_doc。
//
// 解析只回答"这个令牌指向什么、现在还开不开"，【不回答能不能写】——
// 可编辑性由 shareCaps.ts 每次访问现算，原因见该文件头。
//
// 两级开关在这里生效：库级 shareEnabled + 表级 shareEnabled 都开，表才能被外发。
// 关掉任一级后，已发出的链接立即失效（不是"下次再算"，是当次访问即 403）。

import { prisma } from "../../db.js";
import { HttpError } from "../../guards.js";
import { readShareEnabled, tableShareAllowed } from "../authz/libraryVisibility.js";

export interface ShareLinkRow {
  id: string;
  token: string;
  objectType: string;
  objectId: string | null;
  baseId: string;
  viewId: string | null;
  mode: string;
  createdBy: string | null;
  role: string;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface ShareDocRow {
  id: string;
  kbId: string;
  kind: string;
  title: string;
  content: string;
  parentId: string | null;
  shareRole: string;
  shareIncludeChildren: boolean;
  /** 开分享的人（可编辑文档分享动态降级的判定主体）；历史行无值 -> 只读。 */
  shareCreatedBy: string | null;
  updatedAt: Date;
}

interface ShareBaseRow {
  id: string;
  name: string;
  icon: string | null;
  iconColor: string | null;
}

interface ShareTableRow {
  id: string;
  name: string;
  icon: string | null;
  iconColor: string | null;
  primaryFieldId: string;
  baseId: string;
  baseName: string;
}

type ShareTarget =
  | { type: "kb_doc"; doc: ShareDocRow }
  | { type: "base"; link: ShareLinkRow; base: ShareBaseRow }
  | { type: "table"; link: ShareLinkRow; table: ShareTableRow };

/** 对象族白名单：库里出现未知值一律按无效令牌处理（不猜、不回落，避免静默放权）。 */
const KNOWN_OBJECT_TYPES = new Set(["base", "table", "kb_doc"]);

function expired(link: ShareLinkRow, now: Date): boolean {
  return link.expiresAt !== null && link.expiresAt.getTime() <= now.getTime();
}

/** 按 token 取对象化分享链接；不存在/已过期/未知对象族都返回 null（由调用方统一 404）。 */
async function findShareLink(token: string): Promise<ShareLinkRow | null> {
  const row = await prisma.shareLink.findUnique({ where: { token } });
  if (!row || !KNOWN_OBJECT_TYPES.has(row.objectType)) return null;
  return row;
}

async function loadBase(baseId: string): Promise<ShareBaseRow | null> {
  return prisma.base.findFirst({
    where: { id: baseId, deletedAt: null },
    select: { id: true, name: true, icon: true, iconColor: true },
  });
}

async function loadTable(tableId: string): Promise<ShareTableRow | null> {
  const t = await prisma.table.findFirst({
    where: { id: tableId, deletedAt: null },
    select: {
      id: true, name: true, icon: true, iconColor: true, primaryFieldId: true,
      baseId: true, base: { select: { name: true } },
    },
  });
  if (!t) return null;
  return { ...t, baseName: t.base.name };
}

async function loadSharedDoc(token: string): Promise<ShareDocRow | null> {
  return prisma.kbDoc.findFirst({
    where: { shareToken: token, shareEnabled: true, deletedAt: null },
    select: {
      id: true, kbId: true, kind: true, title: true, content: true, parentId: true,
      shareRole: true, shareIncludeChildren: true, shareCreatedBy: true, updatedAt: true,
    },
  });
}

/**
 * 解析一次公开访问的令牌。
 * 顺序：先对象化链接（新的表/库分享），再文档令牌（历史知识库分享）。
 * 两处令牌空间互不重叠（同一串不会同时是两者），先查新表不影响任何存量链接。
 */
export async function resolveShareTarget(token: string, now: Date = new Date()): Promise<ShareTarget> {
  if (!token) throw new HttpError(404, "分享链接已失效或被取消");

  const link = await findShareLink(token);
  if (link) {
    if (expired(link, now)) throw new HttpError(404, "分享链接已过期");
    if (link.objectType === "table") {
      if (!link.objectId) throw new HttpError(404, "分享链接已失效或被取消");
      const table = await loadTable(link.objectId);
      if (!table) throw new HttpError(404, "被分享的数据表不存在或已删除");
      // 两级开关：库级关了或表级关了，链接当次即失效（不缓存、不宽限）。
      if (!(await tableShareAllowed(table.id))) {
        throw new HttpError(403, "该数据表已关闭分享");
      }
      return { type: "table", link, table };
    }
    if (link.objectType === "kb_doc") {
      if (!link.objectId) throw new HttpError(404, "分享链接已失效或被取消");
      const doc = await prisma.kbDoc.findFirst({
        where: { id: link.objectId, deletedAt: null },
        select: {
          id: true, kbId: true, kind: true, title: true, content: true, parentId: true,
          shareRole: true, shareIncludeChildren: true, shareCreatedBy: true, updatedAt: true,
        },
      });
      if (!doc) throw new HttpError(404, "被分享的文档不存在或已删除");
      return { type: "kb_doc", doc };
    }
    const base = await loadBase(link.baseId);
    if (!base) throw new HttpError(404, "被分享的库不存在或已删除");
    if (!(await readShareEnabled("base", base.id))) {
      throw new HttpError(403, "该库已关闭分享");
    }
    return { type: "base", link, base };
  }

  // 文档/画布令牌：沿用改造前的口径（只认 kb_docs.share_token + shareEnabled）。
  // 库级「允许分享」总闸在这里强制，与表侧 tableShareAllowed 同口径：
  // 库级总闸一关，已发出的存量文档/画布分享链接【当次访问即 403】，不缓存、不宽限。
  // （代价——关总闸会让该库已发出的文档链接集体失效——产品已明确接受：
  //   总闸关着，这个知识库就一份都发不出去；表侧早就是这个语义。）
  const doc = await loadSharedDoc(token);
  if (doc) {
    if (!(await readShareEnabled("kb", doc.kbId))) {
      throw new HttpError(403, "该知识库已关闭分享");
    }
    return { type: "kb_doc", doc };
  }

  throw new HttpError(404, "分享链接已失效或被取消");
}

/** 库分享外壳里的一项可分享表：只列「自身存在有效 table 分享链接」的表，并带出该链接 token。 */
export interface ShareableTableItem {
  id: string;
  name: string;
  icon: string | null;
  /** 该表当前有效的 table 分享链接 token（取最新一条）；无有效链接的表不会出现在清单里。 */
  token: string;
}

/**
 * 取某个库下的可分享表清单（库级分享链接的只读外壳用）。
 *
 * 两道条件同时满足才列出（避免死胡同与枚举）：
 *   1. 该表 shareEnabled=1 且未删除（库级总闸由 base 链接解析侧保证）；
 *   2. 该表存在一条【有效】的 table 分享链接（objectType=table、未撤销、未过期）。
 *      撤销即删除 share_link 行，故"行不存在"天然覆盖撤销语义。
 *
 * N+1 规避：表数量级小，用一次 whereIn 批量取回这些表的全部 table 链接，再在内存按
 * 未过期过滤 + 取最新一条 join，不逐表查库。
 */
export async function shareableTables(baseId: string, now: Date = new Date()): Promise<ShareableTableItem[]> {
  const rows = await prisma.table.findMany({
    where: { baseId, deletedAt: null, shareEnabled: 1 },
    select: { id: true, name: true, icon: true },
    orderBy: { createdAt: "asc" },
  });
  if (rows.length === 0) return [];

  const tableIds = rows.map((t) => t.id);
  const links = await prisma.shareLink.findMany({
    where: { objectType: "table", objectId: { in: tableIds } },
    select: { objectId: true, token: true, expiresAt: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });

  // 每张表只保留最新一条【未过期】链接（findMany 已按 createdAt desc，首个命中即最新）。
  const tokenByTable = new Map<string, string>();
  for (const link of links) {
    if (!link.objectId || tokenByTable.has(link.objectId)) continue;
    if (link.expiresAt !== null && link.expiresAt.getTime() <= now.getTime()) continue;
    tokenByTable.set(link.objectId, link.token);
  }

  return rows
    .filter((t) => tokenByTable.has(t.id))
    .map((t) => ({ id: t.id, name: t.name, icon: t.icon, token: tokenByTable.get(t.id)! }));
}
