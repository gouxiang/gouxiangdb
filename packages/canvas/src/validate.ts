// @gx/canvas —— 画布写入「六不变量」纯函数校验器（M6/S6b 第一步）。
//
// 零 IO / 零 @plait 依赖 / 零 DOM：Node（MCP 服务端）与浏览器（未来前端消费）同构可跑。
// 本文件**不搬** apps/web 的 canvas-ops.ts（该文件规则长在 plait transform 调用里，无现成纯函数可零成本抽；
// S6b 裁决：前端一行不改，本片只「新建」。是否让前端反向消费由 S9 按真实收益评估）。
//
// 未知键裁决（ARCH §8.5 的二选一口径，已与项目总监确认，勿改）：
//   - `gx*` 是自留扩展命名空间 → 严格：当前仅 gxNote 可用；gxLinkRef/gxDocRef 是**二期能力**，
//     出现即 UNSUPPORTED_OPERATION；任何其它 gx* 保留键也拒绝（不允许冒充保留命名空间）。
//   - 非 gx 前缀的普通键（fill/strokeColor/strokeWidth/angle/opacity 等 plait 原生键及未来键）
//     → **原样透传不剥离**，不做全量白名单（避免把未来合法键全拒）；只硬拒已证实绝不入库的危险键
//     （id / zIndex / data-gx-* / plait-data-id / 选区态）。
//
// id 生成事实（已核实，勿猜）：
//   @plait/core@0.89.2 fesm2022/plait-core.mjs:1644-1652 的 idCreator(length=5) 从 48 字母表
//   （'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz'，剔除数字与 oOLl/9gq/Vv/Uu/I1 易混字符）随机取 5 个字符。
//   **plait 对元素 id 无任何格式校验**——全仓无 id 正则/数字前缀约束；唯一使用点 uniqueById
//   （同文件 232-240）仅用 Map 按 id 去重。故服务端只需保证「批内唯一 + 与既有 content 不重复」，
//   字符集/长度自定，PlaitBoard 加载不会拒绝。

/* ---------------------------------- 类型 ---------------------------------- */

/** 配额（由调用方显式传入，纯函数不读环境变量；api 默认值见 DEFAULT_CANVAS_LIMITS）。 */
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

/** 当前开放的操作名白名单（最小集：仅尾插几何矩形）。 */
export const SUPPORTED_OPS = ["element.create"] as const;

export type ValidateErrorCode = "UNSUPPORTED_OPERATION" | "INVALID_PARAMS";

export type ParseBoardResult = { elements: unknown[]; parseError: boolean };

export type CommitResult =
  | {
      ok: true;
      /** 本次新建元素（已补服务端 id；顺序同入参）。 */
      elements: Record<string, unknown>[];
      /** 服务端生成的新 id（顺序同 elements）。 */
      appendedIds: string[];
      /** 尾插后的整板数组（JSON.stringify 即落库正文）。 */
      next: unknown[];
      /** 写入后整板 JSON 的 UTF-8 字节数。 */
      nextBytes: number;
    }
  | { ok: false; code: ValidateErrorCode; message: string; supported?: readonly string[] };

/* --------------------------------- 字节口径 -------------------------------- */

const encoder = new TextEncoder();
/** UTF-8 字节数（Node/浏览器同构；等价 Buffer.byteLength(s,"utf8")，但不引 Node-only API）。 */
function byteLength(s: string): number {
  return encoder.encode(s).length;
}

/**
 * 递归累计字符串值的 UTF-8 字节（「批文本」口径，同 apps/api doc.tools.ts 的 collectBytes：
 * 只计字符串值，不计对象键名与非字符串标量）。
 */
function collectStringBytes(v: unknown): number {
  if (typeof v === "string") return byteLength(v);
  if (Array.isArray(v)) return v.reduce<number>((n, x) => n + collectStringBytes(x), 0);
  if (v && typeof v === "object") {
    return Object.values(v as Record<string, unknown>).reduce<number>((n, x) => n + collectStringBytes(x), 0);
  }
  return 0;
}

/* --------------------------------- content -------------------------------- */

/**
 * 解析画布 content，与读侧 canvas.get_board 的 parseElements **同一口径**（本片起读侧改为复用本函数，
 * 单一真源）：空/纯空白按空板（elements:[], parseError:false）；坏 JSON 或顶层非数组 → parseError:true。
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
const ID_LEN = 12; // 48^12 ≈ 1.4e20，碰撞可忽略

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

/* ------------------------------ 单元素不变量 ------------------------------ */

/**
 * 入参禁键（前端视图态/补偿态，绝不入库）：
 *  - id：AI 不得自带 id，一律由服务端补（M6 计划 §402）。
 *  - zIndex：z 序唯一真源是数组顺序（尾插），不存在独立层级键。
 *  - plait-data-id / data-gx-*：DOM 定位属性（canvas-ops.ts:739、LinkBlockForeignObject.tsx:127），非数据。
 *  - selected/isSelected/isSelection/selection：plait 选区是 board 级 WeakMap 前端态，不在元素 JSON 上。
 */
const FORBIDDEN_INPUT_KEYS = new Set(["id", "zIndex", "plait-data-id", "selected", "isSelected", "isSelection", "selection"]);

/** gx* 保留命名空间内当前允许出现在入参中的自定义键（仅此一个；关联/引用能力列二期）。 */
const GX_ALLOWED_KEYS = new Set(["gxNote"]);

/** 已知二期能力的 gx* 键（出现 → UNSUPPORTED_OPERATION，而非 INVALID_PARAMS）。 */
const GX_FUTURE_KEYS = new Set(["gxLinkRef", "gxDocRef"]);

function invalid(message: string): CommitErr {
  return { ok: false, code: "INVALID_PARAMS", message };
}
function unsupported(message: string): CommitErr {
  return { ok: false, code: "UNSUPPORTED_OPERATION", supported: SUPPORTED_OPS, message };
}
type CommitErr = Extract<CommitResult, { ok: false }>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * 校验单个 element.create 的元素体（不改名、不剥离：通过即原样使用，id 在整批校验后统一补）。
 */
function validateCreateElement(raw: unknown): CommitErr | null {
  if (!isPlainObject(raw)) return invalid("element.create 的 element 必须是对象");

  // 1) 危险键硬拒（id / z 序 / DOM 补偿 / 选区态）
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_INPUT_KEYS.has(key)) {
      return invalid(`元素不得自带禁键 "${key}"（id 由服务端生成；z 序由数组顺序决定；选区/DOM 态不入库）`);
    }
    if (key.startsWith("data-gx-")) {
      return invalid(`元素不得携带 DOM 属性键 "${key}"（渲染层 data-gx-* 属性不入库）`);
    }
  }

  // 2) 最小集形状：仅 geometry/rectangle。其余 type（arrow-line/vector-line/mind/image/text…）
  //    与 geometry 其它 shape（ellipse/diamond…）→ UNSUPPORTED_OPERATION，绝不静默收窄。
  if (raw.type !== "geometry" || raw.shape !== "rectangle") {
    return unsupported(
      `当前最小集仅支持 element.create 创建 geometry/rectangle（收到 type=${JSON.stringify(raw.type)}, shape=${JSON.stringify(raw.shape)}）；` +
        "arrow-line/vector-line 等绑定关系图元、脑图、图片、文本与其它形状均为二期能力",
    );
  }

  // 3) gx* 保留命名空间：仅 gxNote（字符串）；gxLinkRef/gxDocRef 等二期能力单列 UNSUPPORTED；
  //    未知 gx* 键拒绝（不允许冒充保留命名空间）。普通（非 gx）键不在此拦截，透传。
  for (const key of Object.keys(raw)) {
    if (!key.startsWith("gx")) continue;
    if (GX_FUTURE_KEYS.has(key)) {
      return unsupported(`元素含二期扩展键 "${key}"（关联文档/关联块能力当前最小集不支持；请只提交普通几何矩形）`);
    }
    if (!GX_ALLOWED_KEYS.has(key)) {
      return invalid(`未知的 gx* 保留键 "${key}"（当前仅允许 gxNote；普通扩展键请勿使用 gx 前缀）`);
    }
  }
  if (raw.gxNote !== undefined && typeof raw.gxNote !== "string") {
    return invalid("gxNote 必须是字符串");
  }

  // 4) points：恰好 2 点、每点恰好 2 个有限数、右下严格大于左上（拒绝零宽/零高/反向矩形）
  const pts = raw.points;
  if (!Array.isArray(pts) || pts.length !== 2) {
    return invalid("rectangle 的 points 必须是恰好 2 个点（左上角、右下角）");
  }
  const isPoint = (p: unknown): boolean =>
    Array.isArray(p) && p.length === 2 && isFiniteNumber(p[0]) && isFiniteNumber(p[1]);
  const [p1, p2] = pts as unknown[];
  if (!isPoint(p1) || !isPoint(p2)) {
    return invalid("points 每个点必须是恰好 2 个有限数（Number.isFinite），不接受 NaN/Infinity/字符串/3 维坐标");
  }
  const [x1, y1] = p1 as [number, number];
  const [x2, y2] = p2 as [number, number];
  if (!(x2 > x1 && y2 > y1)) {
    return invalid(`rectangle 宽高必须为正：右下角 (${x2},${y2}) 必须严格大于左上角 (${x1},${y1})（拒绝零宽/反向）`);
  }

  // 普通未知键（非 gx、非禁键）原样透传——不做白名单剥离（ARCH §8.5）。
  return null;
}

/* ------------------------------- 整批校验 -------------------------------- */

/**
 * 校验一批 commit op 并产出尾插后的完整数组。纯函数：不查库、不触 ctx、不跨边界抛错。
 *
 * 顺序：op 名白名单（其它操作名整批拒绝，绝不静默丢弃）→ 逐元素六不变量 → 服务端补 id（双唯一）→
 * 尾插 → 整板字节上限。任一失败返回 ok:false 且不产出可用 next（原子，无半应用由调用方据 ok 不落库保证）。
 */
export function validateCreateOps(
  existing: unknown[],
  ops: unknown,
  limits: CanvasLimits = DEFAULT_CANVAS_LIMITS,
  genId?: IdGenerator,
): CommitResult {
  try {
    if (!Array.isArray(existing)) return invalid("existing 必须是元素数组");
    if (!Array.isArray(ops)) return invalid("ops 必须是数组");
    if (ops.length === 0) return invalid("ops 至少包含一个操作");
    if (ops.length > limits.maxOps) {
      return invalid(`单批操作数 ${ops.length} 超过上限 ${limits.maxOps}`);
    }

    // 批文本：入参内字符串值累计 UTF-8 字节（与 doc 写工具同口径：按字节，非字符数）
    const batchBytes = collectStringBytes(ops);
    if (batchBytes > limits.maxBatchBytes) {
      return invalid(`批文本 ${batchBytes} 字节超过上限 ${limits.maxBatchBytes} 字节（UTF-8）`);
    }

    const newElements: Record<string, unknown>[] = [];
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (!isPlainObject(op)) return invalid(`ops[${i}] 必须是 { op, element } 对象`);
      if (typeof op.op !== "string" || op.op.length === 0) {
        return invalid(`ops[${i}] 缺少字符串 op 名`);
      }
      // 操作名白名单：未开放操作（element.update/move/delete/connect、zorder…）整批拒绝，绝不静默丢弃
      if (!(SUPPORTED_OPS as readonly string[]).includes(op.op)) {
        return unsupported(`不支持的操作名 "${op.op}"（位置 ${i}；当前仅支持尾插创建，supported=["element.create"]）`);
      }
      const err = validateCreateElement(op.element);
      if (err) return { ...err, message: `ops[${i}]: ${err.message}` };
      // 拷贝入参元素（不直接持有调用方对象引用），id 稍后统一补
      newElements.push({ ...(op.element as Record<string, unknown>) });
    }

    // 服务端补 id（AI 不得自带，已在禁键校验拦死）；批内 + 与 existing 双唯一
    const nextId = genId ?? createIdGenerator(existing);
    const appendedIds: string[] = [];
    const created = newElements.map((el) => {
      const id = nextId();
      appendedIds.push(id);
      return { ...el, id };
    });

    // 尾插：z 序真源 = 数组顺序（content 顶层即数组）
    const next = [...existing, ...created];
    const nextBytes = byteLength(JSON.stringify(next));
    if (nextBytes > limits.maxBoardBytes) {
      return invalid(`写入后整板 ${nextBytes} 字节超过上限 ${limits.maxBoardBytes} 字节（10MB，UTF-8 口径）`);
    }
    return { ok: true, elements: created, appendedIds, next, nextBytes };
  } catch (e) {
    // 纯函数不跨边界抛错：内部意外一律转 INVALID_PARAMS（未执行任何写入）
    return invalid(`校验过程异常（已拦截，未执行任何写入）：${(e as Error).message}`);
  }
}
