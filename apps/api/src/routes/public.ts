// apps/api/src/routes/public.ts
// 公开分享路由（匿名可访问，无需 JWT）。
// 访问模型：
//   - GET /s/:token                 分享根节点内容 + 级联子树摘要
//   - GET /s/:token/doc/:docId      级联子树内某文档内容（需根开启 shareIncludeChildren）
//   - GET /s/:token/ref/:docId      引用闭包内文档（画布 gxDocRef/gxLinkRef 指向的子树外文档，只读）
//   - PUT /s/:token/doc/:docId/content  匿名编辑保存（仅 shareRole=editor 放行）
// 权限完全以分享设置为准，与团队成员权限无关。不暴露成员邮箱、不暴露知识库其他文档。

import { Hono } from "hono";
import { z } from "zod";
import { prisma, withWriteTx } from "../db.js";
import { HttpError, errorResponse } from "../guards.js";
import { buildSearchText, maybeAutoSnapshotTx } from "../domain/kb.js";
import { enqueueChangeEventTx } from "../domain/search/outbox.js";

export const pub = new Hono();

const ANON = "anonymous:share";

interface ShareContext {
  root: { id: string; kbId: string; kind: string; title: string; content: string; shareRole: string; shareIncludeChildren: boolean; updatedAt: Date };
  doc: { id: string; kbId: string; kind: string; title: string; content: string; updatedAt: Date; parentId: string | null };
  canEdit: boolean;
}

/** 按 token 找分享根节点 */
async function findShareRoot(token: string) {
  const root = await prisma.kbDoc.findFirst({
    where: { shareToken: token, shareEnabled: true, deletedAt: null },
    select: {
      id: true, kbId: true, kind: true, title: true, content: true,
      shareRole: true, shareIncludeChildren: true, updatedAt: true,
    },
  });
  if (!root) throw new HttpError(404, "分享链接已失效或被取消");
  return root;
}

/** 收集根节点子树 id 集合（含根） */
async function subtreeIdSet(rootId: string): Promise<Set<string>> {
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

/**
 * 解析一次公开访问：token → 根；可选 docId 指定子树内某文档。
 * needEdit=true 时要求根 shareRole=editor。
 */
async function resolveShare(token: string, docId?: string, needEdit = false): Promise<ShareContext> {
  const root = await findShareRoot(token);
  if (needEdit && root.shareRole !== "editor") {
    throw new HttpError(403, "该分享为仅可见，无法编辑");
  }

  let targetId = root.id;
  if (docId && docId !== root.id) {
    // 访问子文档：必须根开启级联分享，且目标在根子树内
    if (!root.shareIncludeChildren) throw new HttpError(404, "该内容未包含在本次分享范围内");
    const set = await subtreeIdSet(root.id);
    if (!set.has(docId)) throw new HttpError(404, "该内容未包含在本次分享范围内");
    targetId = docId;
  }

  const doc = await prisma.kbDoc.findFirst({
    where: { id: targetId, deletedAt: null },
    select: { id: true, kbId: true, kind: true, title: true, content: true, updatedAt: true, parentId: true },
  });
  if (!doc) throw new HttpError(404, "文档不存在或已被删除");

  return { root, doc, canEdit: root.shareRole === "editor" };
}

function publicDoc(d: { id: string; kind: string; title: string; content: string; updatedAt: Date; parentId: string | null }, canEdit: boolean) {
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
 * - JSON.parse 容错：解析失败返回空集合（不致命）
 * - 用 Set 记录已访问对象防环；非对象 / 非字符串 docId / 缺字段一律安全跳过
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
 * 计算一次公开分享的"可匿名访问闭包"（只读授权集合）：
 *   初始集合 = 根 id；若 root.shareIncludeChildren，并入 subtreeIdSet(root.id)。
 *   随后 BFS 展开集合内 kind="canvas" 文档 content 中的 gxDocRef/gxLinkRef.docId，
 *   新落入的 canvas 再展开一层。
 *   - 层数：根为第 1 层，引用每跳一层；闭包最多保留 REF_CLOSURE_MAX_DEPTH 层
 *     （即第 2、3 层可取，第 4 层起拒绝），故只展开前 (MAX_DEPTH-1) 轮发现的 canvas。
 *   - 集合内文档总数上限 REF_CLOSURE_MAX_DOCS，达到即停止扩展。
 *   环引用 / 非对象 / 缺字段均不会导致崩溃或死循环。
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

  // 第 0 轮：展开初始集合（根 + 子树）内全部 canvas；之后只展开上一轮新发现的 id。
  // 非 canvas id 放入查询也无妨（where kind:"canvas" 会过滤）。
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

// 分享根：内容 + 级联子树摘要
pub.get("/s/:token", async (c) => {
  try {
    const token = c.req.param("token");
    const ctx = await resolveShare(token);
    let tree: Array<{ id: string; kind: string; title: string; parentId: string | null }> = [];
    if (ctx.root.shareIncludeChildren) {
      const set = await subtreeIdSet(ctx.root.id);
      const rows = await prisma.kbDoc.findMany({
        where: { id: { in: [...set] }, deletedAt: null },
        select: { id: true, kind: true, title: true, parentId: true },
        orderBy: { updatedAt: "desc" },
      });
      tree = rows;
    } else {
      tree = [{ id: ctx.root.id, kind: ctx.root.kind, title: ctx.root.title, parentId: null }];
    }
    return c.json({
      rootToken: token,
      shareRole: ctx.root.shareRole,
      canEdit: ctx.canEdit,
      includeChildren: ctx.root.shareIncludeChildren,
      doc: publicDoc(ctx.doc, ctx.canEdit),
      tree,
    });
  } catch (e) {
    return errorResponse(c, e);
  }
});

// 子树内某文档内容
pub.get("/s/:token/doc/:docId", async (c) => {
  try {
    const ctx = await resolveShare(c.req.param("token"), c.req.param("docId"));
    return c.json({ doc: publicDoc(ctx.doc, ctx.canEdit), canEdit: ctx.canEdit, shareRole: ctx.root.shareRole });
  } catch (e) {
    return errorResponse(c, e);
  }
});

// 引用闭包内某文档内容（画布 gxDocRef/gxLinkRef 指向的子树外文档，匿名只读）
pub.get("/s/:token/ref/:docId", async (c) => {
  try {
    const token = c.req.param("token");
    const targetId = c.req.param("docId");
    const root = await findShareRoot(token);

    // 文档子树集（根 + 可选级联子树）：命中则沿用现有 GET doc 的可编辑性
    const subtree = new Set<string>([root.id]);
    if (root.shareIncludeChildren) {
      for (const id of await subtreeIdSet(root.id)) subtree.add(id);
    }

    let canEdit: boolean;
    if (subtree.has(targetId)) {
      canEdit = root.shareRole === "editor";
    } else {
      // 子树外：必须落在引用闭包内，且恒为只读
      const closure = await buildShareReferenceClosure(root);
      if (!closure.has(targetId)) {
        throw new HttpError(403, "该内容未包含在本次分享范围内");
      }
      canEdit = false;
    }

    const row = await prisma.kbDoc.findFirst({
      where: { id: targetId, deletedAt: null },
      select: { id: true, kbId: true, kind: true, title: true, content: true, updatedAt: true, parentId: true },
    });
    if (!row) throw new HttpError(404, "文档不存在或已被删除");

    return c.json({ doc: publicDoc(row, canEdit), canEdit, shareRole: root.shareRole });
  } catch (e) {
    return errorResponse(c, e);
  }
});

// 匿名编辑保存
pub.put("/s/:token/doc/:docId/content", async (c) => {
  try {
    const token = c.req.param("token");
    const docId = c.req.param("docId");
    const ctx = await resolveShare(token, docId, true);
    // U-10：匿名公开写加 2MB 长度上限（此前无上限，可写爆单行/拖垮快照与搜索冗余）
    const schema = z.object({ content: z.string().max(2_000_000, "内容超过 2MB 上限") });
    const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "内容不合法" }, 400);
    const content = parsed.data.content;
    const searchText = buildSearchText(ctx.doc.kind, content);
    // M5/S1：ANON 公开编辑也发 outbox（实体存在即索引，匿名不影响归属）。原裸 update +
    // 非事务快照收紧进单事务：正文、快照、outbox 共生死，enqueue 失败则编辑整体回滚。
    await withWriteTx("public.doc.content.save", async (tx) => {
      await tx.kbDoc.update({
        where: { id: ctx.doc.id },
        data: { content, searchText, updatedBy: ANON },
      });
      await maybeAutoSnapshotTx(tx, ctx.doc.id, ANON);
      await enqueueChangeEventTx(tx, {
        entityType: ctx.doc.kind === "canvas" ? "canvas" : "doc",
        entityId: ctx.doc.id, op: "upsert", version: BigInt(Date.now()),
      });
    });
    return c.json({ ok: true, savedAt: new Date().toISOString() });
  } catch (e) {
    return errorResponse(c, e);
  }
});
