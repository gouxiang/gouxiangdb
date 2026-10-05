// canvas chunk 纯函数（从 chunks.ts 拆出以满足单文件 ≤300 行）。
// 按含文本元素 1 chunk；遍历深度/值数量有保护。

import { CANVAS_MAX_DEPTH, CANVAS_MAX_VALUES } from "./chunks.js";
import type { ProducedChunk } from "./chunks.js";

const CANVAS_TEXT_KEYS = new Set(["text", "label"]);

/**
 * 遍历画布 JSON，按元素收集 text/label（附 gxNote）；深度 12、最多 2000 值（与
 * domain/kb.canvasToSearchText 同保护阈），超限 truncated=true。非法 JSON 返回 null。
 */
export function collectCanvasTextElements(json: string): { texts: string[]; truncated: boolean } | null {
  if (!json || !json.trim()) return { texts: [], truncated: false };
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  const texts: string[] = [];
  let truncated = false;
  const walk = (node: unknown, depth: number): void => {
    if (truncated || depth > CANVAS_MAX_DEPTH || typeof node === "string") return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x, depth + 1);
      return;
    }
    if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of CANVAS_TEXT_KEYS) {
        if (typeof obj[key] === "string" && obj[key].trim()) parts.push(obj[key].trim());
      }
      if (typeof obj.gxNote === "string" && obj.gxNote.trim()) parts.push(obj.gxNote.trim());
      if (parts.length) {
        if (texts.length >= CANVAS_MAX_VALUES) {
          truncated = true;
          return;
        }
        texts.push(parts.join(" "));
      }
      for (const [k, v] of Object.entries(obj)) {
        if (CANVAS_TEXT_KEYS.has(k) || k === "gxNote") continue;
        walk(v, depth + 1);
      }
    }
  };
  walk(data, 0);
  return { texts, truncated };
}

interface CanvasChunkInput { canvasId: string; nodeId: string; title: string; contentJson: string; }

/** canvas 每个含文本元素 1 identity chunk（§4.6）；非法 JSON 返回 null 由接线片记账。 */
export function buildCanvasIdentityChunks(input: CanvasChunkInput): { chunks: ProducedChunk[]; truncated: boolean } | null {
  const collected = collectCanvasTextElements(input.contentJson);
  if (!collected) return null;
  const chunks: ProducedChunk[] = collected.texts.map((t, idx) => ({
    chunkKind: "identity" as const, chunkId: `canvas:${input.canvasId}:${idx}`, entityType: "canvas" as const,
    entityId: input.canvasId, nodeId: input.nodeId, fieldId: null,
    title: idx === 0 ? input.title : `${input.title} #${idx + 1}`, body: t, seq: idx,
  }));
  return { chunks, truncated: collected.truncated };
}
