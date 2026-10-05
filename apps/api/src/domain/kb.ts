// apps/api/src/domain/kb.ts
// 知识库域逻辑：搜索文本提取、版本快照策略。与 Base/Table 域无任何引用耦合。

import { prisma, type DbTx } from "../db.js";

/** 从 Markdown 提取纯文本（去标记，保留内容词） */
export function markdownToSearchText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ") // 代码块
    .replace(/`[^`]*`/g, " ") // 行内代码
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // 链接保留文字
    .replace(/^#{1,6}\s+/gm, "") // 标题号
    .replace(/^\s*>\s+/gm, "") // 引用
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, "") // 任务列表标记
    .replace(/^\s*[-*+]\s+/gm, "") // 无序列表标记
    .replace(/^\s*\d+\.\s+/gm, "") // 有序列表标记
    .replace(/[*_~|]/g, " ") // 粗斜体/删除线/表格竖线
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 从 Drawnix 画布 JSON 提取节点文本。
 * PlaitElement 是嵌套对象：思维导图/流程节点文本多在 slate 结构的 { text: "..." } 中，
 * 也有节点 label/content 字段。递归收集这些键的字符串值。
 */
export function canvasToSearchText(json: string): string {
  if (!json || !json.trim()) return "";
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return "";
  }
  const out: string[] = [];
  const TEXT_KEYS = new Set(["text", "label", "content", "title", "name"]);
  const walk = (node: unknown, depth: number): void => {
    if (depth > 12 || out.length > 2000) return;
    if (typeof node === "string") return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x, depth + 1);
      return;
    }
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (typeof v === "string" && TEXT_KEYS.has(k) && v.trim()) {
          out.push(v.trim());
        } else {
          walk(v, depth + 1);
        }
      }
    }
  };
  walk(data, 0);
  return out.join(" ").replace(/\s+/g, " ").slice(0, 50_000);
}

/** 按 kind 提取搜索文本 */
export function buildSearchText(kind: string, content: string): string {
  return kind === "canvas" ? canvasToSearchText(content) : markdownToSearchText(content);
}

const AUTO_VERSION_WINDOW_MS = 10 * 60 * 1000; // 距上一版本 10 分钟
const MAX_AUTO_VERSIONS = 50; // 自动版本上限（手动版本不参与淘汰）

/**
 * 自动版本快照的事务版：调用方可传入交互事务 tx（M3/S3 内容保存需与 nav 同步同事务），
 * 或直接传全局 prisma（单连接下其本身满足 DbTx 结构）。读/写全部走传入 client。
 */
export async function maybeAutoSnapshotTx(client: DbTx, docId: string, userId: string): Promise<boolean> {
  const doc = await client.kbDoc.findUnique({ where: { id: docId } });
  if (!doc) return false;

  const latest = await client.kbDocVersion.findFirst({
    where: { docId },
    orderBy: { version: "desc" },
  });
  const now = Date.now();
  const needSnapshot =
    !latest ||
    latest.createdAt.getTime() + AUTO_VERSION_WINDOW_MS < now;
  if (!needSnapshot) return false;

  const nextVersion = (latest?.version ?? 0) + 1;
  await client.kbDocVersion.create({
    data: {
      docId,
      version: nextVersion,
      label: null,
      title: doc.title,
      content: doc.content,
      searchText: doc.searchText,
      createdBy: userId,
    },
  });

  // 淘汰最旧自动版本（保留手动版本）
  const autos = await client.kbDocVersion.findMany({
    where: { docId, label: null },
    orderBy: { version: "desc" },
  });
  const stale = autos.slice(MAX_AUTO_VERSIONS);
  if (stale.length > 0) {
    await client.kbDocVersion.deleteMany({
      where: { id: { in: stale.map((v) => v.id) } },
    });
  }
  return true;
}

/** 手动存版本 */
export async function createManualVersion(docId: string, userId: string, label: string): Promise<{ version: number }> {
  const d = await prisma.kbDoc.findUnique({ where: { id: docId } });
  if (!d) throw new Error("文档不存在");
  const latest = await prisma.kbDocVersion.findFirst({
    where: { docId },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  const rec = await prisma.kbDocVersion.create({
    data: {
      docId,
      version: (latest?.version ?? 0) + 1,
      label: label?.trim() || null,
      title: d.title,
      content: d.content,
      searchText: d.searchText,
      createdBy: userId,
    },
  });
  return { version: rec.version };
}
