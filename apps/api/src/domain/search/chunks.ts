// M5/S3 抽文本与 chunk 拆分纯函数层（零 IO / 零接线，表驱动单测见 __tests__/chunks.test.ts）。
// 依据 M5-implementation-plan §4.6/Q7：record = identity x1（只含表名/记录定位，不放任何
// 可被 fieldMask 的业务值，§4.7）+ field xN（N<=FIELD_CHUNK_CAP，默认 50），field body 拼接
// 对齐旧 search.ts:93-95；候选=非计算、可搜索类型、实际有值；排序=类型优先级（文本优先）
// -> 创建序 -> fieldId。doc：h1-h3 粗切 + 300-512 字滑窗 overlap64；canvas：按含文本元素
// 每元素 1 chunk（后两者本期纯函数骨架，TODO S5 indexer 接去标记文本/真实画布数据）。
// 不 import db/fs/net，也不 import 会传递加载 prisma 的模块（内联最小文本规则）。

/** Q7 单记录 field chunk 确定性软上限默认值（可被参数覆盖，admin 可配另在 S4/S9）。 */
export const FIELD_CHUNK_CAP = 50;
export const DOC_TARGET_MIN = 300;
export const DOC_TARGET_MAX = 512;
export const DOC_OVERLAP = 64;
export const CANVAS_MAX_DEPTH = 12;
export const CANVAS_MAX_VALUES = 2000;

export type ChunkEntityType = "record" | "doc" | "canvas";
export type ChunkKind = "identity" | "field";

// 白名单对齐旧 search.ts:76（isComputedFieldType 六型不入）+ 无标量文本类型不入
// （attachment/tabs/json）；autoNumber 旧检索可命中编号值，保留。
const TEXT_TYPES = new Set(["singleLineText", "longText", "richText"]);
const SEARCHABLE_TYPES = new Set([
  ...TEXT_TYPES, "singleSelect", "multiSelect", "email", "url", "phone",
  "number", "currency", "percent", "duration", "date", "datetime", "checkbox", "rating", "autoNumber",
]);

function typePriority(type: string): number {
  if (TEXT_TYPES.has(type)) return 0;
  if (type === "singleSelect" || type === "multiSelect" || type === "email" || type === "url" || type === "phone") return 1;
  return 2;
}

export function isSearchableFieldType(type: string): boolean {
  return SEARCHABLE_TYPES.has(type);
}

/**
 * 字段值抽文本，口径对齐旧 routes/search.ts:93-95：数组元素为含 title 对象时取
 * String(title)，否则 String(元素)，", " 拼接；非数组 String(v)。
 */
export function extractFieldText(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((x) => (x && typeof x === "object" && "title" in (x as object)
        ? String((x as { title: unknown }).title)
        : String(x)))
      .join(", ");
  }
  return value === null || value === undefined ? "" : String(value);
}

/** 与旧 search.ts:92 对齐：仅 null/undefined/空串/抽文本为空（如 []）视为无值；空白串算有值。 */
function hasFieldValue(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return false;
  return extractFieldText(value) !== "";
}

export interface RecordFieldInput {
  fieldId: string; name: string; type: string;
  /** 创建时间毫秒数或 ISO 字符串；缺省退 order；最终平局用 fieldId。 */
  createdAt?: number | string | null;
  order?: number | null;
  value?: unknown;
}

export interface RecordChunkInput {
  recordId: string;
  /** record 不建 nav 节点，nodeId=table 节点 id（§4.5 B-1）。 */
  tableNodeId: string;
  tableName: string;
  baseName?: string;
  /** 主字段 id 仅供调用层参考，绝不把其值拷入 identity（§4.7）。 */
  primaryFieldId?: string | null;
  fields: readonly RecordFieldInput[];
}

export interface ProducedChunk {
  chunkKind: ChunkKind; chunkId: string; entityType: ChunkEntityType; entityId: string;
  nodeId: string; fieldId: string | null; title: string; body: string; seq: number;
}

export interface RecordChunkMeta {
  cap: number; totalCandidates: number; emitted: number; capped: boolean;
  /** 被确定性截断丢弃的 fieldId（按取舍排序，最末位先丢）。 */
  droppedFieldIds: string[];
}

export interface RecordChunksResult {
  identity: ProducedChunk;
  fieldChunks: ProducedChunk[];
  /** identity(seq=0) 在前，其后 field chunk 按取舍序 seq=1..N。 */
  chunks: ProducedChunk[];
  meta: RecordChunkMeta;
}

function createdOrdinal(f: RecordFieldInput): number {
  if (typeof f.createdAt === "number") return f.createdAt;
  if (typeof f.createdAt === "string") {
    const t = Date.parse(f.createdAt);
    if (Number.isFinite(t)) return t;
  }
  return typeof f.order === "number" ? f.order : Number.MAX_SAFE_INTEGER;
}

/** 拆分一条 record：identity（无业务值）+ 至多 cap 个确定性取舍的 field chunk。纯函数。 */
export function buildRecordChunks(input: RecordChunkInput, cap: number = FIELD_CHUNK_CAP): RecordChunksResult {
  if (!Number.isInteger(cap) || cap < 1) throw new Error("field chunk cap must be a positive integer");

  const identity: ProducedChunk = {
    chunkKind: "identity",
    chunkId: `record:${input.recordId}`,
    entityType: "record",
    entityId: input.recordId,
    nodeId: input.tableNodeId,
    fieldId: null,
    // title 只用 record id（非 maskable 业务值）；primary 被 mask 时回退 id 的口径在 S8 snippets 层。
    title: input.recordId,
    body: [input.baseName, input.tableName, `记录 ${input.recordId}`].filter((s) => s && s.trim()).join(" "),
    seq: 0,
  };

  const candidates = input.fields
    .filter((f) => isSearchableFieldType(f.type) && hasFieldValue(f.value))
    .map((f) => ({ f, text: extractFieldText(f.value) }))
    .sort((a, b) => {
      const pa = typePriority(a.f.type);
      const pb = typePriority(b.f.type);
      if (pa !== pb) return pa - pb;
      const oa = createdOrdinal(a.f);
      const ob = createdOrdinal(b.f);
      if (oa !== ob) return oa - ob;
      return a.f.fieldId < b.f.fieldId ? -1 : a.f.fieldId > b.f.fieldId ? 1 : 0;
    });

  const kept = candidates.slice(0, cap);
  const dropped = candidates.slice(cap);
  const fieldChunks: ProducedChunk[] = kept.map((c, idx) => ({
    chunkKind: "field",
    chunkId: `record:${input.recordId}:f:${c.f.fieldId}`,
    entityType: "record",
    entityId: input.recordId,
    nodeId: input.tableNodeId,
    fieldId: c.f.fieldId,
    title: c.f.name,
    body: c.text,
    seq: idx + 1,
  }));

  const meta: RecordChunkMeta = {
    cap,
    totalCandidates: candidates.length,
    emitted: fieldChunks.length,
    capped: candidates.length > cap,
    droppedFieldIds: dropped.map((c) => c.f.fieldId),
  };
  return { identity, fieldChunks, chunks: [identity, ...fieldChunks], meta };
}

// ============ doc：h1-h3 粗切 + 超长滑窗（骨架；TODO S5 接 markdownToSearchText） ============

export interface DocSection { headingPath: string[]; text: string; }

/** 按 h1-h3 粗切章节（纯正则）；标题层级路径随节保留；无正文节过滤。 */
export function splitMarkdownHeadings(markdown: string): DocSection[] {
  const lines = markdown.split(/\r?\n/);
  const sections: DocSection[] = [{ headingPath: [], text: "" }];
  const path: string[] = [];
  for (const line of lines) {
    const m = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (m) {
      const level = m[1].length;
      path.splice(level - 1);
      path[level - 1] = m[2];
      sections.push({ headingPath: path.filter(Boolean).slice(0, level), text: "" });
    } else {
      const cur = sections[sections.length - 1];
      cur.text += (cur.text ? "\n" : "") + line;
    }
  }
  return sections.map((s) => ({ headingPath: s.headingPath, text: s.text.trim() })).filter((s) => s.text);
}

/** 超长文本按码点滑窗：窗长 targetMax、相邻窗重叠 overlap；短于上限整段一窗。 */
export function windowText(text: string, targetMax: number = DOC_TARGET_MAX, overlap: number = DOC_OVERLAP): string[] {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  if (chars.length === 0) return [];
  if (chars.length <= targetMax) return [chars.join("")];
  const step = targetMax - overlap;
  if (step <= 0) throw new Error("window overlap must be smaller than targetMax");
  const windows: string[] = [];
  for (let start = 0; start < chars.length; start += step) {
    windows.push(chars.slice(start, start + targetMax).join(""));
    if (start + targetMax >= chars.length) break;
  }
  return windows;
}

function docChunk(docId: string, nodeId: string, title: string, body: string, idx: number): ProducedChunk {
  return { chunkKind: "identity", chunkId: `doc:${docId}:${idx}`, entityType: "doc", entityId: docId, nodeId, fieldId: null, title, body, seq: idx };
}

export interface DocChunkInput {
  docId: string; nodeId: string; title: string;
  /** 已去标记纯文本（buildDocIdentityChunks 必填，接线片由 markdownToSearchText 产出，TODO S5）。 */
  plainText?: string;
  targetMax?: number; overlap?: number;
}

/** doc 全部 identity 类（无字段概念，§4.6）；按滑窗产出，seq 连续确定。 */
export function buildDocIdentityChunks(input: DocChunkInput): ProducedChunk[] {
  return windowText(input.plainText ?? "", input.targetMax ?? DOC_TARGET_MAX, input.overlap ?? DOC_OVERLAP)
    .map((w, idx) => docChunk(
      input.docId, input.nodeId, idx === 0 ? input.title : `${input.title} #${idx + 1}`, w, idx,
    ));
}

export interface DocMarkdownChunkInput {
  docId: string; nodeId: string; title: string;
  /** 原始 markdown：h1-h3 粗切，节内超长再滑窗（去标记在接线片，TODO S5）。 */
  markdown: string;
  targetMax?: number; overlap?: number;
}
/** h1-h3 粗切 + 超长滑窗：标题路径进 title；seq 按文档顺序连续。 */
export function buildDocChunksFromMarkdown(input: DocMarkdownChunkInput): ProducedChunk[] {
  const targetMax = input.targetMax ?? DOC_TARGET_MAX;
  const overlap = input.overlap ?? DOC_OVERLAP;
  const out: ProducedChunk[] = [];
  for (const section of splitMarkdownHeadings(input.markdown)) {
    for (const w of windowText(section.text, targetMax, overlap)) {
      const path = section.headingPath.join(" / ");
      out.push(docChunk(input.docId, input.nodeId, path ? `${input.title} / ${path}` : input.title, w, out.length));
    }
  }
  return out;
}

// ============ canvas：按含文本元素 1 chunk（骨架；TODO S5 接真实画布） ============

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

export interface CanvasChunkInput { canvasId: string; nodeId: string; title: string; contentJson: string; }

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
