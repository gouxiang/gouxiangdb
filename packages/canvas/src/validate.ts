// @gx/canvas —— element.create 最小集校验（六不变量纯函数）。
//
// 共享基础（类型/字节/id/content/禁键/矩形）见 shared.ts；增删改移连的主入口在 mutate.ts。
//
// 未知键裁决（ARCH §8.5 的二选一口径，已与项目总监确认，勿改）：
//   - `gx*` 是自留扩展命名空间 → 严格：当前仅 gxNote 可用；gxLinkRef/gxDocRef 是**二期能力**，
//     出现即 UNSUPPORTED_OPERATION；任何其它 gx* 保留键也拒绝（不允许冒充保留命名空间）。
//   - 非 gx 前缀的普通键（fill/strokeColor/strokeWidth/angle/opacity 等 plait 原生键及未来键）
//     → **原样透传不剥离**，不做全量白名单（避免把未来合法键全拒）；只硬拒已证实绝不入库的危险键。
//
// id 生成事实（已核实，勿猜）：
//   @plait/core@0.89.2 idCreator(length=5) 从 48 字母表随机取 5 个字符。
//   **plait 对元素 id 无任何格式校验**；唯一使用点 uniqueById 仅用 Map 按 id 去重。
//   故服务端只需保证「批内唯一 + 与既有 content 不重复」，字符集/长度自定，PlaitBoard 加载不会拒绝。

import {
  DEFAULT_CANVAS_LIMITS,
  byteLength,
  checkBodyKeys,
  collectStringBytes,
  createIdGenerator,
  invalid,
  isPlainObject,
  isPoint,
  unsupported,
  type CanvasLimits,
  type CommitErr,
  type IdGenerator,
} from "./shared.js";

// shared 的公共导出（DEFAULT_CANVAS_LIMITS/SUPPORTED_OPS/parseBoardContent/createIdGenerator 等）
// 统一由包入口 index.ts 经 export * from "./shared" 暴露，本文件不重复 re-export 以免同名歧义。

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
  | CommitErr;

/**
 * 校验单个 element.create 的元素体（不改名、不剥离：通过即原样使用，id 在整批校验后统一补）。
 */
export function validateCreateElement(raw: unknown): CommitErr | null {
  if (!isPlainObject(raw)) return invalid("element.create 的 element 必须是对象");

  // 1) 危险键硬拒（create 不允许 id / z 序 / DOM 补偿 / 选区态）+ gx* 命名空间
  const keyErr = checkBodyKeys(raw, false);
  if (keyErr) return keyErr;

  // 2) 最小集形状：仅 geometry/rectangle。其余 type（arrow-line/vector-line/mind/image/text…）
  //    与 geometry 其它 shape（ellipse/diamond…）→ UNSUPPORTED_OPERATION，绝不静默收窄。
  if (raw.type !== "geometry" || raw.shape !== "rectangle") {
    return unsupported(
      `element.create 仅支持创建 geometry/rectangle（收到 type=${JSON.stringify(raw.type)}, shape=${JSON.stringify(raw.shape)}）；` +
        "arrow-line/vector-line 等绑定关系图元请用 element.connect；脑图、图片、文本与其它形状当前不支持",
    );
  }

  // 3) points：恰好 2 点、右下严格大于左上（拒绝零宽/零高/反向矩形）
  const pts = raw.points;
  if (!Array.isArray(pts) || pts.length !== 2) {
    return invalid("rectangle 的 points 必须是恰好 2 个点（左上角、右下角）");
  }
  const [p1, p2] = pts as unknown[];
  if (!isPoint(p1) || !isPoint(p2)) {
    return invalid("points 每个点必须是恰好 2 个有限数（Number.isFinite），不接受 NaN/Infinity/字符串/3 维坐标");
  }
  const [x1, y1] = p1;
  const [x2, y2] = p2;
  if (!(x2 > x1 && y2 > y1)) {
    return invalid(`rectangle 宽高必须为正：右下角 (${x2},${y2}) 必须严格大于左上角 (${x1},${y1})（拒绝零宽/反向）`);
  }

  // 普通未知键（非 gx、非禁键）原样透传——不做白名单剥离（ARCH §8.5）。
  return null;
}

/**
 * 校验一批 element.create 并产出尾插后的完整数组。纯函数：不查库、不触 ctx、不跨边界抛错。
 *
 * 顺序：批形状/数量/字节 → op 名白名单（其它操作名整批拒绝，绝不静默丢弃）→ 逐元素六不变量 →
 * 服务端补 id（双唯一）→ 尾插 → 整板字节上限。任一失败返回 ok:false 且不产出 next（原子）。
 *
 * 注：增删改移混批请用 mutate.ts 的 commitElements（单一真源）；本函数保留仅 create 语义。
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
      if (op.op !== "element.create") {
        return unsupported(`validateCreateOps 仅接受 element.create（位置 ${i} 收到 "${op.op}"）；混批/增删改移请用 commitElements`);
      }
      const err = validateCreateElement(op.element);
      if (err) return { ...err, message: `ops[${i}]: ${err.message}` };
      newElements.push({ ...(op.element as Record<string, unknown>) });
    }

    const nextId = genId ?? createIdGenerator(existing);
    const appendedIds: string[] = [];
    const created = newElements.map((el) => {
      const id = nextId();
      appendedIds.push(id);
      return { ...el, id };
    });

    const next = [...existing, ...created];
    const nextBytes = byteLength(JSON.stringify(next));
    if (nextBytes > limits.maxBoardBytes) {
      return invalid(`写入后整板 ${nextBytes} 字节超过上限 ${limits.maxBoardBytes} 字节（10MB，UTF-8 口径）`);
    }
    return { ok: true, elements: created, appendedIds, next, nextBytes };
  } catch (e) {
    return invalid(`校验过程异常（已拦截，未执行任何写入）：${(e as Error).message}`);
  }
}
