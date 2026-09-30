// @gx/canvas —— commitElements：element.create/update/move/delete/connect 混批纯函数（#622）。
//
// 与前端 Drawnix 行为对齐的关键口径（均据 plait 源码核实，勿改）：
//  1) 目标存在性按「当前已应用前缀 + 批开始时」的板判定；本批先 create/connect 出来的元素
//     可被同批后续 op 引用（它们在原子操作后必然存在）；引用仍不存在即整批 INVALID_PARAMS。
//  2) update 改「位置/样式」，禁改 type/shape（连线的绑定关系也不在此改，请删除后重连）；
//     geometry/rectangle 的 points 仍须 2 点且宽高为正；arrow-line/vector-line points 须 2 点。
//     update 允许以连线为目标（改线样式）。
//  3) move = 目标自身 points 全部加 (dx,dy)，仅形状节点（连线不允许 move：绑定线位移语义复杂）；
//     绑定它的 arrow-line **存储内容不动**——plait 渲染时 getArrowLinePoints 按端点连接点重算首末点。
//  4) delete 允许删除任意元素；删除形状节点时任一端绑定它的 arrow-line **级联删除**
//     （同 withDrawFragment 的 getBoundedArrowLineElements）；删除连线本身不级联。
//  5) connect 创建 arrow-line（两端绑定形状）或 vector-line（两端自由点，不绑定）；
//     服务端补 id、尾插。
// 任一 op 失败整批 ok:false、不产出 next（调用方据 ok 原子不落库）。

import {
  byteLength,
  checkBodyKeys,
  collectStringBytes,
  connectionPoint,
  createIdGenerator,
  invalid,
  isFiniteNumber,
  isPlainObject,
  isPoint,
  rectangleByPoints,
  unsupported,
  type CanvasLimits,
  type CommitErr,
  type IdGenerator,
} from "./shared.js";
import { validateCreateElement } from "./validate.js";

export type MutateResult =
  | {
      ok: true;
      /** 应用全部 op 后的整板数组（JSON.stringify 即落库正文）。 */
      next: unknown[];
      nextBytes: number;
      /** create 新建元素（顺序同入参；含服务端 id）。 */
      created: Record<string, unknown>[];
      createdIds: string[];
      /** connect 新建连线元素（顺序同入参；含服务端 id）。 */
      connected: Record<string, unknown>[];
      connectedIds: string[];
      /** 被更新/移动/删除（含级联）的目标 id（去重，无序）。 */
      updatedIds: string[];
      movedIds: string[];
      deletedIds: string[];
    }
  | CommitErr;

const LINE_SHAPES = new Set(["straight", "curve", "elbow"]);
const MARKER_VALUES = new Set([
  "arrow",
  "none",
  "open-triangle",
  "solid-triangle",
  "sharp-arrow",
  "one-side-up",
  "one-side-down",
  "hollow-triangle",
  "single-slash",
]);

type El = Record<string, unknown> & { id: string };

/** 显式错误守卫（成功元素/连线没有 ok:false 字段）。 */
function isErr(v: unknown): v is CommitErr {
  return (v as CommitErr)?.ok === false;
}

function asElement(v: unknown): El | null {
  return isPlainObject(v) && typeof v.id === "string" && v.id ? (v as El) : null;
}

/**
 * 取目标元素。shapeOnly=true 时仅允许形状节点（geometry/image/table/swimlane…，连线不可，如 move）；
 * shapeOnly=false 时允许任意元素（update/delete，可改/删连线）。
 */
function target(index: Map<string, El>, raw: unknown, shapeOnly: boolean): El | CommitErr {
  const id = typeof raw === "string" ? raw : isPlainObject(raw) && typeof raw.id === "string" ? raw.id : "";
  if (!id) return invalid("目标 id 必须是非空字符串（或 {id} 对象）");
  const el = index.get(id);
  if (!el) return invalid(`目标元素 "${id}" 不存在（id 引用按当前画布与同批已应用操作判定）`);
  if (shapeOnly && (el.type === "arrow-line" || el.type === "vector-line")) {
    return invalid(`目标 "${id}" 是连线；连线不支持 move（连接关系请删除后重连）`);
  }
  return el;
}

/** 校验 update 的 patch：非空对象、禁键/无 id、不改 type/shape、样式值基本类型。 */
function validatePatch(el: El, rawPatch: unknown): CommitErr | null {
  if (!isPlainObject(rawPatch)) return invalid("patch 必须是对象");
  if (Object.keys(rawPatch).length === 0) return invalid("patch 至少包含一个要修改的键");
  const keyErr = checkBodyKeys(rawPatch, false);
  if (keyErr) return keyErr;
  if (rawPatch.type !== undefined || rawPatch.shape !== undefined) {
    return invalid("patch 不得修改 type/shape（元素类型与形状不可变更；请删除后重建或删除后重连）");
  }
  if (el.type === "arrow-line" && (rawPatch.source !== undefined || rawPatch.target !== undefined || rawPatch.texts !== undefined)) {
    return invalid("patch 不得修改连线的绑定关系（source/target/texts）；请删除后用 element.connect 重连");
  }
  if (rawPatch.points !== undefined) {
    const pts = rawPatch.points;
    if (!Array.isArray(pts) || pts.length !== 2 || !isPoint(pts[0]) || !isPoint(pts[1])) {
      return invalid("patch.points 必须是恰好 2 个有限点");
    }
    if (el.type === "geometry" && el.shape === "rectangle") {
      const [x1, y1] = pts[0];
      const [x2, y2] = pts[1];
      if (!(x2 > x1 && y2 > y1)) return invalid("rectangle 宽高必须为正（右下角严格大于左上角）");
    }
  }
  for (const k of ["strokeWidth", "opacity", "angle"]) {
    const v = rawPatch[k];
    if (v !== undefined && !isFiniteNumber(v)) return invalid(`patch.${k} 必须是有限数`);
  }
  for (const k of ["strokeColor", "fill", "strokeStyle"]) {
    const v = rawPatch[k];
    if (v !== undefined && typeof v !== "string") return invalid(`patch.${k} 必须是字符串`);
  }
  return null;
}

/** 构造 connect 连线（不含 id；校验源/目标形状与连接点）。 */
function buildConnect(index: Map<string, El>, op: Record<string, unknown>): Record<string, unknown> | CommitErr {
  const kind = op.type === "vector-line" ? "vector-line" : "arrow-line";
  const shape = typeof op.shape === "string" ? op.shape : "straight";
  if (!LINE_SHAPES.has(shape)) return invalid(`连线 shape 必须是 straight/curve/elbow 之一（收到 ${JSON.stringify(op.shape)}）`);

  if (kind === "vector-line") {
    const sp = op.sourcePoint;
    const tp = op.targetPoint;
    if (!isPoint(sp) || !isPoint(tp)) return invalid("vector-line 需提供 sourcePoint、targetPoint（各为 2 个有限数）");
    if (sp[0] === tp[0] && sp[1] === tp[1]) return invalid("连线起终点不得相同");
    return { type: kind, shape, points: [sp, tp], opacity: 1 };
  }

  const sId = typeof op.sourceId === "string" ? op.sourceId : "";
  const tId = typeof op.targetId === "string" ? op.targetId : "";
  if (!sId || !tId) return invalid("arrow-line 需提供 sourceId、targetId（既有形状元素 id）");
  const s = index.get(sId);
  const t = index.get(tId);
  if (!s || !t) return invalid(`连接端点不存在：sourceId=${sId || "(空)"}, targetId=${tId || "(空)"}`);
  if (s.type === "arrow-line" || s.type === "vector-line" || t.type === "arrow-line" || t.type === "vector-line") {
    return invalid("arrow-line 两端必须是形状节点（geometry 等），不能绑定到连线");
  }
  const rs = rectangleByPoints(s.points);
  const rt = rectangleByPoints(t.points);
  if (!rs || !rt) return invalid("连接端点缺少可用 points，无法计算连接点");
  const sc = op.sourceConnection ?? [0.5, 0.5];
  const tc = op.targetConnection ?? [0.5, 0.5];
  const sp = connectionPoint(rs, sc);
  const tp = connectionPoint(rt, tc);
  if (!sp || !tp) return invalid("sourceConnection/targetConnection 必须是 2 个 [0,1] 区间内的数");
  const sourceMarker = op.sourceMarker ?? "none";
  const targetMarker = op.targetMarker ?? "arrow";
  if (!MARKER_VALUES.has(sourceMarker as string) || !MARKER_VALUES.has(targetMarker as string)) {
    return invalid("sourceMarker/targetMarker 取值不在 ArrowLineMarkerType 枚举内");
  }
  return {
    type: kind,
    shape,
    points: [sp, tp],
    source: { boundId: sId, connection: sc, marker: sourceMarker },
    target: { boundId: tId, connection: tc, marker: targetMarker },
    texts: [],
    opacity: 1,
  };
}

/**
 * 应用一批增删改移连 op，产出 next。纯函数：不查库、不触 ctx、不跨边界抛错。
 */
export function commitElements(
  existing: unknown[],
  ops: unknown,
  limits: CanvasLimits,
  genId?: IdGenerator,
): MutateResult {
  try {
    if (!Array.isArray(existing)) return invalid("existing 必须是元素数组");
    if (!Array.isArray(ops)) return invalid("ops 必须是数组");
    if (ops.length === 0) return invalid("ops 至少包含一个操作");
    if (ops.length > limits.maxOps) return invalid(`单批操作数 ${ops.length} 超过上限 ${limits.maxOps}`);
    const batchBytes = collectStringBytes(ops);
    if (batchBytes > limits.maxBatchBytes) return invalid(`批文本 ${batchBytes} 字节超过上限 ${limits.maxBatchBytes} 字节（UTF-8）`);

    const index = new Map<string, El>();
    for (const v of existing) {
      const el = asElement(v);
      if (el) index.set(el.id, el);
    }
    const nextId = genId ?? createIdGenerator(existing);
    const arr: unknown[] = [...existing];
    const created: Record<string, unknown>[] = [];
    const createdIds: string[] = [];
    const connected: Record<string, unknown>[] = [];
    const connectedIds: string[] = [];
    const updatedIds = new Set<string>();
    const movedIds = new Set<string>();
    const deletedIds = new Set<string>();

    const replaceAt = (id: string, next: Record<string, unknown>): void => {
      const i = arr.findIndex((v) => (v as El)?.id === id);
      if (i >= 0) arr[i] = next;
    };

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      const at = `ops[${i}]`;
      if (!isPlainObject(op)) return invalid(`${at} 必须是 { op, ... } 对象`);
      if (typeof op.op !== "string" || !op.op) return invalid(`${at} 缺少字符串 op 名`);
      const fail = (e: CommitErr): CommitErr => ({ ...e, message: `${at}: ${e.message}` });

      if (op.op === "element.create") {
        const err = validateCreateElement(op.element);
        if (err) return fail(err);
        const el = { ...(op.element as Record<string, unknown>), id: nextId() } as El;
        created.push(el);
        createdIds.push(el.id);
        arr.push(el);
        index.set(el.id, el); // 同批后续 op 可引用
      } else if (op.op === "element.connect") {
        const built = buildConnect(index, op);
        if (isErr(built)) return fail(built);
        const el = { ...built, id: nextId() } as El;
        connected.push(el);
        connectedIds.push(el.id);
        arr.push(el);
        index.set(el.id, el);
      } else if (op.op === "element.update") {
        const el = target(index, op.id, false);
        if (isErr(el)) return fail(el);
        const perr = validatePatch(el, op.patch);
        if (perr) return fail(perr);
        const next = { ...el, ...(op.patch as Record<string, unknown>) } as El;
        replaceAt(el.id, next);
        index.set(el.id, next);
        updatedIds.add(el.id);
      } else if (op.op === "element.move") {
        const el = target(index, op.id, true);
        if (isErr(el)) return fail(el);
        const dx = op.dx;
        const dy = op.dy;
        if (!isFiniteNumber(dx) || !isFiniteNumber(dy)) return fail(invalid("move 需提供有限数 dx、dy"));
        if (dx === 0 && dy === 0) return fail(invalid("move 的 dx/dy 不得同时为 0"));
        const pts = Array.isArray(el.points) ? (el.points as unknown[]).map((p) => (isPoint(p) ? [p[0] + dx, p[1] + dy] : p)) : el.points;
        const next = { ...el, points: pts } as El;
        replaceAt(el.id, next);
        index.set(el.id, next);
        movedIds.add(el.id);
      } else if (op.op === "element.delete") {
        const el = target(index, op.id, false);
        if (isErr(el)) return fail(el);
        // 级联：任一端绑定该形状的 arrow-line（同批已删连线不再重复）
        const cascade: string[] = [];
        for (const [lid, line] of index) {
          if (deletedIds.has(lid) || line.type !== "arrow-line") continue;
          const src = line.source as { boundId?: string } | undefined;
          const tgt = line.target as { boundId?: string } | undefined;
          if (src?.boundId === el.id || tgt?.boundId === el.id) cascade.push(lid);
        }
        const remove = new Set([el.id, ...cascade]);
        for (let k = arr.length - 1; k >= 0; k--) {
          const eid = (arr[k] as El)?.id;
          if (eid && remove.has(eid)) arr.splice(k, 1);
        }
        for (const id of remove) {
          deletedIds.add(id);
          index.delete(id);
        }
      } else {
        return fail(unsupported(`不支持的操作名 "${op.op}"`));
      }
    }

    const nextBytes = byteLength(JSON.stringify(arr));
    if (nextBytes > limits.maxBoardBytes) {
      return invalid(`写入后整板 ${nextBytes} 字节超过上限 ${limits.maxBoardBytes} 字节（10MB，UTF-8 口径）`);
    }
    return {
      ok: true,
      next: arr,
      nextBytes,
      created,
      createdIds,
      connected,
      connectedIds,
      updatedIds: [...updatedIds],
      movedIds: [...movedIds],
      deletedIds: [...deletedIds],
    };
  } catch (e) {
    return invalid(`校验过程异常（已拦截，未执行任何写入）：${(e as Error).message}`);
  }
}
