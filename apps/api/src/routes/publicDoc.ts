// apps/api/src/routes/publicDoc.ts
// 公开分享（匿名）的【文档 / 画布】读取与引用闭包。
//
// 从 routes/public.ts 拆出：公开分享现在有两条互不重叠的对象族（文档/画布 与 数据表/库），
// 混在一个文件里必然越写越长且互相污染。本文件只管前者，
// 数据表侧在 publicTable.ts，统一分发在 public.ts。
//
// 写口径：文档正文的匿名编辑【仍然关闭】（PUT 一律 403），不因本次改造重开。
// 但文档/画布分享的「档位」照常计算并通过 mode/degraded 回传——它决定文档内
// 【嵌入的数据表预览】能不能写（见 publicEmbed.ts），与文档正文能不能改是两件事。

import { Hono } from "hono";
import { prisma } from "../db.js";
import { HttpError, errorResponse } from "../guards.js";
import { resolveShareTarget, type ShareDocRow } from "../domain/share/shareLinkLookup.js";
import { resolveDocShareCaps } from "../domain/share/shareCaps.js";

export const publicDocRoutes = new Hono();

/** 收集根节点子树 id 集合（含根） */
export async function subtreeIdSet(rootId: string): Promise<Set<string>> {
  const all = await prisma.kbDoc.findMany({
    where: { deletedAt: null },
    select: { id: true, parentId: true },
  });
  const childrenOf = new Map<string | null, string[]>();
  for (const d of all) {
    const arr = childrenOf.get(d.parentId) ?? [];
    arr.push(d.id);
    childrenOf.set(d.parentId, arr);
  }
  const set = new Set<string>();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    if (set.has(id)) continue;
    set.add(id);
    for (const ch of childrenOf.get(id) ?? []) stack.push(ch);
  }
  return set;
}

export function publicDoc(
  d: { id: string; kind: string; title: string; content: string; updatedAt: Date; parentId: string | null },
  canEdit: boolean,
) {
  return {
    id: d.id, kind: d.kind, title: d.title, content: d.content,
    parentId: d.parentId, canEdit, updatedAt: d.updatedAt,
  };
}

// 引用闭包防护参数（防画布引用图爆炸 / 越权枚举），见 docs/decisions/KB-EDITOR-ROUND-5.md §2.4
const REF_CLOSURE_MAX_DEPTH = 3;
const REF_CLOSURE_MAX_DOCS = 50;

/**
 * 从一段画布 content（Drawnix PlaitElement[] 的 JSON 串）中递归收集
 * 任意键名为 gxDocRef / gxLinkRef 的对象上的字符串字段 docId。
 */
export function collectRefDocIds(content: string): Set<string> {
  const ids = new Set<string>();
  let root: unknown;
  try {
    root = JSON.parse(content);
  } catch {
    return ids;
  }
  const seen = new Set<object>();
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if ((key === "gxDocRef" || key === "gxLinkRef") && val !== null && typeof val === "object") {
        const refId = (val as Record<string, unknown>).docId;
        if (typeof refId === "string" && refId.length > 0) ids.add(refId);
      }
      walk(val);
    }
  };
  walk(root);
  return ids;
}

/**
 * 计算一次公开分享的"可匿名访问闭包"（只读授权集合）：根 + 可选子树 + 画布引用闭包，
 * 层数上限 REF_CLOSURE_MAX_DEPTH、文档总数上限 REF_CLOSURE_MAX_DOCS。
 */
export async function buildShareReferenceClosure(root: {
  id: string;
  kind: string;
  shareIncludeChildren: boolean;
}): Promise<Set<string>> {
  const allowed = new Set<string>([root.id]);
  if (root.shareIncludeChildren) {
    for (const id of await subtreeIdSet(root.id)) allowed.add(id);
  }

  let frontier = [...allowed];
  for (let hop = 0; hop < REF_CLOSURE_MAX_DEPTH - 1 && frontier.length > 0; hop++) {
    if (allowed.size >= REF_CLOSURE_MAX_DOCS) break;
    const rows = await prisma.kbDoc.findMany({
      where: { id: { in: [...new Set(frontier)].slice(0, REF_CLOSURE_MAX_DOCS) }, kind: "canvas", deletedAt: null },
      select: { id: true, content: true },
    });
    const nextFrontier: string[] = [];
    outer: for (const row of rows) {
      for (const refId of collectRefDocIds(row.content)) {
        if (!allowed.has(refId)) {
          allowed.add(refId);
          nextFrontier.push(refId);
          if (allowed.size >= REF_CLOSURE_MAX_DOCS) break outer;
        }
      }
    }
    frontier = allowed.size >= REF_CLOSURE_MAX_DOCS ? [] : nextFrontier;
  }
  return allowed;
}

/**
 * 文档/画布分享的根节点响应体。
 * canEdit 恒 false：正文的匿名写已关闭，回 true 会让前端去调一个必然 403 的接口。
 * 真正的档位看 mode / degraded —— 嵌入的数据表预览按它决定读写。
 */
export async function docShareResponse(token: string, root: ShareDocRow) {
  const caps = await resolveDocShareCaps(root.shareRole, root.kbId, root.shareCreatedBy);
  let tree: Array<{ id: string; kind: string; title: string; parentId: string | null }> = [];
  if (root.shareIncludeChildren) {
    const set = await subtreeIdSet(root.id);
    tree = await prisma.kbDoc.findMany({
      where: { id: { in: [...set] }, deletedAt: null },
      select: { id: true, kind: true, title: true, parentId: true },
      orderBy: { updatedAt: "desc" },
    });
  } else {
    tree = [{ id: root.id, kind: root.kind, title: root.title, parentId: null }];
  }
  return {
    kind: "doc" as const,
    rootToken: token,
    shareRole: root.shareRole,
    canEdit: false,
    mode: caps.mode,
    requestedMode: caps.requestedMode,
    degraded: caps.degraded,
    includeChildren: root.shareIncludeChildren,
    doc: publicDoc(root, false),
    tree,
  };
}

// 子树内某文档内容
publicDocRoutes.get("/s/:token/doc/:docId", async (c) => {
  try {
    const token = c.req.param("token");
    const docId = c.req.param("docId");
    const target = await resolveShareTarget(token);
    if (target.type !== "kb_doc") throw new HttpError(404, "该分享链接不是文档分享");
    const root = target.doc;

    if (docId !== root.id) {
      if (!root.shareIncludeChildren) throw new HttpError(404, "该内容未包含在本次分享范围内");
      const set = await subtreeIdSet(root.id);
      if (!set.has(docId)) throw new HttpError(404, "该内容未包含在本次分享范围内");
    }
    const doc = await prisma.kbDoc.findFirst({
      where: { id: docId, deletedAt: null },
      select: { id: true, kbId: true, kind: true, title: true, content: true, updatedAt: true, parentId: true },
    });
    if (!doc) throw new HttpError(404, "文档不存在或已被删除");
    const caps = await resolveDocShareCaps(root.shareRole, root.kbId, root.shareCreatedBy);
    return c.json({
      doc: publicDoc(doc, false),
      canEdit: false,
      mode: caps.mode,
      degraded: caps.degraded,
      shareRole: root.shareRole,
    });
  } catch (e) {
    return errorResponse(c, e);
  }
});

// 引用闭包内某文档内容（画布 gxDocRef/gxLinkRef 指向的子树外文档，匿名只读）
publicDocRoutes.get("/s/:token/ref/:docId", async (c) => {
  try {
    const token = c.req.param("token");
    const targetId = c.req.param("docId");
    const target = await resolveShareTarget(token);
    if (target.type !== "kb_doc") throw new HttpError(404, "该分享链接不是文档分享");
    const root = target.doc;

    const subtree = new Set<string>([root.id]);
    if (root.shareIncludeChildren) {
      for (const id of await subtreeIdSet(root.id)) subtree.add(id);
    }
    if (!subtree.has(targetId)) {
      const closure = await buildShareReferenceClosure(root);
      if (!closure.has(targetId)) {
        throw new HttpError(403, "该内容未包含在本次分享范围内");
      }
    }
    const row = await prisma.kbDoc.findFirst({
      where: { id: targetId, deletedAt: null },
      select: { id: true, kbId: true, kind: true, title: true, content: true, updatedAt: true, parentId: true },
    });
    if (!row) throw new HttpError(404, "文档不存在或已被删除");
    const caps = await resolveDocShareCaps(root.shareRole, root.kbId, root.shareCreatedBy);
    return c.json({ doc: publicDoc(row, false), canEdit: false, mode: caps.mode, degraded: caps.degraded, shareRole: root.shareRole });
  } catch (e) {
    return errorResponse(c, e);
  }
});

// 匿名编辑保存：已关闭（产品口径「分享链接进来的外部人只读」，正文写不重开）。
publicDocRoutes.put("/s/:token/doc/:docId/content", async (c) => {
  return errorResponse(c, new HttpError(403, "分享链接为只读，不接受通过分享链接的编辑"));
});
