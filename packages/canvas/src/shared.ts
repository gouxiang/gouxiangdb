// @gx/canvas 共享基础：类型 / 常量 / 字节 / id / content 解析 / 矩形几何（零 IO、零依赖）。
// validate.ts（create 最小集）与 mutate.ts（update/move/delete/connect）共同消费，避免规则重复漂移。

/* ---------------------------------- 类型 ---------------------------------- */

/** 配额（由调用方显式传入，纯函数不读环境变量；api 默认值见 MCP_LIMITS）。 */
export interface CanvasLimits {
  /** 单批 op 条数上限（≤100）。 */
  maxOps: number;
  /** 单批入参字符串值累计 UTF-8 字节上限（100KB；按字节非字符，中文/emoji 下两者不等）。 */
  maxBatchBytes: number;
  /** 写入后整板 JSON 的 UTF-8 字节上限（10MB）。 */
  maxBoardBytes: number;
}

export const DEFAULT_CANVAS_LIMITS: CanvasLimits = {
  maxOps: 100,
  maxBatchBytes: 100 * 1024,
  maxBoardBytes: 10 * 1024 * 1024,
};

/** 当前开放的全部操作名（#622 起：create/update/move/delete/connect）。 */
export const SUPPORTED_OPS = [
  "element.create",
  "element.update",
  "element.move",
  "element.delete",
  "element.connect",
] as const;

export type ValidateErrorCode = "UNSUPPORTED_OPERATION" | "INVALID_PARAMS";

export type ParseBoardResult = { elements: unknown[]; parseError: boolean };

/** 失败态（create / mutate 共用）。 */
export type CommitErr = { ok: false; code: ValidateErrorCode; message: string; supported?: readonly string[] };

/* --------------------------------- 字节口径 -------------------------------- */

const encoder = new TextEncoder();
/** UTF-8 字节数（Node/浏览器同构；等价 Buffer.byteLength(s,"utf8")，但不引 Node-only API）。 */
export function byteLength(s: string): number {
  return encoder.encode(s).length;
}

/**
 * 递归累计字符串值的 UTF-8 字节（「批文本」口径，同 apps/api doc.tools.ts 的 collectBytes：
 * 只计字符串值，不计对象键名与非字符串标量）。
 */
export function collectStringBytes(v: unknown): number {
  if (typeof v === "string") return byteLength(v);
  if (Array.isArray(v)) return v.reduce<number>((n, x) => n + collectStringBytes(x), 0);
  if (v && typeof v === "object") {
    return Object.values(v as Record<string, unknown>).reduce<number>((n, x) => n + collectStringBytes(x), 0);
  }
  return 0;
}

/* --------------------------------- content -------------------------------- */

/**
 * 解析画布 content，与读侧 canvas.get_board 的 parseElements **同一口径**：
 * 空/纯空白按空板（elements:[], parseError:false）；坏 JSON 或顶层非数组 → parseError:true。
 * 读侧宽容返回 parseError 标志；**写侧据此拒绝写入**（绝不覆盖已损坏内容）。
 * 画布 content 顶层就是 PlaitElement[] 的 JSON 字符串（不是 {children} 对象）。
 */
export function parseBoardContent(raw: string | null | undefined): ParseBoardResult {
  if (typeof raw !== "string" || !raw || !raw.trim()) return { elements: [], parseError: false };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { elements: [], parseError: true };
  }
  return Array.isArray(v) ? { elements: v, parseError: false } : { elements: [], parseError: true };
}

/* --------------------------------- id 生成 -------------------------------- */

export type IdGenerator = () => string;

// 与 plait idCreator 同一字母表（无格式约束；同族风格，避免引入其刻意剔除的数字/易混字符）。
const ID_ALPHABET = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz";
const ID_LEN = 12; // 字母表去重后 41 字符；41^12 ≈ 2.3e19，碰撞可忽略

function randomId(): string {
  let s = "";
  for (let i = 0; i < ID_LEN; i++) s += ID_ALPHABET.charAt(Math.floor(Math.random() * ID_ALPHABET.length));
  return s;
}

/**
 * 造一个不与既有元素 id 冲突的 id 生成器：种子集 = existing 内全部 id，每次抽取后立即占坑，
 * 保证批内唯一 + 与既有不重复（极低概率碰撞自动重抽）。
 */
export function createIdGenerator(existing: unknown[]): IdGenerator {
  const used = new Set<string>();
  for (const el of existing) {
    if (el && typeof el === "object" && !Array.isArray(el)) {
      const id = (el as { id?: unknown }).id;
      if (typeof id === "string" || typeof id === "number") used.add(String(id));
    }
  }
  return () => {
    let candidate = randomId();
    while (used.has(candidate)) candidate = randomId();
    used.add(candidate);
    return candidate;
  };
}

/* ------------------------------ 通用形状工具 ------------------------------ */

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** 点：恰好 2 个有限数（不接受 NaN/Infinity/字符串/3 维）。 */
export function isPoint(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && isFiniteNumber(v[0]) && isFiniteNumber(v[1]);
}

export function invalid(message: string): CommitErr {
  return { ok: false, code: "INVALID_PARAMS", message };
}

export function unsupported(message: string): CommitErr {
  return { ok: false, code: "UNSUPPORTED_OPERATION", supported: SUPPORTED_OPS, message };
}

/**
 * 入参禁键（前端视图态/补偿态，绝不入库）：
 *  - id：create/connect 时不得自带 id（update/move/delete 时 id 是目标选择键，由各模块单独放行）。
 *  - zIndex：z 序唯一真源是数组顺序，不存在独立层级键。
 *  - plait-data-id / data-gx-*：DOM 定位属性，非数据。
 *  - selected/isSelected/isSelection/selection：plait 选区是 board 级 WeakMap 前端态。
 */
export const FORBIDDEN_BODY_KEYS = new Set([
  "zIndex",
  "plait-data-id",
  "selected",
  "isSelected",
  "isSelection",
  "selection",
]);

/** gx* 保留命名空间内当前允许出现的自定义键（仅此一个）。 */
export const GX_ALLOWED_KEYS = new Set(["gxNote"]);

/** 已知二期能力的 gx* 键（出现 → UNSUPPORTED_OPERATION，而非 INVALID_PARAMS）。 */
export const GX_FUTURE_KEYS = new Set(["gxLinkRef", "gxDocRef"]);

/** 校验元素体上的危险键 / gx* 保留命名空间（create/update/connect 共用；allowId=该操作允许 id 键）。 */
export function checkBodyKeys(raw: Record<string, unknown>, allowId: boolean): CommitErr | null {
  for (const key of Object.keys(raw)) {
    if (key === "id" && !allowId) {
      return invalid("元素不得自带 id（新元素 id 由服务端生成；修改既有元素时 id 仅作目标选择键）");
    }
    if (key !== "id" && FORBIDDEN_BODY_KEYS.has(key)) {
      return invalid(`元素不得携带禁键 "${key}"（z 序由数组顺序决定；选区/DOM 态不入库）`);
    }
    if (key.startsWith("data-gx-")) {
      return invalid(`元素不得携带 DOM 属性键 "${key}"（渲染层 data-gx-* 属性不入库）`);
    }
    if (!key.startsWith("gx")) continue;
    if (GX_FUTURE_KEYS.has(key)) {
      return unsupported(`元素含二期扩展键 "${key}"（关联文档/关联块能力当前不支持）`);
    }
    if (!GX_ALLOWED_KEYS.has(key)) {
      return invalid(`未知的 gx* 保留键 "${key}"（当前仅允许 gxNote；普通扩展键请勿使用 gx 前缀）`);
    }
  }
  if (raw.gxNote !== undefined && typeof raw.gxNote !== "string") {
    return invalid("gxNote 必须是字符串");
  }
  return null;
}

/* -------------------------------- 矩形几何 -------------------------------- */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 按点集求外接矩形（同 @plait/core RectangleClient.getRectangleByPoints：min/max）。
 * 点全部相同则退化为零宽矩形（返回 null 供调用方拒绝）。
 */
export function rectangleByPoints(points: unknown): Rect | null {
  if (!Array.isArray(points) || points.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    if (!isPoint(p)) return null;
    minX = Math.min(minX, p[0]);
    minY = Math.min(minY, p[1]);
    maxX = Math.max(maxX, p[0]);
    maxY = Math.max(maxY, p[1]);
  }
  if (!(Number.isFinite(minX) && Number.isFinite(minY))) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * 比例连接点（同 @plait/core RectangleClient.getConnectionPoint：
 * 绝对点 = [x + width*cx, y + height*cy]）。connection 分量限定 [0,1]。
 */
export function connectionPoint(rect: Rect, c: unknown): [number, number] | null {
  if (!isPoint(c)) return null;
  const [cx, cy] = c;
  if (cx < 0 || cx > 1 || cy < 0 || cy > 1) return null;
  return [rect.x + rect.width * cx, rect.y + rect.height * cy];
}
